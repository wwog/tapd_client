//! Schema creation for the cache database.
//!
//! There is no upgrade path: the cache is disposable and old shapes are not
//! migrated. A version mismatch simply creates the current tables (the user
//! clears the data directory when moving between incompatible builds).

use rusqlite::Connection;

/// Schema version. Bumped when the stored shape changes; a mismatched database
/// is recreated rather than migrated.
pub(super) const SCHEMA_VERSION: i64 = 14;

pub(super) fn run(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let created = create_schema(conn).and_then(|()| {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|error| error.to_string())
    });
    match created {
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

        -- Last context meter per session: prompt-side occupancy and its split.
        -- One row per session, replaced on every request, so it stays tiny.
        CREATE TABLE IF NOT EXISTS dsh_session_meters (
            session_id TEXT PRIMARY KEY,
            updated_at TEXT NOT NULL,
            payload TEXT NOT NULL
        );

        -- Per-session permission mode. A missing row means "inherit the global
        -- default"; the value is pushed to the running policy plugin.
        CREATE TABLE IF NOT EXISTS dsh_session_modes (
            session_id TEXT PRIMARY KEY,
            mode TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Composer prompt history (↑ panel). Append-only and pruned to the
        -- newest few hundred rows; `text` is the identity the panel dedupes on.
        CREATE TABLE IF NOT EXISTS dsh_prompts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            text TEXT NOT NULL,
            at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS dsh_prompts_text ON dsh_prompts(text);

        -- Composer send queue (ZCode 队列): one row per session, the ordered
        -- items as JSON. Images ride inside the JSON so a restart keeps them;
        -- an empty queue has no row.
        CREATE TABLE IF NOT EXISTS dsh_queues (
            session_id TEXT PRIMARY KEY,
            items TEXT NOT NULL,
            pause TEXT,
            updated_at INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|error| error.to_string())
}
