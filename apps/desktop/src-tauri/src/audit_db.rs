//! The Audit log in `app.db` (plan storage-sqlite P4): one row per finished tool call or chat error. The line's JSON is
//! kept as a codec blob (`body`); its start time, status and picture name are columns, so the counts and the pruning do
//! not read the bodies. The first use copies `audit.jsonl` (the old file) into the table and renames the file.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use ag_adapters::codec;
use rusqlite::{params, Connection};
use serde::Serialize;

pub const SCHEMA_1: &str = "
CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    started_at REAL,
    status TEXT,
    image TEXT,
    body BLOB NOT NULL
);
CREATE INDEX audit_started ON audit (started_at);
";

const DAY_MS: f64 = 86_400_000.0;
/// Most lines one read returns.
const PAGE_MAX: usize = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPageEntry {
    /// The row id: the cursor of the page that reads older lines.
    pub offset: i64,
    pub line: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
    pub entries: Vec<AuditPageEntry>,
    pub cursor: Option<i64>,
    pub has_more: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditDayCount {
    pub day: i64,
    pub total: usize,
    pub failed: usize,
}

fn err(error: rusqlite::Error) -> String {
    error.to_string()
}

/// The local day number of a time (ms since the epoch) for a time zone offset in JS minutes (positive west of UTC).
fn audit_day(started: f64, offset_min: f64) -> i64 {
    ((started - offset_min * 60_000.0) / DAY_MS).floor() as i64
}

/// The start time, status and picture name of one log line.
fn columns(line: &str) -> (Option<f64>, Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return (None, None, None);
    };
    (
        value.get("startedAt").and_then(serde_json::Value::as_f64),
        value
            .get("status")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        value
            .get("image")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    )
}

fn insert(conn: &Connection, line: &str) -> Result<(), String> {
    let (started, status, image) = columns(line);
    let body = codec::encode_keep(&line.to_string())?;
    conn.execute(
        "INSERT INTO audit (started_at, status, image, body) VALUES (?1, ?2, ?3, ?4)",
        params![started, status, image, body],
    )
    .map_err(err)?;
    Ok(())
}

/// The older lines of `cursor` (the newest when it is None), at most `limit`, oldest first within the page.
fn read(conn: &Connection, cursor: Option<i64>, limit: usize) -> Result<AuditPage, String> {
    let page_size = limit.clamp(1, PAGE_MAX);
    let mut statement = conn
        .prepare("SELECT id, body FROM audit WHERE id < ?1 ORDER BY id DESC LIMIT ?2")
        .map_err(err)?;
    let mut found: Vec<(i64, Vec<u8>)> = statement
        .query_map(
            params![cursor.unwrap_or(i64::MAX), (page_size + 1) as i64],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let has_more = found.len() > page_size;
    found.truncate(page_size);
    // The oldest row read is the next cursor, even when a corrupt body is skipped below.
    let next = found.last().map(|(id, _)| *id);
    let mut entries = Vec::with_capacity(found.len());
    for (offset, body) in found.into_iter().rev() {
        if let Ok(line) = codec::decode::<String>(&body) {
            entries.push(AuditPageEntry { offset, line });
        }
    }
    Ok(AuditPage {
        entries,
        cursor: if has_more { next } else { None },
        has_more,
    })
}

/// The full count of every day the log holds, by local day number.
fn days(conn: &Connection, offset_min: i64) -> Result<Vec<AuditDayCount>, String> {
    let mut statement = conn
        .prepare("SELECT started_at, status FROM audit WHERE started_at IS NOT NULL")
        .map_err(err)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, f64>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(err)?;
    let mut counts: BTreeMap<i64, (usize, usize)> = BTreeMap::new();
    for row in rows {
        let (started, status) = row.map_err(err)?;
        let entry = counts
            .entry(audit_day(started, offset_min as f64))
            .or_default();
        entry.0 += 1;
        if status.as_deref() == Some("fail") {
            entry.1 += 1;
        }
    }
    Ok(counts
        .into_iter()
        .map(|(day, (total, failed))| AuditDayCount { day, total, failed })
        .collect())
}

/// Deletes the lines that started before `cutoff`. A line without a start time is kept. Returns how many went.
fn prune_rows(conn: &Connection, cutoff: f64) -> Result<usize, String> {
    conn.execute("DELETE FROM audit WHERE started_at < ?1", [cutoff])
        .map_err(err)
}

/// The picture files the kept lines point to.
fn referenced_images(conn: &Connection) -> Result<HashSet<String>, String> {
    let mut statement = conn
        .prepare("SELECT DISTINCT image FROM audit WHERE image IS NOT NULL")
        .map_err(err)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(err)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(err)?;
    Ok(names)
}

static LEGACY_DONE: AtomicBool = AtomicBool::new(false);

/// Copies the old `audit.jsonl` into the table once, then renames it. A line that is not JSON is dropped, as the old
/// reader dropped it.
fn import_legacy(conn: &mut Connection) -> Result<(), String> {
    if LEGACY_DONE.load(Ordering::Relaxed) {
        return Ok(());
    }
    let folder = crate::home_folder()?.join(crate::channel::home_folder_name());
    let file: PathBuf = folder.join("audit.jsonl");
    if let Ok(text) = std::fs::read_to_string(&file) {
        let tx = conn.transaction().map_err(err)?;
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            if serde_json::from_str::<serde_json::Value>(line).is_ok() {
                insert(&tx, line)?;
            }
        }
        tx.commit().map_err(err)?;
        let _ = std::fs::rename(&file, folder.join("audit.jsonl.imported"));
        let _ = std::fs::remove_file(folder.join("audit.index.json"));
    }
    LEGACY_DONE.store(true, Ordering::Relaxed);
    Ok(())
}

