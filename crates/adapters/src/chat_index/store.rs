//! The queries behind `ChatIndex`. Every write runs in one transaction, so a turn and the binding it moves never disagree.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use super::{
    AppendReport, Binding, BindingOrigin, BindingState, ChatIndex, ChatIndexError, ChatMeta,
    ChatPage, NativeRef, NewMessage, Result, StoredMessage,
};

const BINDING_COLUMNS: &str =
    "id, chat_id, provider, native_id, path, model, epoch, origin, state, synced_seq, cursor_json";
const MESSAGE_COLUMNS: &str =
    "seq, role, agent, model, binding_id, native_provider, native_msg_id, time, blocks_json, blocks";

impl ChatIndex {
    /// Creates the chat, or updates its title, folder, project and agent. `created_at` is kept once it is set.
    pub fn save_chat(&mut self, chat: &ChatMeta) -> Result<()> {
        self.conn.execute(
            "INSERT INTO chats (id, title, project_id, cwd, active_agent, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                project_id = excluded.project_id,
                cwd = excluded.cwd,
                active_agent = excluded.active_agent,
                updated_at = excluded.updated_at,
                deleted_at = NULL",
            params![
                chat.id,
                chat.title,
                chat.project_id,
                chat.cwd,
                chat.active_agent,
                chat.created_at,
                chat.updated_at
            ],
        )?;
        Ok(())
    }

