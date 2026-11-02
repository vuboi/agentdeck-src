//! Command Code connector authentication state.
//!
//! The `command-code` CLI owns its sign-in (`command-code login` stores the account there).
//! AgentDeck only asks the CLI whether it is signed in and runs its chat through the CLI; it never reads the token.

use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;

use super::runtime::command;
use super::{capture, which, Login};

/// Reads `command-code status --json`; the CLI answers `{"authenticated": bool, "version": "..."}`.
pub(crate) async fn login_status() -> Login {
    let Some(path) = which("command-code") else {
        return Login::default();
    };
    match capture(&path, &["status", "--json"], Duration::from_secs(10)).await {
        Ok(out) => login_from_status(&out.stdout),
        Err(_) => Login::default(),
    }
}

/// Runs `command-code login` in its own console and waits for it to end: its sign-in is an interactive terminal flow,
/// so it cannot run on the piped stdio the other connectors use.
pub(crate) async fn sign_in() -> Result<(), String> {
    let program = which("command-code").ok_or("Command Code is not installed")?;
    let mut login = command(&program);
    login
        .arg("login")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    login.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE: the CLI gets a terminal for its prompts
    let mut child = login
        .spawn()
        .map_err(|error| format!("could not start Command Code login: {error}"))?;
    tokio::time::timeout(Duration::from_secs(300), child.wait())
        .await
        .map_err(|_| "Command Code sign-in timed out".to_string())?
        .map_err(|error| error.to_string())?;
    if login_status().await.logged_in == Some(true) {
        Ok(())
    } else {
        Err("Command Code sign-in was not completed".to_string())
    }
}

fn login_from_status(stdout: &str) -> Login {
    let Ok(json) = serde_json::from_str::<Value>(stdout) else {
        return Login::default();
    };
    let Some(authenticated) = json["authenticated"].as_bool() else {
        return Login::default();
    };
    Login {
        logged_in: Some(authenticated),
        detail: authenticated.then(|| "Command Code CLI signed in".to_owned()),
        ..Login::default()
    }
}

#[cfg(test)]
mod tests {
    use super::login_from_status;

    #[test]
    fn reads_the_signed_in_flag_of_the_cli_status() {
        assert_eq!(
            login_from_status(r#"{"authenticated":true,"version":"1.88.2"}"#).logged_in,
            Some(true)
        );
        assert_eq!(
            login_from_status(r#"{"authenticated":false,"version":"1.88.2"}"#).logged_in,
            Some(false)
        );
        assert_eq!(login_from_status("not json").logged_in, None);
    }
}
