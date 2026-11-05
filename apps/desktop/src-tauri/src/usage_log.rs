//! The usage log: one row per finished reply, in `app.db` in AgentDeck's home folder (plan storage-sqlite, P3). A reply is
//! one insert; the dashboards read the rows they need. The log keeps the newest `KEEP` replies, as the IndexedDB array
//! did.

use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};

const SCHEMA_1: &str = "
CREATE TABLE usage (
    id INTEGER PRIMARY KEY,
    at_ms INTEGER NOT NULL,
    at TEXT NOT NULL,
    session_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    model TEXT,
    project_id TEXT,
    ms INTEGER,
    input INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    output INTEGER NOT NULL,
    cost REAL,
    estimated INTEGER NOT NULL
);
CREATE INDEX usage_at ON usage (at_ms);
CREATE INDEX usage_agent_at ON usage (agent, at_ms);
CREATE INDEX usage_project_at ON usage (project_id, at_ms);
";

/// Replies kept: the newest ones, as the log kept before.
const KEEP: i64 = 20_000;
/// Most rows one read returns.
const READ_MAX: i64 = 20_000;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

/// One finished reply. `at_ms` is the time of `at` (ISO text), so reads can filter by range.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub at: String,
    pub at_ms: i64,
    pub session_id: String,
    pub agent: String,
    pub model: Option<String>,
    pub project_id: Option<String>,
    pub ms: Option<u64>,
    pub tokens: Tokens,
    pub cost: Option<f64>,
    pub estimated: bool,
}

static CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

fn with_conn<T>(run: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
    let shared = match CONN.get() {
        Some(conn) => conn,
        None => {
            let folder = crate::home_folder()?.join(crate::channel::home_folder_name());
            let conn = crate::sqlite::open(
                &folder.join("app.db"),
                crate::sqlite::Journal::Wal,
                &[SCHEMA_1],
            )?;
            CONN.get_or_init(|| Mutex::new(conn))
        }
    };
    let mut guard = shared.lock().map_err(|_| "usage log is busy".to_string())?;
    run(&mut guard)
}

