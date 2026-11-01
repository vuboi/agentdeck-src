//! Custom OpenAI-compatible provider probing and quota sources.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use reqwest::header::ACCEPT;
use serde::Serialize;
use serde_json::Value;

use crate::endpoints::ENDPOINTS;

use super::{parse_iso, UsageWindow};

#[path = "providers/cloudflare.rs"]
mod cloudflare;
#[path = "providers/command_code.rs"]
mod command_code;
#[path = "providers/minimax.rs"]
mod minimax;
#[path = "providers/zai.rs"]
mod zai;

/// Asks a provider's endpoint for its models: the "Test connection" button. The key, if any, is read from the
/// environment variable the user named and never leaves this function except as a request header.
pub(crate) async fn probe(
    kind: String,
    base_url: String,
    api_key: Option<String>,
    key_env: Option<String>,
) -> crate::providers::custom::Probe {
    crate::providers::custom::probe(
        &kind,
        &base_url,
        api_key.as_deref(),
        key_env.as_deref(),
        Duration::from_secs(6),
    )
    .await
}

/// What a provider says about the spending left on a key.
#[derive(Serialize, Clone)]
pub struct ProviderQuota {
    /// Credit used and the key's limit, in the provider's billing unit (`limit` is null for a key without one).
    used: f64,
    limit: Option<f64>,
    remaining: Option<f64>,
    /// A key with no credit bought: only the `:free` models work, with daily request caps.
    free_tier: bool,
    /// Rate-limit windows read from a balance/usage endpoint or captured from response headers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    windows: Vec<UsageWindow>,
    /// Where the figures came from: `api`, `balance` or `headers`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    /// Currency of `used`/`limit`/`remaining` when the provider does not bill in USD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    currency: Option<String>,
}

/// The rate-limit windows a provider sent in a response, by host and key. Providers that have no balance endpoint
/// (Groq, Cerebras, every other OpenAI-compatible server) still say what is left of the current window in the headers
/// of each reply; keeping the last reading lets the footer and the composer show it instead of "reports no limit".
static RATE_LIMIT_READINGS: LazyLock<Mutex<HashMap<String, (std::time::Instant, ProviderQuota)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Host of a provider's base URL, lowercased and without the port: `https://api.deepseek.com/v1` → `api.deepseek.com`.
fn provider_host(base_url: &str) -> String {
    base_url
        .split("//")
        .nth(1)
        .unwrap_or(base_url)
        .split('/')
        .next()
        .unwrap_or_default()
        .split('@')
        .next_back()
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// A short, non-reversible tag for a key: two saved keys on one provider must not overwrite each other's reading,
/// and the key itself is never kept with the figures.
fn key_tag(api_key: Option<&str>) -> String {
    let Some(key) = api_key.filter(|key| !key.is_empty()) else {
        return "env".to_string();
    };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", hash & 0xffff_ffff)
}

fn reading_key(base_url: &str, api_key: Option<&str>) -> String {
    format!("{}|{}", provider_host(base_url), key_tag(api_key))
}

/// `1.5`, `3599.7`, `2m59.56s`, `2026-10-31T12:00:00Z` or an epoch in seconds/milliseconds → epoch seconds.
fn parse_reset(value: &str, now: i64) -> Option<i64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value.contains('T') {
        return parse_iso(value);
    }
    if value
        .chars()
        .any(|character| character.is_ascii_alphabetic())
    {
        return duration_seconds(value).map(|seconds| now + seconds.round() as i64);
    }
    let number = value.parse::<f64>().ok()?;
    if number > 1e12 {
        Some((number / 1000.0) as i64)
    } else if number > 1e9 {
        Some(number as i64)
    } else {
        Some(now + number.round() as i64)
    }
}

/// `2m59.56s`, `1h`, `90s`, `1.5s` (fractions allowed on the last part) → seconds.
fn duration_seconds(value: &str) -> Option<f64> {
    let mut total = 0.0;
    let mut rest = value;
    let mut parts = 0;
    while let Some(first) = rest.chars().next() {
        if !first.is_ascii_digit() && first != '.' {
            return None;
        }
        let end = rest
            .find(|character: char| character.is_ascii_alphabetic())
            .unwrap_or(rest.len());
        let amount = rest[..end].parse::<f64>().ok()?;
        let unit = rest[end..].chars().next()?;
        total += match unit {
            'h' => amount * 3600.0,
            'm' => amount * 60.0,
            's' => amount,
            'd' => amount * 86_400.0,
            _ => return None,
        };
        rest = &rest[end + unit.len_utf8()..];
        parts += 1;
    }
    (parts > 0).then_some(total)
}