    /// One live chat, or `None` when it does not exist or was deleted.
    pub fn chat(&self, chat_id: &str) -> Result<Option<ChatMeta>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, title, project_id, cwd, active_agent, created_at, updated_at
                 FROM chats WHERE id = ?1 AND deleted_at IS NULL",
                [chat_id],
                chat_from_row,
            )
            .optional()?)
    }

    /// Every live chat, most recently updated first.
    pub fn list_chats(&self) -> Result<Vec<ChatMeta>> {
        let mut statement = self.conn.prepare(
            "SELECT id, title, project_id, cwd, active_agent, created_at, updated_at
             FROM chats WHERE deleted_at IS NULL ORDER BY updated_at DESC, id",
        )?;
        let rows = statement.query_map([], chat_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Adds a binding to a chat, or updates the binding with the same id. Fails with `NativeBound` when the native
    /// session already belongs to another chat.
    pub fn bind(&mut self, chat_id: &str, binding: &Binding) -> Result<()> {
        if binding.chat_id != chat_id {
            return Err(ChatIndexError::BindingNotInChat {
                binding_id: binding.id.clone(),
                chat_id: chat_id.to_string(),
            });
        }
        let tx = self.conn.transaction()?;
        require_chat(&tx, chat_id)?;
        if let Some(owner) = native_owner(&tx, binding)? {
            return Err(native_bound(binding, owner));
        }
        let owner: Option<String> = tx
            .query_row(
                "SELECT chat_id FROM bindings WHERE id = ?1",
                [&binding.id],
                |row| row.get(0),
            )
            .optional()?;
        if owner.as_deref().is_some_and(|owner| owner != chat_id) {
            return Err(ChatIndexError::BindingNotInChat {
                binding_id: binding.id.clone(),
                chat_id: chat_id.to_string(),
            });
        }
        write_binding(&tx, chat_id, binding)?;
        tx.commit()?;
        Ok(())
    }

    /// Every binding of a chat, in insertion order.
    pub fn bindings(&self, chat_id: &str) -> Result<Vec<Binding>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {BINDING_COLUMNS} FROM bindings WHERE chat_id = ?1 ORDER BY rowid"
        ))?;
        let rows = statement.query_map([chat_id], |row| Ok(parse_binding(row)))?;
        let mut bindings = Vec::new();
        for row in rows {
            bindings.push(row??);
        }
        Ok(bindings)
    }

    /// The live chat that owns a native session, if any.
    pub fn resolve_native(&self, provider: &str, native_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT b.chat_id FROM bindings b JOIN chats c ON c.id = b.chat_id
                 WHERE b.provider = ?1 AND b.native_id = ?2 AND c.deleted_at IS NULL",
                params![provider, native_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Adds AgentDeck's own turns at the end of the ledger. A turn whose native message id is already there is skipped.
    /// Each binding that wrote a turn has now seen the whole ledger, so its `synced_seq` moves to the end.
    pub fn append(&mut self, chat_id: &str, messages: &[NewMessage]) -> Result<AppendReport> {
        let tx = self.conn.transaction()?;
        require_chat(&tx, chat_id)?;
        let mut report = AppendReport::default();
        let mut writers = HashSet::new();
        let mut last_time = None;
        let mut seq = last_seq(&tx, chat_id)?;
        for message in messages {
            if is_known(&tx, chat_id, message.native.as_ref())? {
                report.skipped += 1;
                continue;
            }
            seq += 1;
            insert_message(&tx, chat_id, seq, message)?;
            report.inserted += 1;
            if let Some(binding_id) = &message.binding_id {
                writers.insert(binding_id.clone());
            }
            if !message.time.is_empty() {
                last_time = Some(message.time.clone());
            }
        }
        for binding_id in &writers {
            tx.execute(
                "UPDATE bindings SET synced_seq = ?1 WHERE id = ?2 AND chat_id = ?3",
                params![seq, binding_id, chat_id],
            )?;
        }
        if let Some(time) = last_time {
            tx.execute(
                "UPDATE chats SET updated_at = ?1 WHERE id = ?2",
                params![time, chat_id],
            )?;
        }
        tx.commit()?;
        Ok(report)
    }

    /// Merges turns read from a native session into the ledger. Turns already present (same native message id) are
    /// skipped. New turns go right after the last ledger turn of this binding, and the turns below that are unchanged
    /// (later turns of other bindings move down). A binding with no turns yet gets its turns at the end.
    pub fn sync_native(
        &mut self,
        chat_id: &str,
        binding_id: &str,
        messages: &[NewMessage],
    ) -> Result<AppendReport> {
        let tx = self.conn.transaction()?;
        require_chat(&tx, chat_id)?;
        require_binding_in_chat(&tx, chat_id, binding_id)?;
        let mut report = AppendReport::default();
        let mut fresh = Vec::new();
        for message in messages {
            if is_known(&tx, chat_id, message.native.as_ref())? {
                report.skipped += 1;
            } else {
                fresh.push(message);
            }
        }
        if fresh.is_empty() {
            tx.commit()?;
            return Ok(report);
        }

        let anchor: Option<i64> = tx.query_row(
            "SELECT MAX(seq) FROM messages WHERE chat_id = ?1 AND binding_id = ?2",
            params![chat_id, binding_id],
            |row| row.get(0),
        )?;
        let first = match anchor {
            Some(anchor) => anchor + 1,
            None => last_seq(&tx, chat_id)? + 1,
        };
        let count = i64::try_from(fresh.len()).unwrap_or(i64::MAX);
        shift_from(&tx, chat_id, first, count)?;
        // Turns below `first` stay where they are; every binding that had seen up to `first - 1` still has.
        tx.execute(
            "UPDATE bindings SET synced_seq = synced_seq + ?1 WHERE chat_id = ?2 AND synced_seq >= ?3",
            params![count, chat_id, first],
        )?;

        let mut last_time = None;
        for (offset, message) in fresh.iter().enumerate() {
            let seq = first + i64::try_from(offset).unwrap_or(0);
            // The turns came from this binding's native session, whatever the caller left in `binding_id`.
            let row = NewMessage {
                binding_id: Some(binding_id.to_string()),
                ..(*message).clone()
            };
            insert_message(&tx, chat_id, seq, &row)?;
            report.inserted += 1;
            if !message.time.is_empty() {
                last_time = Some(message.time.clone());
            }
        }
        // The session wrote these turns, so it has seen everything up to the last one, and nothing after it yet.
        tx.execute(
            "UPDATE bindings SET synced_seq = ?1 WHERE id = ?2",
            params![first + count - 1, binding_id],
        )?;
        if let Some(time) = last_time {
            tx.execute(
                "UPDATE chats SET updated_at = ?1 WHERE id = ?2",
                params![time, chat_id],
            )?;
        }
        tx.commit()?;
        Ok(report)
    }

    /// The newest `limit` turns, or the `limit` turns before `before_seq`. `None` when the chat does not exist.
    pub fn open_page(
        &self,
        chat_id: &str,
        before_seq: Option<i64>,
        limit: usize,
    ) -> Result<Option<ChatPage>> {
        let Some(chat) = self.chat(chat_id)? else {
            return Ok(None);
        };
        let fetch = i64::try_from(limit).unwrap_or(i64::MAX).saturating_add(1);
        let before = before_seq.unwrap_or(i64::MAX);
        let mut statement = self.conn.prepare(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages
             WHERE chat_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3"
        ))?;
        let rows = statement.query_map(params![chat_id, before, fetch], |row| {
            Ok(parse_message(row))
        })?;
        let mut messages = Vec::new();
        for row in rows {
            messages.push(row??);
        }
        let has_more = messages.len() > limit;
        messages.truncate(limit);
        messages.reverse();
        Ok(Some(ChatPage {
            chat,
            bindings: self.bindings(chat_id)?,
            messages,
            has_more,
        }))
    }

    /// Removes a chat with its bindings and ledger. Returns the native file paths the bindings pointed at, so the caller
    /// can move them to the trash. Nothing outside the index is touched here.
    pub fn delete_chat(&mut self, chat_id: &str) -> Result<Vec<String>> {
        let tx = self.conn.transaction()?;
        let mut statement = tx.prepare(
            "SELECT path FROM bindings WHERE chat_id = ?1 AND path IS NOT NULL ORDER BY rowid",
        )?;
        let paths = statement
            .query_map([chat_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        tx.execute("DELETE FROM messages WHERE chat_id = ?1", [chat_id])?;
        tx.execute("DELETE FROM bindings WHERE chat_id = ?1", [chat_id])?;
        tx.execute("DELETE FROM chats WHERE id = ?1", [chat_id])?;
        tx.commit()?;
        Ok(paths)
    }
}

fn require_chat(conn: &Connection, chat_id: &str) -> Result<()> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM chats WHERE id = ?1 AND deleted_at IS NULL",
            [chat_id],
            |row| row.get(0),
        )
        .optional()?;
    found
        .map(|_| ())
        .ok_or_else(|| ChatIndexError::ChatNotFound(chat_id.to_string()))
}

