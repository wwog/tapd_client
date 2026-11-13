//! Offline cache for TAPD data (projects and bugs).
//!
//! The cache is a write-through snapshot store: every successful live request
//! stores the exact payload the frontend renders, and the UI asks for a
//! snapshot before hitting the network. This keeps the cache shape-free (no
//! schema churn when `BugListPage`/`BugDetail` evolve) while `bugs` rows are
//! still indexed for a later offline search.
//!
//! Layout:
//! - [`migrate`]: connection schema versioning (`PRAGMA user_version`).
//! - [`snapshots`]: generic + typed snapshot read/write helpers.
//! - [`bugs`]: indexed bug rows and the offline query fallback.
//! - [`agent_tasks`]: durable agent queue/history.
//! - [`dispatch`]: the read-only `cache_*` feature commands.
//!
//! All access goes through one `Mutex<Option<Connection>>`; a failed open
//! leaves the cache disabled and every read degrades to a miss.

mod agent_tasks;
mod bugs;
mod dispatch;
mod migrate;
mod snapshots;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

pub use dispatch::command;

/// SQLite-backed cache. A failed open leaves the cache disabled instead of
/// aborting application startup; every method then behaves like a miss.
pub struct Cache {
    conn: Mutex<Option<Connection>>,
}

impl Cache {
    pub fn open(path: PathBuf) -> Self {
        let conn = match Self::open_connection(&path) {
            Ok(conn) => Some(conn),
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "failed to open offline cache");
                None
            }
        };
        Self {
            conn: Mutex::new(conn),
        }
    }

    fn open_connection(path: &Path) -> Result<Connection, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let conn = Connection::open(path).map_err(|error| error.to_string())?;
        conn.busy_timeout(std::time::Duration::from_millis(2_000))
            .map_err(|error| error.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| error.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|error| error.to_string())?;
        migrate::run(&conn)?;
        Ok(conn)
    }

    /// Runs `f` against the shared connection. `None` means SQLite is disabled
    /// (the cache failed to open), so callers degrade to in-memory behaviour.
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> T) -> Option<T> {
        let guard = self.conn.lock().expect("cache lock");
        guard.as_ref().map(f)
    }

    pub fn clear(&self) -> Result<(), String> {
        let guard = self.conn.lock().expect("cache lock");
        let Some(conn) = guard.as_ref() else {
            return Ok(());
        };
        conn.execute_batch("DELETE FROM snapshots; DELETE FROM bugs;")
            .map_err(|error| error.to_string())
    }
}