/// Rate-limit windows in a response's headers. Both name orders are read (`x-ratelimit-remaining-requests` as served
/// by Groq/Cerebras/OpenRouter, and `anthropic-ratelimit-requests-remaining` as served by Anthropic).
fn parse_rate_windows(headers: &reqwest::header::HeaderMap, now: i64) -> Vec<UsageWindow> {
    struct Row {
        limit: Option<f64>,
        remaining: Option<f64>,
        reset: Option<i64>,
    }
    let mut rows: Vec<(String, Row)> = Vec::new();
    for (name, value) in headers.iter() {
        let name = name.as_str().to_ascii_lowercase();
        let rest = name
            .strip_prefix("anthropic-ratelimit-")
            .or_else(|| name.strip_prefix("x-ratelimit-"))
            .or_else(|| name.strip_prefix("ratelimit-"));
        let Some(rest) = rest else { continue };
        let Ok(text) = value.to_str() else { continue };
        let parts: Vec<&str> = rest.split('-').collect();
        let field = parts
            .iter()
            .copied()
            .find(|part| matches!(*part, "limit" | "remaining" | "reset"))
            .unwrap_or_default();
        if field.is_empty() {
            continue;
        }
        let dimension = parts
            .iter()
            .copied()
            .filter(|part| *part != field)
            .collect::<Vec<_>>()
            .join("-");
        if dimension.is_empty() {
            continue;
        }
        let row = match rows.iter_mut().find(|(name, _)| *name == dimension) {
            Some((_, row)) => row,
            None => {
                rows.push((
                    dimension.clone(),
                    Row {
                        limit: None,
                        remaining: None,
                        reset: None,
                    },
                ));
                let Some((_, row)) = rows.last_mut() else {
                    continue;
                };
                row
            }
        };
        match field {
            "limit" => row.limit = text.trim().parse::<f64>().ok().filter(|value| *value > 0.0),
            "remaining" => row.remaining = text.trim().parse::<f64>().ok(),
            "reset" => row.reset = parse_reset(text, now),
            _ => {}
        }
    }
    rows.into_iter()
        .filter_map(|(dimension, row)| {
            let limit = row.limit?;
            let remaining = row.remaining?.clamp(0.0, limit);
            Some(UsageWindow {
                label: dimension.replace('-', " "),
                pct: ((limit - remaining) / limit * 100.0).clamp(0.0, 100.0),
                resets_at: row.reset,
                remaining: Some(remaining),
                limit: Some(limit),
            })
        })
        .collect()
}

/// Keeps the rate-limit windows of one reply. Called by the chat runtime with the headers of the response it is about
/// to stream; a server that sends none changes nothing.
pub(crate) fn capture_rate_limits(
    base_url: &str,
    api_key: Option<&str>,
    headers: &reqwest::header::HeaderMap,
) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64);
    let windows = parse_rate_windows(headers, now);
    if windows.is_empty() {
        return;
    }
    let quota = ProviderQuota {
        used: 0.0,
        limit: None,
        remaining: None,
        free_tier: false,
        windows,
        source: Some("headers".to_string()),
        currency: None,
    };
    if let Ok(mut readings) = RATE_LIMIT_READINGS.lock() {
        readings.insert(
            reading_key(base_url, api_key),
            (std::time::Instant::now(), quota),
        );
    }
}

/// The last windows a provider sent, while they still describe the current limits (30 minutes).
fn saved_rate_limits(base_url: &str, api_key: Option<&str>) -> Option<ProviderQuota> {
    let readings = RATE_LIMIT_READINGS.lock().ok()?;
    let (at, quota) = readings.get(&reading_key(base_url, api_key))?;
    (at.elapsed() < Duration::from_secs(30 * 60)).then(|| quota.clone())
}

