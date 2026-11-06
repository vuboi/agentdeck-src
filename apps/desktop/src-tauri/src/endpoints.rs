//! The addresses of providers, connectors and local model servers, from the one file the frontend reads too
//! (`src/lib/agents/endpoints.json`, built in). Change an address there, not where it is used.

use std::sync::LazyLock;

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anthropic {
    pub console_bootstrap: String,
    /// With `{org}` for the organization's id.
    pub console_prepaid_credits: String,
}

#[derive(Deserialize)]
pub struct OpenRouter {
    pub key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGpt {
    pub home: String,
    pub usage: String,
    pub reset_credits: String,
    pub reset_credits_consume: String,
}

#[derive(Deserialize)]
pub struct Antigravity {
    pub quota: String,
    #[serde(default)]
    pub quota_fallbacks: Vec<String>,
}

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuota {
    pub deepseek_balance: String,
    pub moonshot_balance: String,
    pub moonshot_balance_cn: String,
    pub zai_quota: String,
    pub zai_quota_cn: String,
    pub zai_subscription: String,
    pub mini_max_usage: String,
    pub mini_max_usage_fallback: String,
    pub mini_max_usage_cn: String,
    pub mini_max_usage_cn_fallback: String,
    pub command_code_base: String,
    pub command_code_whoami: String,
    pub command_code_credits: String,
    pub command_code_subscriptions: String,
    pub command_code_summary: String,
    pub cloudflare_analytics: String,
    pub opencode_go_usage: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkBuddy {
    pub home: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuseCode {
    pub auth: String,
    pub api: String,
}
#[derive(Deserialize)]
pub struct Web {
    pub search: String,
    #[serde(rename = "searchApi")]
    pub search_api: String,
    pub bing: String,
    pub duckduckgo: String,
}

#[derive(Deserialize)]
pub struct Local {
    pub kind: String,
    pub label: String,
    pub base: String,
}

/// The versions of the third-party account tools that were read through and are installed (never `latest`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pins {
    pub codex_auth: String,
    pub claude_swap: String,
    pub copilot: String,
    pub command_code: String,
}

#[derive(Deserialize)]
pub struct Endpoints {
    pub pins: Pins,
    pub anthropic: Anthropic,
    pub openrouter: OpenRouter,
    pub chatgpt: ChatGpt,
    pub antigravity: Antigravity,
    #[serde(rename = "providerQuota")]
    pub provider_quota: ProviderQuota,
    pub web: Web,
    pub workbuddy: WorkBuddy,
    #[serde(rename = "museCode")]
    pub muse_code: MuseCode,
    pub local: Vec<Local>,
}

const SOURCE: &str = include_str!("../../src/lib/agents/endpoints.json");

/// The addresses, read once. The file is part of the build and checked by a test, so it always reads.
pub static ENDPOINTS: LazyLock<Endpoints> = LazyLock::new(|| {
    serde_json::from_str(SOURCE)
        .unwrap_or_else(|error| panic!("src/lib/agents/endpoints.json: {error}"))
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_endpoints_file_reads() {
        let endpoints: Endpoints = serde_json::from_str(SOURCE).expect("endpoints.json");
        assert!(endpoints
            .anthropic
            .console_prepaid_credits
            .contains("{org}"));
        assert_eq!(endpoints.local.len(), 3);
        assert!(endpoints
            .local
            .iter()
            .all(|server| server.base.starts_with("http://127.0.0.1:")));
    }
}
