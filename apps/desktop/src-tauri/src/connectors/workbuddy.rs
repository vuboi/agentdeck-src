//! WorkBuddy account connector: device login, token refresh, and authenticated model discovery.

use std::time::Duration;

use serde_json::Value;

use super::{secret_delete, secret_load, secret_save, Login};

const LEGACY_SECRET: &str = "agentdeck:workbuddy";
const ACCESS_SECRET: &str = "agentdeck:workbuddy:access";
const REFRESH_SECRET: &str = "agentdeck:workbuddy:refresh";
const EXPIRY_SECRET: &str = "agentdeck:workbuddy:expiry";
const ACCESS_COUNT_SECRET: &str = "agentdeck:workbuddy:access:count";
const REFRESH_COUNT_SECRET: &str = "agentdeck:workbuddy:refresh:count";
const USER_ID_SECRET: &str = "agentdeck:workbuddy:user-id";
const ENTERPRISE_ID_SECRET: &str = "agentdeck:workbuddy:enterprise-id";
const BASE: &str = "https://www.workbuddy.ai";
// Windows Credential Manager stores a UTF-16-encoded password in a blob of at
// most CRED_MAX_CREDENTIAL_BLOB_SIZE (2560) bytes, i.e. 1280 UTF-16 units per
// credential; chunk well below that so every piece fits one credential.
const SECRET_CHUNK_UTF16: usize = 1000;

fn load_value(prefix: &str, count_target: &str) -> Option<String> {
    let count = secret_load(count_target.to_string()).and_then(|value| value.parse::<usize>().ok());
    if let Some(count) = count {
        let mut value = String::new();
        for index in 0..count {
            value.push_str(&secret_load(format!("{prefix}:{index}"))?);
        }
        return Some(value);
    }
    secret_load(prefix.to_string())
}

fn save_value(prefix: &str, count_target: &str, value: &str) -> Result<(), String> {
    let mut chunks = Vec::new();
    let mut chunk = String::new();
    let mut chunk_units = 0;
    for character in value.chars() {
        let units = character.len_utf16();
        if chunk_units + units > SECRET_CHUNK_UTF16 && !chunk.is_empty() {
            chunks.push(std::mem::take(&mut chunk));
            chunk_units = 0;
        }
        chunk.push(character);
        chunk_units += units;
    }
    if !chunk.is_empty() || value.is_empty() {
        chunks.push(chunk);
    }
    for (index, chunk) in chunks.iter().enumerate() {
        secret_save(format!("{prefix}:{index}"), chunk.clone())?;
    }
    secret_save(count_target.to_string(), chunks.len().to_string())
}

fn delete_value(prefix: &str, count_target: &str) -> Result<(), String> {
    if let Some(count) = secret_load(count_target.to_string()).and_then(|value| value.parse::<usize>().ok()) {
        for index in 0..count {
            secret_delete(format!("{prefix}:{index}"))?;
        }
    }
    secret_delete(count_target.to_string())
}

pub(super) fn login_status() -> Login {
    let logged_in = load_value(ACCESS_SECRET, ACCESS_COUNT_SECRET).is_some()
        || secret_load(LEGACY_SECRET.to_string()).is_some();
    Login {
        logged_in: Some(logged_in),
        detail: Some("device sign-in".to_string()),
        ..Login::default()
    }
}

