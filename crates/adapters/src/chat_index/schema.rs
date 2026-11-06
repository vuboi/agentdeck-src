//! Table layout of `chats.db`. `CREATE ... IF NOT EXISTS` only: a schema change needs a new `SCHEMA_VERSION` and a step here.

use rusqlite::Connection;

use super::Result;

pub const SCHEMA_VERSION: i64 = 7;

const DDL: &str = "
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT '',
    project_id    TEXT,
    cwd           TEXT,
    active_agent  TEXT,
    created_at    TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL DEFAULT '',
    last_user_at  TEXT NOT NULL DEFAULT '',
    expires_at    TEXT NOT NULL DEFAULT '',
    deleted_at    TEXT
);

CREATE TABLE IF NOT EXISTS bindings (
    id          TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,
    native_id   TEXT,
    path        TEXT,
    model       TEXT,
    epoch       INTEGER NOT NULL DEFAULT 0,
    origin      TEXT NOT NULL,
    state       TEXT NOT NULL,
    synced_seq  INTEGER NOT NULL DEFAULT 0,
    cursor_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS bindings_native
    ON bindings(provider, native_id) WHERE native_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bindings_chat ON bindings(chat_id);

CREATE TABLE IF NOT EXISTS messages (
    chat_id          TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    seq              INTEGER NOT NULL,
    role             TEXT NOT NULL,
    agent            TEXT,
    model            TEXT,
    binding_id       TEXT REFERENCES bindings(id) ON DELETE SET NULL,
    native_provider  TEXT,
    native_msg_id    TEXT,
    time             TEXT NOT NULL DEFAULT '',
    blocks_json      TEXT NOT NULL,
    PRIMARY KEY (chat_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_native
    ON messages(chat_id, native_provider, native_msg_id) WHERE native_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_binding ON messages(binding_id);

-- Version 4 (plan storage-sqlite P5.4): another agent's turns of a chat, and the archive of a chat's replies.
-- Both belong to their chat: deleting the chat deletes them too.
CREATE TABLE IF NOT EXISTS other_turns (
    chat_id  TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    seq      INTEGER NOT NULL,
    blocks   BLOB NOT NULL,
    PRIMARY KEY (chat_id, seq)
);
CREATE TABLE IF NOT EXISTS archive (
    chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    msg_id    TEXT NOT NULL,
    at        TEXT NOT NULL DEFAULT '',
    tokens    INTEGER,
    snapshot  BLOB NOT NULL,
    PRIMARY KEY (chat_id, msg_id)
);

-- Version 5 (plan storage-sqlite P7): which chat uses which attachment file. A file no chat uses is never removed.
CREATE TABLE IF NOT EXISTS attachment_refs (
    path     TEXT NOT NULL,
    chat_id  TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    PRIMARY KEY (path, chat_id)
);

-- Version 6 (plan storage-sqlite P1.6): zstd dictionaries for the messages. Never deleted while a row uses one.
CREATE TABLE IF NOT EXISTS codec_dicts (
    id       INTEGER PRIMARY KEY,
    created  TEXT NOT NULL,
    bytes    BLOB NOT NULL
);
";

/// Dictionaries of the store, as the codec reads them.
pub fn load_dicts(conn: &Connection) -> Result<crate::codec::Dicts> {
    let mut statement = conn.prepare("SELECT id, bytes FROM codec_dicts ORDER BY id")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut dicts = crate::codec::Dicts::default();
    for (id, bytes) in rows {
        let id = u16::try_from(id)
            .map_err(|_| super::ChatIndexError::Codec("dictionary id out of range".into()))?;
        dicts.latest = Some(id);
        dicts.bytes.insert(id, bytes);
    }
    Ok(dicts)
}

/// True when the messages are enough to train the dictionary and none exists yet.
pub fn dicts_due(conn: &Connection) -> Result<bool> {
    let dicts: i64 = conn.query_row("SELECT COUNT(*) FROM codec_dicts", [], |row| row.get(0))?;
    if dicts > 0 {
        return Ok(false);
    }
    let messages: i64 = conn.query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))?;
    Ok(messages >= super::DICT_MIN_ROWS)
}

/// Stores a trained dictionary. Its id is the next free one.
pub fn save_dict(conn: &Connection, bytes: &[u8]) -> Result<()> {
    conn.execute(
        "INSERT INTO codec_dicts (created, bytes) VALUES (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?1)",
        [bytes],
    )?;
    Ok(())
}

/// Turns the foreign keys on, creates the tables and records the schema version.
pub fn prepare(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(DDL)?;
    let version: i64 = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|text| text.parse().ok())
        // A new database has no version yet: its tables come from DDL without the version 2 columns.
        .unwrap_or(1);
    if version < 2 {
        // Version 2: a message keeps its blocks as a codec blob (`blocks`, plan storage-sqlite P5.2) and a short text of
        // the reply (`preview`) for the lists. Rows written before keep their JSON text in `blocks_json`.
        conn.execute_batch(
            "ALTER TABLE messages ADD COLUMN blocks BLOB;
             ALTER TABLE messages ADD COLUMN preview TEXT;",
        )?;
    }
    if version < 3 {
        // Version 3: the message id the screen uses, so a row can be matched back to the message it came from.
        conn.execute_batch(
            "ALTER TABLE messages ADD COLUMN client_id TEXT;
             CREATE INDEX IF NOT EXISTS messages_client ON messages(chat_id, client_id);",
        )?;
    }
    if version < 7 {
        if !has_column(conn, "chats", "last_user_at")? {
            conn.execute_batch(
                "ALTER TABLE chats ADD COLUMN last_user_at TEXT NOT NULL DEFAULT '';",
            )?;
        }
        if !has_column(conn, "chats", "expires_at")? {
            conn.execute_batch(
                "ALTER TABLE chats ADD COLUMN expires_at TEXT NOT NULL DEFAULT '';",
            )?;
        }
        conn.execute(
            "UPDATE chats
             SET last_user_at = CASE WHEN last_user_at = '' THEN updated_at ELSE last_user_at END,
                 expires_at = CASE WHEN expires_at = '' THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', CASE WHEN last_user_at = '' THEN updated_at ELSE last_user_at END, '+14 days'), '') ELSE expires_at END
             WHERE expires_at = ''",
            [],
        )?;
    }
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == column {
            return Ok(true);
        }
    }
    Ok(false)
}
