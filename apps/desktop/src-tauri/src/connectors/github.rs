//! GitHub CLI account state used by the GitHub Copilot connector.

use std::time::Duration;

use super::{capture, copilot_usage, which, Account, Accounts, Login};

/// Reads the active GitHub CLI account without loading or persisting a token.
pub(crate) async fn login() -> Login {
    let Some(gh) = which("gh") else {
        return Login::default();
    };
    match capture(
        &gh,
        &["auth", "status", "--hostname", "github.com"],
        Duration::from_secs(10),
    )
    .await
    {
        Ok(out) => {
            let text = format!("{}\n{}", out.stdout, out.stderr);
            let email = text.lines().find_map(|line| {
                let (_, account) = line.split_once("Logged in to github.com account ")?;
                Some(
                    account
                        .split_whitespace()
                        .next()?
                        .trim_matches(['(', ')'])
                        .to_owned(),
                )
            });
            Login {
                logged_in: Some(out.ok || email.is_some()),
                email,
                plan: None,
                detail: Some("GitHub CLI".into()),
            }
        }
        Err(_) => Login::default(),
    }
}

/// Lists GitHub accounts and refreshes Copilot usage for the active account only.
pub(crate) async fn accounts(account_id: Option<String>) -> Result<Accounts, String> {
    let Some(gh) = which("gh") else {
        return Ok(Accounts {
            manager: false,
            accounts: Vec::new(),
            auto_switch: None,
            error: None,
        });
    };
    let out = capture(
        &gh,
        &["auth", "status", "--hostname", "github.com"],
        Duration::from_secs(10),
    )
    .await?;
    let text = format!("{}\n{}", out.stdout, out.stderr);
    let mut accounts = Vec::new();
    let mut current: Option<(String, bool)> = None;
    for line in text.lines() {
        if let Some((_, rest)) = line.split_once("Logged in to github.com account ") {
            if let Some((id, active)) = current.take() {
                accounts.push((id, active));
            }
            let id = rest
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .trim_matches(['(', ')'])
                .to_owned();
            current = Some((id, false));
        } else if line.contains("Active account: true") {
            if let Some((_, active)) = current.as_mut() {
                *active = true;
            }
        }
    }
    if let Some(row) = current {
        accounts.push(row);
    }
    if accounts.len() == 1 && !accounts[0].1 {
        accounts[0].1 = true;
    }
    let mut rows: Vec<Account> = accounts
        .into_iter()
        .map(|(id, active)| Account {
            id: id.clone(),
            email: id,
            alias: None,
            plan: Some("GitHub Copilot".into()),
            active,
            usage: Vec::new(),
            observed_at: None,
            status: None,
            expired: false,
            reset_credits_available: None,
        })
        .collect();
    // The usage call answers for the account `gh` is signed in as, which is the active row.
    let usage_id = account_id
        .clone()
        .or_else(|| rows.iter().find(|row| row.active).map(|row| row.id.clone()));
    if let Some(row) = rows
        .iter_mut()
        .find(|row| usage_id.as_deref() == Some(row.id.as_str()))
    {
        if row.active {
            if let Some((usage, observed)) = copilot_usage(&gh).await {
                row.usage = usage;
                row.observed_at = Some(observed);
            } else {
                row.status = Some("Live Copilot quota is unavailable for this account".into());
            }
        } else if account_id.is_some() {
            row.status =
                Some("Copilot quota can only be refreshed for the active GitHub account".into());
        }
    }
    Ok(Accounts {
        manager: true,
        accounts: rows,
        auto_switch: None,
        error: (!out.ok && text.is_empty()).then(|| "GitHub CLI is not signed in".into()),
    })
}

/// Switches the active account in GitHub CLI.
pub(crate) async fn switch(id: &str) -> Result<(), String> {
    let gh = which("gh").ok_or("`gh` is not installed")?;
    let out = capture(
        &gh,
        &["auth", "switch", "--hostname", "github.com", "--user", id],
        Duration::from_secs(30),
    )
    .await?;
    if out.ok {
        Ok(())
    } else {
        Err(super::failure(&out))
    }
}

/// Removes an inactive account from GitHub CLI.
pub(crate) async fn remove(id: &str) -> Result<(), String> {
    let gh = which("gh").ok_or("`gh` is not installed")?;
    let listed = capture(
        &gh,
        &["auth", "status", "--hostname", "github.com"],
        Duration::from_secs(10),
    )
    .await?;
    let text = format!("{}\n{}", listed.stdout, listed.stderr);
    let mut active_row = false;
    let mut active = false;
    for line in text.lines() {
        if let Some((_, rest)) = line.split_once("Logged in to github.com account ") {
            active_row = rest
                .split_whitespace()
                .next()
                .is_some_and(|name| name.trim_matches(['(', ')']) == id);
        } else if active_row && line.contains("Active account: true") {
            active = true;
            break;
        }
    }
    if active {
        return Err(
            "This GitHub account is in use: switch to another account before removing it"
                .to_string(),
        );
    }
    let out = capture(
        &gh,
        &[
            "auth",
            "logout",
            "--hostname",
            "github.com",
            "--user",
            id,
            "--confirm",
        ],
        Duration::from_secs(30),
    )
    .await?;
    if out.ok {
        Ok(())
    } else {
        Err(super::failure(&out))
    }
}
