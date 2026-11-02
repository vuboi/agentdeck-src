//! Shared process and executable helpers used by CLI connectors.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

fn search_path() -> Vec<PathBuf> {
    ag_adapters::agent::runner::augmented_path()
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_else(|| {
            let path = std::env::var_os("PATH").unwrap_or_default();
            ag_adapters::agent::runner::common_dirs_here()
                .into_iter()
                .chain(std::env::split_paths(&path))
                .collect()
        })
}

pub(crate) fn which(name: &str) -> Option<PathBuf> {
    let suffixes: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    search_path().into_iter().find_map(|dir| {
        suffixes
            .iter()
            .map(|suffix| dir.join(format!("{name}{suffix}")))
            .find(|path| path.is_file())
    })
}

pub(crate) fn command(program: &Path) -> Command {
    #[cfg(windows)]
    let mut command = {
        let is_batch = program
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
            });
        if is_batch {
            let mut command = Command::new("cmd");
            command.args(["/D", "/S", "/C"]).arg(program);
            command
        } else {
            Command::new(program)
        }
    };
    #[cfg(not(windows))]
    let mut command = Command::new(program);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some((key, path)) = ag_adapters::agent::runner::augmented_path_env() {
        command.env(key, path);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
}

pub(crate) struct KillTree(pub(crate) Option<u32>);
impl KillTree {
    pub(crate) fn of(child: &tokio::process::Child) -> Self {
        Self(child.id())
    }
}
impl Drop for KillTree {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Some(pid) = self.0 {
            use std::os::windows::process::CommandExt;
            let mut kill = std::process::Command::new("taskkill");
            kill.args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            kill.creation_flags(0x0800_0000);
            let _ = kill.spawn();
        }
        #[cfg(not(windows))]
        let _ = self.0;
    }
}

pub(crate) struct Captured {
    pub(crate) ok: bool,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

pub(crate) fn account_tool_allows(program: &Path, args: &[&str]) -> Result<(), String> {
    let name = program
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let allowed: &[&str] = match name.as_str() {
        "codex-auth" => &["list", "switch", "remove", "login"],
        "cswap" => &["list", "switch", "add", "remove"],
        _ => return Ok(()),
    };
    match args.first() {
        Some(first) if allowed.contains(first) => Ok(()),
        other => Err(format!(
            "{name} {} is not one AgentDeck runs",
            other.copied().unwrap_or_default()
        )),
    }
}

pub(crate) async fn capture(
    program: &Path,
    args: &[&str],
    limit: Duration,
) -> Result<Captured, String> {
    account_tool_allows(program, args)?;
    let child = command(program)
        .args(args)
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", program.display()))?;
    let output = tokio::time::timeout(limit, child.wait_with_output())
        .await
        .map_err(|_| {
            format!(
                "{} took longer than {}s",
                program.display(),
                limit.as_secs()
            )
        })?
        .map_err(|error| error.to_string())?;
    Ok(Captured {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

pub(crate) async fn version_of(program: &Path) -> Option<String> {
    let out = capture(program, &["--version"], Duration::from_secs(8))
        .await
        .ok()?;
    let text = if out.stdout.trim().is_empty() {
        out.stderr
    } else {
        out.stdout
    };
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}
