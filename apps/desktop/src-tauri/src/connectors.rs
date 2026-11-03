//! Settings → Connectors: finds the agent CLIs on this machine, installs and signs them in, and switches between
//! the accounts each one has been signed in with.
//!
//! Account switching is done by two existing tools instead of our own credential juggling:
//! - Codex: `codex-auth` (`@loongphy/codex-auth`). Its `~/.codex/accounts/registry.json` is read directly (it holds
//!   no tokens); only changes go through the CLI.
//! - Claude Code: `cswap` (`claude-swap`, installed with `uv tool`). Its `--json` output is parsed.
//!
//! Provider account tokens stay in their existing credential stores. Antigravity account snapshots use Windows
//! Credential Manager; the on-disk account index contains emails only. External commands run without a shell.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::endpoints::ENDPOINTS;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

#[path = "connectors/antigravity.rs"]
pub(crate) mod antigravity;
#[path = "connectors/claude.rs"]
pub(crate) mod claude;
#[path = "connectors/codex.rs"]
pub(crate) mod codex;
#[path = "connectors/commandcode.rs"]
pub(crate) mod commandcode;
#[path = "connectors/copilot.rs"]
pub(crate) mod copilot;
#[path = "connectors/github.rs"]
pub(crate) mod github;
#[path = "connectors/muse_code.rs"]
pub(crate) mod muse_code;
#[path = "connectors/opencode.rs"]
pub(crate) mod opencode;
#[path = "connectors/providers.rs"]
pub(crate) mod providers;
#[path = "connectors/runtime.rs"]
pub(crate) mod runtime;
#[path = "connectors/secrets.rs"]
pub(crate) mod secrets;
#[path = "connectors/workbuddy.rs"]
pub(crate) mod workbuddy;

pub(crate) use antigravity::{
    agy_saved_active_email, agy_sign_in, antigravity_sign_in_another_account,
};
#[cfg(test)]
pub(crate) use antigravity::{mode_unavailable, parse_agy_quota};
pub(crate) use claude::{parse_cswap, ConsoleCredit};
pub(crate) use codex::{
    fetch_reset_credits as fetch_codex_reset_credits, fetch_usage as fetch_codex_usage,
    parse_registry as parse_codex_registry,
};
#[cfg(test)]
pub(crate) use copilot::parse_usage as parse_copilot_usage;
pub(crate) use copilot::usage as copilot_usage;
pub(crate) use providers::{capture_rate_limits, ProviderQuota};

#[cfg(test)]
pub(crate) use crate::providers::custom::{models_url, parse_models};
pub(crate) use runtime::{
    account_tool_allows, capture, command, version_of, which, Captured, KillTree,
};
pub(crate) use secrets::{delete_secret, stored_secret, write_secret};

/// Keep the Tauri command symbols in this facade while the credential-store implementation lives in `secrets.rs`.
#[tauri::command]
pub fn secret_save(target: String, value: String) -> Result<(), String> {
    secrets::secret_save(target, value)
}

#[tauri::command]
pub fn secret_load(target: String) -> Option<String> {
    secrets::secret_load(target)
}

#[tauri::command]
pub fn secret_delete(target: String) -> Result<(), String> {
    secrets::secret_delete(target)
}

/// Keep the Tauri command symbol in this facade while Codex's reset-credit implementation lives in `codex.rs`.
#[tauri::command]
pub async fn codex_consume_reset_credit(email: String) -> Result<(), String> {
    codex::consume_reset_credit(email).await
}

/// Keep the Tauri command symbol in this facade while Claude's Console implementation lives in `claude.rs`.
#[tauri::command]
pub async fn claude_console_credit(session_key: String) -> Result<ConsoleCredit, String> {
    claude::console_credit(session_key).await
}

/// Keep the Tauri command symbol in this facade while custom provider probing lives in `providers.rs`.
#[tauri::command]
pub async fn provider_probe(
    kind: String,
    base_url: String,
    api_key: Option<String>,
    key_env: Option<String>,
) -> crate::providers::custom::Probe {
    providers::probe(kind, base_url, api_key, key_env).await
}

/// Keep the Tauri command symbol in this facade while provider quota sources live in `providers.rs`.
#[tauri::command]
pub async fn provider_quota(
    base_url: String,
    api_key: Option<String>,
    key_env: Option<String>,
) -> Option<ProviderQuota> {
    providers::quota(base_url, api_key, key_env).await
}

/// Keep the Tauri command symbol in this facade while OpenCode Go usage lives in `opencode.rs`.
#[tauri::command]
pub async fn opencode_quota() -> opencode::OpenCodeQuota {
    opencode::quota().await
}

/// Keep the Tauri command symbols in this facade while Antigravity account and quota logic lives in `antigravity.rs`.
#[tauri::command]
pub async fn antigravity_quota() -> Option<antigravity::AgyQuota> {
    antigravity::antigravity_quota().await
}

#[tauri::command]
pub fn antigravity_quota_cached() -> Option<antigravity::AgyQuota> {
    antigravity::antigravity_quota_cached()
}

#[tauri::command]
pub async fn antigravity_quotas(
    force: Option<bool>,
    account_id: Option<String>,
) -> Vec<antigravity::AgyAccountQuota> {
    antigravity::antigravity_quotas(force, account_id).await
}

#[tauri::command]
pub async fn antigravity_accounts_list() -> Vec<antigravity::AgyAccount> {
    antigravity::antigravity_accounts_list().await
}

#[tauri::command]
pub async fn antigravity_account_adopt() -> Result<(), String> {
    antigravity::antigravity_account_adopt().await
}

#[tauri::command]
pub async fn antigravity_account_switch(id: String) -> Result<(), String> {
    antigravity::antigravity_account_switch(id).await
}

#[tauri::command]
pub async fn agy_modes(force: bool) -> antigravity::AgyModes {
    antigravity::agy_modes(force).await
}

#[tauri::command]
pub async fn antigravity_account_remove(id: String) -> Result<(), String> {
    antigravity::antigravity_account_remove(id).await
}

struct LoginTask {
    generation: u64,
    abort: tokio::task::AbortHandle,
}

#[cfg(windows)]
struct CancellableChild {
    child: tokio::process::Child,
    kill_on_drop: bool,
}

#[cfg(windows)]
impl Drop for CancellableChild {
    fn drop(&mut self) {
        if self.kill_on_drop {
            let _ = self.child.start_kill();
        }
    }
}

static LOGIN_TASKS: LazyLock<Mutex<HashMap<String, LoginTask>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static LOGIN_GENERATION: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------------------------------------------
// Process and executable helpers live in connectors/runtime.rs.\n\n/// A line of an install or sign-in that is running, for the log under the button.
#[derive(Clone, Serialize)]
struct LogLine {
    id: String,
    line: String,
}

async fn pump<R: AsyncRead + Unpin>(
    app: AppHandle,
    id: String,
    stream: R,
    activity: Option<tokio::sync::mpsc::UnboundedSender<()>>,
) {
    let mut lines = BufReader::new(stream).lines();
    let mut opened = false;
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim_end().to_owned();
        if !line.is_empty() {
            if let Some(activity) = &activity {
                let _ = activity.send(());
            }
            // Claude Code says it opens the browser, but started without a console on Windows it does not: the address it
            // prints is opened here, once.
            if cfg!(windows) && id == "claude" && !opened {
                if let Some(url) = sign_in_address(&line) {
                    opened = true;
                    let _ = crate::browser::open_external(url);
                }
            }
            let _ = app.emit(
                "connector-log",
                LogLine {
                    id: id.clone(),
                    line,
                },
            );
        }
    }
}

/// The OAuth page address a sign-in CLI printed in `line`, if it is there.
fn sign_in_address(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let url: String = line[start..]
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    (url.contains("/oauth/authorize")).then_some(url)
}

