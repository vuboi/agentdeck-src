//! Antigravity account, quota and mode connector.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

use crate::endpoints::ENDPOINTS;

use super::{
    antigravity_email_since, antigravity_login, capture, delete_secret, parse_iso,
    refresh_antigravity_cli_email, safe_arg, stored_secret, version_of, which, write_secret,
    CancellableChild, UsageWindow,
};

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct QuotaGroup {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) windows: Vec<UsageWindow>,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct AgyQuota {
    /// Epoch seconds of the figures.
    pub(crate) observed_at: Option<i64>,
    pub(crate) groups: Vec<QuotaGroup>,
}

/// agy hands its quota to the status-line command, and a tool that already owns that hook (AI Usage Meter) saves
/// it to `usage-cache.json`: `{"fetchedAt": ms, "quota": {"gemini-5h": {"remaining_fraction", "reset_time"}, ...}}`.
/// The keys are `<model group>-<window>`. Read-only: AgentDeck never edits agy's status-line setting.
pub(crate) fn parse_agy_quota(text: &str) -> Option<AgyQuota> {
    let json: Value = serde_json::from_str(text).ok()?;
    let quota = json["quota"].as_object()?;
    let mut groups: Vec<QuotaGroup> = Vec::new();
    for (key, entry) in quota {
        let (group, window) = key.rsplit_once('-')?;
        let Some(remaining) = entry["remaining_fraction"].as_f64() else {
            continue;
        };
        let window = UsageWindow {
            label: if window == "weekly" {
                "7d".to_string()
            } else {
                window.to_string()
            },
            pct: ((1.0 - remaining) * 100.0).clamp(0.0, 100.0),
            resets_at: entry["reset_time"].as_str().and_then(parse_iso),
            remaining: None,
            limit: None,
        };
        match groups.iter_mut().find(|item| item.id == group) {
            Some(item) => item.windows.push(window),
            None => groups.push(QuotaGroup {
                id: group.to_string(),
                label: match group {
                    "gemini" => "Gemini models".to_string(),
                    "3p" => "Claude and GPT-OSS models".to_string(),
                    other => other.to_string(),
                },
                windows: vec![window],
            }),
        }
    }
    groups.sort_by_key(|item| item.id != "gemini");
    for group in &mut groups {
        group.windows.sort_by_key(|window| window.label != "5h");
    }
    Some(AgyQuota {
        observed_at: json["fetchedAt"].as_i64().map(|ms| ms / 1000),
        groups,
    })
}

/// The last quota figures agy saved to a file (its status line does it, when it runs). `None` when nothing is there.
fn saved_agy_quota() -> Option<AgyQuota> {
    let path = crate::home_folder()
        .ok()?
        .join(".gemini")
        .join("antigravity-cli")
        .join("ai-quota-tray")
        .join("usage-cache.json");
    parse_agy_quota(&std::fs::read_to_string(path).ok()?)
}

/// The last locally saved quota, returned before the live request so Settings can show it immediately.
pub fn antigravity_quota_cached() -> Option<AgyQuota> {
    saved_agy_quota()
}

fn agy_accounts_path() -> Result<PathBuf, String> {
    crate::home_folder().map(|home| {
        home.join(crate::channel::home_folder_name())
            .join("antigravity-accounts.json")
    })
}

#[cfg(windows)]
pub(crate) fn agy_secret_target(email: &str) -> String {
    let suffix: String = email
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("AgentDeck Antigravity {suffix}")
}

#[derive(Serialize, serde::Deserialize, Clone)]
pub struct AgyAccount {
    pub(crate) id: String,
    pub(crate) email: String,
    pub(crate) active: bool,
    #[serde(default)]
    pub(crate) expired: bool,
    #[serde(default)]
    pub(crate) status: Option<String>,
}

/// Reports only problems that can be checked from the saved credential without making a network request.
fn agy_credential_status(email: &str) -> (bool, Option<String>) {
    #[cfg(windows)]
    {
        let Some(secret) = stored_secret(&agy_secret_target(email)) else {
            return (true, Some("Saved credentials are missing".to_string()));
        };
        let Ok(value) = serde_json::from_str::<Value>(&secret) else {
            return (true, Some("Saved login is invalid".to_string()));
        };
        let token = &value["token"];
        // The access token lives about an hour; the refresh token is what keeps the sign-in. agy renews the access
        // token itself the next time it runs, so only a missing refresh token means signing in again.
        if token["refresh_token"].as_str().is_none_or(str::is_empty) {
            if token["access_token"].as_str().is_none_or(str::is_empty) {
                return (true, Some("Access token is missing".to_string()));
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_secs() as i64);
            if token["expiry"]
                .as_str()
                .and_then(parse_iso)
                .is_some_and(|expiry| expiry <= now + 30)
            {
                return (true, Some("Access token expired".to_string()));
            }
        }
    }
    #[cfg(not(windows))]
    let _ = email;

    (false, None)
}

