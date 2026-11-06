//! Tauri commands over the chat index (`~/.agentdeck/chats.db`, the ledger and bindings in `ag_adapters::chat_index`).
//!
//! The index is opened on first use and kept open. Every command runs its SQLite work on a blocking thread, so the
//! UI thread never waits on the database.

use std::path::PathBuf;
use std::sync::Mutex;

use ag_adapters::chat_index::{
    AppendReport, ArchiveEntry, Binding, ChatIndex, ChatIndexError, ChatMeta, ChatPage, LegacyDump,
    MigrationReport, MigrationStatus, NewMessage,
};

/// The one open index. `None` until the first command runs.
static INDEX: Mutex<Option<ChatIndex>> = Mutex::new(None);

fn index_path() -> Result<PathBuf, String> {
    Ok(crate::home_folder()?
        .join(crate::channel::home_folder_name())
        .join("chats.db"))
}

/// Runs `work` against the open index on a blocking thread.
async fn with_index<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut ChatIndex) -> Result<T, ChatIndexError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut slot = INDEX
            .lock()
            .map_err(|_| "chat index lock is poisoned".to_string())?;
        if slot.is_none() {
            *slot = Some(ChatIndex::open(&index_path()?).map_err(|error| error.to_string())?);
        }
        let index = slot.as_mut().ok_or("chat index is not open")?;
        work(index).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn chat_index_status() -> Result<MigrationStatus, String> {
    with_index(|index| index.legacy_status()).await
}

/// Turns the rollback flag on or off. While it is on, the frontend keeps reading IndexedDB.
#[tauri::command]
pub async fn chat_index_set_rollback(enabled: bool) -> Result<(), String> {
    with_index(move |index| index.set_legacy_rollback(enabled)).await
}

/// Imports the IndexedDB dump the frontend read. Runs once; `force` clears the index's chat data and imports again.
#[tauri::command]
pub async fn chat_index_migrate(
    dump: LegacyDump,
    force: Option<bool>,
) -> Result<MigrationReport, String> {
    with_index(move |index| index.migrate_legacy(&dump, force.unwrap_or(false))).await
}

#[tauri::command]
pub async fn chat_list() -> Result<Vec<ChatMeta>, String> {
    with_index(|index| index.list_chats()).await
}

/// Creates a chat, or updates its title, folder, project and agent.
#[tauri::command]
pub async fn chat_save(chat: ChatMeta) -> Result<(), String> {
    with_index(move |index| index.save_chat(&chat)).await
}

/// The newest turns of a chat, or the `limit` turns before `before_seq`. `None` when the chat does not exist.
#[tauri::command]
pub async fn chat_open(
    id: String,
    before_seq: Option<i64>,
    limit: Option<usize>,
) -> Result<Option<ChatPage>, String> {
    with_index(move |index| index.open_page(&id, before_seq, limit.unwrap_or(50))).await
}

#[tauri::command]
pub async fn chat_bind(chat_id: String, binding: Binding) -> Result<(), String> {
    with_index(move |index| index.bind(&chat_id, &binding)).await
}

/// The chat that owns a native session, if any.
#[tauri::command]
pub async fn chat_resolve_native(
    provider: String,
    native_id: String,
) -> Result<Option<String>, String> {
    with_index(move |index| index.resolve_native(&provider, &native_id)).await
}

/// Adds AgentDeck's own turns at the end of a chat. Turns already in the ledger (same native id) are skipped.
/// The attachment files the turns name are recorded for the chat (plan storage-sqlite P7).
#[tauri::command]
pub async fn chat_append(
    chat_id: String,
    messages: Vec<NewMessage>,
) -> Result<AppendReport, String> {
    let folder = attachments_folder()?;
    let named = attachments_named(&folder, &messages);
    with_index(move |index| {
        let report = index.append(&chat_id, &messages)?;
        index.note_attachments(&chat_id, &named)?;
        Ok(report)
    })
    .await
}

/// The folder of the files attached to a chat (`<home>/attachments`), as a string.
fn attachments_folder() -> Result<String, String> {
    Ok(crate::home_folder()?
        .join(crate::channel::home_folder_name())
        .join("attachments")
        .to_string_lossy()
        .into_owned())
}

/// The attachment files the turns name: every path under `folder` found in their blocks.
fn attachments_named(folder: &str, messages: &[NewMessage]) -> Vec<String> {
    let mut found = std::collections::BTreeSet::new();
    for message in messages {
        // The blocks are JSON text: backslashes of a Windows path come out doubled.
        let text = message.blocks.to_string().replace("\\\\", "\\");
        let mut rest = text.as_str();
        while let Some(at) = rest.find(folder) {
            let tail = &rest[at..];
            let end = tail
                .find(|c: char| {
                    matches!(
                        c,
                        '"' | '\'' | ' ' | '\n' | '\r' | '\t' | ')' | ']' | '>' | '`'
                    )
                })
                .unwrap_or(tail.len());
            let path = tail[..end].trim_end_matches('\\');
            if path.len() > folder.len() {
                found.insert(path.to_string());
            }
            rest = &tail[end..];
        }
    }
    found.into_iter().collect()
}

