//! Codex account registry and ChatGPT usage connector.

use std::path::Path;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::header::{ACCEPT, AUTHORIZATION, REFERER, USER_AGENT};
use serde_json::Value;

use crate::endpoints::ENDPOINTS;

use super::{codex_home, window_label, Account, AutoSwitch, UsageWindow};

fn parse_codex_window(window: &Value, label_prefix: Option<&str>, now: i64) -> Option<UsageWindow> {
    let used_percent = window["used_percent"].as_f64()?;
    let seconds = window["limit_window_seconds"].as_i64()?;
    if seconds <= 0 {
        return None;
    }
    let label = window_label((seconds + 59) / 60);
    let label = label_prefix
        .filter(|prefix| !prefix.is_empty())
        .map(|prefix| format!("{prefix} {label}"))
        .unwrap_or(label);
    let resets_at = window["reset_at"].as_i64().or_else(|| {
        window["reset_after_seconds"]
            .as_i64()
            .filter(|remaining| *remaining >= 0)
            .map(|remaining| now + remaining)
    });
    Some(UsageWindow {
        label,
        pct: used_percent.clamp(0.0, 100.0),
        resets_at,
        remaining: None,
        limit: None,
    })
}

pub(crate) fn parse_usage(payload: &Value) -> (Vec<UsageWindow>, Option<String>) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64);
    let mut windows = ["primary_window", "secondary_window"]
        .iter()
        .filter_map(|name| payload.pointer(&format!("/rate_limit/{name}")))
        .filter_map(|window| parse_codex_window(window, None, now))
        .collect::<Vec<_>>();
    if let Some(additional) = payload["additional_rate_limits"].as_array() {
        for entry in additional {
            let prefix = entry["limit_name"]
                .as_str()
                .or_else(|| entry["metered_feature"].as_str());
            for name in ["primary_window", "secondary_window"] {
                if let Some(window) = entry["rate_limit"].get(name) {
                    if let Some(parsed) = parse_codex_window(window, prefix, now) {
                        windows.push(parsed);
                    }
                }
            }
        }
    }
    let plan = payload["plan_type"].as_str().map(str::to_owned);
    (windows, plan)
}

pub(crate) async fn fetch_usage(
    codex_home: &Path,
    email: &str,
) -> Result<(Vec<UsageWindow>, Option<String>), String> {
    let (access_token, account_id) = codex_account_auth(codex_home, email)?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Could not create Codex usage client: {error}"))?
        .get(ENDPOINTS.chatgpt.usage.as_str())
        .headers(reset_headers(
            &access_token,
            account_id.as_deref(),
            "/backend-api/wham/usage",
        ))
        .send()
        .await
        .map_err(|error| format!("Could not fetch Codex usage: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Codex usage API returned HTTP {status}"));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("Could not parse Codex usage response: {error}"))?;
    let (windows, plan) = parse_usage(&payload);
    if windows.is_empty() {
        return Err("Codex usage API returned no rate-limit windows".to_string());
    }
    Ok((windows, plan))
}

fn codex_account_auth(codex_home: &Path, email: &str) -> Result<(String, Option<String>), String> {
    let registry_path = codex_home.join("accounts").join("registry.json");
    let registry_text = std::fs::read_to_string(&registry_path)
        .map_err(|error| format!("Could not read Codex account registry: {error}"))?;
    let registry: Value = serde_json::from_str(&registry_text)
        .map_err(|error| format!("Could not parse Codex account registry: {error}"))?;
    let account_key = registry["accounts"]
        .as_array()
        .and_then(|accounts| {
            accounts.iter().find_map(|account| {
                (account["email"].as_str() == Some(email))
                    .then(|| account["account_key"].as_str())
                    .flatten()
            })
        })
        .ok_or_else(|| "Codex account was not found in codex-auth registry".to_string())?;
    let auth_path = codex_home
        .join("accounts")
        .join(format!("{}.auth.json", URL_SAFE_NO_PAD.encode(account_key)));
    let auth_text = std::fs::read_to_string(&auth_path)
        .map_err(|error| format!("Could not read saved Codex account credentials: {error}"))?;
    let auth: Value = serde_json::from_str(&auth_text)
        .map_err(|error| format!("Could not parse saved Codex account credentials: {error}"))?;
    if auth["auth_mode"].as_str() == Some("apikey")
        || auth["OPENAI_API_KEY"]
            .as_str()
            .is_some_and(|key| !key.is_empty())
    {
        return Err("API key accounts do not support Codex reset credits".to_string());
    }
    let access_token = auth["tokens"]["access_token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "Saved Codex account has no access token; sign in again".to_string())?
        .to_owned();
    let account_id = auth["tokens"]["account_id"].as_str().map(str::to_owned);
    Ok((access_token, account_id))
}

fn reset_headers(
    access_token: &str,
    account_id: Option<&str>,
    target_path: &str,
) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        ACCEPT,
        reqwest::header::HeaderValue::from_static("application/json"),
    );
    headers.insert(
        REFERER,
        reqwest::header::HeaderValue::from_str(&ENDPOINTS.chatgpt.home)
            .unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("https://chatgpt.com/")),
    );
    headers.insert(
        USER_AGENT,
        reqwest::header::HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        ),
    );
    if let Ok(value) = reqwest::header::HeaderValue::from_str(&format!("Bearer {access_token}")) {
        headers.insert(AUTHORIZATION, value);
    }
    if let Ok(value) = reqwest::header::HeaderValue::from_str(target_path) {
        headers.insert("x-openai-target-path", value.clone());
        headers.insert("x-openai-target-route", value);
    }
    if let Some(account_id) = account_id {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(account_id) {
            headers.insert("ChatGPT-Account-Id", value);
        }
    }
    headers
}

