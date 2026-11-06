//! Muse Code subscription connector: RFC 8628 device login and inference-key minting.

use crate::endpoints::ENDPOINTS;
use std::time::Duration;

use serde_json::Value;

use super::{secret_delete, secret_load, secret_save, Login};

const ACCESS_SECRET: &str = "agentdeck:muse-code:access";
const DCA_SECRET: &str = "agentdeck:muse-code:dca";
const EXPIRY_SECRET: &str = "agentdeck:muse-code:expiry";
const CLIENT_ID: &str = "1031625952748946";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const USER_AGENT: &str = "AgentDeck/1.0";

pub(super) fn login_status() -> Login {
    Login {
        logged_in: Some(secret_load(DCA_SECRET.to_string()).is_some()),
        detail: Some("Muse Code device sign-in".to_string()),
        ..Login::default()
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

async fn form_post(url: &str, fields: &[(&str, &str)]) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(fields)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    let payload = serde_json::from_str::<Value>(&body)
        .map_err(|error| format!("Muse Code returned invalid JSON ({status}): {error}"))?;
    if !status.is_success() {
        return Err(payload["error_description"]
            .as_str()
            .or_else(|| payload["error"].as_str())
            .unwrap_or("Muse Code request failed")
            .to_string());
    }
    Ok(payload)
}

fn save_tokens(dca: &str, access: Option<&str>) -> Result<(), String> {
    secret_save(DCA_SECRET.to_string(), dca.to_string())?;
    if let Some(access) = access.filter(|value| !value.is_empty()) {
        secret_save(ACCESS_SECRET.to_string(), access.to_string())?;
        secret_save(
            EXPIRY_SECRET.to_string(),
            now().saturating_add(24 * 60 * 60).to_string(),
        )?;
    }
    Ok(())
}

pub(crate) async fn mint_key(dca: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(format!("{}/muse-code/key", ENDPOINTS.muse_code.api))
        .bearer_auth(dca)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|error| format!("Muse Code key mint failed: {error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("Muse Code key response was invalid: {error}"))?;
    if !status.is_success() {
        return Err(payload["error_description"]
            .as_str()
            .or_else(|| payload["error"].as_str())
            .unwrap_or("Muse Code key mint rejected")
            .to_string());
    }
    let access = payload["api_key"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("Muse Code key mint returned no API key")?;
    save_tokens(dca, Some(access))?;
    Ok(access.to_string())
}

pub(crate) async fn access_token() -> Result<String, String> {
    let dca = secret_load(DCA_SECRET.to_string()).ok_or("Muse Code is not signed in")?;
    let expires_at = secret_load(EXPIRY_SECRET.to_string())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    if let Some(access) = secret_load(ACCESS_SECRET.to_string()) {
        if expires_at > now().saturating_add(300) {
            return Ok(access);
        }
    }
    mint_key(&dca).await
}

pub(crate) async fn refresh_access_token() -> Result<String, String> {
    let dca = secret_load(DCA_SECRET.to_string()).ok_or("Muse Code is not signed in")?;
    secret_delete(ACCESS_SECRET.to_string())?;
    secret_delete(EXPIRY_SECRET.to_string())?;
    mint_key(&dca).await
}

pub(super) async fn sign_in() -> Result<(), String> {
    let device = form_post(
        &format!("{}/oidc/device/authorization/", ENDPOINTS.muse_code.auth),
        &[("client_id", CLIENT_ID)],
    )
    .await?;
    let device_code = device["device_code"]
        .as_str()
        .ok_or("Muse Code returned no device code")?;
    let verification = device["verification_uri_complete"]
        .as_str()
        .or_else(|| device["verification_uri"].as_str())
        .ok_or("Muse Code returned no verification URL")?;
    crate::browser::open_external(verification.to_string())?;
    let mut interval = device["interval"].as_u64().unwrap_or(5).max(1);
    let deadline = now().saturating_add(device["expires_in"].as_u64().unwrap_or(900));
    while now() < deadline {
        tokio::time::sleep(Duration::from_secs(interval)).await;
        let payload = form_post(
            &format!("{}/oidc/device/token/", ENDPOINTS.muse_code.auth),
            &[
                ("client_id", CLIENT_ID),
                ("device_code", device_code),
                ("grant_type", DEVICE_GRANT),
            ],
        )
        .await;
        match payload {
            Ok(payload) => {
                let dca = payload["access_token"]
                    .as_str()
                    .ok_or("Muse Code returned no device access token")?;
                save_tokens(dca, None)?;
                let _ = mint_key(dca).await;
                return Ok(());
            }
            Err(error) if error.contains("authorization_pending") => {}
            Err(error) if error.contains("slow_down") => interval = interval.saturating_add(5),
            Err(error) => return Err(format!("Muse Code sign-in failed: {error}")),
        }
    }
    Err("Muse Code sign-in expired before it was approved".to_string())
}

fn collect_models(value: &Value, models: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if let Some(id) = object["id"].as_str().filter(|id| !id.is_empty()) {
                if !models.iter().any(|known| known == id) {
                    models.push(id.to_string());
                }
            }
            object
                .values()
                .for_each(|child| collect_models(child, models));
        }
        Value::Array(items) => items.iter().for_each(|item| collect_models(item, models)),
        _ => {}
    }
}

pub(crate) async fn models() -> Result<Vec<String>, String> {
    let token = access_token().await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        // Muse Code exposes the model catalogue through the OpenAI-compatible
        // endpoint used by its inference API; /muse-code/models is not that
        // catalogue path.
        .get(format!("{}/v1/models", ENDPOINTS.muse_code.api))
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Muse Code model catalog failed: {error}"))?;
    let status = response.status();
    let payload: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("Muse Code model catalog returned {status}"));
    }
    let mut models = Vec::new();
    collect_models(&payload["data"], &mut models);
    models.retain(|model| model.len() < 120 && !model.contains('/'));
    if models.is_empty() {
        return Ok([
            "muse-spark-1.3-contributor",
            "muse-spark-1.3",
            "muse-spark-1.2-contributor",
            "muse-spark-1.2",
        ]
        .into_iter()
        .map(str::to_string)
        .collect());
    }
    Ok(models)
}

pub(super) fn logout() -> Result<(), String> {
    for target in [ACCESS_SECRET, DCA_SECRET, EXPIRY_SECRET] {
        secret_delete(target.to_string())?;
    }
    Ok(())
}
