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
//! - [`dispatch`]: the read-only `cache_*` feature commands.
//!
//! All access goes through one `Mutex<Option<Connection>>`; a failed open
//! leaves the cache disabled and every read degrades to a miss.

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
    fn fresh_cache_gets_the_current_schema() {
        let path = std::env::temp_dir().join(format!(
            "tapd-cache-fresh-{}.sqlite3",
            uuid::Uuid::new_v4().simple()
        ));
        let cache = Cache::open(path);
        let guard = cache.conn.lock().expect("cache lock");
        let conn = guard.as_ref().expect("cache connection");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, super::migrate::SCHEMA_VERSION);
        for table in [
            "snapshots",
            "bugs",
            "notification_settings",
            "notification_items",
            "notification_seen",
            "notification_cursors",
            "mcp_audit",
            "dsh_tasks",
            "dsh_session_meters",
            "dsh_session_modes",
        ] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("table lookup");
            assert_eq!(exists, 1, "{table} must exist");
        }
    }
}