/// Runs a command to its end, sending each output line to the UI as `connector-log`.
async fn run_logged(
    app: &AppHandle,
    id: &str,
    program: &Path,
    args: &[&str],
    limit: Duration,
) -> Result<(), String> {
    run_logged_with_idle_timeout(app, id, program, args, limit, None, None).await
}

/// Runs an interactive login CLI with an optional output-idle timeout, so a closed auth page cannot leave the UI
/// waiting forever for a callback that will never arrive.
async fn run_logged_with_idle_timeout(
    app: &AppHandle,
    id: &str,
    program: &Path,
    args: &[&str],
    limit: Duration,
    idle_limit: Option<Duration>,
    auth_watch_provider: Option<&str>,
) -> Result<(), String> {
    account_tool_allows(program, args)?;
    let initial_auth = match auth_watch_provider {
        Some(provider) => Some(login_status(provider).await),
        None => None,
    };
    let _ = app.emit(
        "connector-log",
        LogLine {
            id: id.to_owned(),
            line: format!(
                "$ {} {}",
                program
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                args.join(" ")
            ),
        },
    );
    let mut command = command(program);
    // Aborting sign-in (or timing out after the browser is closed) must not leave the CLI
    // waiting for an OAuth callback in the background.
    command.kill_on_drop(true);
    let mut child = command
        .args(args)
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", program.display()))?;
    let (activity_tx, mut activity_rx) = tokio::sync::mpsc::unbounded_channel();
    let out = child.stdout.take().map(|stream| {
        tauri::async_runtime::spawn(pump(
            app.clone(),
            id.to_owned(),
            stream,
            idle_limit.map(|_| activity_tx.clone()),
        ))
    });
    let err = child.stderr.take().map(|stream| {
        tauri::async_runtime::spawn(pump(
            app.clone(),
            id.to_owned(),
            stream,
            idle_limit.map(|_| activity_tx.clone()),
        ))
    });
    drop(activity_tx);
    let mut auth_completed = false;
    let status: Result<std::process::ExitStatus, String> = if let Some(idle_limit) = idle_limit {
        let deadline = tokio::time::Instant::now() + limit;
        let mut idle_deadline = tokio::time::Instant::now() + idle_limit;
        let mut auth_check_at = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            tokio::select! {
                status = child.wait() => break status.map_err(|error| error.to_string()),
                _ = tokio::time::sleep_until(idle_deadline.min(deadline)) => {
                    if tokio::time::Instant::now() >= deadline {
                        break Err(format!("timed out after {} minutes", limit.as_secs() / 60));
                    }
                    break Err(format!("sign-in stopped responding for {} seconds; it was cancelled", idle_limit.as_secs()));
                }
                Some(()) = activity_rx.recv() => {
                    idle_deadline = tokio::time::Instant::now() + idle_limit;
                }
                _ = tokio::time::sleep_until(auth_check_at), if auth_watch_provider.is_some() => {
                    auth_check_at = tokio::time::Instant::now() + Duration::from_secs(2);
                    if let (Some(provider), Some(initial)) = (auth_watch_provider, initial_auth.as_ref()) {
                        let current = login_status(provider).await;
                        if authenticated_since(initial, &current) {
                            auth_completed = true;
                            let _ = child.start_kill();
                            break Err("sign-in completed".to_string());
                        }
                    }
                }
            }
        }
    } else {
        tokio::time::timeout(limit, child.wait())
            .await
            .map_err(|_| format!("timed out after {} minutes", limit.as_secs() / 60))?
            .map_err(|error| error.to_string())
    };
    if status.is_err() {
        let _ = child.start_kill();
    }
    for mut task in [out, err].into_iter().flatten() {
        if tokio::time::timeout(Duration::from_secs(2), &mut task)
            .await
            .is_err()
        {
            // A CLI-launched child may inherit the pipe handles even after the CLI exits.
            // Never let its detached output reader keep the sign-in spinner alive.
            task.abort();
        }
    }
    if auth_completed {
        return Ok(());
    }
    let status = status?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("exited with {status}"))
    }
}

/// Reads provider auth status without loading usage data, for noticing OAuth success while its CLI is still waiting.
async fn login_status(provider: &str) -> Login {
    match provider {
        "claude" => match which("claude") {
            Some(claude) => {
                match capture(&claude, &["auth", "status"], Duration::from_secs(5)).await {
                    Ok(output) => claude_login(&output.stdout),
                    Err(_) => Login::default(),
                }
            }
            None => Login::default(),
        },
        "codex" => codex_login(),
        "copilot" => github::login().await,
        "opencode" => opencode::login_status().await,
        "command-code" => commandcode::login_status().await,
        "workbuddy" => workbuddy::login_status(),
        "muse-code" => muse_code::login_status(),
        _ => Login::default(),
    }
}

/// Only ends an active login early when credentials become available or the signed-in identity changes.
fn authenticated_since(before: &Login, after: &Login) -> bool {
    after.logged_in == Some(true)
        && (before.logged_in != Some(true)
            || before.email != after.email
            || before.plan != after.plan)
}

// ---------------------------------------------------------------------------------------------------------------
// What is installed and who is signed in

#[derive(Serialize)]
pub struct Tool {
    id: &'static str,
    path: Option<String>,
    version: Option<String>,
}

#[derive(Clone, Serialize, Default)]
pub struct Login {
    /// `None` when AgentDeck cannot tell (Antigravity has no status command).
    logged_in: Option<bool>,
    email: Option<String>,
    plan: Option<String>,
    detail: Option<String>,
}

#[derive(Serialize)]
pub struct Detected {
    tools: Vec<Tool>,
    claude: Login,
    codex: Login,
    antigravity: Login,
    opencode: Login,
    copilot: Login,
    workbuddy: Login,
    muse_code: Login,
    command_code: Login,
}

#[tauri::command]
pub async fn workbuddy_models() -> Result<Vec<String>, String> {
    workbuddy::models().await
}

pub async fn workbuddy_model_infos() -> Result<Vec<ag_adapters::models::ModelInfo>, String> {
    workbuddy::model_infos().await
}

#[tauri::command]
pub async fn workbuddy_image_models() -> Result<Vec<String>, String> {
    workbuddy::image_models().await
}

pub(crate) async fn workbuddy_image(
    model: &str,
    prompt: &str,
    references: Vec<String>,
) -> Result<serde_json::Value, String> {
    workbuddy::image_generate(model, prompt, references).await
}

#[tauri::command]
pub async fn muse_code_models() -> Result<Vec<String>, String> {
    muse_code::models().await
}

#[tauri::command]
pub fn connector_logout(id: String) -> Result<(), String> {
    match id.as_str() {
        "workbuddy" => workbuddy::logout(),
        "muse-code" => muse_code::logout(),
        _ => Err("this connector does not have a native logout flow".to_string()),
    }
}

const TOOLS: [&str; 12] = [
    "claude",
    "codex",
    "agy",
    "opencode",
    "copilot",
    "codex-auth",
    "cswap",
    "uv",
    "npm",
    "gh",
    "codebuddy",
    "command-code",
];

pub(crate) fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| crate::home_folder().ok().map(|home| home.join(".codex")))
        .unwrap_or_default()
}

