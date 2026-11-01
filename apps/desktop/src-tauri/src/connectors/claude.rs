//! Claude Code account and Claude Console credit connector.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::endpoints::ENDPOINTS;

use super::{parse_iso, Account, UsageWindow};

pub(crate) fn parse_cswap(text: &str) -> Result<Vec<Account>, String> {
    let json: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    if let Some(error) = json.get("error") {
        return Err(error["message"]
            .as_str()
            .map_or_else(|| error.to_string(), str::to_owned));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64);
    Ok(json["accounts"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let number = item["number"].as_i64()?;
                    let windows: Vec<UsageWindow> = [("fiveHour", "5h"), ("sevenDay", "7d")]
                        .iter()
                        .filter_map(|(key, label)| {
                            let window = &item["usage"][*key];
                            Some(UsageWindow {
                                label: (*label).to_string(),
                                pct: window["pct"].as_f64()?,
                                resets_at: window["resetsAt"].as_str().and_then(parse_iso),
                                remaining: None,
                                limit: None,
                            })
                        })
                        .collect();
                    let status = item["usageStatus"]
                        .as_str()
                        .filter(|status| *status != "ok")
                        .map(str::to_owned);
                    Some(Account {
                        expired: status.as_deref() == Some("expired"),
                        id: number.to_string(),
                        email: item["email"].as_str().unwrap_or("(unknown)").to_owned(),
                        alias: item["alias"]
                            .as_str()
                            .filter(|alias| !alias.is_empty())
                            .map(str::to_owned),
                        plan: item["plan"].as_str().map(str::to_owned),
                        active: item["active"].as_bool().unwrap_or(false),
                        observed_at: (!windows.is_empty()).then_some(now),
                        usage: windows,
                        status,
                        reset_credits_available: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// The prepaid credit of the Claude Console organization, read from its billing page endpoints.
#[derive(Serialize)]
pub struct ConsoleCredit {
    pub(crate) balance: f64,
    pub(crate) granted: Option<f64>,
    pub(crate) expires_at: Option<String>,
}

fn minor_amount(value: &Value, exponent: i64) -> Option<f64> {
    let minor = value.as_f64()?;
    (0..=6)
        .contains(&exponent)
        .then(|| minor / 10f64.powi(exponent as i32))
}

/// Reads the Console's prepaid credit with its sign-in cookie. These are undocumented Console routes and may change.
pub(crate) async fn console_credit(session_key: String) -> Result<ConsoleCredit, String> {
    let key = session_key.trim();
    let key = key.strip_prefix("sessionKey=").unwrap_or(key);
    if key.is_empty() {
        return Err("no Console session key".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")
        .build()
        .map_err(|error| error.to_string())?;
    let get = |url: String| {
        client
            .get(url)
            .header("Cookie", format!("sessionKey={key}"))
            .header("Accept", "application/json")
            .send()
    };
    let read = |response: reqwest::Response| async move {
        match response.status().as_u16() {
            200..=299 => response
                .json::<Value>()
                .await
                .map_err(|error| format!("not the Console's answer: {error}")),
            401 | 403 => Err("the Console session ended: copy a new sessionKey".to_string()),
            code => Err(format!("the Console answered {code}")),
        }
    };
    let boot = read(
        get(ENDPOINTS.anthropic.console_bootstrap.clone())
            .await
            .map_err(|error| error.to_string())?,
    )
    .await?;
    let org = boot["account"]["memberships"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|member| &member["organization"])
        .find(|org| {
            org["capabilities"]
                .as_array()
                .is_some_and(|caps| caps.iter().any(|cap| cap == "api"))
        })
        .and_then(|org| org["uuid"].as_str())
        .ok_or("this sign-in has no API organization")?
        .to_string();
    let body = read(
        get(ENDPOINTS
            .anthropic
            .console_prepaid_credits
            .replace("{org}", &org))
        .await
        .map_err(|error| error.to_string())?,
    )
    .await?;
    let credits = &body["balance"]["credits"];
    let exponent = credits["exponent"].as_i64().unwrap_or(2);
    let balance =
        minor_amount(&credits["amount_minor"], exponent).ok_or("the Console sent no balance")?;
    let grants: Vec<&Value> = ["promo_tranches", "tranches"]
        .iter()
        .filter_map(|name| body[*name].as_array())
        .flatten()
        .filter(|grant| {
            grant["remaining_amount_minor_units"]
                .as_f64()
                .unwrap_or(0.0)
                > 0.0
        })
        .collect();
    let granted: f64 = grants
        .iter()
        .filter_map(|grant| {
            [
                "amount_minor_units",
                "initial_amount_minor_units",
                "original_amount_minor_units",
            ]
            .iter()
            .find_map(|field| minor_amount(&grant[*field], exponent))
        })
        .sum();
    let expires_at = grants
        .iter()
        .filter_map(|grant| grant["expires_at"].as_str())
        .min()
        .map(str::to_string);
    Ok(ConsoleCredit {
        balance,
        granted: (granted >= balance && granted > 0.0).then_some(granted),
        expires_at,
    })
}