fn insert(tx: &Transaction, record: &Record) -> Result<(), String> {
    tx.execute(
        "INSERT INTO usage (at_ms, at, session_id, agent, model, project_id, ms, input, cache_read, cache_write, output, cost, estimated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            record.at_ms,
            record.at,
            record.session_id,
            record.agent,
            record.model,
            record.project_id,
            record.ms.map(|value| value as i64),
            record.tokens.input as i64,
            record.tokens.cache_read as i64,
            record.tokens.cache_write as i64,
            record.tokens.output as i64,
            record.cost,
            record.estimated,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Drops the oldest rows beyond `keep`.
fn trim(tx: &Transaction, keep: i64) -> Result<(), String> {
    tx.execute(
        "DELETE FROM usage WHERE id <= (SELECT id FROM usage ORDER BY id DESC LIMIT 1 OFFSET ?1)",
        [keep],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn add_keeping(conn: &mut Connection, record: &Record, keep: i64) -> Result<(), String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    insert(&tx, record)?;
    trim(&tx, keep)?;
    tx.commit().map_err(|error| error.to_string())
}

fn since_in(conn: &Connection, from_ms: i64) -> Result<Vec<Record>, String> {
    let mut statement = conn
        .prepare(
            "SELECT at, at_ms, session_id, agent, model, project_id, ms, input, cache_read, cache_write, output, cost, estimated
             FROM usage WHERE at_ms >= ?1 ORDER BY at_ms, id LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![from_ms, READ_MAX], |row| {
            Ok(Record {
                at: row.get(0)?,
                at_ms: row.get(1)?,
                session_id: row.get(2)?,
                agent: row.get(3)?,
                model: row.get(4)?,
                project_id: row.get(5)?,
                ms: row.get::<_, Option<i64>>(6)?.map(|value| value as u64),
                tokens: Tokens {
                    input: row.get::<_, i64>(7)? as u64,
                    cache_read: row.get::<_, i64>(8)? as u64,
                    cache_write: row.get::<_, i64>(9)? as u64,
                    output: row.get::<_, i64>(10)? as u64,
                },
                cost: row.get(11)?,
                estimated: row.get(12)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn import_in(conn: &mut Connection, records: &[Record], keep: i64) -> Result<usize, String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    for record in records {
        insert(&tx, record)?;
    }
    trim(&tx, keep)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(records.len())
}

#[tauri::command]
pub fn usage_record(record: Record) -> Result<(), String> {
    with_conn(|conn| add_keeping(conn, &record, KEEP))
}

/// Replies from `from_ms` on, oldest first, at most `READ_MAX`.
#[tauri::command]
pub fn usage_since(from_ms: i64) -> Result<Vec<Record>, String> {
    with_conn(|conn| since_in(conn, from_ms))
}

/// Copies replies from the old IndexedDB log, once (the caller remembers that it did). Returns how many were copied.
#[tauri::command]
pub fn usage_import(records: Vec<Record>) -> Result<usize, String> {
    with_conn(|conn| import_in(conn, &records, KEEP))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> std::path::PathBuf {
        let folder = std::env::temp_dir().join(format!("agentdeck-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        folder.join("app.db")
    }

    fn record(at_ms: i64, agent: &str, output: u64) -> Record {
        Record {
            at: format!("t{at_ms}"),
            at_ms,
            session_id: "chat-1".into(),
            agent: agent.into(),
            model: Some("m".into()),
            project_id: None,
            ms: Some(120),
            tokens: Tokens {
                input: 10,
                output,
                cache_read: 3,
                cache_write: 1,
            },
            cost: Some(0.5),
            estimated: false,
        }
    }

    #[test]
    fn replies_come_back_oldest_first_with_their_tokens() {
        let path = temp();
        let mut conn =
            crate::sqlite::open(&path, crate::sqlite::Journal::Wal, &[SCHEMA_1]).expect("open");
        add_keeping(&mut conn, &record(300, "claude", 7), KEEP).expect("add");
        add_keeping(&mut conn, &record(100, "codex", 5), KEEP).expect("add");
        let all = since_in(&conn, 0).expect("read");
        assert_eq!(
            all.iter().map(|r| r.at_ms).collect::<Vec<_>>(),
            vec![100, 300]
        );
        assert_eq!(all[1].tokens.output, 7);
        assert_eq!(all[0].model.as_deref(), Some("m"));
        assert_eq!(since_in(&conn, 200).expect("range").len(), 1);
        let _ = std::fs::remove_dir_all(path.parent().expect("folder"));
    }

    #[test]
    fn the_log_keeps_only_the_newest_replies() {
        let path = temp();
        let mut conn =
            crate::sqlite::open(&path, crate::sqlite::Journal::Wal, &[SCHEMA_1]).expect("open");
        for at in 0..5 {
            add_keeping(&mut conn, &record(at, "claude", 1), 3).expect("add");
        }
        let kept = since_in(&conn, 0).expect("read");
        assert_eq!(
            kept.iter().map(|r| r.at_ms).collect::<Vec<_>>(),
            vec![2, 3, 4]
        );
        let _ = std::fs::remove_dir_all(path.parent().expect("folder"));
    }

    #[test]
    fn an_import_is_one_transaction_and_keeps_the_limit() {
        let path = temp();
        let mut conn =
            crate::sqlite::open(&path, crate::sqlite::Journal::Wal, &[SCHEMA_1]).expect("open");
        let batch: Vec<Record> = (0..10).map(|at| record(at, "claude", 1)).collect();
        assert_eq!(import_in(&mut conn, &batch, 4).expect("import"), 10);
        assert_eq!(since_in(&conn, 0).expect("read").len(), 4);
        let _ = std::fs::remove_dir_all(path.parent().expect("folder"));
    }
}