fn claude_login(status: &str) -> Login {
    let Ok(json) = serde_json::from_str::<Value>(status) else {
        return Login {
            logged_in: Some(false),
            ..Login::default()
        };
    };
    let text = |key: &str| {
        json[key]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    Login {
        logged_in: Some(json["loggedIn"].as_bool().unwrap_or(false)),
        email: text("email"),
        plan: text("subscriptionType"),
        detail: text("orgName").or_else(|| text("authMethod")),
    }
}

fn codex_login() -> Login {
    let home = codex_home();
    if let Some(account) = read_codex_registry(&home)
        .ok()
        .and_then(|(accounts, _)| accounts.into_iter().find(|a| a.active))
    {
        return Login {
            logged_in: Some(true),
            email: Some(account.email),
            plan: account.plan,
            detail: None,
        };
    }
    Login {
        logged_in: Some(home.join("auth.json").is_file()),
        ..Login::default()
    }
}

/// Antigravity has no status command and keeps its login in the OS credential store, so the state is read from its
/// own log: the later of "You are not logged into Antigravity" and "Experiments refreshed after login" wins.
fn antigravity_state(log_tail: &str) -> Option<bool> {
    let out = log_tail.rfind("You are not logged into Antigravity");
    let inn = log_tail.rfind("refreshed after login");
    match (inn, out) {
        (Some(inn), Some(out)) => Some(inn > out),
        (Some(_), None) => Some(true),
        (None, Some(_)) => Some(false),
        (None, None) => None,
    }
}

/// The last `authenticated successfully as <email>` in a log.
fn antigravity_email(log_tail: &str) -> Option<String> {
    const MARK: &str = "authenticated successfully as ";
    let rest = &log_tail[log_tail.rfind(MARK)? + MARK.len()..];
    let email: String = rest
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != ',')
        .collect();
    email.contains('@').then_some(email)
}

/// Reads the account identity from CLI logs written on or after `since`.
fn antigravity_email_since(since: std::time::SystemTime) -> Option<String> {
    let folder = crate::home_folder()
        .ok()?
        .join(".gemini")
        .join("antigravity-cli")
        .join("log");
    let mut logs: Vec<_> = std::fs::read_dir(folder)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("cli-"))
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            (modified >= since).then_some((modified, entry.path()))
        })
        .collect();
    logs.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    logs.into_iter()
        .find_map(|(_, path)| antigravity_email(&tail_of(&path)))
}

/// Runs a quiet CLI model-list request so `agy` records which account owns the current credential.
async fn refresh_antigravity_cli_email(since: std::time::SystemTime) -> Result<String, String> {
    let agy = which("agy").ok_or("Antigravity CLI is not installed")?;
    let result = capture(&agy, &["models"], Duration::from_secs(30)).await?;
    antigravity_email_since(since).ok_or_else(|| {
        if result.ok {
            "the Antigravity CLI did not report the signed-in account email".to_string()
        } else {
            "the Antigravity CLI could not verify the signed-in account".to_string()
        }
    })
}

fn tail_of(path: &Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let length = file.metadata().map_or(0, |meta| meta.len());
    let _ = file.seek(SeekFrom::Start(length.saturating_sub(512 * 1024)));
    let mut bytes = Vec::new();
    let _ = file.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn antigravity_login() -> Login {
    let Ok(home) = crate::home_folder() else {
        return Login::default();
    };
    let folder = home.join(".gemini").join("antigravity-cli").join("log");
    let mut logs: Vec<_> = std::fs::read_dir(folder)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("cli-"))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    logs.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    let credential_present = agy_sign_in().is_some();
    let Some((_, newest)) = logs.first() else {
        return Login {
            logged_in: credential_present.then_some(true),
            email: agy_saved_active_email(),
            ..Login::default()
        };
    };
    // The current OAuth credential is authoritative; CLI logs can lag behind a successful sign-in.
    let logged_in = credential_present
        .then_some(true)
        .or_else(|| antigravity_state(&tail_of(newest)));
    // The sign-in line is written once per sign-in, so it may sit in an older log.
    let email = agy_saved_active_email().or_else(|| {
        logs.iter()
            .take(8)
            .find_map(|(_, path)| antigravity_email(&tail_of(path)))
    });
    Login {
        logged_in,
        email,
        ..Login::default()
    }
}

fn detect_selected(only: Option<&str>, id: &str) -> bool {
    only.is_none() || only == Some(id)
}

fn detect_tools(only: Option<&str>) -> Vec<&'static str> {
    match only {
        None => TOOLS.to_vec(),
        Some("claude") => vec!["claude", "cswap"],
        Some("codex") => vec!["codex", "codex-auth"],
        Some("agy") => vec!["agy"],
        Some("opencode") => vec!["opencode"],
        Some("command-code") => vec!["command-code"],
        Some("copilot") => vec!["copilot", "gh"],
        Some("workbuddy") => vec!["codebuddy"],
        Some("muse-code") => Vec::new(),
        Some(_) => Vec::new(),
    }
}

/// Prefer the Claude Code binary resolved for the desktop app, then search the inherited PATH.
fn claude_binary() -> Option<PathBuf> {
    std::env::var_os("AGENTDECK_CLAUDE_CODE_BINARY")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| which("claude"))
}

/// Which CLIs are installed (with versions) and whether each is signed in. Reads no tokens.
#[tauri::command]
pub async fn connectors_detect(only: Option<String>) -> Detected {
    let only = only.as_deref();
    let handles: Vec<_> = detect_tools(only)
        .into_iter()
        .map(|id| {
            tauri::async_runtime::spawn(async move {
                let found = if id == "claude" {
                    claude_binary()
                } else {
                    which(id)
                };
                let found = match found {
                    Some(path) => Some(path),
                    None if id == "codex" => npm_global_binary("codex").await,
                    None => None,
                };
                let version = match &found {
                    Some(path) => version_of(path).await,
                    None => None,
                };
                Tool {
                    id,
                    path: found.map(|path| path.to_string_lossy().into_owned()),
                    version,
                }
            })
        })
        .collect();
    let mut tools = Vec::new();
    for handle in handles {
        if let Ok(tool) = handle.await {
            tools.push(tool);
        }
    }
    for tool in &tools {
        crate::flow_log::note(
            "rust",
            "-",
            "connectors",
            &format!(
                "detect {} => {} (version {})",
                tool.id,
                tool.path.as_deref().unwrap_or("not found"),
                tool.version.as_deref().unwrap_or("-")
            ),
        );
    }
    let claude = if detect_selected(only, "claude") {
        match claude_binary() {
            Some(path) => {
                match capture(&path, &["auth", "status"], Duration::from_secs(10)).await {
                    Ok(out) => claude_login(&out.stdout),
                    Err(_) => Login::default(),
                }
            }
            None => Login::default(),
        }
    } else {
        Login::default()
    };
    let codex = detect_selected(only, "codex")
        .then(codex_login)
        .unwrap_or_default();
    let antigravity = detect_selected(only, "agy")
        .then(antigravity_login)
        .unwrap_or_default();
    let opencode = if detect_selected(only, "opencode") {
        opencode::login_status().await
    } else {
        Login::default()
    };
    let copilot = if detect_selected(only, "copilot") {
        github::login().await
    } else {
        Login::default()
    };
    let workbuddy = if detect_selected(only, "workbuddy") {
        workbuddy::login_status()
    } else {
        Login::default()
    };
    let command_code = if detect_selected(only, "command-code") {
        commandcode::login_status().await
    } else {
        Login::default()
    };
    let muse_code = if detect_selected(only, "muse-code") {
        muse_code::login_status()
    } else {
        Login::default()
    };
    Detected {
        tools,
        claude,
        codex,
        antigravity,
        opencode,
        copilot,
        workbuddy,
        muse_code,
        command_code,
    }
}

/// Finds an npm global executable when its configured prefix is outside the usual CLI search paths.
async fn npm_global_binary(name: &str) -> Option<PathBuf> {
    let npm = which("npm")?;
    let output = capture(&npm, &["config", "get", "prefix"], Duration::from_secs(5))
        .await
        .ok()?;
    if !output.ok {
        return None;
    }
    let prefix = PathBuf::from(output.stdout.trim());
    if prefix.as_os_str().is_empty() {
        return None;
    }
    let suffixes: &[&str] = if cfg!(windows) {
        &[".cmd", ".exe", ".bat"]
    } else {
        &[""]
    };
    [prefix.clone(), prefix.join("bin")]
        .into_iter()
        .flat_map(|directory| {
            suffixes
                .iter()
                .map(move |suffix| directory.join(format!("{name}{suffix}")))
        })
        .find(|path| path.is_file())
}

#[derive(Serialize)]
pub struct LatestVersion {
    id: &'static str,
    latest: Option<String>,
}

