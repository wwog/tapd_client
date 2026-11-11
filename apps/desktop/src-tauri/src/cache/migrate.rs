//! Schema creation and upgrade path for the cache database.
//!
//! The schema is versioned with `PRAGMA user_version`: fresh/pre-release
//! databases are rebuilt, while the shipped v5 shape is upgraded in place.

use rusqlite::Connection;

/// Schema version. Bumped only when the stored shape changes; fresh and
/// pre-release databases are rebuilt from scratch, while the shipped v5
/// shape is upgraded in place.
const SCHEMA_VERSION: i64 = 6;

pub(super) fn run(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }

    if version >= 5 {
        upgrade_v5(conn)?;
    } else {
        // Fresh install or a pre-1.0 development database: this data is
        // disposable (snapshots / task history), so rebuild instead of
        // carrying five incremental migrations for shapes nobody ships.
        conn.execute_batch(
            r#"
            BEGIN;
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
            COMMIT;
            "#,
        )
        .map_err(|error| error.to_string())?;
    }

    create_schema(conn)?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|error| error.to_string())?;

    if version >= 5 {
        restore_v5_agent_tasks(conn)?;
    }
    Ok(())
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

        -- AgentTask is serialized into `payload`; `AgentTask` is the single
        -- schema and history paging happens in memory.
        CREATE TABLE IF NOT EXISTS agent_tasks (
            id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_queue_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            paused INTEGER NOT NULL DEFAULT 0
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
        "#,
    )
    .map_err(|error| error.to_string())
}

/// v5 (the shipped 1.0 schema) → v6: keep user-visible rows, collapse the
/// task table to its JSON payload, and drop tables/columns no code reads.
fn upgrade_v5(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        BEGIN;
        CREATE TEMP TABLE legacy_agent_tasks AS
            SELECT id, payload, updated_at FROM agent_tasks WHERE payload <> '';
        DROP TABLE IF EXISTS agent_tasks;
        DROP TABLE IF EXISTS agent_queue_state;
        DROP TABLE IF EXISTS mcp_audit;
        DROP TABLE IF EXISTS notification_baseline;
        ALTER TABLE notification_settings DROP COLUMN settings_version;
        COMMIT;
        "#,
    )
    .map_err(|error| error.to_string())
}

fn restore_v5_agent_tasks(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        INSERT OR REPLACE INTO agent_tasks (id, payload, updated_at)
            SELECT id, payload, updated_at FROM legacy_agent_tasks;
        DROP TABLE legacy_agent_tasks;
        "#,
    )
    .map_err(|error| error.to_string())
}
