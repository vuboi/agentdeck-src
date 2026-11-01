use reqwest::{header::ACCEPT, Client};
use serde_json::{json, Value};

use crate::endpoints::ENDPOINTS;

use super::{ProviderQuota, UsageWindow};

const QUERY: &str = "query WorkersAiDailyUsage($accountTag: string!, $since: Date!) { viewer { accounts(filter: { accountTag: $accountTag }) { aiInferenceAdaptiveGroups(filter: { date_geq: $since }, limit: 100) { count sum { totalNeurons } } } } }";

pub(crate) fn supports_host(host: &str) -> bool {
    host == "api.cloudflare.com" || host.ends_with(".cloudflare.com")
}

pub(crate) async fn fetch(client: &Client, base_url: &str, key: &str) -> Option<ProviderQuota> {
    let account_id = account_id(base_url)?;
    let today = utc_date();
    let response = client
        .post(ENDPOINTS.provider_quota.cloudflare_analytics.as_str())
        .bearer_auth(key)
        .header(ACCEPT, "application/json")
        .json(&json!({
            "query": QUERY,
            "variables": { "accountTag": account_id, "since": today }
        }))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let json: Value = response.json().await.ok()?;
    if json["errors"]
        .as_array()
        .is_some_and(|errors| !errors.is_empty())
    {
        return None;
    }
    let groups = json["data"]["viewer"]["accounts"][0]["aiInferenceAdaptiveGroups"].as_array()?;
    let neurons = groups
        .iter()
        .map(|group| {
            number(&group["sum"]["totalNeurons"])
                .unwrap_or(0.0)
                .max(0.0)
        })
        .sum::<f64>();
    let requests = groups
        .iter()
        .map(|group| number(&group["count"]).unwrap_or(0.0).max(0.0))
        .sum::<f64>();
    Some(ProviderQuota {
        used: neurons,
        limit: Some(10_000.0),
        remaining: Some((10_000.0 - neurons).max(0.0)),
        free_tier: true,
        windows: vec![
            UsageWindow {
                label: "neurons daily".to_string(),
                pct: (neurons / 10_000.0 * 100.0).clamp(0.0, 100.0),
                resets_at: Some(next_midnight()),
                remaining: Some((10_000.0 - neurons).max(0.0)),
                limit: Some(10_000.0),
            },
            UsageWindow {
                label: "requests today".to_string(),
                pct: 0.0,
                resets_at: Some(next_midnight()),
                remaining: Some(requests),
                limit: None,
            },
        ],
        source: Some("api".to_string()),
        currency: None,
    })
}

fn account_id(base_url: &str) -> Option<String> {
    let marker = "/accounts/";
    let rest = base_url.split_once(marker)?.1;
    let id = rest.split('/').next()?.trim();
    (!id.is_empty() && id != "{account_id}").then_some(id.to_string())
}

fn utc_date() -> String {
    // The GraphQL API expects YYYY-MM-DD. This civil-date conversion avoids adding a date crate.
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs() / 86_400) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    format!("{year:04}-{month:02}-{day:02}")
}

fn next_midnight() -> i64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    i64::try_from(((now / 86_400) + 1) * 86_400).unwrap_or(i64::MAX)
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
}