/// The newest npm release of each CLI and of the Claude Agent SDK. Read only: nothing is installed here.
#[tauri::command]
pub async fn connectors_latest_versions() -> Vec<LatestVersion> {
    const PACKAGES: [(&str, &str); 5] = [
        ("claude", "@anthropic-ai/claude-code"),
        ("codex", "@openai/codex"),
        ("opencode", "@opencode/cli"),
        ("workbuddy", "@tencent-ai/codebuddy-code"),
        ("claude-sdk", "@anthropic-ai/claude-agent-sdk"),
    ];
    let handles: Vec<_> = PACKAGES
        .into_iter()
        .map(|(id, package)| {
            tauri::async_runtime::spawn(async move {
                let latest = crate::store::maintenance::latest(package).await.ok();
                LatestVersion { id, latest }
            })
        })
        .collect();
    let mut rows = Vec::new();
    for handle in handles {
        if let Ok(row) = handle.await {
            rows.push(row);
        }
    }
    rows
}

/// Every executable named `name` along the search path, in order.
fn copies_of(name: &str) -> Vec<PathBuf> {
    let suffixes: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    let mut found: Vec<PathBuf> = Vec::new();
    for dir in ag_adapters::agent::runner::augmented_path()
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default()
    {
        for suffix in suffixes {
            let path = dir.join(format!("{name}{suffix}"));
            if path.is_file() && !found.contains(&path) {
                found.push(path);
            }
        }
    }
    found
}

/// Updates a CLI in the background. Skipped (`Ok(false)`) while a chat turn runs on it, so an update never ends a turn.
#[tauri::command]
pub async fn connector_update_idle(app: AppHandle, id: String) -> Result<bool, String> {
    if crate::agent_runs::agent_busy(&id) {
        return Ok(false);
    }
    // A pnpm and an npm copy of the same CLI: updating one leaves the other stale, so leave both alone.
    if copies_of(&id).len() > 1 {
        return Ok(false);
    }
    connector_install(app, id).await?;
    Ok(true)
}

// ---------------------------------------------------------------------------------------------------------------
// Install and sign in

/// Installs a CLI or one of the helper tools, logging to `connector-log`.
#[tauri::command]
pub async fn connector_install(app: AppHandle, id: String) -> Result<(), String> {
    let limit = Duration::from_secs(600);
    // Update where the CLI already lives (a pnpm-installed CLI stays with pnpm), so no second copy appears; a fresh
    // install uses pnpm when it is the user's global tool (PNPM_HOME), else npm.
    let node_tool = |package: &str| -> Result<(PathBuf, Vec<String>), String> {
        let pnpm_owned = match which(&id) {
            Some(existing) => existing.components().any(|part| {
                part.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("pnpm")
            }),
            None => std::env::var_os("PNPM_HOME").is_some(),
        };
        if let Some(pnpm) = which("pnpm").filter(|_| pnpm_owned) {
            Ok((pnpm, vec!["add".into(), "-g".into(), package.into()]))
        } else if let Some(npm) = which("npm") {
            Ok((npm, vec!["install".into(), "-g".into(), package.into()]))
        } else if let Some(pnpm) = which("pnpm") {
            Ok((pnpm, vec!["add".into(), "-g".into(), package.into()]))
        } else {
            Err("Node.js (npm) is needed for this: install it from nodejs.org first".to_string())
        }
    };
    let pnpm_tool = |package: &str| -> Result<(PathBuf, Vec<String>), String> {
        let pnpm = which("pnpm")
            .ok_or("pnpm is needed for this: install pnpm through Corepack or pnpm.io first")?;
        Ok((pnpm, vec!["add".into(), "-g".into(), package.into()]))
    };
    let (program, args): (PathBuf, Vec<String>) = match id.as_str() {
        "codex" => node_tool("@openai/codex")?,
        "opencode" => {
            // Its `opencode` command is the native binary that the package's postinstall script puts in place: without
            // this npm (11+) skips the script and leaves a command that does not exist.
            let (program, mut args) = node_tool("@opencode/cli")?;
            if args.first().is_some_and(|first| first == "install") {
                args.push("--allow-scripts=@opencode/cli".into());
            }
            (program, args)
        }
        // Pinned to the version that was read through (see `pins` in endpoints.json): a newer one is looked at before it is used.
        "codex-auth" => node_tool(&format!(
            "@loongphy/codex-auth@{}",
            ENDPOINTS.pins.codex_auth
        ))?,
        "cswap" => {
            let uv = which("uv")
                .ok_or("`uv` is needed for claude-swap: install it from docs.astral.sh/uv first")?;
            (
                uv,
                vec![
                    "tool".into(),
                    "install".into(),
                    format!("claude-swap=={}", ENDPOINTS.pins.claude_swap),
                ],
            )
        }
        "claude" => {
            // Anthropic's own installer script.
            if cfg!(windows) {
                let shell = which("pwsh")
                    .or_else(|| which("powershell"))
                    .ok_or("PowerShell was not found")?;
                (
                    shell,
                    vec![
                        "-NoProfile".into(),
                        "-ExecutionPolicy".into(),
                        "Bypass".into(),
                        "-Command".into(),
                        "irm https://claude.ai/install.ps1 | iex".into(),
                    ],
                )
            } else {
                let shell = which("bash").ok_or("bash was not found")?;
                (
                    shell,
                    vec![
                        "-c".into(),
                        "curl -fsSL https://claude.ai/install.sh | bash".into(),
                    ],
                )
            }
        }
        "agy" => {
            if cfg!(windows) {
                let shell = which("pwsh")
                    .or_else(|| which("powershell"))
                    .ok_or("PowerShell was not found")?;
                (
                    shell,
                    vec![
                        "-NoProfile".into(),
                        "-ExecutionPolicy".into(),
                        "Bypass".into(),
                        "-Command".into(),
                        "irm https://antigravity.google/cli/install.ps1 | iex".into(),
                    ],
                )
            } else {
                let shell = which("bash").ok_or("bash was not found")?;
                (
                    shell,
                    vec![
                        "-c".into(),
                        "curl -fsSL https://antigravity.google/cli/install.sh | bash".into(),
                    ],
                )
            }
        }
        // Pinned to the CLI version the SDK was built against (its `cli-version.txt`): the SDK speaks its protocol.
        "copilot" => node_tool(&format!("@github/copilot@{}", ENDPOINTS.pins.copilot))?,
        "workbuddy" => pnpm_tool("@tencent-ai/codebuddy-code")?,
        "command-code" => node_tool(&format!("command-code@{}", ENDPOINTS.pins.command_code))?,
        other => return Err(format!("do not know how to install `{other}`")),
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run_logged(&app, &id, &program, &args, limit).await
}

/// Opens the vendor's sign-in (a browser page) and waits for it to finish. Codex goes through `codex-auth login`
/// when it is installed, so the account is also added to its list.
#[tauri::command]
pub async fn connector_login(app: AppHandle, id: String) -> Result<(), String> {
    let id = normalize_connector_id(&id);
    let generation = LOGIN_GENERATION.fetch_add(1, Ordering::Relaxed);
    let task = {
        let mut tasks = LOGIN_TASKS
            .lock()
            .map_err(|_| "could not access connector sign-in state".to_string())?;
        // A sign-in still listed is one nobody is waiting for any more (its page was closed, or the window was reloaded while
        // the CLI waited for the browser). Signing in again ends it and starts over, instead of refusing until it times out.
        if let Some(old) = tasks.remove(&id) {
            old.abort.abort();
        }
        let task_id = id.clone();
        let task = tokio::spawn(async move { connector_login_inner(app, task_id).await });
        let abort = task.abort_handle();
        tasks.insert(id.clone(), LoginTask { generation, abort });
        task
    };

    let result = match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => Err("sign-in cancelled".to_string()),
        Err(error) => Err(format!("sign-in task failed: {error}")),
    };

    if let Ok(mut tasks) = LOGIN_TASKS.lock() {
        if tasks
            .get(&id)
            .is_some_and(|task| task.generation == generation)
        {
            tasks.remove(&id);
        }
    }
    result
}

