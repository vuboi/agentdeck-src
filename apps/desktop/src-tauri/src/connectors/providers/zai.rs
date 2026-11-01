use reqwest::{header::ACCEPT, Client};
use serde_json::Value;

use crate::endpoints::ENDPOINTS;

use super::{ProviderQuota, UsageWindow};

pub(crate) fn supports_host(host: &str) -> bool {
    host == "api.z.ai" || host.ends_with(".z.ai") || host == "open.bigmodel.cn"
}

pub(crate) async fn fetch(client: &Client, host: &str, key: &str) -> Option<ProviderQuota> {
    let endpoint = if host == "open.bigmodel.cn" {
        ENDPOINTS.provider_quota.zai_quota_cn.as_str()
    } else {
        ENDPOINTS.provider_quota.zai_quota.as_str()
    };
    let response = client
        .get(endpoint)
        .bearer_auth(key)
        .header(ACCEPT, "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let json: Value = response.json().await.ok()?;
    let limits = json["data"]["limits"].as_array()?;
    let mut windows = Vec::new();
    for limit in limits {
        let kind = limit["type"].as_str().unwrap_or("quota");
        let percentage = number(&limit["percentage"])
            .unwrap_or(0.0)
            .clamp(0.0, 100.0);
        let reset = epoch_seconds(&limit["nextResetTime"]);
        let label = match kind {
            "TIME_LIMIT" => "monthly".to_string(),
            "CREDIT_LIMIT" if number(&limit["number"]) == Some(5.0) => "5h credits".to_string(),
            "CREDIT_LIMIT" if number(&limit["number"]) == Some(1.0) => "weekly credits".to_string(),
            "TOKENS_LIMIT" if number(&limit["number"]) == Some(5.0) => "5h tokens".to_string(),
            "TOKENS_LIMIT" if number(&limit["number"]) == Some(1.0) => "weekly tokens".to_string(),
            other => other.to_ascii_lowercase().replace('_', " "),
        };
        windows.push(UsageWindow {
            label,
            pct: percentage,
            resets_at: reset,
            remaining: None,
            limit: None,
        });
    }
    (!windows.is_empty()).then_some(ProviderQuota {
        used: 0.0,
        limit: None,
        remaining: None,
        free_tier: false,
        windows,
        source: Some("api".to_string()),
        currency: None,
    })
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
}

fn epoch_seconds(value: &Value) -> Option<i64> {
    let value = number(value)?;
    Some(if value > 1e12 {
        (value / 1000.0) as i64
    } else {
        value as i64
    })
}