pub(crate) async fn access_token() -> Result<String, String> {
    let (access, refresh, expires_at) =
        if let Some(access) = load_value(ACCESS_SECRET, ACCESS_COUNT_SECRET) {
            let refresh = load_value(REFRESH_SECRET, REFRESH_COUNT_SECRET).unwrap_or_default();
            let expires_at = secret_load(EXPIRY_SECRET.to_string())
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(u64::MAX);
            (access, refresh, expires_at)
        } else {
            let raw = secret_load(LEGACY_SECRET.to_string()).ok_or("WorkBuddy is not signed in")?;
            let json: Value =
                serde_json::from_str(&raw).map_err(|_| "saved WorkBuddy credential is invalid")?;
            (
                json["access_token"].as_str().unwrap_or_default().to_owned(),
                json["refresh_token"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                json["expires_at"].as_u64().unwrap_or(u64::MAX),
            )
        };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    if expires_at <= now + 60 && !refresh.is_empty() {
        if let Ok(token) = refresh_token(&refresh).await {
            return Ok(token);
        }
    }
    if access.is_empty() {
        Err("saved WorkBuddy credential has no access token".to_string())
    } else {
        Ok(access)
    }
}

pub(crate) fn user_id() -> Option<String> {
    secret_load(USER_ID_SECRET.to_string())
}

pub(crate) fn enterprise_id() -> Option<String> {
    secret_load(ENTERPRISE_ID_SECRET.to_string())
}

pub(super) fn logout() -> Result<(), String> {
    delete_value(ACCESS_SECRET, ACCESS_COUNT_SECRET)?;
    delete_value(REFRESH_SECRET, REFRESH_COUNT_SECRET)?;
    for target in [LEGACY_SECRET, EXPIRY_SECRET, USER_ID_SECRET, ENTERPRISE_ID_SECRET] {
        secret_delete(target.to_string())?;
    }
    Ok(())
}

fn save_tokens(access: &str, refresh: &str, expires_at: u64) -> Result<(), String> {
    save_value(ACCESS_SECRET, ACCESS_COUNT_SECRET, access)?;
    save_value(REFRESH_SECRET, REFRESH_COUNT_SECRET, refresh)?;
    secret_save(EXPIRY_SECRET.to_string(), expires_at.to_string())
}

fn save_account_metadata(account: &Value) -> Result<(), String> {
    let user_id = ["uid", "userId", "user_id"]
        .iter()
        .find_map(|key| match &account[*key] {
            Value::String(value) if !value.is_empty() => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
        .ok_or("WorkBuddy account response returned no user ID")?;
    secret_save(USER_ID_SECRET.to_string(), user_id.to_string())?;
    if let Some(enterprise_id) =
        ["enterpriseId", "enterprise_id"]
            .iter()
            .find_map(|key| match &account[*key] {
                Value::String(value) if !value.is_empty() => Some(value.clone()),
                Value::Number(value) => Some(value.to_string()),
                _ => None,
            })
    {
        secret_save(ENTERPRISE_ID_SECRET.to_string(), enterprise_id)?;
    }
    Ok(())
}

async fn refresh_token(refresh_token: &str) -> Result<String, String> {
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("WorkBuddy/5.5.6")
        .build()
        .map_err(|error| error.to_string())?
        .post(format!("{BASE}/v2/plugin/auth/token/refresh"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("X-Refresh-Token", refresh_token)
        .header("X-Product", "SaaS")
        .header("X-Domain", "www.workbuddy.ai")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("User-Agent", "WorkBuddy/5.5.6")
        .header("X-User-Id", user_id().unwrap_or_default())
        .body("{}")
        .send()
        .await
        .map_err(|error| format!("WorkBuddy token refresh failed: {error}"))?;
    let payload: Value = response.json().await.map_err(|error| error.to_string())?;
    if payload["code"].as_i64() != Some(0) {
        return Err(payload["msg"]
            .as_str()
            .unwrap_or("refresh rejected")
            .to_string());
    }
    let access = payload["data"]["accessToken"]
        .as_str()
        .ok_or("WorkBuddy refresh returned no access token")?;
    let next_refresh = payload["data"]["refreshToken"]
        .as_str()
        .unwrap_or(refresh_token);
    let expires_in = payload["data"]["expiresIn"].as_u64().unwrap_or(2_592_000);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    save_tokens(access, next_refresh, now.saturating_add(expires_in))?;
    Ok(access.to_string())
}

pub(super) async fn sign_in() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("WorkBuddy/5.5.6")
        .build()
        .map_err(|error| error.to_string())?;
    let state = client
        .post(format!("{BASE}/v2/plugin/auth/state?platform=CLI"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("X-Product", "SaaS")
        .json(&serde_json::json!({ "platform": "CLI" }))
        .send()
        .await
        .map_err(|error| format!("WorkBuddy sign-in could not start: {error}"))?;
    let status = state.status();
    let payload: Value = state
        .json()
        .await
        .map_err(|error| format!("WorkBuddy sent invalid sign-in data: {error}"))?;
    if !status.is_success() || payload["code"].as_i64() != Some(0) {
        return Err(format!(
            "WorkBuddy sign-in rejected: {}",
            payload["msg"].as_str().unwrap_or("unknown error")
        ));
    }
    let state_id = payload["data"]["state"]
        .as_str()
        .ok_or("WorkBuddy sign-in returned no state")?;
    let auth_url = payload["data"]["authUrl"]
        .as_str()
        .or_else(|| payload["data"]["url"].as_str())
        .ok_or("WorkBuddy sign-in returned no browser URL")?;
    crate::browser::open_external(auth_url.to_string())?;

    for _ in 0..120 {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let response = client
            .get(format!("{BASE}/v2/plugin/auth/token?state={state_id}"))
            .header("Accept", "application/json")
            .header("X-Product", "SaaS")
            .send()
            .await
            .map_err(|error| format!("WorkBuddy sign-in polling failed: {error}"))?;
        let payload: Value = response
            .json()
            .await
            .map_err(|error| format!("WorkBuddy sent invalid token data: {error}"))?;
        if payload["code"].as_i64() == Some(0) {
            let access = payload["data"]["accessToken"]
                .as_str()
                .ok_or("WorkBuddy sign-in returned no access token")?;
            let expires_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |duration| duration.as_secs())
                .saturating_add(payload["data"]["expiresIn"].as_u64().unwrap_or(2_592_000));
            save_tokens(
                access,
                payload["data"]["refreshToken"].as_str().unwrap_or_default(),
                expires_at,
            )?;

            // The access token alone is enough for the login badge, but the model catalogue and chat gateway also
            // bind the request to the WorkBuddy user ID returned by this follow-up account call.
            for _ in 0..60 {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let account = client
                    .get(format!("{BASE}/v2/plugin/login/account?state={state_id}"))
                    .header("Accept", "application/json")
                    .header("Authorization", format!("Bearer {access}"))
                    .header("X-Product", "SaaS")
                    .header("X-Domain", "www.workbuddy.ai")
                    .header("X-Requested-With", "XMLHttpRequest")
                    .send()
                    .await
                    .map_err(|error| format!("WorkBuddy account lookup failed: {error}"))?;
                let account_payload: Value = account
                    .json()
                    .await
                    .map_err(|error| format!("WorkBuddy sent invalid account data: {error}"))?;
                if account_payload["code"].as_i64() == Some(0) {
                    save_account_metadata(&account_payload["data"])?;
                    return Ok(());
                }
                if account_payload["code"].as_i64() != Some(12151) {
                    return Err(format!(
                        "WorkBuddy account lookup failed: {}",
                        account_payload["msg"].as_str().unwrap_or("unknown error")
                    ));
                }
            }
            return Err("WorkBuddy account lookup timed out".to_string());
        }
        if payload["code"].as_i64() != Some(11217) {
            return Err(format!(
                "WorkBuddy sign-in failed: {}",
                payload["msg"].as_str().unwrap_or("unknown error")
            ));
        }
    }
    Err("WorkBuddy sign-in timed out after 10 minutes".to_string())
}

fn is_model_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() < 120
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
}

fn collect_models(value: &Value, models: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for key in ["id", "model", "modelId", "model_id"] {
                if let Some(model) = object[key].as_str().filter(|model| is_model_id(model)) {
                    if !models.iter().any(|known| known == model) {
                        models.push(model.to_string());
                    }
                }
            }
            for child in object.values() {
                collect_models(child, models);
            }
        }
        Value::Array(items) => {
            for item in items {
                if let Value::String(model) = item {
                    if is_model_id(model) && !models.iter().any(|known| known == model) {
                        models.push(model.clone());
                    }
                } else {
                    collect_models(item, models);
                }
            }
        }
        _ => {}
    }
}

pub(crate) async fn models() -> Result<Vec<String>, String> {
    let token = access_token().await?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("WorkBuddy/5.5.6")
        .build()
        .map_err(|error| error.to_string())?
        .get(format!("{BASE}/v3/config"))
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("X-Product", "SaaS")
        .header("X-Domain", "www.workbuddy.ai")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("X-User-Id", user_id().unwrap_or_default())
        .header("X-Enterprise-Id", enterprise_id().unwrap_or_default())
        .header("User-Agent", "WorkBuddy/5.5.6")
        .header("X-IDE-Type", "WorkBuddy")
        .header("X-IDE-Name", "WorkBuddy")
        .header("X-IDE-Version", "5.5.6")
        .header("X-Agent-Intent", "craft")
        .header("X-Agent-Purpose", "conversation")
        .header("X-Agent-Type", "main")
        .send()
        .await
        .map_err(|error| format!("WorkBuddy model catalog failed: {error}"))?;
    if !response.status().is_success() {
        return Ok(static_models());
    }
    let payload: Value = match response.json().await {
        Ok(payload) => payload,
        Err(_) => return Ok(static_models()),
    };
    let mut models = Vec::new();
    collect_models(&payload, &mut models);
    models.retain(|model| !model.contains('/') && is_model_id(model));
    if models.is_empty() {
        return Ok(static_models());
    }
    Ok(models)
}

fn static_models() -> Vec<String> {
    [
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "deepseek-v4.1-flash",
        "hy4-preview",
        "kimi-k3",
        "gemini-3.5-flash",
        "glm-5.3",
        "glm-5.2",
        "hy3",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}