/// Whether two Antigravity sign-ins are the same login. agy renews the access token every hour, so the whole value
/// changes; the refresh token does not.
#[cfg_attr(not(windows), allow(dead_code))]
fn same_agy_login(a: &Value, b: &Value) -> bool {
    let refresh = |value: &Value| {
        value["token"]["refresh_token"]
            .as_str()
            .filter(|token| !token.is_empty())
            .map(str::to_owned)
    };
    match (refresh(a), refresh(b)) {
        (Some(left), Some(right)) => left == right,
        _ => a == b,
    }
}

pub(crate) fn read_agy_accounts() -> Vec<AgyAccount> {
    agy_accounts_path()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Vec<AgyAccount>>(&text).ok())
        .unwrap_or_default()
}

pub(crate) fn write_agy_accounts(accounts: &[AgyAccount]) -> Result<(), String> {
    let path = agy_accounts_path()?;
    let parent = path
        .parent()
        .ok_or("could not find the AgentDeck data folder")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let text = serde_json::to_string_pretty(accounts).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| error.to_string())
}

/// The sign-in of Antigravity (`{"token": {"access_token", "refresh_token", "expiry"}}`), read and never written: the
/// system store first, then the file agy falls back to when it has no system store.
pub(crate) fn agy_sign_in() -> Option<Value> {
    #[cfg(windows)]
    if let Some(value) = stored_secret("gemini:antigravity")
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    {
        return Some(value);
    }
    let file = crate::home_folder()
        .ok()?
        .join(".gemini")
        .join("jetski-standalone-oauth-token");
    serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()
}

/// Saved Antigravity accounts. The JSON index stores emails only; each OAuth token is held by Windows Credential Manager.
pub async fn antigravity_accounts_list() -> Vec<AgyAccount> {
    #[cfg(windows)]
    adopt_unsaved_agy_sign_in().await;
    let active = agy_saved_active_email().or_else(|| antigravity_login().email);
    read_agy_accounts()
        .into_iter()
        .map(|mut account| {
            account.active = active.as_deref() == Some(account.email.as_str());
            (account.expired, account.status) = agy_credential_status(&account.email);
            account
        })
        .collect()
}

/// agy is signed in with a login no saved account holds (it was signed in outside AgentDeck, or agy got a new refresh
/// token): the account is asked of agy itself (`agy models` writes the email to its log) and saved. Tried at most once
/// every ten minutes, so a list refresh never runs the CLI over and over.
#[cfg(windows)]
async fn adopt_unsaved_agy_sign_in() {
    static LAST_TRY: AtomicU64 = AtomicU64::new(0);
    let Some(current) = agy_sign_in() else { return };
    if current["token"]["access_token"]
        .as_str()
        .is_none_or(str::is_empty)
    {
        return;
    }
    if agy_saved_active_email().is_some() {
        return;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let last = LAST_TRY.load(Ordering::Relaxed);
    if last != 0 && now.saturating_sub(last) < 600 {
        return;
    }
    LAST_TRY.store(now, Ordering::Relaxed);
    let Ok(email) = refresh_antigravity_cli_email(std::time::SystemTime::now()).await else {
        return;
    };
    let _ = save_agy_account(&current, email);
}

pub(crate) fn agy_saved_active_email() -> Option<String> {
    #[cfg(not(windows))]
    return None;

    #[cfg(windows)]
    {
        let current = agy_sign_in()?;
        let email = read_agy_accounts().into_iter().find_map(|account| {
            let saved = stored_secret(&agy_secret_target(&account.email))?;
            let saved: Value = serde_json::from_str(&saved).ok()?;
            same_agy_login(&saved, &current).then_some(account.email)
        })?;
        // agy renewed the token since it was saved: keep the saved copy current, so switching back to this account
        // later gives agy a fresh token, not one from hours ago.
        let target = agy_secret_target(&email);
        let stale = stored_secret(&target)
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .is_some_and(|saved| saved != current);
        if stale {
            if let Ok(text) = serde_json::to_string(&current) {
                let _ = write_secret(&target, &text);
            }
        }
        Some(email)
    }
}

/// Saves the Antigravity account currently signed in on this machine. Call after signing in with `agy`.
pub async fn antigravity_account_adopt() -> Result<(), String> {
    #[cfg(not(windows))]
    return Err(
        "Antigravity account switching currently requires Windows Credential Manager".to_string(),
    );

    #[cfg(windows)]
    {
        let sign_in = agy_sign_in().ok_or("no Antigravity sign-in was found")?;
        let email = antigravity_login()
            .email
            .ok_or("could not read the signed-in Antigravity email from its CLI log")?;
        save_agy_account(&sign_in, email)
    }
}

/// Puts agy's previous sign-in back unless the new one was completed. "Sign in another account" clears agy's shared
/// sign-in first; a cancel (the task is dropped), a timeout or a closed console must not leave agy signed out.
#[cfg(windows)]
struct RestoreSignIn {
    previous: Option<Value>,
    armed: bool,
}

#[cfg(windows)]
impl Drop for RestoreSignIn {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Some(previous) = &self.previous {
            if let Ok(text) = serde_json::to_string(previous) {
                let _ = write_secret("gemini:antigravity", &text);
            }
        }
    }
}