fn normalize_connector_id(id: &str) -> String {
    id.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod login_tests {
    use super::normalize_connector_id;

    #[test]
    fn native_muse_code_id_is_normalized_before_dispatch() {
        assert_eq!(normalize_connector_id("  Muse-Code "), "muse-code");
    }
}

/// Cancels an in-progress connector sign-in and drops its child process.
#[tauri::command]
pub fn connector_login_cancel(id: String) -> Result<(), String> {
    let task = LOGIN_TASKS
        .lock()
        .map_err(|_| "could not access connector sign-in state".to_string())?
        .remove(&id);
    if let Some(task) = task {
        task.abort.abort();
    }
    Ok(())
}

async fn connector_login_inner(app: AppHandle, id: String) -> Result<(), String> {
    let limit = Duration::from_secs(300);
    let idle_limit = Some(Duration::from_secs(120));
    match id.as_str() {
        "workbuddy" => workbuddy::sign_in().await,
        "muse-code" => muse_code::sign_in().await,
        "claude" => {
            let claude = claude_binary().ok_or("Claude Code is not installed")?;
            run_logged_with_idle_timeout(
                &app,
                &id,
                &claude,
                &["auth", "login"],
                limit,
                idle_limit,
                Some("claude"),
            )
            .await
        }
        "copilot" => {
            let gh = which("gh").ok_or("GitHub CLI (`gh`) is not installed")?;
            let _auth_lock = github::AUTH_LOCK.lock().await;
            run_logged_with_idle_timeout(
                &app,
                &id,
                &gh,
                &["auth", "login", "--hostname", "github.com", "--web"],
                limit,
                idle_limit,
                Some("copilot"),
            )
            .await
        }
        "codex" => {
            let auth = which("codex-auth");
            let codex = match which("codex") {
                Some(path) => Some(path),
                None => npm_global_binary("codex").await,
            };
            match (auth, codex) {
                (Some(auth), _) => {
                    run_logged_with_idle_timeout(
                        &app,
                        &id,
                        &auth,
                        &["login"],
                        limit,
                        idle_limit,
                        Some("codex"),
                    )
                    .await
                }
                (None, Some(codex)) => {
                    run_logged_with_idle_timeout(
                        &app,
                        &id,
                        &codex,
                        &["login"],
                        limit,
                        idle_limit,
                        Some("codex"),
                    )
                    .await
                }
                (None, None) => Err("Codex is not installed".to_string()),
            }
        }
        "opencode" => {
            let opencode = which("opencode").ok_or("OpenCode is not installed")?;
            // AgentDeck has no interactive TTY. Passing the OpenAI integration skips OpenCode's provider picker, and
            // the method is named explicitly: without a TTY OpenCode refuses to choose one by itself ("Pass --method").
            run_logged(
                &app,
                &id,
                &opencode,
                &["auth", "login", "openai", "--method", "chatgpt-browser"],
                limit,
            )
            .await
        }
        // Its sign-in is an interactive terminal flow: it runs in its own console (see `commandcode.rs`).
        "command-code" => commandcode::sign_in().await,
        "agy" => antigravity_sign_in_another_account(&app).await,
        other => Err(format!("no sign-in for `{other}`")),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Accounts

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct UsageWindow {
    /// `5h`, `7d`, `30d`…, or `requests`/`tokens` for a rate-limit window.
    label: String,
    pct: f64,
    /// Epoch seconds. May be in the past when the figure is old.
    resets_at: Option<i64>,
    /// Units left and the window's ceiling, when the provider gives counts rather than a percentage
    /// (rate-limit headers: requests or tokens still allowed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remaining: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    limit: Option<f64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Account {
    /// What to pass back to `account_switch`.
    id: String,
    email: String,
    alias: Option<String>,
    plan: Option<String>,
    active: bool,
    usage: Vec<UsageWindow>,
    /// Epoch seconds of the figures, when known.
    observed_at: Option<i64>,
    /// Why there is no usage (expired login, API off).
    status: Option<String>,
    /// The login has expired (the usage call answered 401): the account must sign in again and cannot be switched to.
    expired: bool,
    /// Reset credits reported by ChatGPT's reset-credits API. `None` means the API could not be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    reset_credits_available: Option<i64>,
}

#[derive(Serialize)]
pub struct AutoSwitch {
    enabled: bool,
    five_hour: u64,
    weekly: u64,
}

#[derive(Serialize)]
pub struct Accounts {
    /// The switcher tool is installed.
    manager: bool,
    accounts: Vec<Account>,
    auto_switch: Option<AutoSwitch>,
    error: Option<String>,
}

fn window_label(minutes: i64) -> String {
    match minutes {
        300 => "5h".to_string(),
        10_080 => "7d".to_string(),
        43_200 => "30d".to_string(),
        m if m % 1440 == 0 => format!("{}d", m / 1440),
        m if m % 60 == 0 => format!("{}h", m / 60),
        m => format!("{m}m"),
    }
}

/// Emails `codex-auth list` last showed with a 401 (signed out). The registry keeps no trace of that, only the table
/// the tool prints, so the answer of the latest refresh is remembered here. `None` means it has not been checked yet.
static CODEX_EXPIRED: std::sync::Mutex<Option<Vec<String>>> = std::sync::Mutex::new(None);

/// `codex-auth` rewrites its registry and account snapshots while switching or refreshing. Serialize every command
/// that touches that store so `list` cannot observe a transient missing file.
static CODEX_AUTH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// `cswap` rewrites its account list while adding, switching, or removing an account.
/// Serialize AgentDeck's reads and writes so Settings cannot parse a half-written list.
static CSWAP_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Rows of the `codex-auth list` table whose usage columns say `401`.
fn expired_in_list(table: &str) -> Vec<String> {
    table
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            words.next()?.parse::<u32>().ok()?;
            let email = words.next()?;
            words.any(|word| word == "401").then(|| email.to_owned())
        })
        .collect()
}

/// Whether `codex-auth list` returned any account rows that can be matched to its registry.
fn has_account_rows_in_list(table: &str) -> bool {
    table.lines().any(|line| {
        let mut words = line.split_whitespace();
        words
            .next()
            .is_some_and(|number| number.parse::<u32>().is_ok())
            && words.next().is_some_and(|email| email.contains('@'))
    })
}

/// Accounts of `codex-auth`, from its registry file (no tokens in it).
fn read_codex_registry(codex_home: &Path) -> Result<(Vec<Account>, Option<AutoSwitch>), String> {
    let path = codex_home.join("accounts").join("registry.json");
    let text =
        std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    parse_codex_registry(&text)
}

/// `YYYY-MM-DDTHH:MM:SSZ` to epoch seconds (the offset is taken to be UTC, which is what `cswap` writes).
fn parse_iso(text: &str) -> Option<i64> {
    let number = |from: usize, len: usize| text.get(from..from + len)?.parse::<i64>().ok();
    let (year, month, day) = (number(0, 4)?, number(5, 2)?, number(8, 2)?);
    let (hour, minute, second) = (number(11, 2)?, number(14, 2)?, number(17, 2)?);
    // Days since 1970-01-01 (Howard Hinnant's civil-from-days, inverted).
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let year_of_era = shifted - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}

/// `cswap list --json`.
/// The accounts one provider has been signed in with. `refresh` asks the switcher tool for fresh usage figures
/// (a network call by that tool); without it the saved figures are read from disk.
#[tauri::command]
pub async fn accounts_list(
    provider: String,
    refresh: bool,
    account_id: Option<String>,
) -> Result<Accounts, String> {
    match provider.as_str() {
        "codex" => {
            let manager = which("codex-auth");
            let status_not_checked = CODEX_EXPIRED
                .lock()
                .map(|known| known.is_none())
                .unwrap_or(true);
            if account_id.is_none() && (refresh || status_not_checked) {
                if let Some(auth) = &manager {
                    let _auth_lock = CODEX_AUTH_LOCK.lock().await;
                    // `list` refreshes usage and is the only source for 401 status, which is absent from the registry.
                    // On Windows `command()` routes `.cmd` shims through cmd.exe. Do not show stale registry rows as
                    // switchable if the first status check failed.
                    let mut out = capture(auth, &["list"], Duration::from_secs(40)).await?;
                    // codex-auth can briefly expose FileNotFound while another process has just replaced an account
                    // snapshot. Retry only that transient shape; auth and CLI errors must still reach the UI.
                    if !out.ok && failure(&out).contains("FileNotFound") {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        out = capture(auth, &["list"], Duration::from_secs(40)).await?;
                    }
                    if !out.ok && failure(&out).contains("FileNotFound") {
                        // A broken or concurrently replaced codex-auth snapshot must not hide the accounts that
                        // are still available in registry.json. Their live usage requests below remain the source
                        // of truth for expired accounts.
                        if let Ok(mut known) = CODEX_EXPIRED.lock() {
                            *known = Some(Vec::new());
                        }
                    } else if !out.ok {
                        // Say why: the first line of its own message, so a broken shim or a path problem is visible.
                        let why = [out.stderr.as_str(), out.stdout.as_str()]
                            .iter()
                            .flat_map(|text| text.lines())
                            .map(str::trim)
                            .find(|line| !line.is_empty())
                            .unwrap_or("no output");
                        return Err(format!(
                            "codex-auth list failed while checking account status: {why}"
                        ));
                    }
                    if out.ok && !has_account_rows_in_list(&out.stdout) {
                        return Err(
                            "codex-auth list returned no account rows to verify".to_string()
                        );
                    }
                    if out.ok {
                        if let Ok(mut known) = CODEX_EXPIRED.lock() {
                            *known = Some(expired_in_list(&out.stdout));
                        }
                    }
                }
            }
            match read_codex_registry(&codex_home()) {
                Ok((mut accounts, auto_switch)) => {
                    let known = CODEX_EXPIRED
                        .lock()
                        .map(|known| known.clone().unwrap_or_default())
                        .unwrap_or_default();
                    for account in accounts
                        .iter_mut()
                        .filter(|account| known.contains(&account.email))
                    {
                        account.expired = true;
                        account.usage.clear();
                        account.status = Some("signed out (401)".to_string());
                    }
                    let mut usage_queries = tokio::task::JoinSet::new();
                    for account in accounts.iter().filter(|account| {
                        !account.expired
                            && account_id
                                .as_deref()
                                .is_none_or(|requested| requested == account.id)
                    }) {
                        let email = account.email.clone();
                        let home = codex_home();
                        usage_queries.spawn(async move {
                            let (usage, credits) = tokio::join!(
                                fetch_codex_usage(&home, &email),
                                fetch_codex_reset_credits(&home, &email),
                            );
                            (email, usage, credits.ok())
                        });
                    }
                    while let Some(Ok((email, usage, credits))) = usage_queries.join_next().await {
                        if let Some(account) = accounts.iter_mut().find(|item| item.email == email)
                        {
                            match usage {
                                Ok((windows, plan)) => {
                                    account.usage = windows;
                                    account.observed_at = Some(
                                        std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .map_or(0, |elapsed| elapsed.as_secs() as i64),
                                    );
                                    account.status = None;
                                    if plan.is_some() {
                                        account.plan = plan;
                                    }
                                }
                                Err(error) => {
                                    if error.contains("HTTP 401") || error.contains("HTTP 404") {
                                        account.expired = true;
                                        account.usage.clear();
                                    }
                                    account.status =
                                        Some(format!("Live usage unavailable: {error}"));
                                }
                            }
                            account.reset_credits_available = credits;
                        }
                    }
                    Ok(Accounts {
                        manager: manager.is_some(),
                        accounts,
                        auto_switch,
                        error: None,
                    })
                }
                Err(error) => Ok(Accounts {
                    manager: manager.is_some(),
                    accounts: Vec::new(),
                    auto_switch: None,
                    error: manager.is_some().then_some(error),
                }),
            }
        }
        "claude" => {
            let Some(cswap) = which("cswap") else {
                return Ok(Accounts {
                    manager: false,
                    accounts: Vec::new(),
                    auto_switch: None,
                    error: None,
                });
            };
            let _cswap_lock = CSWAP_LOCK.lock().await;
            match capture(&cswap, &["list", "--json"], Duration::from_secs(40)).await {
                Ok(out) => match parse_cswap(&out.stdout) {
                    Ok(accounts) => Ok(Accounts {
                        manager: true,
                        accounts,
                        auto_switch: None,
                        error: None,
                    }),
                    Err(error) => Ok(Accounts {
                        manager: true,
                        accounts: Vec::new(),
                        auto_switch: None,
                        error: Some(error),
                    }),
                },
                Err(error) => Ok(Accounts {
                    manager: true,
                    accounts: Vec::new(),
                    auto_switch: None,
                    error: Some(error),
                }),
            }
        }
        "copilot" => github::accounts(account_id).await,
        other => Err(format!("`{other}` has no account list")),
    }
}

fn safe_arg(value: &str) -> Result<&str, String> {
    if value.is_empty() || value.starts_with('-') || value.chars().any(char::is_control) {
        Err("that is not a valid account".to_string())
    } else {
        Ok(value)
    }
}

pub(crate) fn failure(out: &Captured) -> String {
    let text = if out.stderr.trim().is_empty() {
        &out.stdout
    } else {
        &out.stderr
    };
    text.lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("the command failed")
        .to_owned()
}

/// Makes `id` the account the CLI uses from now on. A turn already running keeps the account it started with.
#[tauri::command]
pub async fn account_switch(provider: String, id: String) -> Result<(), String> {
    let id = safe_arg(&id)?;
    if provider == "copilot" {
        return github::switch(id).await;
    }
    let (tool, args): (&str, Vec<&str>) = match provider.as_str() {
        "codex" => ("codex-auth", vec!["switch", id]),
        "claude" => ("cswap", vec!["switch", id, "--json"]),
        other => return Err(format!("`{other}` has no accounts to switch")),
    };
    let program = which(tool).ok_or_else(|| format!("`{tool}` is not installed"))?;
    let _auth_lock = if provider == "codex" {
        Some(CODEX_AUTH_LOCK.lock().await)
    } else {
        None
    };
    let _cswap_lock = if provider == "claude" {
        Some(CSWAP_LOCK.lock().await)
    } else {
        None
    };
    let out = capture(&program, &args, Duration::from_secs(30)).await?;
    if out.ok {
        Ok(())
    } else {
        Err(failure(&out))
    }
}

/// Signs in (browser) and saves the account into the switcher's list.
#[tauri::command]
pub async fn account_add(app: AppHandle, provider: String) -> Result<(), String> {
    let id = format!("add:{provider}");
    let generation = LOGIN_GENERATION.fetch_add(1, Ordering::Relaxed);
    let task = {
        let mut tasks = LOGIN_TASKS
            .lock()
            .map_err(|_| "could not access connector account state".to_string())?;
        if tasks.contains_key(&id) {
            return Err("adding an account is already running".to_string());
        }
        let task = tokio::spawn(async move { account_add_inner(app, provider).await });
        let abort = task.abort_handle();
        tasks.insert(id.clone(), LoginTask { generation, abort });
        task
    };

    let result = match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => Err("account addition cancelled".to_string()),
        Err(error) => Err(format!("account addition task failed: {error}")),
    };

    if let Ok(mut tasks) = LOGIN_TASKS.lock() {
        if tasks
            .get(&id)
            .is_some_and(|task| task.generation == generation)
        {
            tasks.remove(&id);
        }
    }
    result
}