/// Removes the attachment files that every chat using them has left idle since `cutoff` (ISO 8601, UTC). A file no chat
/// names is never removed. Returns how many files were removed.
#[tauri::command]
pub async fn chat_attachments_sweep(cutoff: String) -> Result<usize, String> {
    let folder = PathBuf::from(attachments_folder()?);
    let paths = with_index(move |index| index.idle_attachments(&cutoff)).await?;
    let gone = tauri::async_runtime::spawn_blocking(move || {
        let mut gone = Vec::new();
        for path in paths {
            let file = PathBuf::from(&path);
            if !file.starts_with(&folder) {
                continue;
            }
            match std::fs::remove_file(&file) {
                Ok(()) => gone.push(path),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => gone.push(path),
                Err(_) => {}
            }
        }
        gone
    })
    .await
    .map_err(|error| error.to_string())?;
    let count = gone.len();
    with_index(move |index| index.forget_attachments(&gone)).await?;
    Ok(count)
}

/// Removes a chat and its ledger. Returns the native files its bindings pointed at; the caller moves them to the trash.
#[tauri::command]
pub async fn chat_delete(chat_id: String) -> Result<Vec<String>, String> {
    with_index(move |index| index.delete_chat(&chat_id)).await
}

/// Stores another agent's turn of a chat at `seq` (`chat.otherTurns`, plan storage-sqlite P5.4).
#[tauri::command]
pub async fn chat_put_other_turn(
    chat_id: String,
    seq: i64,
    blocks: serde_json::Value,
) -> Result<(), String> {
    with_index(move |index| index.put_other_turn(&chat_id, seq, &blocks)).await
}

/// The other agents' turns of a chat, oldest first, as `[seq, blocks]` pairs.
#[tauri::command]
pub async fn chat_other_turns(chat_id: String) -> Result<Vec<(i64, serde_json::Value)>, String> {
    with_index(move |index| index.other_turns(&chat_id)).await
}

/// Stores an archived reply of a chat (plan storage-sqlite P5.4). A reply with the same id is replaced.
#[tauri::command]
pub async fn chat_put_archive(
    chat_id: String,
    msg_id: String,
    at: String,
    tokens: Option<i64>,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    with_index(move |index| index.put_archive(&chat_id, &msg_id, &at, tokens, &snapshot)).await
}

/// The archived replies of a chat, oldest first.
#[tauri::command]
pub async fn chat_archive(chat_id: String) -> Result<Vec<ArchiveEntry>, String> {
    with_index(move |index| index.archive(&chat_id)).await
}

/// Removes every other-agent turn of a chat.
#[tauri::command]
pub async fn chat_clear_other_turns(chat_id: String) -> Result<(), String> {
    with_index(move |index| index.clear_other_turns(&chat_id)).await
}

/// Every other-agent turn of every chat, as `[chat id, seq, blocks]`.
#[tauri::command]
pub async fn chat_other_turns_all() -> Result<Vec<(String, i64, serde_json::Value)>, String> {
    with_index(|index| index.other_turns_all()).await
}

/// Every archived entry of every chat, as `[chat id, entry]`.
#[tauri::command]
pub async fn chat_archive_all() -> Result<Vec<(String, ArchiveEntry)>, String> {
    with_index(|index| index.archive_all()).await
}

/// Writes a backup file under `<home>/backup/` (plan storage-sqlite P5.5, before the IndexedDB chat copy is removed).
/// `name` must be a plain file name. Returns the path written.
#[tauri::command]
pub async fn chat_backup_write(name: String, json: String) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("the backup name must be a plain file name".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let folder = crate::home_folder()?
            .join(crate::channel::home_folder_name())
            .join("backup");
        std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
        let path = folder.join(&name);
        std::fs::write(&path, json.as_bytes()).map_err(|error| error.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The newest chat backup written by the IndexedDB migration, as its JSON text; `None` when there is none.
#[tauri::command]
pub async fn chat_backup_latest() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = crate::home_folder()?
            .join(crate::channel::home_folder_name())
            .join("backup");
        let Ok(entries) = std::fs::read_dir(&folder) else {
            return Ok(None);
        };
        let newest = entries
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("indexeddb-chats-") && name.ends_with(".json"))
            .max();
        match newest {
            None => Ok(None),
            Some(name) => std::fs::read_to_string(folder.join(name))
                .map(Some)
                .map_err(|error| error.to_string()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_paths_are_found_in_blocks_with_doubled_backslashes() {
        let folder = r"C:\Users\me\.agentdeck\attachments";
        let message = NewMessage {
            client_id: None,
            role: "user".to_string(),
            agent: None,
            model: None,
            binding_id: None,
            time: String::new(),
            native: None,
            blocks: serde_json::json!({
                "text": r"look at C:\Users\me\.agentdeck\attachments\1.png and (C:\Users\me\.agentdeck\attachments\2.pdf).",
            }),
        };
        assert_eq!(
            attachments_named(folder, &[message]),
            vec![
                r"C:\Users\me\.agentdeck\attachments\1.png".to_string(),
                r"C:\Users\me\.agentdeck\attachments\2.pdf".to_string(),
            ]
        );
    }
}
