use reqwest::{header::ACCEPT, Client};
use serde_json::Value;

use crate::endpoints::ENDPOINTS;

use super::{ProviderQuota, UsageWindow};

pub(crate) fn supports_host(host: &str) -> bool {
    host == "api.minimax.io"
        || host.ends_with(".minimax.io")
        || host == "api.minimaxi.com"
        || host.ends_with(".minimaxi.com")
}

pub(crate) async fn fetch(client: &Client, host: &str, key: &str) -> Option<ProviderQuota> {
    let urls = if host.ends_with(".minimaxi.com") {
        [
            ENDPOINTS.provider_quota.mini_max_usage_cn.as_str(),
            ENDPOINTS.provider_quota.mini_max_usage_cn_fallback.as_str(),
        ]
    } else {
        [
            ENDPOINTS.provider_quota.mini_max_usage.as_str(),
            ENDPOINTS.provider_quota.mini_max_usage_fallback.as_str(),
        ]
    };
    for url in urls {
        let response = match client
            .get(url)
            .bearer_auth(key)
            .header(ACCEPT, "application/json")
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => continue,
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(json) = response.json().await else {
            continue;
        };
        if let Some(quota) = parse(&json) {
            return Some(quota);
        }
    }
    None
}

fn parse(json: &Value) -> Option<ProviderQuota> {
    let models = json["model_remains"].as_array()?;
    let mut windows = Vec::new();
    let mut scalar: Option<(f64, f64)> = None;
    for model in models {
        let name = model["model_name"].as_str().unwrap_or("MiniMax");
        let total = number(&model["current_interval_total_count"]).unwrap_or(0.0);
        let used = number(&model["current_interval_usage_count"]);
        let remaining_percent = number(&model["current_interval_remaining_percent"]);
        let reset = epoch_seconds(&model["end_time"]);
        if total > 0.0 {
            let used = used.unwrap_or(0.0).clamp(0.0, total);
            scalar.get_or_insert((used, total));
            windows.push(UsageWindow {
                label: format!("{name} interval"),
                pct: used / total * 100.0,
                resets_at: reset,
                remaining: Some(total - used),
                limit: Some(total),
            });
        } else if let Some(remaining) = remaining_percent {
            windows.push(UsageWindow {
                label: format!("{name} interval"),
                pct: (100.0 - remaining).clamp(0.0, 100.0),
                resets_at: reset,
                remaining: None,
                limit: None,
            });
        }

        let weekly_total = number(&model["current_weekly_total_count"]).unwrap_or(0.0);
        let weekly_used = number(&model["current_weekly_usage_count"]);
        let weekly_remaining = number(&model["current_weekly_remaining_percent"]);
        let weekly_reset = epoch_seconds(&model["weekly_end_time"]);
        if weekly_total > 0.0 {
            let used = weekly_used.unwrap_or(0.0).clamp(0.0, weekly_total);
            scalar.get_or_insert((used, weekly_total));
            windows.push(UsageWindow {
                label: format!("{name} weekly"),
                pct: used / weekly_total * 100.0,
                resets_at: weekly_reset,
                remaining: Some(weekly_total - used),
                limit: Some(weekly_total),
            });
        } else if let Some(remaining) = weekly_remaining {
            windows.push(UsageWindow {
                label: format!("{name} weekly"),
                pct: (100.0 - remaining).clamp(0.0, 100.0),
                resets_at: weekly_reset,
                remaining: None,
                limit: None,
            });
        }
    }
    (!windows.is_empty()).then(|| {
        let (used, limit) = scalar.unwrap_or((0.0, 0.0));
        ProviderQuota {
            used,
            limit: (limit > 0.0).then_some(limit),
            remaining: (limit > 0.0).then_some((limit - used).max(0.0)),
            free_tier: false,
            windows,
            source: Some("api".to_string()),
            currency: None,
        }
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
