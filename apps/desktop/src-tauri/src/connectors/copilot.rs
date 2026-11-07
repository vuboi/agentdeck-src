//! GitHub Copilot account quota connector.

use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use super::{capture, parse_iso, UsageWindow};

/// Premium-request quota of the account `gh` is signed in as, from `copilot_internal/user`.
pub(crate) async fn usage(gh: &Path) -> Option<(Vec<UsageWindow>, i64)> {
    let out = capture(
        gh,
        &["api", "copilot_internal/user"],
        Duration::from_secs(15),
    )
    .await
    .ok()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    out.ok.then(|| parse_usage(&out.stdout, now)).flatten()
}

/// `copilot_internal/user` JSON to the premium-request window. An unlimited plan has no window.
pub(crate) fn parse_usage(text: &str, now: i64) -> Option<(Vec<UsageWindow>, i64)> {
    let json: Value = serde_json::from_str(text).ok()?;
    let premium = &json["quota_snapshots"]["premium_interactions"];
    if premium["unlimited"].as_bool().unwrap_or(false) {
        return Some((Vec::new(), now));
    }
    let left = premium["percent_remaining"]
        .as_f64()
        .or_else(|| premium["percent_remaining"].as_str()?.parse().ok())?;
    let window = UsageWindow {
        label: "30d".into(),
        pct: (100.0 - left).clamp(0.0, 100.0),
        resets_at: json["quota_reset_date"]
            .as_str()
            .and_then(|date| parse_iso(&format!("{date}T00:00:00Z"))),
        remaining: None,
        limit: None,
    };
    Some((vec![window], now))
}
