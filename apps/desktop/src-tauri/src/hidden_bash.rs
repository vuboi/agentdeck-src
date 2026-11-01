#![windows_subsystem = "windows"]

use std::process::{Command, Stdio};

fn main() {
    use std::os::windows::process::CommandExt;

    let Some(real) = std::env::var_os("AGENTDECK_REAL_GIT_BASH") else {
        std::process::exit(127);
    };
    let status = Command::new(real)
        .args(std::env::args_os().skip(1))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status();
    std::process::exit(status.ok().and_then(|value| value.code()).unwrap_or(1));
}
