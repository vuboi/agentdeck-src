//! The queries behind `ChatIndex`. Every write runs in one transaction, so a turn and the binding it moves never disagree.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use super::{
    AppendReport, ArchiveEntry, Binding, BindingOrigin, BindingState, ChatIndex, ChatIndexError,
    ChatMeta, ChatPage, NativeRef, NewMessage, Result, StoredMessage,
};

const BINDING_COLUMNS: &str =
    "id, chat_id, provider, native_id, path, model, epoch, origin, state, synced_seq, cursor_json";
const MESSAGE_COLUMNS: &str =
    "seq, role, agent, model, binding_id, native_provider, native_msg_id, time, blocks_json, blocks, client_id";

impl ChatIndex {
    /// Creates the chat, or updates its title, folder, project and agent. `created_at` is kept once it is set.
    pub fn save_chat(&mut self, chat: &ChatMeta) -> Result<()> {
        self.conn.execute(
            "INSERT INTO chats (id, title, project_id, cwd, active_agent, created_at, updated_at, last_user_at, expires_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(NULLIF(?9, ''), strftime('%Y-%m-%dT%H:%M:%fZ', CASE WHEN ?8 = '' THEN ?6 ELSE ?8 END, '+14 days')), NULL)
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
                chat.updated_at,
                chat.last_user_at,
                chat.expires_at
            ],
        )?;
        Ok(())
    }

    /// One live chat, or `None` when it does not exist or was deleted.
    pub fn chat(&self, chat_id: &str) -> Result<Option<ChatMeta>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, title, project_id, cwd, active_agent, created_at, updated_at, last_user_at, expires_at
                 FROM chats WHERE id = ?1 AND deleted_at IS NULL",
                [chat_id],
                chat_from_row,
            )
            .optional()?)
    }

    /// Every live chat, most recently updated first.
    pub fn list_chats(&mut self) -> Result<Vec<ChatMeta>> {
        self.purge_expired()?;
        let mut statement = self.conn.prepare(
            "SELECT id, title, project_id, cwd, active_agent, created_at, updated_at, last_user_at, expires_at
             FROM chats WHERE deleted_at IS NULL ORDER BY updated_at DESC, id",
        )?;
        let rows = statement.query_map([], chat_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Deletes chats whose user inactivity window has elapsed. Native provider sessions and files are untouched.
    pub fn purge_expired(&mut self) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM chats WHERE deleted_at IS NULL AND expires_at <> '' AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            [],
        )?)
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
        let mut last_user_at = None;
        let mut seq = last_seq(&tx, chat_id)?;
        for message in messages {
            if is_known(&tx, chat_id, message.native.as_ref())? {
                report.skipped += 1;
                continue;
            }
            seq += 1;
            insert_message(&tx, chat_id, seq, message, &self.dicts)?;
            report.inserted += 1;
            if let Some(binding_id) = &message.binding_id {
                writers.insert(binding_id.clone());
            }
            if !message.time.is_empty() {
                last_time = Some(message.time.clone());
            }
            if message.role == "user" && !message.time.is_empty() {
                last_user_at = Some(message.time.clone());
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
        if let Some(time) = last_user_at {
            tx.execute(
                // A time SQLite cannot read (a clock text) leaves the chat's lifetime as it was, rather than NULL.
                "UPDATE chats SET
                    last_user_at = CASE WHEN strftime('%Y-%m-%dT%H:%M:%fZ', ?1) IS NULL THEN last_user_at ELSE ?1 END,
                    expires_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ?1, '+14 days'), expires_at)
                 WHERE id = ?2",
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
            insert_message(&tx, chat_id, seq, &row, &self.dicts)?;
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
            Ok(parse_message(row, &self.dicts))
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

    /// Stores one of another agent's turns of a chat (`chat.otherTurns`) at `seq`. A turn at the same seq is replaced.
    pub fn put_other_turn(&mut self, chat_id: &str, seq: i64, blocks: &Value) -> Result<()> {
        require_chat(&self.conn, chat_id)?;
        let blob = self
            .dicts
            .encode_keep(blocks)
            .map_err(ChatIndexError::Codec)?;
        self.conn.execute(
            "INSERT INTO other_turns (chat_id, seq, blocks) VALUES (?1, ?2, ?3)
             ON CONFLICT(chat_id, seq) DO UPDATE SET blocks = excluded.blocks",
            params![chat_id, seq, blob],
        )?;
        Ok(())
    }

    /// The other agents' turns of a chat, oldest first.
    pub fn other_turns(&self, chat_id: &str) -> Result<Vec<(i64, Value)>> {
        let mut statement = self
            .conn
            .prepare("SELECT seq, blocks FROM other_turns WHERE chat_id = ?1 ORDER BY seq")?;
        let rows = statement
            .query_map([chat_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(seq, bytes)| {
                Ok((
                    seq,
                    self.dicts.decode(&bytes).map_err(ChatIndexError::Codec)?,
                ))
            })
            .collect()
    }

    /// Stores an archived message's snapshot (what the archive kept of a reply) under its message id. Replaces the same id.
    pub fn put_archive(
        &mut self,
        chat_id: &str,
        msg_id: &str,
        at: &str,
        tokens: Option<i64>,
        snapshot: &Value,
    ) -> Result<()> {
        require_chat(&self.conn, chat_id)?;
        let blob = self
            .dicts
            .encode_keep(snapshot)
            .map_err(ChatIndexError::Codec)?;
        self.conn.execute(
            "INSERT INTO archive (chat_id, msg_id, at, tokens, snapshot) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(chat_id, msg_id) DO UPDATE SET at = excluded.at, tokens = excluded.tokens, snapshot = excluded.snapshot",
            params![chat_id, msg_id, at, tokens, blob],
        )?;
        Ok(())
    }

    /// The archived snapshots of a chat, oldest first (by `at`, then message id).
    pub fn archive(&self, chat_id: &str) -> Result<Vec<ArchiveEntry>> {
        let mut statement = self.conn.prepare(
            "SELECT msg_id, at, tokens, snapshot FROM archive WHERE chat_id = ?1 ORDER BY at, msg_id",
        )?;
        let rows = statement
            .query_map([chat_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(msg_id, at, tokens, bytes)| {
                Ok(ArchiveEntry {
                    msg_id,
                    at,
                    tokens,
                    snapshot: self.dicts.decode(&bytes).map_err(ChatIndexError::Codec)?,
                })
            })
            .collect()
    }
}

impl ChatIndex {
    /// Removes every other-agent turn of a chat (before its list is written again in order).
    pub fn clear_other_turns(&mut self, chat_id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM other_turns WHERE chat_id = ?1", [chat_id])?;
        Ok(())
    }

    /// Every other-agent turn of every chat as `(chat id, seq, blocks)`, in chat then seq order.
    pub fn other_turns_all(&self) -> Result<Vec<(String, i64, Value)>> {
        let mut statement = self
            .conn
            .prepare("SELECT chat_id, seq, blocks FROM other_turns ORDER BY chat_id, seq")?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(chat_id, seq, bytes)| {
                Ok((
                    chat_id,
                    seq,
                    self.dicts.decode(&bytes).map_err(ChatIndexError::Codec)?,
                ))
            })
            .collect()
    }

    /// Every archived entry of every chat as `(chat id, entry)`, in chat then time order.
    pub fn archive_all(&self) -> Result<Vec<(String, ArchiveEntry)>> {
        let mut statement = self.conn.prepare(
            "SELECT chat_id, msg_id, at, tokens, snapshot FROM archive ORDER BY chat_id, at, msg_id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(chat_id, msg_id, at, tokens, bytes)| {
                Ok((
                    chat_id,
                    ArchiveEntry {
                        msg_id,
                        at,
                        tokens,
                        snapshot: self.dicts.decode(&bytes).map_err(ChatIndexError::Codec)?,
                    },
                ))
            })
            .collect()
    }

    /// Records that a chat uses these attachment files (plan storage-sqlite P7).
    pub fn note_attachments(&mut self, chat_id: &str, paths: &[String]) -> Result<()> {
        require_chat(&self.conn, chat_id)?;
        for path in paths {
            self.conn.execute(
                "INSERT OR IGNORE INTO attachment_refs (path, chat_id) VALUES (?1, ?2)",
                params![path, chat_id],
            )?;
        }
        Ok(())
    }

    /// Attachment files whose every chat has been idle since before `cutoff`, the files to remove.
    pub fn idle_attachments(&self, cutoff: &str) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare(
            "SELECT r.path FROM attachment_refs r JOIN chats c ON c.id = r.chat_id
             GROUP BY r.path HAVING MAX(c.updated_at) < ?1 ORDER BY r.path",
        )?;
        let rows = statement
            .query_map([cutoff], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Drops the references to attachment files that were removed.
    pub fn forget_attachments(&mut self, paths: &[String]) -> Result<()> {
        for path in paths {
            self.conn
                .execute("DELETE FROM attachment_refs WHERE path = ?1", [path])?;
        }
        Ok(())
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
    dicts: &crate::codec::Dicts,
) -> Result<()> {
    // The blocks go in as a codec blob (version 2); `blocks_json` stays empty for these rows.
    let blocks = dicts
        .encode_keep(&message.blocks)
        .map_err(ChatIndexError::Codec)?;
    conn.execute(
        "INSERT INTO messages (chat_id, seq, role, agent, model, binding_id, native_provider, native_msg_id, time, blocks_json, blocks, preview, client_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '', ?10, ?11, ?12)",
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
            message.client_id,
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
        last_user_at: row.get(7)?,
        expires_at: row.get(8)?,
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

fn parse_message(row: &Row, dicts: &crate::codec::Dicts) -> Result<StoredMessage> {
    let native_provider: Option<String> = row.get(5)?;
    let native_msg_id: Option<String> = row.get(6)?;
    let native = match (native_provider, native_msg_id) {
        (Some(provider), Some(msg_id)) => Some(NativeRef { provider, msg_id }),
        _ => None,
    };
    // Version 2 rows keep the blocks as a blob; older rows keep their JSON text.
    let blob: Option<Vec<u8>> = row.get(9)?;
    let blocks: Value = match blob {
        Some(bytes) => dicts.decode(&bytes).map_err(|error| {
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
            client_id: row.get(10)?,
        },
    })
}
