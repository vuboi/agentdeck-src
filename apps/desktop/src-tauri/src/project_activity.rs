use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

const LEGACY_FILE: &str = ".agentdeck/activity.md";
const DIRECTORY: &str = "project-activity";
const HEADER: &str = "# AgentDeck project activity\n\n";
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 256 * 1024;

fn file_in(data_dir: &Path, root: &Path) -> Result<PathBuf, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    let key = hex::encode(hasher.finalize());
    Ok(data_dir.join(DIRECTORY).join(format!("{key}.md")))
}

fn ensure_legacy_ignored(root: &Path) -> Result<(), String> {
    let gitignore = root.join(".gitignore");
    let contents = std::fs::read_to_string(&gitignore).unwrap_or_default();
    if contents
        .lines()
        .any(|line| line.trim() == "/.agentdeck/activity.md")
    {
        return Ok(());
    }
    let mut handle = OpenOptions::new()
        .create(true)
        .append(true)
        .open(gitignore)
        .map_err(|error| error.to_string())?;
    if !contents.is_empty() && !contents.ends_with('\n') {
        handle.write_all(b"\n").map_err(|error| error.to_string())?;
    }
    handle
        .write_all(b"\n# AgentDeck project activity log\n/.agentdeck/activity.md\n")
        .map_err(|error| error.to_string())
}

fn migrate_legacy(root: &Path, destination: &Path) -> Result<(), String> {
    let legacy = root.join(LEGACY_FILE);
    if !legacy.is_file() {
        return Ok(());
    }
    if !destination.exists() {
        let content = std::fs::read(&legacy).map_err(|error| error.to_string())?;
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(destination, content).map_err(|error| error.to_string())?;
    }
    if std::fs::remove_file(&legacy).is_err() {
        ensure_legacy_ignored(root)?;
    } else if let Some(parent) = legacy.parent() {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(())
}

fn read_in(data_dir: &Path, root: &Path) -> Result<String, String> {
    let file = file_in(data_dir, root)?;
    migrate_legacy(root, &file)?;
    match std::fs::read(file) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_BYTES)]).into_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn append_in(data_dir: &Path, root: &Path, entry: &str) -> Result<(), String> {
    let file = file_in(data_dir, root)?;
    migrate_legacy(root, &file)?;
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
pub async fn project_activity_read(app: tauri::AppHandle, root: String) -> Result<String, String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || read_in(&data_dir, Path::new(&root)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_activity_append(
    app: tauri::AppHandle,
    root: String,
    entry: String,
) -> Result<(), String> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || append_in(&data_dir, Path::new(&root), &entry))
        .await
        .map_err(|error| error.to_string())?
}

/// Saves a project activity snapshot where the user picks and returns the chosen path.
#[tauri::command]
pub async fn project_activity_save(
    app: tauri::AppHandle,
    name: String,
    text: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let destination = app
            .dialog()
            .file()
            .set_title("Save project activity log")
            .set_file_name(name)
            .add_filter("Markdown", &["md"])
            .blocking_save_file();
        let Some(destination) = destination else {
            return Ok(None);
        };
        let destination = destination.into_path().map_err(|error| error.to_string())?;
        std::fs::write(&destination, text).map_err(|error| error.to_string())?;
        Ok(Some(destination.display().to_string()))
    })
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
            &folder,
            "<!-- agentdeck:activity-entry {\"id\":\"one\"} -->\n## One",
        )
        .unwrap();
        append_in(
            &folder,
            &folder,
            "<!-- agentdeck:activity-entry {\"id\":\"two\"} -->\n## Two",
        )
        .unwrap();
        let text = read_in(&folder, &folder).unwrap();
        assert!(text.starts_with(HEADER));
        assert!(text.find("## One").unwrap() < text.find("## Two").unwrap());
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn refuses_empty_invalid_and_oversized_entries() {
        let folder = temp("invalid");
        assert!(append_in(&folder, &folder, "").is_err());
        assert!(append_in(&folder, &folder, "## no marker").is_err());
        assert!(append_in(
            &folder,
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
