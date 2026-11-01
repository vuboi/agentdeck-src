use reqwest::{header::ACCEPT, Client};
use serde_json::Value;

use crate::endpoints::ENDPOINTS;

use super::{ProviderQuota, UsageWindow};

pub(crate) fn supports_host(host: &str) -> bool {
    host == "api.commandcode.ai" || host.ends_with(".commandcode.ai")
}

pub(crate) async fn fetch(client: &Client, key: &str) -> Option<ProviderQuota> {
    let whoami = get(
        client,
        ENDPOINTS.provider_quota.command_code_whoami.as_str(),
        key,
    )
    .await
    .unwrap_or(Value::Null);
    let org_id = get_string(&whoami["org"]["id"]);
    let query = org_id.map(|id| format!("?orgId={id}"));
    let url = query
        .as_deref()
        .map(|suffix| {
            format!(
                "{}{}",
                ENDPOINTS.provider_quota.command_code_credits, suffix
            )
        })
        .unwrap_or_else(|| ENDPOINTS.provider_quota.command_code_credits.clone());
    let credits = get(client, &url, key).await?;
    let limits = &credits["windowLimits"];
    let mut windows = Vec::new();
    for (key_name, label) in [("fiveHour", "5-hour"), ("weekly", "weekly")] {
        let window = &limits[key_name];
        let Some(cap) = number(&window["cap"]).filter(|cap| *cap > 0.0) else {
            continue;
        };
        let used = number(&window["used"]).unwrap_or(0.0).clamp(0.0, cap);
        windows.push(UsageWindow {
            label: label.to_string(),
            pct: used / cap * 100.0,
            resets_at: epoch_seconds(&window["resetAt"]),
            remaining: Some(cap - used),
            limit: Some(cap),
        });
    }
    let remaining = ["monthlyCredits", "purchasedCredits", "freeCredits"]
        .iter()
        .map(|key| number(&credits["credits"][*key]).unwrap_or(0.0).max(0.0))
        .sum::<f64>();
    (!windows.is_empty() || remaining > 0.0).then_some(ProviderQuota {
        used: 0.0,
        limit: None,
        remaining: Some(remaining),
        free_tier: false,
        windows,
        source: Some("api".to_string()),
        currency: Some("USD".to_string()),
    })
}

async fn get(client: &Client, url: &str, key: &str) -> Option<Value> {
    let response = client
        .get(url)
        .bearer_auth(key)
        .header(ACCEPT, "application/json")
        .send()
        .await
        .ok()?;
    response.error_for_status().ok()?.json().await.ok()
}

fn get_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
}

fn epoch_seconds(value: &Value) -> Option<i64> {
    let value = value.as_str()?;
    if let Ok(number) = value.parse::<f64>() {
        return Some(if number > 1e12 {
            (number / 1000.0) as i64
        } else {
            number as i64
        });
    }
    super::super::parse_iso(value)
}
