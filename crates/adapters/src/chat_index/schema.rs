//! Table layout of `chats.db`. `CREATE ... IF NOT EXISTS` only: a schema change needs a new `SCHEMA_VERSION` and a step here.

use rusqlite::Connection;

use super::Result;

pub const SCHEMA_VERSION: i64 = 1;

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
";

/// Turns the foreign keys on, creates the tables and records the schema version.
pub fn prepare(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(DDL)?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO NOTHING",
        [SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
}