/// Cancels an in-progress account-add flow and drops its child process.
#[tauri::command]
pub fn account_add_cancel(provider: String) -> Result<(), String> {
    let id = format!("add:{provider}");
    let task = LOGIN_TASKS
        .lock()
        .map_err(|_| "could not access connector account state".to_string())?
        .remove(&id);
    if let Some(task) = task {
        task.abort.abort();
    }
    Ok(())
}

async fn account_add_inner(app: AppHandle, provider: String) -> Result<(), String> {
    match provider.as_str() {
        "codex" => {
            let auth = which("codex-auth").ok_or("`codex-auth` is not installed")?;
            let _auth_lock = CODEX_AUTH_LOCK.lock().await;
            run_logged_with_idle_timeout(
                &app,
                "codex",
                &auth,
                &["login"],
                Duration::from_secs(300),
                Some(Duration::from_secs(120)),
                Some("codex"),
            )
            .await
        }
        "claude" => {
            let cswap = which("cswap").ok_or("`cswap` is not installed")?;
            let claude = claude_binary().ok_or("Claude Code is not installed")?;
            // Sign in as the new account first; the switcher then saves whoever is signed in.
            run_logged_with_idle_timeout(
                &app,
                "claude",
                &claude,
                &["auth", "login"],
                Duration::from_secs(300),
                Some(Duration::from_secs(120)),
                Some("claude"),
            )
            .await?;
            let _cswap_lock = CSWAP_LOCK.lock().await;
            run_logged(&app, "claude", &cswap, &["add"], Duration::from_secs(60)).await
        }
        "copilot" => {
            let gh = which("gh").ok_or("GitHub CLI (`gh`) is not installed")?;
            let _auth_lock = github::AUTH_LOCK.lock().await;
            run_logged_with_idle_timeout(
                &app,
                "copilot",
                &gh,
                &["auth", "login", "--hostname", "github.com", "--web"],
                Duration::from_secs(300),
                Some(Duration::from_secs(120)),
                Some("copilot"),
            )
            .await
        }
        other => Err(format!("`{other}` has no accounts to add")),
    }
}

