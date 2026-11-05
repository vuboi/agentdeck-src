//! Index of the Claude and Codex transcripts, kept in SQLite between starts (plan storage-sqlite P6). A transcript whose
//! length and modified time are unchanged is not read again, so the start-up scan costs one `stat` per file. Only the
//! entries that changed are written; entries of deleted files are removed.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    time::UNIX_EPOCH,
};

use rusqlite::{params, Connection};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

/// Bump when an indexer's output changes, so every entry is indexed again (`user_version`).
const VERSION: i64 = 2;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS entries (
    path TEXT PRIMARY KEY,
    len INTEGER NOT NULL,
    modified TEXT NOT NULL,
    value TEXT
);
";

#[derive(Serialize, Deserialize, Clone)]
struct Entry<T> {
    len: u64,
    modified: u128,
    /// `None` for a file the indexer skipped (no messages), so it is not read again either.
    value: Option<T>,
}

/// Index entries of one kind of file (`T`), in the database at `path`.
pub struct IndexCache<T> {
    conn: Option<Connection>,
    saved: HashMap<String, Entry<T>>,
    /// Keys of this scan (every file seen), and the ones whose entry was indexed again.
    seen: HashSet<String>,
    dirty: HashMap<String, Entry<T>>,
}

fn open_db(path: &Path) -> Option<Connection> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let conn = Connection::open(path).ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(10));
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0);
    if version != VERSION {
        // Another format or an older one: the cache is rebuilt, nothing else depends on it.
        conn.execute_batch("DROP TABLE IF EXISTS entries;").ok()?;
    }
    conn.execute_batch(SCHEMA).ok()?;
    conn.pragma_update(None, "user_version", VERSION).ok()?;
    Some(conn)
}

impl<T: Serialize + DeserializeOwned + Clone> IndexCache<T> {
    /// The entries saved last time. A missing, damaged or older database gives an empty cache.
    pub fn open(path: &Path) -> Self {
        let conn = open_db(path);
        let mut saved = HashMap::new();
        if let Some(conn) = &conn {
            if let Ok(mut statement) =
                conn.prepare("SELECT path, len, modified, value FROM entries")
            {
                let rows = statement.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, u64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                });
                if let Ok(rows) = rows {
                    for (key, len, modified, value) in rows.flatten() {
                        let Ok(modified) = modified.parse::<u128>() else {
                            continue;
                        };
                        let value = match value {
                            Some(text) => match serde_json::from_str::<Option<T>>(&text) {
                                Ok(value) => value,
                                Err(_) => continue,
                            },
                            None => None,
                        };
                        saved.insert(
                            key,
                            Entry {
                                len,
                                modified,
                                value,
                            },
                        );
                    }
                }
            }
        }
        Self {
            conn,
            saved,
            seen: HashSet::new(),
            dirty: HashMap::new(),
        }
    }

    /// The indexed value of `file`: the saved one when the file has not changed, otherwise `index` runs.
    pub fn get_or_index(&mut self, file: &Path, index: impl FnOnce() -> Option<T>) -> Option<T> {
        let Ok(meta) = fs::metadata(file) else {
            return index();
        };
        let Some(modified) = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|age| age.as_nanos())
        else {
            return index();
        };
        let len = meta.len();
        let key = file.to_string_lossy().into_owned();
        self.seen.insert(key.clone());
        match self.saved.remove(&key) {
            Some(entry) if entry.len == len && entry.modified == modified => entry.value,
            _ => {
                let value = index();
                self.dirty.insert(
                    key,
                    Entry {
                        len,
                        modified,
                        value: value.clone(),
                    },
                );
                value
            }
        }
    }

    /// Writes this scan's changes in one transaction: the entries that were indexed again, and no entry of a file
    /// that was not seen. A failed write only costs the next start a scan.
    pub fn save(self) {
        let Some(mut conn) = self.conn else {
            return;
        };
        // Saved entries that were not looked at belong to files that no longer exist.
        let gone: Vec<String> = self
            .saved
            .into_keys()
            .filter(|key| !self.seen.contains(key))
            .collect();
        if gone.is_empty() && self.dirty.is_empty() {
            return;
        }
        let Ok(tx) = conn.transaction() else {
            return;
        };
        for key in &gone {
            let _ = tx.execute("DELETE FROM entries WHERE path = ?1", [key]);
        }
        for (key, entry) in &self.dirty {
            let value = serde_json::to_string(&entry.value).ok();
            let _ = tx.execute(
                "INSERT INTO entries (path, len, modified, value) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(path) DO UPDATE SET len = excluded.len, modified = excluded.modified, value = excluded.value",
                params![key, entry.len, entry.modified.to_string(), value],
            );
        }
        let _ = tx.commit();
        // Fold the write-ahead log back into the file, so it does not keep the size of its busiest scan.
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
}
