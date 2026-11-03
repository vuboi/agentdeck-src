//! OpenCode connector authentication state.
//!
//! OpenCode owns its provider credentials and account picker. AgentDeck can inspect whether its auth store is usable,
//! and can read the official OpenCode Go usage endpoint when the Go subscription key is present.

use std::path::PathBuf;
use std::time::Duration;

use reqwest::header::ACCEPT;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::endpoints::ENDPOINTS;

use super::{capture, which, Login};

/// Reads OpenCode's own auth store without exposing provider credentials to AgentDeck.
pub(crate) async fn login_status() -> Login {
    let Some(path) = which("opencode") else {
        return Login::default();
    };
    match capture(
        &path,
        &["auth", "list", "--format", "json"],
        Duration::from_secs(10),
    )
    .await
    {
        Ok(out) => {
            let providers = auth_providers(&out.stdout);
            Login {
                logged_in: Some(out.ok && !providers.is_empty()),
                detail: (!providers.is_empty()).then(|| providers.join(", ")),
                ..Login::default()
            }
        }
        Err(_) => Login::default(),
    }
}

/// Provider names from `opencode auth list --format json` (an array of entries or an object keyed by provider).
fn auth_providers(stdout: &str) -> Vec<String> {
    let Ok(json) = serde_json::from_str::<Value>(stdout) else {
        return Vec::new();
    };
    match json {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                ["name", "provider", "id"]
                    .iter()
                    .find_map(|key| item[key].as_str())
                    .map(str::to_owned)
            })
            .collect(),
        Value::Object(map) => map.keys().cloned().collect(),
        _ => Vec::new(),
    }
}
#[derive(Serialize, Clone)]
pub(crate) struct OpenCodeQuota {
    pub(crate) windows: Vec<super::UsageWindow>,
    pub(crate) observed_at: Option<i64>,
    pub(crate) error: Option<String>,
}

#[derive(Deserialize)]
struct UsageResponse {
    usage: UsageWindows,
}

#[derive(Deserialize)]
struct UsageWindows {
    rolling: UsageWindowResponse,
    weekly: UsageWindowResponse,
    monthly: UsageWindowResponse,
}

#[derive(Deserialize)]
struct UsageWindowResponse {
    percent: f64,
    #[serde(rename = "resetsAt")]
    resets_at: String,
}

pub(crate) async fn quota() -> OpenCodeQuota {
    let Some(key) = read_go_key() else {
        return OpenCodeQuota {
            windows: Vec::new(),
            observed_at: None,
            error: Some("OpenCode Go usage key not found".to_string()),
        };
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(error) => return error_result(error.to_string()),
    };
    let response = match client
        .get(ENDPOINTS.provider_quota.opencode_go_usage.as_str())
        .bearer_auth(key)
        .header(ACCEPT, "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return error_result(error.to_string()),
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return error_result(format!(
            "OpenCode Go usage returned HTTP {}",
            response.status()
        ));
    }
    if !response.status().is_success() {
        return error_result(format!(
            "OpenCode Go usage returned HTTP {}",
            response.status()
        ));
    }
    let body = match response.json::<UsageResponse>().await {
        Ok(body) => body,
        Err(error) => return error_result(format!("invalid OpenCode Go usage response: {error}")),
    };
    let observed_at = now_seconds();
    OpenCodeQuota {
        windows: vec![
            to_window("rolling", &body.usage.rolling),
            to_window("weekly", &body.usage.weekly),
            to_window("monthly", &body.usage.monthly),
        ],
        observed_at: Some(observed_at),
        error: None,
    }
}

fn to_window(label: &str, source: &UsageWindowResponse) -> super::UsageWindow {
    super::UsageWindow {
        label: label.to_string(),
        pct: source.percent.clamp(0.0, 100.0),
        resets_at: super::parse_iso(&source.resets_at),
        remaining: None,
        limit: None,
    }
}

fn read_go_key() -> Option<String> {
    let path = auth_path();
    let body = std::fs::read_to_string(path).ok()?;
    let json: Value = serde_json::from_str(&body).ok()?;
    let key = json["opencode-go"]["key"].as_str()?.trim();
    (!key.is_empty()).then_some(key.to_string())
}

fn auth_path() -> PathBuf {
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(data_home).join("opencode").join("auth.json");
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join(".local")
        .join("share")
        .join("opencode")
        .join("auth.json")
}

fn error_result(error: String) -> OpenCodeQuota {
    OpenCodeQuota {
        windows: Vec::new(),
        observed_at: None,
        error: Some(error),
    }
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs() as i64)
}

#[cfg(test)]
mod auth_tests {
    use super::auth_providers;

    #[test]
    fn reads_providers_from_an_array_or_an_object() {
        assert_eq!(
            auth_providers(r#"[{"name":"opencode-go"},{"provider":"x"}]"#),
            vec!["opencode-go", "x"]
        );
        assert_eq!(auth_providers(r#"{"a":{}}"#), vec!["a"]);
        assert!(auth_providers("[]").is_empty());
        assert!(auth_providers("nope").is_empty());
    }
}
