//! Parsed transcripts kept on disk between starts (plan storage-sqlite P6.3). A transcript is stored as pages of
//! `PAGE` messages, MessagePack + lz4 (codec mode 11). A file whose length and modified time still match its pages is
//! not parsed again after a restart. Pages of a changed file are replaced. The whole cache is capped at `CAP_BYTES`,
//! least recently used first. A cache that cannot be read is dropped and rebuilt; it is never an error for the user.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use super::HistoryMessage;
use crate::codec;

/// Messages per stored page.
pub const PAGE: usize = 50;
/// Upper bound of the stored pages, in bytes.
pub const CAP_BYTES: i64 = 500 * 1024 * 1024;
/// Bump when the stored message shape changes: a different version empties the cache.
const VERSION: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS history_pages (
    path       TEXT NOT NULL,
    page       INTEGER NOT NULL,
    len        INTEGER NOT NULL,
    modified   INTEGER NOT NULL,
    last_used  INTEGER NOT NULL,
    data       BLOB NOT NULL,
    PRIMARY KEY (path, page)
);
CREATE INDEX IF NOT EXISTS history_pages_used ON history_pages(last_used);
";

/// A file's stamp as stored: its length and its modified time in nanoseconds (-1 when unknown).
fn stamp_of(len: u64, modified: Option<SystemTime>) -> (i64, i64) {
    let nanos = modified
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(-1, |time| time.as_nanos() as i64);
    (len as i64, nanos)
}

fn open(db: &Path) -> Option<Connection> {
    if let Some(parent) = db.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(db).ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(10));
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    if version != VERSION {
        conn.execute_batch("DROP TABLE IF EXISTS history_pages;")
            .ok()?;
    }
    conn.execute_batch(SCHEMA).ok()?;
    conn.pragma_update(None, "user_version", VERSION).ok()?;
    Some(conn)
}

fn now_ticks() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_nanos() as i64)
}

/// The messages of a transcript as stored, when every page matches the file's current stamp.
pub fn get(
    db: &Path,
    file: &Path,
    len: u64,
    modified: Option<SystemTime>,
) -> Option<Vec<HistoryMessage>> {
    let (len, modified) = stamp_of(len, modified);
    let conn = open(db)?;
    let key = file.to_string_lossy().into_owned();
    let rows = {
        let mut statement = conn
            .prepare(
                "SELECT page, len, modified, data FROM history_pages WHERE path = ?1 ORDER BY page",
            )
            .ok()?;
        let rows = statement
            .query_map([&key], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            })
            .ok()?
            .collect::<rusqlite::Result<Vec<_>>>()
            .ok()?;
        rows
    };
    if rows.is_empty() {
        return None;
    }
    let mut messages = Vec::new();
    for (index, (page, stored_len, stored_modified, data)) in rows.iter().enumerate() {
        if *page != index as i64 || *stored_len != len || *stored_modified != modified {
            return None;
        }
        let chunk: Vec<HistoryMessage> = codec::decode(data).ok()?;
        messages.extend(chunk);
    }
    let _ = conn.execute(
        "UPDATE history_pages SET last_used = ?2 WHERE path = ?1",
        params![key, now_ticks()],
    );
    Some(messages)
}

/// Stores a transcript's pages, replacing any older ones of the same file, then keeps the cache under its cap.
pub fn put(
    db: &Path,
    file: &Path,
    len: u64,
    modified: Option<SystemTime>,
    messages: &[HistoryMessage],
) {
    if messages.is_empty() {
        return;
    }
    let (len, modified) = stamp_of(len, modified);
    let Some(mut conn) = open(db) else { return };
    let key = file.to_string_lossy().into_owned();
    let used = now_ticks();
    let Ok(tx) = conn.transaction() else { return };
    let _ = tx.execute("DELETE FROM history_pages WHERE path = ?1", [&key]);
    for (page, chunk) in messages.chunks(PAGE).enumerate() {
        let Ok(data) = codec::encode_cache_named(&chunk.to_vec()) else {
            return;
        };
        let _ = tx.execute(
            "INSERT INTO history_pages (path, page, len, modified, last_used, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![key, page as i64, len, modified, used, data],
        );
    }
    if tx.commit().is_ok() {
        prune(&conn);
    }
}

/// Removes the least recently used pages while the cache is over `CAP_BYTES`.
fn prune(conn: &Connection) {
    let total: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(data)), 0) FROM history_pages",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if total <= CAP_BYTES {
        return;
    }
    let mut over = total - CAP_BYTES;
    let rows: Vec<(i64, i64)> = {
        let Ok(mut statement) = conn.prepare(
            "SELECT rowid, LENGTH(data) FROM history_pages ORDER BY last_used, path, page",
        ) else {
            return;
        };
        let Ok(found) = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))) else {
            return;
        };
        found.flatten().collect()
    };
    for (rowid, size) in rows {
        if over <= 0 {
            break;
        }
        let _ = conn.execute("DELETE FROM history_pages WHERE rowid = ?1", [rowid]);
        over -= size;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: usize) -> HistoryMessage {
        HistoryMessage {
            id: format!("m{id}"),
            role: "user".to_string(),
            time: String::new(),
            blocks: Vec::new(),
            usage: None,
            model: None,
        }
    }

    #[test]
    fn a_stored_transcript_comes_back_while_its_stamp_matches() {
        let folder = std::env::temp_dir().join(format!("page-cache-{}", std::process::id()));
        let db = folder.join("pages.db");
        let file = folder.join("session.jsonl");
        let messages: Vec<HistoryMessage> = (0..120).map(message).collect();
        let modified = Some(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000));

        put(&db, &file, 42, modified, &messages);
        assert_eq!(get(&db, &file, 42, modified), Some(messages));
        assert_eq!(
            get(&db, &file, 43, modified),
            None,
            "a changed length is parsed again"
        );
        let _ = std::fs::remove_dir_all(&folder);
    }
}