/// Saves the current credential before clearing the shared sign-in, then waits for the desktop app to finish OAuth.
pub(crate) async fn antigravity_sign_in_another_account() -> Result<(), String> {
    #[cfg(not(windows))]
    return Err(
        "Antigravity account sign-in currently requires Windows Credential Manager".to_string(),
    );

    #[cfg(windows)]
    {
        let previous = agy_sign_in();
        if let Some(sign_in) = previous.as_ref() {
            let email = if let Some(email) = agy_saved_active_email() {
                email
            } else {
                refresh_antigravity_cli_email(std::time::SystemTime::now()).await?
            };
            save_agy_account(sign_in, email)?;
        }

        let agy = which("agy").ok_or("Antigravity CLI is not installed")?;
        let token_file = crate::home_folder()?
            .join(".gemini")
            .join("jetski-standalone-oauth-token");
        if token_file.exists() {
            std::fs::remove_file(&token_file).map_err(|error| {
                format!("could not clear the old Antigravity sign-in file: {error}")
            })?;
        }
        let mut restore = RestoreSignIn {
            previous: previous.clone(),
            armed: true,
        };
        delete_secret("gemini:antigravity")?;

        // `agy` owns the CLI sign-in flow. A fresh console gives its TUI a real terminal and lets
        // Google Sign-In open the browser; launching Antigravity.exe here skips the CLI auth log.
        let login_started_at = std::time::SystemTime::now();
        let mut cli = Command::new(&agy);
        cli.stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        cli.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE
        let child = cli
            .spawn()
            .map_err(|error| format!("could not start Antigravity CLI: {error}"))?;
        let mut child = CancellableChild {
            child,
            kill_on_drop: true,
        };

        let timeout = tokio::time::Instant::now() + Duration::from_secs(300);
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if let Some(current) = agy_sign_in() {
                let has_access_token = current["token"]["access_token"]
                    .as_str()
                    .is_some_and(|token| !token.is_empty());
                if has_access_token && previous.as_ref() != Some(&current) {
                    let email = if let Some(email) = antigravity_email_since(login_started_at) {
                        email
                    } else {
                        refresh_antigravity_cli_email(login_started_at).await?
                    };
                    save_agy_account(&current, email)?;
                    // The new sign-in stays: nothing to put back.
                    restore.armed = false;
                    // Leave the authenticated CLI available in its terminal, but stop treating it
                    // as part of the cancellable sign-in task.
                    child.kill_on_drop = false;
                    return Ok(());
                }
            }
            if let Some(status) = child
                .child
                .try_wait()
                .map_err(|error| format!("could not check Antigravity CLI: {error}"))?
            {
                return Err(format!(
                    "Antigravity CLI exited before sign-in completed ({status})"
                ));
            }
            if tokio::time::Instant::now() >= timeout {
                return Err("timed out waiting for Antigravity CLI sign-in".to_string());
            }
        }
    }
}