pub(crate) async fn fetch_reset_credits(codex_home: &Path, email: &str) -> Result<i64, String> {
    let (access_token, account_id) = codex_account_auth(codex_home, email)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Could not create Codex reset credits client: {error}"))?;
    let response = client
        .get(ENDPOINTS.chatgpt.reset_credits.as_str())
        .headers(reset_headers(
            &access_token,
            account_id.as_deref(),
            "/backend-api/wham/rate-limit-reset-credits",
        ))
        .send()
        .await
        .map_err(|error| format!("Could not fetch Codex reset credits: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Codex reset credits API returned HTTP {status}"));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("Could not parse Codex reset credits response: {error}"))?;
    payload
        .get("available_count")
        .or_else(|| payload.get("availableCount"))
        .or_else(|| {
            payload.get("data").and_then(|data| {
                data.get("available_count")
                    .or_else(|| data.get("availableCount"))
            })
        })
        .and_then(Value::as_i64)
        .or_else(|| {
            payload
                .get("credits")
                .or_else(|| payload.get("data").and_then(|data| data.get("credits")))
                .and_then(Value::as_array)
                .map(|credits| {
                    credits
                        .iter()
                        .filter(|credit| {
                            let status = credit["status"].as_str().unwrap_or("available");
                            !matches!(
                                status.to_ascii_lowercase().as_str(),
                                "redeemed" | "used" | "consumed" | "expired"
                            )
                        })
                        .count() as i64
                })
        })
        .ok_or_else(|| "Codex reset credits response has no available count".to_string())
}

pub(crate) async fn consume_reset_credit(email: String) -> Result<(), String> {
    let home = codex_home();
    let available = fetch_reset_credits(&home, &email).await?;
    if available < 1 {
        return Err("No Codex reset credits are available for this account".to_string());
    }
    let (access_token, account_id) = codex_account_auth(&home, &email)?;
    let target_path = "/backend-api/wham/rate-limit-reset-credits/consume";
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not create Codex reset client: {error}"))?;
    let response = client
        .post(ENDPOINTS.chatgpt.reset_credits_consume.as_str())
        .headers(reset_headers(
            &access_token,
            account_id.as_deref(),
            target_path,
        ))
        .json(&serde_json::json!({ "redeem_request_id": uuid::Uuid::new_v4().to_string() }))
        .send()
        .await
        .map_err(|error| format!("Could not redeem Codex reset credit: {error}"))?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("Codex reset API returned HTTP {status}"))
    }
}

pub(crate) fn parse_registry(text: &str) -> Result<(Vec<Account>, Option<AutoSwitch>), String> {
    let json: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let active = json["active_account_key"].as_str().unwrap_or_default();
    let accounts = json["accounts"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let key = item["account_key"].as_str()?;
                    let usage = &item["last_usage"];
                    let windows: Vec<UsageWindow> = ["primary", "secondary"]
                        .iter()
                        .filter_map(|name| {
                            let window = &usage[*name];
                            Some(UsageWindow {
                                label: window_label(window["window_minutes"].as_i64()?),
                                pct: window["used_percent"].as_f64()?,
                                resets_at: window["resets_at"].as_i64(),
                                remaining: None,
                                limit: None,
                            })
                        })
                        .collect();
                    let text = |name: &str| {
                        item[name]
                            .as_str()
                            .filter(|value| !value.is_empty())
                            .map(str::to_owned)
                    };
                    Some(Account {
                        expired: false,
                        id: text("email").unwrap_or_else(|| key.to_owned()),
                        email: text("email").unwrap_or_else(|| key.to_owned()),
                        alias: text("alias"),
                        plan: text("plan"),
                        active: key == active,
                        status: windows
                            .is_empty()
                            .then(|| "no usage figures yet".to_string()),
                        usage: windows,
                        observed_at: item["last_usage_at"].as_i64(),
                        reset_credits_available: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let auto = &json["auto_switch"];
    let auto_switch = auto["enabled"].as_bool().map(|enabled| AutoSwitch {
        enabled,
        five_hour: auto["threshold_5h_percent"].as_u64().unwrap_or(10),
        weekly: auto["threshold_weekly_percent"].as_u64().unwrap_or(5),
    });
    Ok((accounts, auto_switch))
}
