//! Which build this is, from its bundle identifier. The installed app keeps `~/.agentdeck` and the `agentdeck` MCP
//! server name; a dev or local build gets its own folder and its own name, so two builds never read or write one
//! another's state, and an agent config (Antigravity's MCP file is global) only ever points at the build that wrote it.

use std::sync::OnceLock;

static IDENTIFIER: OnceLock<String> = OnceLock::new();

/// Called once at start-up, before anything reads a folder or a name.
pub fn init(identifier: &str) {
    let _ = IDENTIFIER.set(identifier.to_string());
}

fn identifier() -> &'static str {
    IDENTIFIER
        .get()
        .map_or("dev.agentdeck.desktop", String::as_str)
}

/// The folder under the home folder for this build's data.
pub fn home_folder_name() -> &'static str {
    home_folder_for(identifier())
}

fn home_folder_for(identifier: &str) -> &'static str {
    match identifier {
        "dev.agentdeck.desktop" => ".agentdeck",
        "dev.agentdeck.desktop.dev" => ".agentdeck-dev",
        "dev.agentdeck.desktop.local" => ".agentdeck-local",
        "dev.agentdeck.desktop.harnessproof" => ".agentdeck-harnessproof",
        _ => ".agentdeck-other",
    }
}

/// The name this build registers its AgentDeck browser server under in agent configs.
pub fn server_name() -> &'static str {
    server_name_for(identifier())
}

fn server_name_for(identifier: &str) -> &'static str {
    match identifier {
        "dev.agentdeck.desktop" => "agentdeck",
        "dev.agentdeck.desktop.dev" => "agentdeck-dev",
        "dev.agentdeck.desktop.local" => "agentdeck-local",
        "dev.agentdeck.desktop.harnessproof" => "agentdeck-harnessproof",
        _ => "agentdeck-other",
    }
}

/// Any build's AgentDeck browser server name: never offered as a third-party server, and not a name a user may add.
pub fn is_bridge_name(name: &str) -> bool {
    matches!(
        name,
        "agentdeck"
            | "agentdeck-dev"
            | "agentdeck-local"
            | "agentdeck-harnessproof"
            | "agentdeck-other"
    )
}

#[cfg(test)]
mod tests {
    use super::{home_folder_for, is_bridge_name, server_name_for};

    #[test]
    fn harness_proof_channel_has_private_data_and_bridge_names() {
        let identifier = "dev.agentdeck.desktop.harnessproof";
        assert_eq!(home_folder_for(identifier), ".agentdeck-harnessproof");
        assert_eq!(server_name_for(identifier), "agentdeck-harnessproof");
        assert!(is_bridge_name("agentdeck-harnessproof"));
    }
}