/// Saves an Antigravity credential under its account-specific Windows Credential Manager target.
#[cfg(windows)]
fn save_agy_account(sign_in: &Value, email: String) -> Result<(), String> {
    if sign_in["token"]["access_token"]
        .as_str()
        .is_none_or(str::is_empty)
    {
        return Err("the current Antigravity login has no access token".to_string());
    }
    let serialized = serde_json::to_string(sign_in).map_err(|error| error.to_string())?;
    write_secret(&agy_secret_target(&email), &serialized)?;
    let mut accounts = read_agy_accounts();
    if let Some(account) = accounts.iter_mut().find(|account| account.email == email) {
        account.active = true;
    } else {
        accounts.push(AgyAccount {
            id: email.clone(),
            email,
            active: true,
            expired: false,
            status: None,
        });
    }
    write_agy_accounts(&accounts)
}

/// Makes a previously saved Antigravity account the active login used by agy and quota refresh.
pub async fn antigravity_account_switch(id: String) -> Result<(), String> {
    #[cfg(not(windows))]
    return Err(
        "Antigravity account switching currently requires Windows Credential Manager".to_string(),
    );

    #[cfg(windows)]
    {
        let id = safe_arg(&id)?;
        let account = read_agy_accounts()
            .into_iter()
            .find(|account| account.id == id)
            .ok_or("Antigravity account was not found")?;
        let secret = stored_secret(&agy_secret_target(&account.email))
            .ok_or("saved Antigravity credentials are missing")?;
        let sign_in: Value = serde_json::from_str(&secret)
            .map_err(|_| "saved Antigravity credentials are invalid")?;
        // Checked against Antigravity's servers only when there is no refresh token to fall back on: an access token
        // that ran out is renewed by agy on its next run, so it is no reason to refuse the switch.
        let renewable = sign_in["token"]["refresh_token"]
            .as_str()
            .is_some_and(|token| !token.is_empty());
        if !renewable {
            fetch_agy_summary(&sign_in).await?;
        }
        // The account being left keeps its newest token.
        let _ = agy_saved_active_email();
        write_secret("gemini:antigravity", &secret)?;
        let mut accounts = read_agy_accounts();
        for saved in &mut accounts {
            saved.active = saved.id == id;
        }
        write_agy_accounts(&accounts)
    }
}

