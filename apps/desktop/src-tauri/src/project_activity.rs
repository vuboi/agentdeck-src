use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

const FILE: &str = ".agentdeck/activity.md";
const HEADER: &str = "# AgentDeck project activity\n\n";
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 256 * 1024;

fn file_in(root: &Path) -> Result<PathBuf, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    Ok(root.join(FILE))
}

fn read_in(root: &Path) -> Result<String, String> {
    let file = file_in(root)?;
    match std::fs::read(file) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_BYTES)]).into_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn append_in(root: &Path, entry: &str) -> Result<(), String> {
    let file = file_in(root)?;
    let entry = entry.trim();
    if entry.is_empty() {
        return Err("activity entry is empty".to_string());
    }
    if entry.len() > MAX_ENTRY_BYTES {
        return Err(format!(
            "activity entry is larger than {} KB",
            MAX_ENTRY_BYTES / 1024
        ));
    }
    if !entry.starts_with("<!-- agentdeck:activity-entry ") {
        return Err("activity entry has an invalid marker".to_string());
    }
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    }
    let existing_len = std::fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0);
    if existing_len + entry.len() as u64 + HEADER.len() as u64 > MAX_BYTES as u64 {
        return Err(format!(
            "activity log is larger than {} MB",
            MAX_BYTES / 1024 / 1024
        ));
    }
    let mut handle = OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .map_err(|error| error.to_string())?;
    if existing_len == 0 {
        handle
            .write_all(HEADER.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    handle
        .write_all(entry.as_bytes())
        .map_err(|error| error.to_string())?;
    handle.write_all(b"\n\n").map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn project_activity_read(root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_in(Path::new(&root)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_activity_append(root: String, entry: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || append_in(Path::new(&root), &entry))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let folder =
            std::env::temp_dir().join(format!("agentdeck-activity-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn appends_one_project_log_and_keeps_entries_in_order() {
        let folder = temp("append");
        append_in(
            &folder,
            "<!-- agentdeck:activity-entry {\"id\":\"one\"} -->\n## One",
        )
        .unwrap();
        append_in(
            &folder,
            "<!-- agentdeck:activity-entry {\"id\":\"two\"} -->\n## Two",
        )
        .unwrap();
        let text = read_in(&folder).unwrap();
        assert!(text.starts_with(HEADER));
        assert!(text.find("## One").unwrap() < text.find("## Two").unwrap());
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn refuses_empty_invalid_and_oversized_entries() {
        let folder = temp("invalid");
        assert!(append_in(&folder, "").is_err());
        assert!(append_in(&folder, "## no marker").is_err());
        assert!(append_in(
            &folder,
            &format!(
                "<!-- agentdeck:activity-entry x -->\n{}",
                "x".repeat(MAX_ENTRY_BYTES)
            )
        )
        .is_err());
        let _ = std::fs::remove_dir_all(folder);
    }
}