/// The spending left on a key, for the providers that tell it. OpenRouter (`GET /key`), DeepSeek
/// (`GET /user/balance`) and Moonshot (`GET /users/me/balance`) expose a balance/limit endpoint; every other provider
/// contributes the rate-limit windows captured from its replies (`source: "headers"`). `None` keeps the last reading.
pub(crate) async fn quota(
    base_url: String,
    api_key: Option<String>,
    key_env: Option<String>,
) -> Option<ProviderQuota> {
    let host = provider_host(&base_url);
    let key = api_key.clone().filter(|key| !key.is_empty()).or_else(|| {
        key_env
            .filter(|name| !name.is_empty())
            .and_then(|name| std::env::var(name).ok())
            .filter(|value| !value.is_empty())
    });
    let captured = saved_rate_limits(&base_url, key.as_deref());
    let is_openrouter = host == "openrouter.ai" || host.ends_with(".openrouter.ai");
    let is_deepseek = host == "api.deepseek.com" || host.ends_with(".deepseek.com");
    let is_moonshot = host == "api.moonshot.ai"
        || host == "api.moonshot.cn"
        || host.ends_with(".moonshot.ai")
        || host.ends_with(".moonshot.cn");
    let Some(key) = key else {
        return captured;
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;

    if zai::supports_host(&host) {
        return zai::fetch(&client, &host, &key).await.or(captured);
    }
    if minimax::supports_host(&host) {
        return minimax::fetch(&client, &host, &key).await.or(captured);
    }
    if command_code::supports_host(&host) {
        return command_code::fetch(&client, &key).await.or(captured);
    }
    if cloudflare::supports_host(&host) {
        return cloudflare::fetch(&client, &base_url, &key)
            .await
            .or(captured);
    }
    if !is_openrouter && !is_deepseek && !is_moonshot {
        return captured;
    }

    if is_deepseek {
        // DeepSeek: GET https://api.deepseek.com/user/balance
        // { "is_available": true, "balance_infos": [{ "currency": "CNY"|"USD", "total_balance": "...", ... }] }
        let response = client
            .get(ENDPOINTS.provider_quota.deepseek_balance.as_str())
            .bearer_auth(&key)
            .header(ACCEPT, "application/json")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return captured;
        }
        let json: Value = response.json().await.ok()?;
        let infos = json["balance_infos"].as_array()?;
        let info = infos
            .iter()
            .find(|item| item["currency"].as_str() == Some("USD"))
            .or_else(|| infos.first())?;
        let total = balance_amount(&info["total_balance"])?;
        let mut quota = ProviderQuota {
            used: 0.0,
            limit: None,
            remaining: Some(total),
            free_tier: false,
            windows: Vec::new(),
            source: Some("balance".to_string()),
            currency: info["currency"].as_str().map(str::to_owned),
        };
        if let Some(captured) = captured {
            quota.windows = captured.windows;
        }
        return Some(quota);
    }

    if is_moonshot {
        // Moonshot: GET https://api.moonshot.ai/v1/users/me/balance
        // { "code": 0, "data": { "available_balance": 100.0, "voucher_balance": ..., "cash_balance": ... } }
        let url = if host.ends_with(".cn") {
            ENDPOINTS.provider_quota.moonshot_balance_cn.as_str()
        } else {
            ENDPOINTS.provider_quota.moonshot_balance.as_str()
        };
        let response = client
            .get(url)
            .bearer_auth(&key)
            .header(ACCEPT, "application/json")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return captured;
        }
        let json: Value = response.json().await.ok()?;
        if json["code"].as_i64() != Some(0) || json["status"].as_bool() == Some(false) {
            return captured;
        }
        let data = &json["data"];
        let total = balance_amount(&data["available_balance"])
            .or_else(|| balance_amount(&data["cash_balance"]))?;
        let currency = data["currency"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| Some(if host.ends_with(".cn") { "CNY" } else { "USD" }.to_string()));
        let mut quota = ProviderQuota {
            used: 0.0,
            limit: None,
            remaining: Some(total),
            free_tier: false,
            windows: Vec::new(),
            source: Some("balance".to_string()),
            currency,
        };
        if let Some(captured) = captured {
            quota.windows = captured.windows;
        }
        return Some(quota);
    }

    let response = client
        .get(ENDPOINTS.openrouter.key.as_str())
        .bearer_auth(key)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return captured;
    }
    let json: Value = response.json().await.ok()?;
    let data = &json["data"];
    Some(ProviderQuota {
        used: data["usage"].as_f64().unwrap_or(0.0),
        limit: data["limit"].as_f64(),
        remaining: data["limit_remaining"].as_f64(),
        free_tier: data["is_free_tier"].as_bool().unwrap_or(false),
        windows: captured.map(|quota| quota.windows).unwrap_or_default(),
        source: Some("api".to_string()),
        currency: None,
    })
}

/// A balance as a number or as a decimal string (`"100.00"`), which is how DeepSeek sends it.
fn balance_amount(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
}