pub(crate) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::snapshots::bug_list_key;
    use super::*;
    use serde_json::Value;
    use tapd_core::tapd::{BugQuery, BugSummary};

    fn temp_cache() -> Cache {
        let path = std::env::temp_dir().join(format!(
            "tapd-cache-test-{}.sqlite3",
            uuid::Uuid::new_v4().simple()
        ));
        Cache::open(path)
    }

    #[test]
    fn snapshots_roundtrip() {
        let cache = temp_cache();
        cache.put_workspace_context(&serde_json::json!({ "ok": true }));
        let (value, fetched_at): (Value, i64) = cache
            .get_workspace_context()
            .expect("snapshot should exist");
        assert_eq!(value["ok"], true);
        assert!(fetched_at > 0);
    }

    #[test]
    fn bug_list_key_is_stable() {
        let query = BugQuery::default();
        assert_eq!(bug_list_key(&query), bug_list_key(&query));
    }

    #[test]
    fn offline_query_filters_and_paginates() {
        let cache = temp_cache();
        let mut mine = BugSummary {
            id: "1".to_string(),
            title: "login crash".to_string(),
            owner: "me".to_string(),
            status: "new".to_string(),
            created: "2026-01-02 00:00:00".to_string(),
            modified: "2026-01-02 00:00:00".to_string(),
            ..BugSummary::default()
        };
        let other = BugSummary {
            id: "2".to_string(),
            short_id: "0022".to_string(),
            title: "logout crash".to_string(),
            owner: "someone".to_string(),
            status: "new".to_string(),
            created: "2026-01-03 00:00:00".to_string(),
            modified: "2026-01-03 00:00:00".to_string(),
            ..BugSummary::default()
        };
        mine.workspace_id = "ws".to_string();
        cache.put_bug_records("ws", &[mine, other]);

        let query = BugQuery {
            workspace_id: "ws".to_string(),
            owners: vec!["me".to_string()],
            perpage: 10,
            page: 1,
            sort_name: "created".to_string(),
            order: "desc".to_string(),
            ..BugQuery::default()
        };
        let (page, fetched_at) = cache.query_bugs(&query).expect("offline rows");
        assert_eq!(page.total, 1);
        assert_eq!(page.bugs[0].id, "1");
        assert!(fetched_at > 0);

        let several = BugQuery {
            owners: vec!["me".to_string(), "someone".to_string()],
            ..query.clone()
        };
        let (page, _) = cache.query_bugs(&several).expect("several owners");
        assert_eq!(page.total, 2);

        let keyword = BugQuery {
            keyword: Some("CRASH".to_string()),
            owners: Vec::new(),
            perpage: 1,
            page: 2,
            ..query.clone()
        };
        let (page, _) = cache.query_bugs(&keyword).expect("keyword rows");
        assert_eq!(page.total, 2);
        assert_eq!(page.bugs.len(), 1);
        assert_eq!(page.bugs[0].id, "1");

        // Digits are an id lookup (full id or the list's short id), so the
        // title need not contain them.
        let by_id = BugQuery {
            keyword: Some("#2".to_string()),
            owners: Vec::new(),
            ..query.clone()
        };
        let (page, _) = cache.query_bugs(&by_id).expect("id rows");
        assert_eq!(page.total, 1);
        assert_eq!(page.bugs[0].id, "2");

        let by_short_id = BugQuery {
            keyword: Some("0022".to_string()),
            owners: Vec::new(),
            ..query.clone()
        };
        let (page, _) = cache.query_bugs(&by_short_id).expect("short id rows");
        assert_eq!(page.total, 1);
        assert_eq!(page.bugs[0].id, "2");
    }

    #[test]
    fn persists_and_loads_agent_tasks() {
        let cache = temp_cache();
        let task = crate::agent::AgentTask {
            id: "task-1".to_string(),
            workspace_id: "ws".to_string(),
            workspace_name: "WS".to_string(),
            bug_id: "bug-1".to_string(),
            title: "bug title".to_string(),
            severity: "严重".to_string(),
            priority: "高".to_string(),
            json_path: "/tmp/bug.json".to_string(),
            repo_path: "/tmp/repo".to_string(),
            worktree_path: None,
            worktree_branch: None,
            status: crate::agent::TaskStatus::Succeeded,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            started_at: None,
            finished_at: None,
            exit_code: Some(0),
            error: None,
            prompt: "prompt".to_string(),
            source: "manual".to_string(),
            runtime_id: "opencode".to_string(),
            model: String::new(),
            permission_mode: String::new(),
            agent_session_id: None,
            approval: None,
            merge: None,
            commit_only: false,
            extra_prompt: String::new(),
            attachments: Vec::new(),
            baseline_dirty: Vec::new(),
            baseline_head: None,
            attempt: 0,
            interrupted: false,
            changes: None,
        };
        assert!(cache.save_agent_tasks(std::slice::from_ref(&task), true, &[]));

        let (tasks, paused) = cache.load_agent_tasks().expect("sqlite");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "task-1");
        assert_eq!(tasks[0].prompt, "prompt");
        assert_eq!(tasks[0].severity, "严重");
        assert_eq!(tasks[0].status, crate::agent::TaskStatus::Succeeded);
        assert!(paused);

        {
            let guard = cache.conn.lock().expect("cache lock");
            let conn = guard.as_ref().expect("cache connection");
            let payload: String = conn
                .query_row(
                    "SELECT payload FROM agent_tasks WHERE id = 'task-1'",
                    [],
                    |row| row.get(0),
                )
                .expect("persisted row");
            assert!(payload.contains("\"prompt\":\"prompt\""));
            assert!(!payload.contains("\"sessionId\""));
        }

        // Removed ids are deleted and the queue flag is updated.
        assert!(cache.save_agent_tasks(&[], false, &["task-1".to_string()]));
        let (tasks, paused) = cache.load_agent_tasks().expect("sqlite");
        assert!(tasks.is_empty());
        assert!(!paused);
    }

    #[test]
    fn pre_release_cache_is_rebuilt() {
        let path = std::env::temp_dir().join(format!(
            "tapd-cache-v1-{}.sqlite3",
            uuid::Uuid::new_v4().simple()
        ));
        {
            let conn = Connection::open(&path).expect("v1 db");
            conn.execute_batch(
                "CREATE TABLE snapshots (kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (kind, key));
                 INSERT INTO snapshots VALUES ('bug_list', 'k', '{}', 1);
                 CREATE TABLE bugs (workspace_id TEXT NOT NULL, bug_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', modified TEXT NOT NULL DEFAULT '', raw TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, bug_id));
                 CREATE TABLE agent_tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, bug_id TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
                 INSERT INTO agent_tasks VALUES ('old-task', 'ws', 'bug', 'succeeded', 1);
                 PRAGMA user_version = 1;",
            )
            .expect("v1 schema");
        }

        let cache = Cache::open(path);
        let guard = cache.conn.lock().expect("cache lock");
        let conn = guard.as_ref().expect("cache connection");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, 6);
        for table in [
            "agent_tasks",
            "notification_settings",
            "notification_items",
            "notification_seen",
            "notification_cursors",
            "mcp_audit",
            "agent_queue_state",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("table lookup");
            assert_eq!(exists, 1, "{table} must be recreated");
        }
        let snapshots: i64 = conn
            .query_row("SELECT COUNT(*) FROM snapshots", [], |row| row.get(0))
            .expect("snapshots");
        assert_eq!(snapshots, 0, "pre-1.0 snapshots are disposable");
        let tasks: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_tasks", [], |row| row.get(0))
            .expect("tasks");
        assert_eq!(
            tasks, 0,
            "pre-1.0 task rows have no payload and are dropped"
        );
    }

    #[test]
    fn v5_upgrade_keeps_user_data() {
        let path = std::env::temp_dir().join(format!(
            "tapd-cache-v5-{}.sqlite3",
            uuid::Uuid::new_v4().simple()
        ));
        let payload = "{\"id\":\"task-1\",\"workspaceId\":\"ws\",\"bugId\":\"b\"}";
        {
            let conn = Connection::open(&path).expect("v5 db");
            conn.execute_batch(&format!(
                "CREATE TABLE snapshots (kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (kind, key));
                 INSERT INTO snapshots VALUES ('bug_list', 'k', '{{}}', 1);
                 CREATE TABLE agent_tasks (
                    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workspace_name TEXT NOT NULL DEFAULT '',
                    bug_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
                    session_id TEXT, repo_path TEXT NOT NULL DEFAULT '', log_path TEXT NOT NULL DEFAULT '',
                    md_path TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT '', started_at TEXT, finished_at TEXT,
                    exit_code INTEGER, error TEXT, updated_at INTEGER NOT NULL,
                    payload TEXT NOT NULL DEFAULT '', severity TEXT NOT NULL DEFAULT '',
                    priority TEXT NOT NULL DEFAULT '', runtime_id TEXT NOT NULL DEFAULT '',
                    transport TEXT NOT NULL DEFAULT ''
                 );
                 INSERT INTO agent_tasks (id, workspace_id, bug_id, status, updated_at, payload)
                    VALUES ('task-1', 'ws', 'b', 'succeeded', 7, '{payload}');
                 CREATE TABLE agent_queue_state (id INTEGER PRIMARY KEY CHECK (id = 1), paused INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE notification_settings (
                    id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL, scope TEXT NOT NULL,
                    include_new INTEGER NOT NULL, include_transferred INTEGER NOT NULL,
                    include_reopened INTEGER NOT NULL, poll_interval_secs INTEGER NOT NULL,
                    quiet_enabled INTEGER NOT NULL, quiet_start TEXT NOT NULL, quiet_end TEXT NOT NULL,
                    max_visible INTEGER NOT NULL, settings_version INTEGER NOT NULL,
                    ai_enabled INTEGER NOT NULL
                 );
                 CREATE TABLE notification_items (id TEXT PRIMARY KEY);
                 CREATE TABLE notification_seen (bug_key TEXT PRIMARY KEY);
                 CREATE TABLE notification_ignored (bug_key TEXT PRIMARY KEY);
                 CREATE TABLE notification_cursors (workspace_id TEXT PRIMARY KEY, cursor TEXT NOT NULL);
                 CREATE TABLE notification_baseline (workspace_id TEXT PRIMARY KEY, done_at TEXT NOT NULL);
                 CREATE TABLE mcp_audit (id TEXT PRIMARY KEY);
                 PRAGMA user_version = 5;"
            ))
            .expect("v5 schema");
        }

        let cache = Cache::open(path);
        let guard = cache.conn.lock().expect("cache lock");
        let conn = guard.as_ref().expect("cache connection");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, 6);
        let payload: String = conn
            .query_row(
                "SELECT payload FROM agent_tasks WHERE id = 'task-1'",
                [],
                |row| row.get(0),
            )
            .expect("task payload survives");
        assert!(payload.contains("task-1"));
        let snapshots: i64 = conn
            .query_row("SELECT COUNT(*) FROM snapshots", [], |row| row.get(0))
            .expect("snapshots");
        assert_eq!(snapshots, 1, "v5 snapshots survive the upgrade");
        let baseline_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                  WHERE type = 'table' AND name = 'notification_baseline'",
                [],
                |row| row.get(0),
            )
            .expect("baseline table");
        assert_eq!(baseline_table, 0, "baseline table is no longer needed");
    }
}
