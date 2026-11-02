//! Shared process and executable helpers used by CLI connectors.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut push = |path: Option<PathBuf>| {
        if let Some(path) = path.filter(|path| !dirs.contains(path)) {
            dirs.push(path);
        }
    };
    let home = crate::home_folder().ok().or_else(|| {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
    });
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|path| path.join("AppData").join("Local")));
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from).or_else(|| {
        home.as_ref()
            .map(|path| path.join("AppData").join("Roaming"))
    });
    push(home.as_ref().map(|path| path.join(".local").join("bin")));
    push(home.as_ref().map(|path| path.join(".cargo").join("bin")));
    push(home.as_ref().map(|path| path.join(".volta").join("bin")));
    push(home.as_ref().map(|path| path.join(".bun").join("bin")));
    push(
        home.as_ref()
            .map(|path| path.join(".local").join("share").join("pnpm")),
    );
    push(
        home.as_ref()
            .map(|path| path.join(".local").join("share").join("mise").join("shims")),
    );
    push(home.as_ref().map(|path| path.join(".asdf").join("shims")));
    push(std::env::var_os("PNPM_HOME").map(PathBuf::from));
    push(std::env::var_os("NVM_BIN").map(PathBuf::from));
    push(std::env::var_os("FNM_MULTISHELL_PATH").map(PathBuf::from));
    push(std::env::var_os("BUN_INSTALL").map(|path| PathBuf::from(path).join("bin")));
    push(std::env::var_os("VOLTA_HOME").map(|path| PathBuf::from(path).join("bin")));
    push(std::env::var_os("MISE_DATA_DIR").map(|path| PathBuf::from(path).join("shims")));
    push(std::env::var_os("ASDF_DATA_DIR").map(|path| PathBuf::from(path).join("shims")));
    push(roaming.as_ref().map(|path| path.join("npm")));
    push(local.as_ref().map(|path| path.join("pnpm")));
    push(local.as_ref().map(|path| path.join("agy").join("bin")));
    push(local.as_ref().map(|path| path.join("Volta").join("bin")));
    push(
        local
            .as_ref()
            .map(|path| path.join("Microsoft").join("WinGet").join("Links")),
    );
    push(local.as_ref().map(|path| path.join("mise").join("shims")));
    push(
        local
            .as_ref()
            .map(|path| path.join("mise").join("installs").join("node")),
    );
    if let Some(local) = local.as_ref() {
        for parent in [
            local.join("mise").join("installs").join("node"),
            local.join("nvm"),
        ] {
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten() {
                    push(Some(entry.path()));
                }
            }
        }
    }
    if let Some(home) = home.as_ref() {
        for parent in [
            home.join(".nvm").join("versions").join("node"),
            home.join(".local")
                .join("share")
                .join("mise")
                .join("installs")
                .join("node"),
        ] {
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten() {
                    push(Some(entry.path().join(if cfg!(windows) {
                        ""
                    } else {
                        "bin"
                    })));
                }
            }
        }
    }
    if let Some(mise_data) = std::env::var_os("MISE_DATA_DIR").map(PathBuf::from) {
        if let Ok(entries) = std::fs::read_dir(mise_data.join("installs").join("node")) {
            for entry in entries.flatten() {
                push(Some(entry.path()));
            }
        }
    }
    push(std::env::var_os("HOMEBREW_PREFIX").map(|path| PathBuf::from(path).join("bin")));
    push(std::env::var_os("BREW_PREFIX").map(|path| PathBuf::from(path).join("bin")));
    if cfg!(windows) {
        push(std::env::var_os("ProgramFiles").map(|path| PathBuf::from(path).join("nodejs")));
        push(std::env::var_os("ProgramFiles(x86)").map(|path| PathBuf::from(path).join("nodejs")));
        push(Some(PathBuf::from(r"C:\ProgramData\chocolatey\bin")));
    } else if cfg!(target_os = "macos") {
        push(Some(PathBuf::from("/opt/homebrew/bin")));
        push(Some(PathBuf::from("/opt/homebrew/sbin")));
        push(Some(PathBuf::from("/usr/local/bin")));
        push(Some(PathBuf::from("/usr/local/sbin")));
        push(home.as_ref().map(|path| path.join("Library").join("pnpm")));
    } else {
        push(Some(PathBuf::from("/home/linuxbrew/.linuxbrew/bin")));
        push(
            home.as_ref()
                .map(|path| path.join(".linuxbrew").join("bin")),
        );
        push(Some(PathBuf::from("/usr/local/bin")));
        push(Some(PathBuf::from("/usr/bin")));
        push(Some(PathBuf::from("/bin")));
        push(Some(PathBuf::from("/snap/bin")));
    }
    dirs
}

fn search_path() -> Vec<PathBuf> {
    ag_adapters::agent::runner::augmented_path()
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_else(|| {
            let path = std::env::var_os("PATH").unwrap_or_default();
            extra_dirs()
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