/// Saves the account Claude Code is signed in as right now into `cswap`'s list, without a new sign-in.
#[tauri::command]
pub async fn account_adopt() -> Result<(), String> {
    let cswap = which("cswap").ok_or("`cswap` is not installed")?;
    let _cswap_lock = CSWAP_LOCK.lock().await;
    let out = capture(&cswap, &["add"], Duration::from_secs(60)).await?;
    if out.ok {
        Ok(())
    } else {
        Err(failure(&out))
    }
}

/// Removes one saved account from the switcher tool: `codex-auth` for Codex, `cswap` for Claude. The account in use
/// cannot be removed, so the CLI is never left signed in as an account that AgentDeck no longer knows.
#[tauri::command]
pub async fn account_remove(provider: String, id: String) -> Result<(), String> {
    let id = safe_arg(&id)?;
    match provider.as_str() {
        "codex" => {
            let auth = which("codex-auth").ok_or("`codex-auth` is not installed")?;
            let _auth_lock = CODEX_AUTH_LOCK.lock().await;
            let out = capture(&auth, &["remove", id], Duration::from_secs(30)).await?;
            if out.ok {
                Ok(())
            } else {
                Err(failure(&out))
            }
        }
        "claude" => {
            let cswap = which("cswap").ok_or("`cswap` is not installed")?;
            let _cswap_lock = CSWAP_LOCK.lock().await;
            let listed = capture(&cswap, &["list", "--json"], Duration::from_secs(30)).await?;
            let accounts = parse_cswap(&listed.stdout)?;
            match accounts.iter().find(|account| account.id == id) {
                None => return Err("that Claude account is not in the list".to_string()),
                Some(account) if account.active => return Err(
                    "This Claude account is in use: switch to another account before removing it"
                        .to_string(),
                ),
                Some(_) => {}
            }
            let out = capture(&cswap, &["remove", id], Duration::from_secs(30)).await?;
            if out.ok {
                Ok(())
            } else {
                Err(failure(&out))
            }
        }
        "copilot" => github::remove(id).await,
        other => Err(format!("`{other}` accounts cannot be removed here")),
    }
}

