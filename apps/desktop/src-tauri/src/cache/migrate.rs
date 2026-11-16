//! Schema creation and upgrade path for the cache database.
//!
//! The schema is versioned with `PRAGMA user_version`: fresh/pre-release
//! databases are rebuilt, while the shipped v5 shape is upgraded in place.

use rusqlite::Connection;

/// Schema version. Bumped only when the stored shape changes; fresh and
/// pre-release databases are rebuilt from scratch, while shipped shapes are
/// upgraded in place.
const SCHEMA_VERSION: i64 = 7;

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
            // disposable (snapshots / task history), so rebuild instead of
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
                "#,
            )
            .map_err(|error| error.to_string())?;
        }

        create_schema(conn)?;
        if version >= 5 {
            restore_v5_agent_tasks(conn)?;
        }
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

        -- 自由对话：会话元数据仍以 ChatSession JSON 写入 payload，索引列只
        -- 用于按项目 / 运行时 / 模型 / 状态过滤与按时间排序。
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            workspace_name TEXT NOT NULL DEFAULT '',
            runtime_id TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            payload TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS chat_sessions_updated_idx
            ON chat_sessions(updated_at DESC);
        CREATE INDEX IF NOT EXISTS chat_sessions_workspace_idx
            ON chat_sessions(workspace_id);
        CREATE INDEX IF NOT EXISTS chat_sessions_runtime_idx
            ON chat_sessions(runtime_id);
        CREATE INDEX IF NOT EXISTS chat_sessions_model_idx
            ON chat_sessions(model);

        -- 消息历史：rowid 保持首次写入顺序，UNIQUE 用于同一消息的 upsert
        -- （工具结果回填会更新已有行，rowid 不变）。
        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            role TEXT NOT NULL,
            kind TEXT NOT NULL,
            at TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL DEFAULT '',
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(chat_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS chat_messages_chat_idx
            ON chat_messages(chat_id, id);

        -- 关键字搜索：trigram 支持中文子串（>=3 字）；短词由查询层回退 LIKE。
        CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
            text,
            content='chat_messages',
            content_rowid='id',
            tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ai
        AFTER INSERT ON chat_messages BEGIN
            INSERT INTO chat_messages_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ad
        AFTER DELETE ON chat_messages BEGIN
            INSERT INTO chat_messages_fts(chat_messages_fts, rowid, text)
                VALUES ('delete', old.id, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS chat_messages_fts_au
        AFTER UPDATE ON chat_messages BEGIN
            INSERT INTO chat_messages_fts(chat_messages_fts, rowid, text)
                VALUES ('delete', old.id, old.text);
            INSERT INTO chat_messages_fts(rowid, text) VALUES (new.id, new.text);
        END;
        "#,
    )
    .map_err(|error| error.to_string())
}

/// v5 (the shipped 1.0 schema) → v6: keep user-visible rows, collapse the
/// task table to its JSON payload, and drop tables/columns no code reads.
///
/// The old table is renamed (not copied into a TEMP table), so the preserved
/// rows survive a crash and the restore step runs in the same transaction.
fn upgrade_v5(conn: &Connection) -> Result<(), String> {
    if table_exists(conn, "agent_tasks")? {
        conn.execute_batch("DROP TABLE IF EXISTS legacy_agent_tasks")
            .map_err(|error| error.to_string())?;
        conn.execute_batch("ALTER TABLE agent_tasks RENAME TO legacy_agent_tasks")
            .map_err(|error| error.to_string())?;
    }
    conn.execute_batch(
        r#"
        DROP TABLE IF EXISTS agent_queue_state;
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

fn restore_v5_agent_tasks(conn: &Connection) -> Result<(), String> {
    if !table_exists(conn, "legacy_agent_tasks")? {
        // A previous attempt already consumed the old table.
        return Ok(());
    }
    conn.execute_batch(
        r#"
        INSERT OR REPLACE INTO agent_tasks (id, payload, updated_at)
            SELECT id, payload, updated_at FROM legacy_agent_tasks WHERE payload <> '';
        DROP TABLE legacy_agent_tasks;
        "#,
    )
    .map_err(|error| error.to_string())
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
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
    fn v5_upgrade_keeps_task_payloads_and_stamps_the_version() {
        let conn = v5_connection();
        run(&conn).expect("migrate");

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, SCHEMA_VERSION);
        let payload: String = conn
            .query_row("SELECT payload FROM agent_tasks WHERE id = 't1'", [], |row| {
                row.get(0)
            })
            .expect("task payload survives");
        assert_eq!(payload, r#"{"id":"t1"}"#);
        assert!(!column_exists(&conn, "notification_settings", "settings_version").expect("columns"));
    }

    #[test]
    fn v5_upgrade_survives_a_database_left_without_its_task_table() {
        // The old TEMP-table migration could drop `agent_tasks` and exit
        // before stamping the version. The next start must still migrate.
        let conn = v5_connection();
        conn.execute_batch("DROP TABLE agent_tasks").expect("simulate partial");

        run(&conn).expect("recoverable migration");

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, SCHEMA_VERSION);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_tasks", [], |row| row.get(0))
            .expect("agent_tasks exists");
        assert_eq!(count, 0);
    }
}