/// The quota as Antigravity's own servers say it now: the buckets (`<model group>-<window>`, e.g. `gemini-5h`) with the
/// fraction left and when each resets. Uses the access token agy already holds; it is not renewed here, so one that ran
/// out is reported, and agy renews it the next time it runs.
async fn fetch_agy_summary(sign_in: &Value) -> Result<(i64, Value), String> {
    let token = &sign_in["token"];
    let access = token["access_token"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("the Antigravity sign-in has no access token")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64);
    if token["expiry"]
        .as_str()
        .and_then(parse_iso)
        .is_some_and(|expiry| expiry <= now + 30)
    {
        return Err("the Antigravity sign-in has expired: run agy once to renew it".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let mut urls = Vec::with_capacity(1 + ENDPOINTS.antigravity.quota_fallbacks.len());
    urls.push(ENDPOINTS.antigravity.quota.as_str());
    urls.extend(
        ENDPOINTS
            .antigravity
            .quota_fallbacks
            .iter()
            .map(String::as_str),
    );
    let mut best: Option<(usize, Value)> = None;
    let mut last_error = None;
    for url in urls {
        let response = match client
            .post(url)
            .bearer_auth(access)
            .header(
                reqwest::header::USER_AGENT,
                "antigravity/2.25.0 (aidev_client; os_type=windows; arch=amd64; cl=1003475615)",
            )
            .json(&serde_json::json!({}))
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        if !response.status().is_success() {
            last_error = Some(format!(
                "Antigravity's servers answered {}",
                response.status()
            ));
            continue;
        }
        let summary: Value = match response.json().await {
            Ok(summary) => summary,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        let bucket_count = summary["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|group| group["buckets"].as_array().into_iter().flatten())
            .filter(|bucket| {
                bucket["bucketId"].as_str().is_some()
                    && bucket["remainingFraction"].as_f64().is_some()
            })
            .count();
        let has_gemini = summary["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|group| group["buckets"].as_array().into_iter().flatten())
            .any(|bucket| {
                bucket["bucketId"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("gemini-"))
            });
        let has_third_party = summary["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|group| group["buckets"].as_array().into_iter().flatten())
            .any(|bucket| {
                bucket["bucketId"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("3p-"))
            });
        // A complete summary contains both shared pools. A partial 200 response must not stop the
        // search because the daily endpoint has been observed to omit the Gemini group.
        if has_gemini && has_third_party {
            return Ok((now, summary));
        }
        if best
            .as_ref()
            .is_none_or(|(best_count, _)| bucket_count > *best_count)
        {
            best = Some((bucket_count, summary));
        }
    }
    match best {
        Some((count, summary)) if count > 0 => Ok((now, summary)),
        _ => {
            Err(last_error
                .unwrap_or_else(|| "Antigravity's servers sent no quota buckets".to_string()))
        }
    }
}

async fn fetch_agy_quota_for_sign_in(sign_in: &Value) -> Result<AgyQuota, String> {
    let (now, summary) = fetch_agy_summary(sign_in).await?;
    let mut quota = serde_json::Map::new();
    for group in summary["groups"].as_array().into_iter().flatten() {
        for bucket in group["buckets"].as_array().into_iter().flatten() {
            let (Some(id), Some(fraction)) = (
                bucket["bucketId"].as_str(),
                bucket["remainingFraction"].as_f64(),
            ) else {
                continue;
            };
            if !id.contains('-') {
                continue;
            }
            quota.insert(id.to_string(), serde_json::json!({ "remaining_fraction": fraction, "reset_time": bucket["resetTime"] }));
        }
    }
    let figures = serde_json::json!({ "fetchedAt": now * 1000, "quota": quota });
    parse_agy_quota(&figures.to_string())
        .filter(|found| !found.groups.is_empty())
        .ok_or_else(|| "Antigravity's servers sent no quota buckets".to_string())
}

async fn fetch_agy_quota() -> Result<AgyQuota, String> {
    let sign_in = agy_sign_in().ok_or("no Antigravity sign-in was found on this machine")?;
    fetch_agy_quota_for_sign_in(&sign_in).await
}

/// The quota of Antigravity: live from its servers; when that is not possible (no sign-in, an expired one, no network),
/// the figures agy last saved to a file, which carry their own time.
pub async fn antigravity_quota() -> Option<AgyQuota> {
    match fetch_agy_quota().await {
        Ok(live) => Some(live),
        Err(error) => {
            tracing_note(&error);
            saved_agy_quota()
        }
    }
}

/// One saved Antigravity account and its own quota. `error` says why there is none (no saved sign-in, or one whose access
/// token ran out: agy renews it on its next run).
#[derive(Serialize, Debug, Clone)]
pub struct AgyAccountQuota {
    id: String,
    email: String,
    active: bool,
    quota: Option<AgyQuota>,
    error: Option<String>,
}

/// The quota of every saved Antigravity account, each read with its own sign-in. Accounts are read at the same time,
/// and the result is shared for 20 s: the composer, the account menu and Settings all ask for it, and one refresh
/// should not run three rounds of credential-store and network reads.
pub async fn antigravity_quotas(
    force: Option<bool>,
    account_id: Option<String>,
) -> Vec<AgyAccountQuota> {
    type AgyQuotaCache = Option<(std::time::Instant, Vec<AgyAccountQuota>)>;
    static CACHE: LazyLock<tokio::sync::Mutex<AgyQuotaCache>> =
        LazyLock::new(|| tokio::sync::Mutex::new(None));
    let mut cache = CACHE.lock().await;
    if account_id.is_none() && !force.unwrap_or(false) {
        if let Some((at, rows)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(20) {
                return rows.clone();
            }
        }
    }
    let rows = read_agy_quotas(account_id.as_deref()).await;
    if account_id.is_none() {
        *cache = Some((std::time::Instant::now(), rows.clone()));
    }
    rows
}

/// The live quota of each saved account. The account in use is read with agy's own current sign-in (the saved copy may
/// be an hour old); the others with the credential saved for them. No CLI runs and no adoption is attempted here, so a
/// refresh is a few parallel requests instead of a scan of the CLI logs.
async fn read_agy_quotas(account_id: Option<&str>) -> Vec<AgyAccountQuota> {
    #[cfg(windows)]
    let active = agy_saved_active_email().or_else(|| antigravity_login().email);
    #[cfg(not(windows))]
    let active: Option<String> = None;
    let accounts = read_agy_accounts()
        .into_iter()
        .filter(|account| account_id.is_none_or(|requested| requested == account.id));
    let reads = accounts.into_iter().map(|account| {
        let active = active.clone();
        async move {
            let is_active = active.as_deref() == Some(account.email.as_str()) || account.active;
            #[cfg(windows)]
            let sign_in = if is_active {
                agy_sign_in().or_else(|| {
                    stored_secret(&agy_secret_target(&account.email))
                        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                })
            } else {
                stored_secret(&agy_secret_target(&account.email))
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            };
            #[cfg(not(windows))]
            let sign_in: Option<Value> = None;
            let (quota, error) = match sign_in {
                None => (None, Some("Saved credentials are missing".to_string())),
                Some(sign_in) => match fetch_agy_quota_for_sign_in(&sign_in).await {
                    Ok(quota) => (Some(quota), None),
                    Err(error) => (None, Some(error)),
                },
            };
            AgyAccountQuota {
                id: account.id,
                email: account.email,
                active: is_active,
                quota,
                error,
            }
        }
    });
    futures_util::future::join_all(reads).await
}

// ---------------------------------------------------------------------------------------------------------------
// Antigravity permission modes and account removal

/// agy prints this and carries on in its default mode when the account may not use `--mode <name>`.
pub(crate) fn mode_unavailable(output: &str) -> bool {
    output.contains("is not available for this account")
}

#[derive(Serialize, Debug, Default, PartialEq)]
pub struct AgyModes {
    /// `--mode` values the account cannot use (`auto`, `accept-edits`, `plan`). Empty: all work, or it could not be told.
    unavailable: Vec<String>,
}

/// Which of agy's `--mode` values this account can use. agy only says so when it starts a turn, so each mode is tried
/// once with a one-word prompt that is cut after 3 seconds; the answer is kept per agy version in
/// `~/.agentdeck/agy-modes.json`, so it is asked again only after an update (or with `force`).
pub async fn agy_modes(force: bool) -> AgyModes {
    let Some(agy) = which("agy") else {
        return AgyModes::default();
    };
    let version = version_of(&agy).await.unwrap_or_default();
    let cache = crate::home_folder().ok().map(|home| {
        home.join(crate::channel::home_folder_name())
            .join("agy-modes.json")
    });
    if !force {
        let saved = cache
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        if let Some(saved) =
            saved.filter(|saved| saved["version"].as_str() == Some(version.as_str()))
        {
            let unavailable = saved["unavailable"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            return AgyModes { unavailable };
        }
    }
    let probe = |mode: &'static str| {
        let agy = agy.clone();
        async move {
            let args = [
                "-p",
                ".",
                "--mode",
                mode,
                "--print-timeout",
                "3s",
                "--output-format",
                "text",
            ];
            match capture(&agy, &args, Duration::from_secs(30)).await {
                Ok(out) if mode_unavailable(&format!("{}{}", out.stdout, out.stderr)) => {
                    Some(mode.to_owned())
                }
                _ => None,
            }
        }
    };
    let (auto, edits, plan) = tokio::join!(probe("auto"), probe("accept-edits"), probe("plan"));
    let unavailable: Vec<String> = [auto, edits, plan].into_iter().flatten().collect();
    if let Some(path) = cache {
        if let Some(folder) = path.parent() {
            let _ = std::fs::create_dir_all(folder);
        }
        let _ = std::fs::write(
            path,
            serde_json::json!({ "version": version, "unavailable": unavailable }).to_string(),
        );
    }
    AgyModes { unavailable }
}

/// Removes one saved Antigravity account: its index entry and its credential in the system store. The account in
/// use cannot be removed (switch to another account first), so agy is never left pointing at a deleted login.
pub async fn antigravity_account_remove(id: String) -> Result<(), String> {
    #[cfg(not(windows))]
    return Err(
        "Antigravity account removal currently requires Windows Credential Manager".to_string(),
    );

    #[cfg(windows)]
    {
        let id = safe_arg(&id)?;
        let accounts = read_agy_accounts();
        let account = accounts
            .iter()
            .find(|account| account.id == id)
            .ok_or("Antigravity account was not found")?;
        let active = agy_saved_active_email().or_else(|| antigravity_login().email);
        if active.as_deref() == Some(account.email.as_str()) || account.active {
            return Err(
                "This Antigravity account is in use: switch to another account before removing it"
                    .to_string(),
            );
        }
        let email = account.email.clone();
        let kept: Vec<AgyAccount> = accounts
            .into_iter()
            .filter(|saved| saved.id != id)
            .collect();
        write_agy_accounts(&kept)?;
        delete_secret(&agy_secret_target(&email))?;
        Ok(())
    }
}

fn tracing_note(error: &str) {
    eprintln!("antigravity quota: {error}");
}
