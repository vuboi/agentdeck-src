//! Command Code connector authentication state.
//!
//! The `command-code` CLI owns its sign-in (`command-code login` stores the account there).
//! AgentDeck only asks the CLI whether it is signed in and runs its chat through the CLI; it never reads the token.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;

use super::runtime::{command, KillTree};
use super::{capture, which, Login};

/// Reads `command-code status --json`; the CLI answers `{"authenticated": bool, "version": "..."}`.
pub(crate) async fn login_status() -> Login {
    let Some(path) = which("command-code") else {
        return Login::default();
    };
    match capture(
        &path,
        &["status", "--json", "--no-auto-update"],
        Duration::from_secs(10),
    )
    .await
    {
        Ok(out) => login_from_status(&out.stdout),
        Err(_) => Login::default(),
    }
}

/// Runs `command-code login` in its own console and waits until it signs in or ends: its sign-in is an interactive
/// terminal flow, so it cannot run on the piped stdio the other connectors use.
pub(crate) async fn sign_in() -> Result<(), String> {
    let program = which("command-code").ok_or("Command Code is not installed")?;
    // `start /WAIT` opens the CLI in its own console window. Handing the CLI our GUI process's stdio
    // (`Stdio::inherit`, which is empty here) made it exit before it could prompt.
    // `start` runs a `.cmd` shim as `cmd /K`, which keeps the console open after the CLI ends and so never returns;
    // the `cmd /C` wrapper closes it when the CLI exits.
    #[cfg(windows)]
    let mut login = {
        use std::os::windows::process::CommandExt;
        let mut login = command(Path::new("cmd"));
        login.as_std_mut().raw_arg(format!(
            "/D /S /C \"start \"\" /WAIT cmd /D /S /C \"\"{}\" login\"\"",
            program.display()
        ));
        login
    };
    #[cfg(not(windows))]
    let mut login = {
        let mut login = command(&program);
        login.arg("login");
        login
    };
    login
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = login
        .spawn()
        .map_err(|error| format!("could not start Command Code login: {error}"))?;
    // Ends the console tree when this returns early (signed in, cancelled or timed out).
    let _console = KillTree::of(&child);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    // The CLI can sign in and still stay open, so the saved sign-in is checked while it runs.
    while tokio::time::Instant::now() < deadline {
        tokio::select! {
            _ = child.wait() => break,
            _ = tokio::time::sleep(Duration::from_secs(2)) => {
                if login_status().await.logged_in == Some(true) {
                    return Ok(());
                }
            }
        }
    }
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
        email: authenticated
            .then(|| json["user"].as_str().map(str::to_owned))
            .flatten(),
        detail: authenticated.then(|| match json["model"].as_str() {
            Some(model) => format!("Command Code CLI signed in · {model}"),
            None => "Command Code CLI signed in".to_owned(),
        }),
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

    #[test]
    fn keeps_the_user_and_model_of_the_cli_status() {
        let login = login_from_status(r#"{"authenticated":true,"user":"vuboi","model":"m1"}"#);
        assert_eq!(login.email.as_deref(), Some("vuboi"));
        assert!(login.detail.is_some_and(|detail| detail.contains("m1")));
    }
}