fn require_binding_in_chat(conn: &Connection, chat_id: &str, binding_id: &str) -> Result<()> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM bindings WHERE id = ?1 AND chat_id = ?2",
            params![binding_id, chat_id],
            |row| row.get(0),
        )
        .optional()?;
    found
        .map(|_| ())
        .ok_or_else(|| ChatIndexError::BindingNotInChat {
            binding_id: binding_id.to_string(),
            chat_id: chat_id.to_string(),
        })
}

/// The chat of another binding that already holds this binding's native session, when there is one.
pub(super) fn native_owner(conn: &Connection, binding: &Binding) -> Result<Option<String>> {
    let Some(native_id) = &binding.native_id else {
        return Ok(None);
    };
    Ok(conn
        .query_row(
            "SELECT chat_id FROM bindings WHERE provider = ?1 AND native_id = ?2 AND id <> ?3",
            params![binding.provider, native_id, binding.id],
            |row| row.get(0),
        )
        .optional()?)
}

fn native_bound(binding: &Binding, chat_id: String) -> ChatIndexError {
    ChatIndexError::NativeBound {
        provider: binding.provider.clone(),
        native_id: binding.native_id.clone().unwrap_or_default(),
        chat_id,
    }
}

fn last_seq(conn: &Connection, chat_id: &str) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE chat_id = ?1",
        [chat_id],
        |row| row.get(0),
    )?)
}

