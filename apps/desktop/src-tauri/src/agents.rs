//! Which agent CLIs are installed here, and which of them are set up (signed in).
//!
//! Surfaces read this instead of a fixed provider list: a CLI that is not installed is hidden everywhere; an installed
//! one is listed in Settings; only a configured one joins the model picker and the MCP and skill targets.

use serde::Serialize;

use crate::connectors::{login_status, which};

/// The CLIs AgentDeck can drive, as (id, binary). Only this table names them; surfaces ask `status`.
const KNOWN: [(&str, &str); 7] = [
    ("claude", "claude"),
    ("codex", "codex"),
    ("antigravity", "agy"),
    ("opencode", "opencode"),
    ("copilot", "copilot"),
    ("command-code", "command-code"),
    ("workbuddy", "codebuddy"),
];

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct AgentStatus {
    pub id: &'static str,
    pub installed: bool,
    pub configured: bool,
}

/// The ids of the installed CLIs, in table order.
pub(crate) fn installed_ids() -> Vec<&'static str> {
    KNOWN
        .iter()
        .filter(|(_, binary)| which(binary).is_some())
        .map(|(id, _)| *id)
        .collect()
}

#[tauri::command]
pub async fn agents_status() -> Vec<AgentStatus> {
    // Each CLI is asked at the same time: a slow sign-in check (Command Code) no longer waits for the others.
    let handles: Vec<_> = KNOWN
        .into_iter()
        .map(|(id, binary)| tokio::spawn(status_of(id, binary)))
        .collect();
    let mut out = Vec::with_capacity(KNOWN.len());
    for handle in handles {
        if let Ok(row) = handle.await {
            out.push(row);
        }
    }
    out
}

async fn status_of(id: &'static str, binary: &'static str) -> AgentStatus {
    let installed = which(binary).is_some();
    let configured = installed
        && match id {
            // Antigravity has no status command: it is set up when one of its accounts is not expired.
            "antigravity" => crate::connectors::antigravity_accounts_list()
                .await
                .iter()
                .any(|account| !account.expired),
            _ => login_status(id).await.logged_in == Some(true),
        };
    AgentStatus {
        id,
        installed,
        configured,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_known_id_has_a_binary_and_a_unique_id() {
        let mut ids: Vec<&str> = KNOWN.iter().map(|(id, _)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), KNOWN.len());
        assert!(KNOWN.iter().all(|(_, binary)| !binary.is_empty()));
    }
}
