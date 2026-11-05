//! Stops one background command a chat's CLI started (`run_in_background`), and nothing else: the CLI and its reply keep
//! running. The CLI has no way to stop a single background shell, so the command's own process is found among the
//! CLI's descendants by its command line and ended with its children.

use std::collections::{HashMap, HashSet};

/// One process of the system: its id, its parent's, and its command line.
struct ProcessRow {
    pid: u32,
    parent: u32,
    command_line: String,
}

/// True when a process running `command` under the CLI of `chat` was found and ended.
#[tauri::command]
pub async fn stop_background_command(chat: String, command: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || stop_background(&chat, &command))
        .await
        .map_err(|error| error.to_string())?
}

fn stop_background(chat: &str, command: &str) -> Result<bool, String> {
    let roots = ag_adapters::agent::runner::pids_of_chat(chat);
    if roots.is_empty() {
        return Ok(false);
    }
    let rows = process_rows()?;
    Ok(match background_process(&roots, &rows, command) {
        Some(pid) => {
            crate::process_guard::kill_tree(pid);
            true
        }
        None => false,
    })
}

/// Quotes and escapes differ between the tool input and a shell's command line (`echo "skip"` runs as
/// `bash -c "echo \"skip\""`): both sides drop them and collapse runs of spaces before they are compared.
fn normalize(text: &str) -> String {
    text.chars()
        .filter(|c| !matches!(c, '"' | '\'' | '\\' | '`'))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The topmost descendant of `roots` whose command line holds `command`: the shell that runs it, whose children (the
/// command's own processes) end with it. The roots themselves (the CLI) never match.
fn background_process(roots: &[u32], rows: &[ProcessRow], command: &str) -> Option<u32> {
    let wanted = normalize(command);
    if wanted.is_empty() {
        return None;
    }
    let parents: HashMap<u32, u32> = rows.iter().map(|row| (row.pid, row.parent)).collect();
    let under_root = |pid: u32| {
        let mut at = pid;
        for _ in 0..128 {
            let Some(&parent) = parents.get(&at) else {
                return false;
            };
            if roots.contains(&parent) {
                return true;
            }
            if parent == 0 || parent == at {
                return false;
            }
            at = parent;
        }
        false
    };
    let matching: HashSet<u32> = rows
        .iter()
        .filter(|row| !roots.contains(&row.pid))
        .filter(|row| normalize(&row.command_line).contains(&wanted))
        .map(|row| row.pid)
        .filter(|&pid| under_root(pid))
        .collect();
    rows.iter()
        .map(|row| row.pid)
        .filter(|pid| matching.contains(pid))
        .find(|pid| !matches!(parents.get(pid), Some(parent) if matching.contains(parent)))
}

#[cfg(windows)]
fn process_rows() -> Result<Vec<ProcessRow>, String> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
        ])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    let items = match value {
        serde_json::Value::Array(items) => items,
        other => vec![other],
    };
    Ok(items
        .iter()
        .filter_map(|item| {
            Some(ProcessRow {
                pid: u32::try_from(item["ProcessId"].as_u64()?).ok()?,
                parent: u32::try_from(item["ParentProcessId"].as_u64()?).ok()?,
                command_line: item["CommandLine"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect())
}

#[cfg(not(windows))]
fn process_rows() -> Result<Vec<ProcessRow>, String> {
    let output = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,args="])
        .output()
        .map_err(|error| error.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let parent = parts.next()?.parse().ok()?;
            Some(ProcessRow {
                pid,
                parent,
                command_line: parts.collect::<Vec<_>>().join(" "),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, parent: u32, command_line: &str) -> ProcessRow {
        ProcessRow {
            pid,
            parent,
            command_line: command_line.to_string(),
        }
    }

    #[test]
    fn the_shell_running_the_command_under_the_cli_is_found() {
        let rows = vec![
            row(10, 1, "command-code -p \"run echo noop\""),
            row(20, 10, "bash -c \"sleep 60; echo noop\""),
            row(21, 20, "sleep 60"),
            row(30, 10, "bash -c \"echo other\""),
        ];
        assert_eq!(
            background_process(&[10], &rows, "sleep 60; echo noop"),
            Some(20)
        );
    }

    #[test]
    fn quotes_and_spaces_do_not_matter() {
        let rows = vec![
            row(10, 1, "cli"),
            row(20, 10, "bash -c \"echo \\\"skip\\\"\""),
        ];
        assert_eq!(background_process(&[10], &rows, "echo  \"skip\""), Some(20));
    }

    #[test]
    fn the_cli_itself_and_other_processes_never_match() {
        let rows = vec![
            row(10, 1, "cli echo noop"),
            row(40, 2, "bash -c \"echo noop\""),
        ];
        assert_eq!(background_process(&[10], &rows, "echo noop"), None);
        assert_eq!(background_process(&[10], &rows, "  "), None);
    }
}