pub(super) fn is_known(
    conn: &Connection,
    chat_id: &str,
    native: Option<&NativeRef>,
) -> Result<bool> {
    let Some(native) = native else {
        return Ok(false);
    };
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM messages WHERE chat_id = ?1 AND native_provider = ?2 AND native_msg_id = ?3",
            params![chat_id, native.provider, native.msg_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

/// Moves every turn at `from` or later up by `count`. Two steps, because `(chat_id, seq)` is unique while the rows move:
/// first to negative numbers (which nothing else uses), then back to positive.
fn shift_from(conn: &Connection, chat_id: &str, from: i64, count: i64) -> Result<()> {
    conn.execute(
        "UPDATE messages SET seq = -(seq + ?1) WHERE chat_id = ?2 AND seq >= ?3",
        params![count, chat_id, from],
    )?;
    conn.execute(
        "UPDATE messages SET seq = -seq WHERE chat_id = ?1 AND seq < 0",
        [chat_id],
    )?;
    Ok(())
}

/// Writes a binding row (insert, or update of the same id). Callers check ownership first; see `native_owner`.
pub(super) fn write_binding(conn: &Connection, chat_id: &str, binding: &Binding) -> Result<()> {
    conn.execute(
        "INSERT INTO bindings (id, chat_id, provider, native_id, path, model, epoch, origin, state, synced_seq, cursor_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
            provider = excluded.provider,
            native_id = excluded.native_id,
            path = excluded.path,
            model = excluded.model,
            epoch = excluded.epoch,
            origin = excluded.origin,
            state = excluded.state,
            synced_seq = excluded.synced_seq,
            cursor_json = excluded.cursor_json",
        params![
            binding.id,
            chat_id,
            binding.provider,
            binding.native_id,
            binding.path,
            binding.model,
            binding.epoch,
            binding.origin.as_str(),
            binding.state.as_str(),
            binding.synced_seq,
            binding.cursor.as_ref().map(Value::to_string),
        ],
    )?;
    Ok(())
}

pub(super) fn insert_message(
    conn: &Connection,
    chat_id: &str,
    seq: i64,
    message: &NewMessage,
) -> Result<()> {
    // The blocks go in as a codec blob (version 2); `blocks_json` stays empty for these rows.
    let blocks = crate::codec::encode_keep(&message.blocks).map_err(ChatIndexError::Codec)?;
    conn.execute(
        "INSERT INTO messages (chat_id, seq, role, agent, model, binding_id, native_provider, native_msg_id, time, blocks_json, blocks, preview)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '', ?10, ?11)",
        params![
            chat_id,
            seq,
            message.role,
            message.agent,
            message.model,
            message.binding_id,
            message.native.as_ref().map(|native| native.provider.as_str()),
            message.native.as_ref().map(|native| native.msg_id.as_str()),
            message.time,
            blocks,
            preview_of(&message.blocks),
        ],
    )?;
    Ok(())
}

/// The first 300 characters of the text of a message's blocks, for the lists.
pub(super) fn preview_of(blocks: &Value) -> String {
    let mut text = String::new();
    if let Some(list) = blocks.as_array() {
        for block in list {
            if let Some(part) = block.get("text").and_then(Value::as_str) {
                text.push_str(part);
                text.push(' ');
            }
            if text.chars().count() >= 300 {
                break;
            }
        }
    }
    text.trim().chars().take(300).collect()
}

fn chat_from_row(row: &Row) -> rusqlite::Result<ChatMeta> {
    Ok(ChatMeta {
        id: row.get(0)?,
        title: row.get(1)?,
        project_id: row.get(2)?,
        cwd: row.get(3)?,
        active_agent: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// Rows hold text for the enums; a value this build does not know is an error, not a guess.
fn parse_binding(row: &Row) -> Result<Binding> {
    let origin: String = row.get(7)?;
    let state: String = row.get(8)?;
    let cursor: Option<String> = row.get(10)?;
    Ok(Binding {
        id: row.get(0)?,
        chat_id: row.get(1)?,
        provider: row.get(2)?,
        native_id: row.get(3)?,
        path: row.get(4)?,
        model: row.get(5)?,
        epoch: row.get(6)?,
        origin: BindingOrigin::parse(&origin).ok_or_else(|| {
            ChatIndexError::InvalidDump(format!("unknown binding origin {origin}"))
        })?,
        state: BindingState::parse(&state)
            .ok_or_else(|| ChatIndexError::InvalidDump(format!("unknown binding state {state}")))?,
        synced_seq: row.get(9)?,
        cursor: cursor.map(|text| serde_json::from_str(&text)).transpose()?,
    })
}

fn parse_message(row: &Row) -> Result<StoredMessage> {
    let native_provider: Option<String> = row.get(5)?;
    let native_msg_id: Option<String> = row.get(6)?;
    let native = match (native_provider, native_msg_id) {
        (Some(provider), Some(msg_id)) => Some(NativeRef { provider, msg_id }),
        _ => None,
    };
    // Version 2 rows keep the blocks as a blob; older rows keep their JSON text.
    let blob: Option<Vec<u8>> = row.get(9)?;
    let blocks: Value = match blob {
        Some(bytes) => crate::codec::decode(&bytes).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Blob, error.into())
        })?,
        None => {
            let text: String = row.get(8)?;
            serde_json::from_str(&text).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    8,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?
        }
    };
    Ok(StoredMessage {
        seq: row.get(0)?,
        message: NewMessage {
            role: row.get(1)?,
            agent: row.get(2)?,
            model: row.get(3)?,
            binding_id: row.get(4)?,
            time: row.get(7)?,
            native,
            blocks,
        },
    })
}