/// `codex-auth`'s own background switch when a window runs low.
#[tauri::command]
pub async fn codex_auto_switch(enabled: bool, five_hour: u8, weekly: u8) -> Result<(), String> {
    let auth = which("codex-auth").ok_or("`codex-auth` is not installed")?;
    let _auth_lock = CODEX_AUTH_LOCK.lock().await;
    let five = five_hour.min(99).to_string();
    let week = weekly.min(99).to_string();
    let thresholds = capture(
        &auth,
        &["config", "auto", "--5h", &five, "--weekly", &week],
        Duration::from_secs(20),
    )
    .await?;
    if !thresholds.ok {
        return Err(failure(&thresholds));
    }
    let toggle = capture(
        &auth,
        &["config", "auto", if enabled { "enable" } else { "disable" }],
        Duration::from_secs(20),
    )
    .await?;
    if toggle.ok {
        Ok(())
    } else {
        Err(failure(&toggle))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Custom and local providers

#[derive(Serialize)]
pub struct LocalServer {
    kind: &'static str,
    label: &'static str,
    base_url: &'static str,
    models: Vec<String>,
}

/// Looks for the usual local model servers (Ollama, LM Studio, llama.cpp) on this machine.
#[tauri::command]
pub async fn local_scan() -> Vec<LocalServer> {
    let servers: Vec<(&str, &str, &str)> = ENDPOINTS
        .local
        .iter()
        .map(|server| {
            (
                server.kind.as_str(),
                server.label.as_str(),
                server.base.as_str(),
            )
        })
        .collect();
    let limit = Duration::from_millis(700);
    let handles: Vec<_> = servers
        .into_iter()
        .map(|(kind, label, base_url)| {
            tauri::async_runtime::spawn(async move {
                let found =
                    crate::providers::custom::probe(kind, base_url, None, None, limit).await;
                found.ok.then_some(LocalServer {
                    kind,
                    label,
                    base_url,
                    models: found.models,
                })
            })
        })
        .collect();
    let mut found = Vec::new();
    for handle in handles {
        if let Ok(Some(server)) = handle.await {
            found.push(server);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_account_tools_run_only_the_commands_agentdeck_needs() {
        let tool = |name: &str| PathBuf::from(format!("C:/bin/{name}.cmd"));
        for command in ["list", "switch", "remove", "login"] {
            assert!(account_tool_allows(&tool("codex-auth"), &[command]).is_ok());
        }
        // The command that downloads a third-party Codex build, and anything that is not a command at all.
        assert!(account_tool_allows(&tool("codex-auth"), &["app"]).is_err());
        assert!(account_tool_allows(&tool("codex-auth"), &["--help"]).is_err());
        assert!(account_tool_allows(&tool("codex-auth"), &[]).is_err());
        assert!(account_tool_allows(&tool("cswap"), &["list", "--json"]).is_ok());
        assert!(account_tool_allows(&tool("cswap"), &["upgrade"]).is_err());
        assert!(account_tool_allows(&tool("cswap"), &["remove"]).is_ok());
        // Other programs are not this guard's business.
        assert!(account_tool_allows(&tool("claude"), &["auth", "login"]).is_ok());
    }

    #[test]
    fn copilot_quota_is_the_premium_window_left_until_the_monthly_reset() {
        let text = r#"{"quota_reset_date":"2026-11-01","quota_snapshots":{
            "chat":{"unlimited":true,"percent_remaining":100},
            "premium_interactions":{"entitlement":200,"remaining":142,"unlimited":false,"percent_remaining":71.1}}}"#;
        let (usage, _) = parse_copilot_usage(text, 1_800_000_000).expect("quota");
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].label, "30d");
        assert!((usage[0].pct - 28.9).abs() < 1e-9);
        assert_eq!(usage[0].resets_at, parse_iso("2026-11-01T00:00:00Z"));

        // An unlimited plan has no window to show.
        let unlimited = r#"{"quota_snapshots":{"premium_interactions":{"unlimited":true,"percent_remaining":100}}}"#;
        assert_eq!(
            parse_copilot_usage(unlimited, 1).expect("quota").0,
            Vec::new()
        );
        assert!(parse_copilot_usage("not json", 1).is_none());
    }

    #[test]
    fn codex_registry_gives_accounts_and_windows() {
        let text = r#"{
          "active_account_key": "b",
          "auto_switch": {"enabled": true, "threshold_5h_percent": 12, "threshold_weekly_percent": 6},
          "accounts": [
            {"account_key": "a", "email": "a@x.com", "alias": "", "plan": "free",
             "last_usage": {"primary": {"used_percent": 93, "window_minutes": 43200, "resets_at": 1788172584}, "secondary": null},
             "last_usage_at": 1786326361},
            {"account_key": "b", "email": "b@x.com", "plan": "business",
             "last_usage": {"primary": {"used_percent": 91.5, "window_minutes": 300, "resets_at": 5},
                            "secondary": {"used_percent": 95, "window_minutes": 10080, "resets_at": 6}}},
            {"account_key": "c", "email": "c@x.com"}
          ]}"#;
        let (accounts, auto) = parse_codex_registry(text).expect("parses");
        assert_eq!(accounts.len(), 3);
        assert!(!accounts[0].active && accounts[1].active);
        assert_eq!(accounts[0].alias, None);
        assert_eq!(
            accounts[0].usage,
            vec![UsageWindow {
                label: "30d".into(),
                pct: 93.0,
                resets_at: Some(1_788_172_584),
                remaining: None,
                limit: None,
            }]
        );
        assert_eq!(
            accounts[1]
                .usage
                .iter()
                .map(|w| w.label.as_str())
                .collect::<Vec<_>>(),
            ["5h", "7d"]
        );
        assert_eq!(accounts[2].status.as_deref(), Some("no usage figures yet"));
        let auto = auto.expect("auto switch");
        assert!(auto.enabled && auto.five_hour == 12 && auto.weekly == 6);
    }

    #[test]
    fn expired_rows_are_found_in_the_list_table() {
        let table = "  ACCOUNT  PLAN  5H USAGE  WEEKLY USAGE
----
01 a@x.com   Free   401   401   74d ago
02 b@x.com   Business   100% (03:03 on 24 Oct)  88% (00:12 on 30 Oct)  Now
";
        assert_eq!(expired_in_list(table), vec!["a@x.com".to_string()]);
    }

    #[test]
    fn cswap_json_gives_accounts() {
        let text = r#"{"schemaVersion":1,"activeAccountNumber":2,"accounts":[
          {"number":1,"email":"a@x.com","active":false,"usageStatus":"expired"},
          {"number":2,"email":"b@x.com","active":true,"usageStatus":"ok",
           "usage":{"fiveHour":{"pct":25.0,"resetsAt":"2026-06-22T23:29:59Z"},"sevenDay":{"pct":16.0,"resetsAt":"2026-06-26T17:59:59Z"}}}]}"#;
        let accounts = parse_cswap(text).expect("parses");
        assert_eq!(accounts[0].status.as_deref(), Some("expired"));
        assert!(accounts[0].expired && !accounts[1].expired);
        assert!(accounts[0].usage.is_empty());
        assert!(accounts[1].active);
        assert_eq!(accounts[1].usage[0].pct, 25.0);
        assert_eq!(accounts[1].usage[0].resets_at, Some(1_782_170_999));
        let error = parse_cswap(r#"{"schemaVersion":1,"error":{"message":"no accounts"}}"#);
        assert_eq!(error, Err("no accounts".to_string()));
    }

    #[test]
    fn iso_dates_become_epoch_seconds() {
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso("2000-03-01T00:00:01Z"), Some(951_868_801));
        assert_eq!(parse_iso("nope"), None);
    }

    #[test]
    fn claude_status_is_read() {
        let login = claude_login(
            r#"{"loggedIn":true,"authMethod":"claude.ai","email":"me@x.com","orgName":"Org"}"#,
        );
        assert_eq!(login.logged_in, Some(true));
        assert_eq!(login.email.as_deref(), Some("me@x.com"));
        assert_eq!(login.detail.as_deref(), Some("Org"));
        assert_eq!(claude_login("Not logged in").logged_in, Some(false));
    }

    #[test]
    fn model_lists_follow_each_kind() {
        assert_eq!(models_url("ollama", "http://h:1/"), "http://h:1/api/tags");
        assert_eq!(models_url("openai", "http://h/v1"), "http://h/v1/models");
        assert_eq!(
            models_url("anthropic", "https://api.x.com"),
            "https://api.x.com/v1/models"
        );
        assert_eq!(
            models_url("anthropic", "https://api.x.com/v1/"),
            "https://api.x.com/v1/models"
        );
        let tags: Value = serde_json::json!({"models": [{"name": "llama3"}]});
        assert_eq!(parse_models("ollama", &tags), ["llama3"]);
        let data: Value = serde_json::json!({"data": [{"id": "m1"}, {"id": "m2"}]});
        assert_eq!(parse_models("openai", &data), ["m1", "m2"]);
    }

    #[test]
    fn account_arguments_cannot_be_flags() {
        assert!(safe_arg("-rf").is_err());
        assert!(safe_arg("").is_err());
        assert_eq!(safe_arg("a@b.com"), Ok("a@b.com"));
    }

    #[test]
    fn antigravity_state_follows_the_later_log_line() {
        let out = "x You are not logged into Antigravity.
";
        let inn = "y Experiments refreshed after login
";
        assert_eq!(antigravity_state(&format!("{out}{inn}")), Some(true));
        assert_eq!(antigravity_state(&format!("{inn}{out}")), Some(false));
        assert_eq!(antigravity_state(inn), Some(true));
        assert_eq!(antigravity_state("nothing"), None);
    }

    #[test]
    fn antigravity_email_is_the_last_sign_in() {
        let log = "x authenticated successfully as a@x.com
 y authenticated successfully as b@x.com, authMethod=consumer";
        assert_eq!(antigravity_email(log).as_deref(), Some("b@x.com"));
        assert_eq!(antigravity_email("nothing"), None);
    }

    #[test]
    fn agy_quota_groups_by_model_family() {
        let text = r#"{"fetchedAt":1792739564113,"quota":{
          "3p-5h":{"remaining_fraction":1,"reset_time":"2026-10-23T12:11:42Z"},
          "3p-weekly":{"remaining_fraction":0.5,"reset_time":"2026-10-30T07:11:42Z"},
          "gemini-weekly":{"remaining_fraction":0.5658594,"reset_time":"2026-10-24T13:04:48Z"},
          "gemini-5h":{"remaining_fraction":0.98,"reset_time":"2026-10-23T11:57:34Z"}}}"#;
        let quota = parse_agy_quota(text).expect("parses");
        assert_eq!(quota.observed_at, Some(1_792_739_564));
        assert_eq!(quota.groups[0].id, "gemini");
        assert_eq!(
            quota.groups[0]
                .windows
                .iter()
                .map(|w| w.label.as_str())
                .collect::<Vec<_>>(),
            ["5h", "7d"]
        );
        assert!((quota.groups[0].windows[1].pct - 43.41406).abs() < 0.001);
        assert_eq!(quota.groups[1].label, "Claude and GPT-OSS models");
        assert_eq!(quota.groups[1].windows[0].pct, 0.0);
        assert_eq!(parse_agy_quota("{}"), None);
    }

    #[test]
    fn agy_says_when_a_mode_is_not_for_this_account() {
        assert!(mode_unavailable("warning: --mode auto is not available for this account; continuing in the default mode."));
        assert!(!mode_unavailable(
            "[agy] print timeout after 3s with turn in progress"
        ));
    }

    #[test]
    fn window_labels() {
        assert_eq!(window_label(300), "5h");
        assert_eq!(window_label(10_080), "7d");
        assert_eq!(window_label(90), "90m");
        assert_eq!(window_label(2880), "2d");
    }
}
