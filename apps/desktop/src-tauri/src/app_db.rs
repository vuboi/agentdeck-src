//! `app.db`, the database of AgentDeck's own data in its home folder: the usage log and the Audit log (plan
//! storage-sqlite P3, P4). One connection, one list of migrations: a migration added here is applied once, in order.

use std::sync::{Mutex, OnceLock};

use rusqlite::Connection;

/// Every migration of `app.db`, in order. Never reorder or edit one that shipped; add the next one at the end.
const MIGRATIONS: &[&str] = &[crate::usage_log::SCHEMA_1, crate::audit_db::SCHEMA_1];

static CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

/// Runs `run` with the shared connection, opening (and migrating) the database on first use.
pub fn with_conn<T>(run: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
    let shared = match CONN.get() {
        Some(conn) => conn,
        None => {
            let folder = crate::home_folder()?.join(crate::channel::home_folder_name());
            let conn = crate::sqlite::open(
                &folder.join("app.db"),
                crate::sqlite::Journal::Wal,
                MIGRATIONS,
            )?;
            CONN.get_or_init(|| Mutex::new(conn))
        }
    };
    let mut guard = shared
        .lock()
        .map_err(|_| "app database is busy".to_string())?;
    run(&mut guard)
}
