//! Schema creation and upgrade path for the cache database.
//!
//! The schema is versioned with `PRAGMA user_version`: fresh/pre-release
//! databases are rebuilt, while the shipped v5 shape is upgraded in place.
//!
//! v8 removes the external-agent queue/chat tables. The cache is disposable and
//! the built-in agent keeps its sessions in the dsh store, so those tables are
//! dropped instead of migrated. v9 adds `dsh_tasks`, the task workflow rows
//! (metadata only; the transcript still lives in the dsh store).

use rusqlite::Connection;

/// Schema version. Bumped only when the stored shape changes; fresh and
/// pre-release databases are rebuilt from scratch, while shipped shapes are
/// upgraded in place.
const SCHEMA_VERSION: i64 = 9;

pub(super) fn run(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }

    // The whole upgrade is one transaction: a crash leaves either the old or
    // the new shape, never a half-dropped database with the old version stamp.
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let migrated = (|| -> Result<(), String> {
        if version >= 5 {
            upgrade_v5(conn)?;
        } else {
            // Fresh install or a pre-1.0 development database: this data is
            // disposable (snapshots / notifications), so rebuild instead of
            // carrying five incremental migrations for shapes nobody ships.
            conn.execute_batch(
                r#"
                DROP TABLE IF EXISTS snapshots;
                DROP TABLE IF EXISTS bugs;
                DROP TABLE IF EXISTS agent_tasks;
                DROP TABLE IF EXISTS agent_queue_state;
                DROP TABLE IF EXISTS mcp_audit;
                DROP TABLE IF EXISTS notification_settings;
                DROP TABLE IF EXISTS notification_items;
                DROP TABLE IF EXISTS notification_seen;
                DROP TABLE IF EXISTS notification_ignored;
                DROP TABLE IF EXISTS notification_cursors;
                DROP TABLE IF EXISTS notification_baseline;
                DROP TABLE IF EXISTS chat_messages_fts;
                DROP TABLE IF EXISTS chat_messages;
                DROP TABLE IF EXISTS chat_sessions;
                DROP TABLE IF EXISTS dsh_tasks;
                "#,
            )
            .map_err(|error| error.to_string())?;
        }

        create_schema(conn)?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|error| error.to_string())?;
        Ok(())
    })();

    match migrated {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|error| error.to_string()),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn create_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS snapshots (
            kind TEXT NOT NULL,
            key TEXT NOT NULL,
            payload TEXT NOT NULL,
            fetched_at INTEGER NOT NULL,
            PRIMARY KEY (kind, key)
        );

        CREATE TABLE IF NOT EXISTS bugs (
            workspace_id TEXT NOT NULL,
            bug_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT '',
            modified TEXT NOT NULL DEFAULT '',
            raw TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, bug_id)
        );

        -- The audit entry is serialized into `payload`; only the retention
        -- timestamp is a column because the table is trimmed by age.
        CREATE TABLE IF NOT EXISTS mcp_audit (
            id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notification_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER NOT NULL,
            scope TEXT NOT NULL,
            include_new INTEGER NOT NULL,
            include_transferred INTEGER NOT NULL,
            include_reopened INTEGER NOT NULL,
            poll_interval_secs INTEGER NOT NULL,
            quiet_enabled INTEGER NOT NULL,
            quiet_start TEXT NOT NULL,
            quiet_end TEXT NOT NULL,
            max_visible INTEGER NOT NULL,
            ai_enabled INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notification_items (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            workspace_name TEXT NOT NULL DEFAULT '',
            bug_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL,
            owner TEXT NOT NULL DEFAULT '',
            creator TEXT NOT NULL DEFAULT '',
            severity TEXT NOT NULL DEFAULT '',
            priority TEXT NOT NULL DEFAULT '',
            created TEXT NOT NULL DEFAULT '',
            detected_at TEXT NOT NULL DEFAULT '',
            state TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notification_seen (
            bug_key TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT '',
            owner TEXT NOT NULL DEFAULT '',
            created TEXT NOT NULL DEFAULT '',
            assigned_time TEXT NOT NULL DEFAULT '',
            kinds TEXT NOT NULL DEFAULT '',
            last_seen TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS notification_ignored (
            bug_key TEXT PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS notification_cursors (
            workspace_id TEXT PRIMARY KEY,
            cursor TEXT NOT NULL
        );

        -- One row per built-in agent task. `payload` is the serialized task
        -- record; the columns exist for ordering, filtering and the workflow
        -- compare-and-swap, not for rendering.
        CREATE TABLE IF NOT EXISTS dsh_tasks (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            project_id TEXT NOT NULL DEFAULT '',
            workflow TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            payload TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS dsh_tasks_updated ON dsh_tasks(updated_at DESC);
        CREATE INDEX IF NOT EXISTS dsh_tasks_workflow ON dsh_tasks(workflow);
        "#,
    )
    .map_err(|error| error.to_string())
}

/// v5 (the shipped 1.0 schema) → current: keep user-visible rows and drop the
/// tables/columns no code reads any more.
fn upgrade_v5(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        DROP TABLE IF EXISTS legacy_agent_tasks;
        DROP TABLE IF EXISTS agent_tasks;
        DROP TABLE IF EXISTS agent_queue_state;
        DROP TABLE IF EXISTS chat_messages_fts;
        DROP TABLE IF EXISTS chat_messages;
        DROP TABLE IF EXISTS chat_sessions;
        DROP TABLE IF EXISTS mcp_audit;
        DROP TABLE IF EXISTS notification_baseline;
        "#,
    )
    .map_err(|error| error.to_string())?;
    // A partially migrated file may already lack the column.
    if column_exists(conn, "notification_settings", "settings_version")? {
        conn.execute_batch("ALTER TABLE notification_settings DROP COLUMN settings_version")
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;
    for name in names {
        if name.map_err(|error| error.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v5_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory");
        conn.execute_batch(
            r#"
            CREATE TABLE agent_tasks (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO agent_tasks VALUES ('t1', '{"id":"t1"}', 1);
            CREATE TABLE chat_sessions (id TEXT PRIMARY KEY);
            CREATE TABLE notification_settings (
                id INTEGER PRIMARY KEY,
                settings_version INTEGER
            );
            CREATE TABLE snapshots (
                kind TEXT NOT NULL,
                key TEXT NOT NULL,
                payload TEXT NOT NULL,
                fetched_at INTEGER NOT NULL,
                PRIMARY KEY (kind, key)
            );
            PRAGMA user_version = 5;
            "#,
        )
        .expect("v5 schema");
        conn
    }

    #[test]
    fn v5_upgrade_drops_agent_tables_and_stamps_the_version() {
        let conn = v5_connection();
        run(&conn).expect("migrate");

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, SCHEMA_VERSION);
        for table in ["agent_tasks", "chat_sessions"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("table lookup");
            assert_eq!(exists, 0, "{table} must be dropped");
        }
        assert!(
            !column_exists(&conn, "notification_settings", "settings_version").expect("columns")
        );
    }

    #[test]
    fn v5_upgrade_survives_a_database_without_its_task_table() {
        let conn = v5_connection();
        conn.execute_batch("DROP TABLE agent_tasks")
            .expect("simulate partial");

        run(&conn).expect("recoverable migration");

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, SCHEMA_VERSION);
    }
}
