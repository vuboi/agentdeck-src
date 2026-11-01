//! Keeps Claude Code's Git Bash subprocesses hidden on Windows.

#[cfg(windows)]
pub fn install() {
    use std::path::{Path, PathBuf};

    // An explicit user choice wins, including a wrapper they already installed themselves.
    if std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").is_some_and(|path| Path::new(&path).is_file())
    {
        return;
    }
    let real = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .map(|path| path.join("Git").join("bin").join("bash.exe"))
        .into_iter()
        .chain(
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|path| {
                    path.join("Programs")
                        .join("Git")
                        .join("bin")
                        .join("bash.exe")
                }),
        )
        .chain(
            std::env::var_os("PATH")
                .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
                .unwrap_or_default()
                .into_iter()
                .map(|path| path.join("bash.exe")),
        )
        .find(|path| path.is_file());
    let (Some(real), Some(home)) = (real, crate::home_folder().ok()) else {
        return;
    };
    let folder = home.join("bin").join("claude");
    let wrapper = folder.join("bash.exe");
    let bytes = include_bytes!(env!("AGENTDECK_HIDDEN_BASH"));
    if std::fs::read(&wrapper).ok().as_deref() != Some(bytes.as_slice())
        && (std::fs::create_dir_all(&folder).is_err() || std::fs::write(&wrapper, bytes).is_err())
    {
        return;
    }
    std::env::set_var("AGENTDECK_REAL_GIT_BASH", real);
    std::env::set_var("CLAUDE_CODE_GIT_BASH_PATH", wrapper);
}

#[cfg(not(windows))]
pub fn install() {}
