//! Shared process and executable helpers used by CLI connectors.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
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
    #[cfg(unix)]
    command.process_group(0);
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
        #[cfg(unix)]
        if let Some(pid) = self.0 {
            ag_adapters::agent::runner::kill_tree(pid);
        }
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
    let mut child = command(program)
        .args(args)
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", program.display()))?;
    if let Some(pid) = child.id() {
        crate::process_guard::adopt_pid(pid);
    }
    let stdout = Arc::new(Mutex::new(Vec::new()));
    let stderr = Arc::new(Mutex::new(Vec::new()));
    let mut readers = [
        tokio::spawn(drain(child.stdout.take(), stdout.clone())),
        tokio::spawn(drain(child.stderr.take(), stderr.clone())),
    ];
    let status = match tokio::time::timeout(limit, child.wait()).await {
        Ok(status) => status.map_err(|error| error.to_string())?,
        Err(_) => {
            for reader in &readers {
                reader.abort();
            }
            return Err(format!(
                "{} took longer than {}s",
                program.display(),
                limit.as_secs()
            ));
        }
    };
    // The process has ended, but its pipes can stay open: on Windows a process started at the same moment inherits
    // them, and holds them for as long as it runs. Waiting for their end made every check of a detect run wait for its
    // whole limit, so the output is read for a short while after the exit instead.
    let _ = tokio::time::timeout(Duration::from_millis(300), async {
        for reader in &mut readers {
            let _ = reader.await;
        }
    })
    .await;
    for reader in &readers {
        reader.abort();
    }
    let text = |buffer: &Arc<Mutex<Vec<u8>>>| {
        buffer
            .lock()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default()
    };
    Ok(Captured {
        ok: status.success(),
        stdout: text(&stdout),
        stderr: text(&stderr),
    })
}

/// Copies a child's pipe into `into` until the pipe ends or the reader is stopped.
async fn drain<R: AsyncRead + Unpin>(pipe: Option<R>, into: Arc<Mutex<Vec<u8>>>) {
    let Some(mut pipe) = pipe else {
        return;
    };
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                if let Ok(mut bytes) = into.lock() {
                    bytes.extend_from_slice(&chunk[..read]);
                }
            }
        }
    }
}

pub(crate) async fn version_of(program: &Path) -> Option<String> {
    version_with(program, &["--version"]).await
}

/// The first line `program` prints for `args`, on stdout or, when that is empty, on stderr.
pub(crate) async fn version_with(program: &Path, args: &[&str]) -> Option<String> {
    let out = capture(program, args, Duration::from_secs(8)).await.ok()?;
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
