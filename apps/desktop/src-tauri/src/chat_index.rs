//! Tauri commands over the chat index (`~/.agentdeck/chats.db`, the ledger and bindings in `ag_adapters::chat_index`).
//!
//! The index is opened on first use and kept open. Every command runs its SQLite work on a blocking thread, so the
//! UI thread never waits on the database. Reading a native session (`chat_sync_native`) happens outside the lock.

use std::path::PathBuf;
use std::sync::Mutex;

use ag_adapters::chat_index::{
    AppendReport, Binding, ChatIndex, ChatIndexError, ChatMeta, ChatPage, LegacyDump,
    MigrationReport, MigrationStatus, NativeRef, NewMessage,
};
use ag_adapters::history::{self, HistoryMessage, Source};

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
#[tauri::command]
pub async fn chat_append(
    chat_id: String,
    messages: Vec<NewMessage>,
) -> Result<AppendReport, String> {
    with_index(move |index| index.append(&chat_id, &messages)).await
}

/// Reads every native session bound to the chat and merges the turns it has not seen yet. Each binding's file is read
/// with the same reader the history list uses, and only the path inside its history folder is accepted.
#[tauri::command]
pub async fn chat_sync_native(chat_id: String) -> Result<AppendReport, String> {
    let owner = chat_id.clone();
    let bindings = with_index(move |index| index.bindings(&owner)).await?;
    let roots = crate::roots()?;
    let mut total = AppendReport::default();
    for binding in bindings {
        let (Some(path), Some(source)) = (binding.path.clone(), source_of(&binding.provider))
        else {
            continue;
        };
        let roots = roots.clone();
        let read = tauri::async_runtime::spawn_blocking(move || {
            history::load(&roots, source, &PathBuf::from(path))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
        let messages: Vec<NewMessage> = read
            .iter()
            .map(|message| native_turn(&binding, message))
            .collect();
        let owner = chat_id.clone();
        let report =
            with_index(move |index| index.sync_native(&owner, &binding.id, &messages)).await?;
        total.inserted += report.inserted;
        total.skipped += report.skipped;
    }
    Ok(total)
}

/// Removes a chat and its ledger. Returns the native files its bindings pointed at; the caller moves them to the trash.
#[tauri::command]
pub async fn chat_delete(chat_id: String) -> Result<Vec<String>, String> {
    with_index(move |index| index.delete_chat(&chat_id)).await
}

fn source_of(provider: &str) -> Option<Source> {
    match provider {
        "claude" => Some(Source::Claude),
        "codex" => Some(Source::Codex),
        "copilot" => Some(Source::Copilot),
        "antigravity" => Some(Source::Antigravity),
        _ => None,
    }
}

/// A native turn in the shape the chat view keeps: its id, role, time and blocks, plus the native id used for dedupe.
fn native_turn(binding: &Binding, message: &HistoryMessage) -> NewMessage {
    NewMessage {
        client_id: None,
        role: message.role.clone(),
        agent: Some(binding.provider.clone()),
        model: message.model.clone(),
        binding_id: Some(binding.id.clone()),
        time: message.time.clone(),
        native: Some(NativeRef {
            provider: binding.provider.clone(),
            msg_id: message.id.clone(),
        }),
        blocks: serde_json::json!({
            "id": message.id,
            "role": message.role,
            "time": message.time,
            "model": message.model,
            "blocks": message.blocks,
        }),
    }
}
