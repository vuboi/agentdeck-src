//! How AgentDeck opens its SQLite databases (plan storage-sqlite, P1): the same pragmas everywhere, the schema changed by
//! numbered migrations counted in `user_version`, and a checkpoint that folds the write-ahead log back into the file.

use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

/// Opens (creating it if needed) a database in WAL mode, sets the pragmas, and applies the migrations it has not had yet.
/// Migration `n` (0-based) brings `user_version` to `n + 1`; a database from a newer AgentDeck is refused, not rewritten.
pub fn open(path: &Path, migrations: &[&str]) -> Result<Connection, String> {
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(|error| error.to_string())?;
    }
    let conn = Connection::open(path).map_err(|error| error.to_string())?;
    conn.busy_timeout(Duration::from_secs(30))
        .map_err(|error| error.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    // The WAL is folded back into the file past 4 MB and cut to 64 MB after a checkpoint, so it cannot grow without bound.
    conn.execute_batch(
        "PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=67108864;",
    )
    .map_err(|error| error.to_string())?;
    migrate(&conn, migrations)?;
    Ok(conn)
}

fn migrate(conn: &Connection, migrations: &[&str]) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let version = usize::try_from(version).map_err(|_| "invalid schema version".to_string())?;
    if version > migrations.len() {
        return Err(format!(
            "this database is schema version {version}, newer than this AgentDeck knows ({})",
            migrations.len()
        ));
    }
    for (index, sql) in migrations.iter().enumerate().skip(version) {
        let script = format!("BEGIN; {sql}\nPRAGMA user_version = {}; COMMIT;", index + 1);
        if let Err(error) = conn.execute_batch(&script) {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(format!("migration {} failed: {error}", index + 1));
        }
    }
    Ok(())
}

/// Folds the write-ahead log back into the database file. Errors are ignored: the log stays correct, and the next
/// checkpoint retries.
pub fn checkpoint(conn: &Connection) {
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let folder =
            std::env::temp_dir().join(format!("agentdeck-sqlite-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        folder.join("test.db")
    }

    #[test]
    fn migrations_run_once_and_set_the_version() {
        let path = temp("migrate");
        let schema = [
            "CREATE TABLE t (a INTEGER);",
            "ALTER TABLE t ADD COLUMN b TEXT;",
        ];
        {
            let conn = open(&path, &schema).expect("open");
            conn.execute("INSERT INTO t (a, b) VALUES (1, 'kept')", [])
                .expect("row");
        }
        let conn = open(&path, &schema).expect("reopen");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, 2);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0))
            .expect("rows");
        assert_eq!(rows, 1, "a reopen must not run the migrations again");
        checkpoint(&conn);
        let _ = std::fs::remove_dir_all(path.parent().expect("folder"));
    }

    #[test]
    fn a_newer_database_is_refused() {
        let path = temp("newer");
        drop(open(&path, &["CREATE TABLE t (a INTEGER);", "SELECT 1;"]).expect("open"));
        let error = open(&path, &["CREATE TABLE t (a INTEGER);"]).expect_err("refused");
        assert!(error.contains("newer"), "{error}");
        let _ = std::fs::remove_dir_all(path.parent().expect("folder"));
    }

    #[test]
    fn a_failed_migration_changes_nothing() {
        let path = temp("failed");
        let error = open(
            &path,
            &["CREATE TABLE t (a INTEGER); SELECT * FROM missing;"],
        )
        .expect_err("failed");
        assert!(error.contains("migration 1 failed"), "{error}");
        let conn = Connection::open(&path).expect("reopen");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, 0);
        let _ = std::fs::remove_dir_all(path.parent().expect("folder"));
    }
}