fn run<T>(work: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
    crate::app_db::with_conn(|conn| {
        import_legacy(conn)?;
        work(conn)
    })
}

#[tauri::command]
pub fn audit_append(line: String, offset_min: i64) -> Result<(), String> {
    let _ = offset_min;
    run(|conn| insert(conn, &line))
}

#[tauri::command]
pub async fn audit_read(cursor: Option<i64>, limit: usize) -> Result<AuditPage, String> {
    tauri::async_runtime::spawn_blocking(move || run(|conn| read(conn, cursor, limit)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn audit_days(offset_min: i64) -> Result<Vec<AuditDayCount>, String> {
    tauri::async_runtime::spawn_blocking(move || run(|conn| days(conn, offset_min)))
        .await
        .map_err(|error| error.to_string())?
}

/// Keeps the lines from `cutoff` on (the app passes the start of yesterday) and deletes the pictures no kept line
/// names. Returns how many lines went.
#[tauri::command]
pub async fn audit_prune(cutoff: f64) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dropped = run(|conn| prune_rows(conn, cutoff))?;
        let kept = run(|conn| referenced_images(conn))?;
        if let Ok(entries) = std::fs::read_dir(crate::audit_images()?) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !kept.contains(&name) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Ok(dropped)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn audit_clear() -> Result<(), String> {
    run(|conn| {
        conn.execute("DELETE FROM audit", []).map_err(err)?;
        Ok(())
    })?;
    match std::fs::remove_dir_all(crate::audit_images()?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlite::{open, Journal};

    fn temp(name: &str) -> PathBuf {
        let folder =
            std::env::temp_dir().join(format!("agentdeck-audit-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        folder.join("app.db")
    }

    fn line(started: f64, status: &str, image: Option<&str>) -> String {
        let mut value = serde_json::json!({ "key": format!("k{started}"), "startedAt": started, "status": status, "tool": "Bash" });
        if let Some(image) = image {
            value["image"] = serde_json::json!(image);
        }
        value.to_string()
    }

    #[test]
    fn pages_go_back_from_the_newest_line() {
        let path = temp("pages");
        let conn = open(&path, Journal::Wal, &[SCHEMA_1]).expect("open");
        for index in 0..5 {
            insert(&conn, &line(1000.0 + index as f64, "ok", None)).expect("insert");
        }
        let first = read(&conn, None, 2).expect("first page");
        assert_eq!(first.entries.len(), 2);
        assert!(
            first.entries[0].line.contains("1003"),
            "{}",
            first.entries[0].line
        );
        assert!(first.has_more);
        let second = read(&conn, first.cursor, 2).expect("second page");
        assert!(second.entries[1].line.contains("1002"));
        let last = read(&conn, second.cursor, 2).expect("last page");
        assert_eq!(last.entries.len(), 1);
        assert!(last.entries[0].line.contains("1000"));
        assert!(!last.has_more);
        assert_eq!(last.cursor, None);
        let _ = std::fs::remove_dir_all(path.parent().expect("folder"));
    }

    #[test]
    fn days_are_counted_with_their_failures() {
        let path = temp("days");
        let conn = open(&path, Journal::Wal, &[SCHEMA_1]).expect("open");
        insert(&conn, &line(0.0, "ok", None)).expect("a");
        insert(&conn, &line(60_000.0, "fail", None)).expect("b");
        insert(&conn, &line(DAY_MS + 1.0, "ok", None)).expect("c");
        let counted = days(&conn, 0).expect("days");
        assert_eq!(counted.len(), 2);
        assert_eq!(
            (counted[0].day, counted[0].total, counted[0].failed),
            (0, 2, 1)
        );
        assert_eq!(
            (counted[1].day, counted[1].total, counted[1].failed),
            (1, 1, 0)
        );
        let _ = std::fs::remove_dir_all(path.parent().expect("folder"));
    }

    #[test]
    fn pruning_keeps_lines_without_a_time_and_the_pictures_still_named() {
        let path = temp("prune");
        let conn = open(&path, Journal::Wal, &[SCHEMA_1]).expect("open");
        insert(&conn, &line(10.0, "ok", Some("old.png"))).expect("old");
        insert(&conn, &line(900.0, "ok", Some("new.png"))).expect("new");
        insert(&conn, &json_without_time()).expect("untimed");
        assert_eq!(prune_rows(&conn, 100.0).expect("prune"), 1);
        let kept = referenced_images(&conn).expect("images");
        assert!(kept.contains("new.png") && !kept.contains("old.png"));
        assert_eq!(read(&conn, None, 10).expect("left").entries.len(), 2);
        let _ = std::fs::remove_dir_all(path.parent().expect("folder"));
    }

    fn json_without_time() -> String {
        r#"{"key":"no-time","status":"ok"}"#.to_string()
    }

    #[test]
    fn a_body_is_kept_as_the_exact_line() {
        let path = temp("exact");
        let conn = open(&path, Journal::Wal, &[SCHEMA_1]).expect("open");
        let text = line(5.0, "ok", None);
        insert(&conn, &text).expect("insert");
        let page = read(&conn, None, 1).expect("read");
        assert_eq!(page.entries[0].line, text);
        let _ = std::fs::remove_dir_all(path.parent().expect("folder"));
    }
}
