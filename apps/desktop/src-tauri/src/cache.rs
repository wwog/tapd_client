//! Offline cache for TAPD data (projects and bugs).
//!
//! The cache is a write-through snapshot store: every successful live request
//! stores the exact payload the frontend renders, and the UI asks for a
//! snapshot before hitting the network. This keeps the cache shape-free (no
//! schema churn when `BugListPage`/`BugDetail` evolve) while `bugs` rows are
//! still indexed for a later offline search.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use tapd_core::tapd::{BugListPage, BugQuery, BugSummary};

use crate::state::SharedState;

const KIND_WORKSPACES: &str = "workspace_context";
const KIND_BUG_LIST: &str = "bug_list";
const KIND_BUG_DETAIL: &str = "bug_detail";
const KIND_WORKSPACE_MEMBERS: &str = "workspace_members";

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
        Self::migrate(&conn)?;
        Ok(conn)
    }

    /// Schema version. Bumped only when the stored shape changes; fresh and
    /// pre-release databases are rebuilt from scratch, while the shipped v5
    /// shape is upgraded in place.
    const SCHEMA_VERSION: i64 = 6;

    fn migrate(conn: &Connection) -> Result<(), String> {
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if version >= Self::SCHEMA_VERSION {
            return Ok(());
        }

        if version >= 5 {
            Self::upgrade_v5(conn)?;
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

        Self::create_schema(conn)?;
        conn.pragma_update(None, "user_version", Self::SCHEMA_VERSION)
            .map_err(|error| error.to_string())?;

        if version >= 5 {
            Self::restore_v5_agent_tasks(conn)?;
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

    /// Runs `f` against the shared connection. `None` means SQLite is disabled
    /// (the cache failed to open), so callers degrade to in-memory behaviour.
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> T) -> Option<T> {
        let guard = self.conn.lock().expect("cache lock");
        guard.as_ref().map(f)
    }

    pub fn get(&self, kind: &str, key: &str) -> Option<(String, i64)> {
        let guard = self.conn.lock().expect("cache lock");
        let conn = guard.as_ref()?;
        conn.query_row(
            "SELECT payload, fetched_at FROM snapshots WHERE kind = ?1 AND key = ?2",
            params![kind, key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .ok()
        .flatten()
    }

    fn put(&self, kind: &str, key: &str, payload: &str) {
        let guard = self.conn.lock().expect("cache lock");
        let Some(conn) = guard.as_ref() else {
            return;
        };
        let fetched_at = unix_now();
        if let Err(error) = conn.execute(
            "INSERT INTO snapshots (kind, key, payload, fetched_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(kind, key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at",
            params![kind, key, payload, fetched_at],
        ) {
            tracing::warn!(%error, kind, key, "failed to write cache snapshot");
        }
    }

    pub fn get_snapshot<T: DeserializeOwned>(&self, kind: &str, key: &str) -> Option<(T, i64)> {
        let (payload, fetched_at) = self.get(kind, key)?;
        serde_json::from_str(&payload)
            .ok()
            .map(|value| (value, fetched_at))
    }

    pub fn put_snapshot<T: Serialize>(&self, kind: &str, key: &str, value: &T) {
        match serde_json::to_string(value) {
            Ok(payload) => self.put(kind, key, &payload),
            Err(error) => tracing::warn!(%error, kind, key, "failed to serialize cache snapshot"),
        }
    }

    /// Write-through helpers used by the live TAPD commands.
    pub fn put_workspace_context<T: Serialize>(&self, value: &T) {
        self.put_snapshot(KIND_WORKSPACES, "latest", value);
    }

    pub fn get_workspace_context<T: DeserializeOwned>(&self) -> Option<(T, i64)> {
        self.get_snapshot(KIND_WORKSPACES, "latest")
    }

    pub fn put_bug_list<T: Serialize>(&self, query: &BugQuery, value: &T) {
        self.put_snapshot(KIND_BUG_LIST, &bug_list_key(query), value);
    }

    pub fn get_bug_list<T: DeserializeOwned>(&self, query: &BugQuery) -> Option<(T, i64)> {
        self.get_snapshot(KIND_BUG_LIST, &bug_list_key(query))
    }

    pub fn put_bug_detail<T: Serialize>(&self, workspace_id: &str, bug_id: &str, value: &T) {
        self.put_snapshot(
            KIND_BUG_DETAIL,
            &bug_detail_key(workspace_id, bug_id),
            value,
        );
    }

    pub fn get_bug_detail<T: DeserializeOwned>(
        &self,
        workspace_id: &str,
        bug_id: &str,
    ) -> Option<(T, i64)> {
        self.get_snapshot(KIND_BUG_DETAIL, &bug_detail_key(workspace_id, bug_id))
    }

    pub fn put_workspace_members<T: Serialize>(&self, workspace_id: &str, value: &T) {
        self.put_snapshot(KIND_WORKSPACE_MEMBERS, workspace_id, value);
    }

    pub fn get_workspace_members<T: DeserializeOwned>(
        &self,
        workspace_id: &str,
    ) -> Option<(T, i64)> {
        self.get_snapshot(KIND_WORKSPACE_MEMBERS, workspace_id)
    }

    pub fn put_bug_records(&self, workspace_id: &str, bugs: &[BugSummary]) {
        let guard = self.conn.lock().expect("cache lock");
        let Some(conn) = guard.as_ref() else {
            return;
        };
        let updated_at = unix_now();
        for bug in bugs {
            let raw = match serde_json::to_string(bug) {
                Ok(raw) => raw,
                Err(_) => continue,
            };
            if let Err(error) = conn.execute(
                "INSERT INTO bugs (workspace_id, bug_id, title, status, modified, raw, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(workspace_id, bug_id) DO UPDATE SET
                    title = excluded.title,
                    status = excluded.status,
                    modified = excluded.modified,
                    raw = excluded.raw,
                    updated_at = excluded.updated_at",
                params![
                    workspace_id,
                    bug.id,
                    bug.title,
                    bug.status,
                    bug.modified,
                    raw,
                    updated_at
                ],
            ) {
                tracing::warn!(%error, bug_id = %bug.id, "failed to cache bug record");
            }
        }
    }

    /// Loads the persisted agent task list and the queue-paused flag.
    /// `None` means SQLite is disabled (the caller degrades to an empty
    /// in-memory queue).
    pub fn load_agent_tasks(&self) -> Option<(Vec<crate::agent::AgentTask>, bool)> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare("SELECT payload FROM agent_tasks WHERE payload <> '' ORDER BY rowid ASC")
                .ok()?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .ok()?;
            let mut tasks = Vec::new();
            for payload in rows.flatten() {
                match serde_json::from_str(&payload) {
                    Ok(task) => tasks.push(task),
                    Err(error) => tracing::warn!(%error, "failed to decode persisted agent task"),
                }
            }
            let paused = conn
                .query_row(
                    "SELECT paused FROM agent_queue_state WHERE id = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .ok()
                .flatten()
                .unwrap_or(0)
                != 0;
            Some((tasks, paused))
        })
        .flatten()
    }

    /// Persists the given (already dirty) tasks plus the queue flag and removes
    /// `removed` rows in one transaction. Returns `false` when SQLite is
    /// unavailable or the write failed.
    pub fn save_agent_tasks(
        &self,
        tasks: &[crate::agent::AgentTask],
        paused: bool,
        removed: &[String],
    ) -> bool {
        let guard = self.conn.lock().expect("cache lock");
        let Some(conn) = guard.as_ref() else {
            return false;
        };
        let updated_at = unix_now();
        let result = (|| -> rusqlite::Result<()> {
            let tx = conn.unchecked_transaction()?;
            for task in tasks {
                let payload = match serde_json::to_string(task) {
                    Ok(payload) => payload,
                    Err(error) => {
                        tracing::warn!(%error, task_id = %task.id, "failed to serialize agent task");
                        continue;
                    }
                };
                tx.execute(
                    "INSERT INTO agent_tasks (id, payload, updated_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(id) DO UPDATE SET
                        payload = excluded.payload,
                        updated_at = excluded.updated_at",
                    params![task.id, payload, updated_at],
                )?;
            }
            for id in removed {
                tx.execute("DELETE FROM agent_tasks WHERE id = ?1", params![id])?;
            }
            tx.execute(
                "INSERT INTO agent_queue_state (id, paused) VALUES (1, ?1)
                 ON CONFLICT(id) DO UPDATE SET paused = excluded.paused",
                params![if paused { 1i64 } else { 0i64 }],
            )?;
            tx.commit()
        })();
        match result {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!(%error, "failed to persist agent tasks");
                false
            }
        }
    }

    pub fn clear(&self) -> Result<(), String> {
        let guard = self.conn.lock().expect("cache lock");
        let Some(conn) = guard.as_ref() else {
            return Ok(());
        };
        conn.execute_batch("DELETE FROM snapshots; DELETE FROM bugs;")
            .map_err(|error| error.to_string())
    }

    /// Offline fallback: filters the cached `bugs` rows locally when no exact
    /// snapshot exists for this query (e.g. the user changed a filter offline).
    pub fn query_bugs(&self, query: &BugQuery) -> Option<(BugListPage, i64)> {
        // Saved views (`confId`) are server-side definitions we cannot replay.
        if query
            .conf_id
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        {
            return None;
        }

        let guard = self.conn.lock().expect("cache lock");
        let conn = guard.as_ref()?;
        let mut statement = conn
            .prepare("SELECT raw, updated_at FROM bugs WHERE workspace_id = ?1")
            .ok()?;
        let rows = statement
            .query_map(params![query.workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .ok()?;

        let mut matched: Vec<BugSummary> = Vec::new();
        let mut newest = 0i64;
        for row in rows.flatten() {
            let (raw, updated_at) = row;
            newest = newest.max(updated_at);
            let Ok(bug) = serde_json::from_str::<BugSummary>(&raw) else {
                continue;
            };
            if matches_query(query, &bug) {
                matched.push(bug);
            }
        }
        if matched.is_empty() {
            return None;
        }

        sort_bugs(query, &mut matched);
        let total = matched.len() as u32;
        let perpage = query.perpage.max(1);
        let page = query.page.max(1);
        let start = ((page - 1) as usize).saturating_mul(perpage as usize);
        let bugs = matched
            .into_iter()
            .skip(start)
            .take(perpage as usize)
            .collect();

        Some((
            BugListPage {
                page,
                perpage,
                total,
                status_map: Default::default(),
                status_order: Default::default(),
                bugs,
            },
            newest,
        ))
    }
}

fn matches_query(query: &BugQuery, bug: &BugSummary) -> bool {
    if let Some(owner) = query
        .owner
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        if bug.owner != owner {
            return false;
        }
    }
    if let Some(creator) = query
        .creator
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        if bug.creator != creator {
            return false;
        }
    }
    if !query.statuses.is_empty() && !query.statuses.contains(&bug.status) {
        return false;
    }
    if !query.priorities.is_empty() && !query.priorities.contains(&bug.priority) {
        return false;
    }
    if !query.severities.is_empty() && !query.severities.contains(&bug.severity) {
        return false;
    }
    if let Some(keyword) = query
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let needle = keyword.to_lowercase();
        if !bug.title.to_lowercase().contains(&needle) {
            return false;
        }
    }
    if let Some(after) = query.modified_after.as_deref().filter(|v| !v.is_empty()) {
        if bug.modified.as_str() < after {
            return false;
        }
    }
    if let Some(after) = query.created_after.as_deref().filter(|v| !v.is_empty()) {
        if bug.created.as_str() < after {
            return false;
        }
    }
    true
}

/// TAPD's default status order, used only for the offline fallback: customized
/// workflows are not stored alongside the bug rows.
const OFFLINE_STATUS_ORDER: &[&str] = &[
    "new",
    "in_progress",
    "resolved",
    "verified",
    "reopened",
    "rejected",
    "closed",
    "open",
    "progressing",
    "done",
];

fn status_rank(status: &str) -> usize {
    OFFLINE_STATUS_ORDER
        .iter()
        .position(|key| *key == status)
        .unwrap_or(OFFLINE_STATUS_ORDER.len())
}

fn sort_bugs(query: &BugQuery, bugs: &mut [BugSummary]) {
    let descending = !query.order.eq_ignore_ascii_case("asc");
    // Each arm sorts ascending; `descending` is applied once at the end so the
    // direction cannot drift between columns.
    match query.sort_name.as_str() {
        "modified" => bugs.sort_by(|a, b| a.modified.cmp(&b.modified)),
        // Same grouping as TAPD's server-side status sort; unknown statuses
        // stay together at the end instead of interleaving.
        "status" => bugs.sort_by(|a, b| {
            status_rank(&a.status)
                .cmp(&status_rank(&b.status))
                .then_with(|| a.created.cmp(&b.created))
        }),
        _ => bugs.sort_by(|a, b| a.created.cmp(&b.created)),
    }
    if descending {
        bugs.reverse();
    }
}

pub fn bug_list_key(query: &BugQuery) -> String {
    serde_json::to_string(query).unwrap_or_default()
}

pub fn bug_detail_key(workspace_id: &str, bug_id: &str) -> String {
    format!("{workspace_id}:{bug_id}")
}

pub(crate) fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedPayload {
    data: Option<Value>,
    fetched_at: Option<i64>,
}

fn cached(value: Option<(Value, i64)>) -> CachedPayload {
    match value {
        Some((data, fetched_at)) => CachedPayload {
            data: Some(data),
            fetched_at: Some(fetched_at),
        },
        None => CachedPayload {
            data: None,
            fetched_at: None,
        },
    }
}

pub async fn command(state: &SharedState, name: &str, payload: Value) -> Result<Value, String> {
    let cache = &state.cache;
    match name {
        "cache_workspace_context" => {
            let value = cache.get_workspace_context::<Value>();
            Ok(serde_json::to_value(cached(value)).unwrap_or_else(|_| Value::Null))
        }
        "cache_bug_list" => {
            let query = parse_bug_query(&payload)?;
            // Exact query snapshot first; otherwise filter the cached bug rows
            // locally so offline filter changes still show data.
            let value = cache.get_bug_list::<Value>(&query).or_else(|| {
                cache.query_bugs(&query).and_then(|(page, fetched_at)| {
                    serde_json::to_value(page).ok().map(|v| (v, fetched_at))
                })
            });
            Ok(serde_json::to_value(cached(value)).unwrap_or_else(|_| Value::Null))
        }
        "cache_bug_detail" => {
            let workspace_id = payload
                .get("workspaceId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            let bug_id = payload
                .get("bugId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if workspace_id.is_empty() || bug_id.is_empty() {
                return Err("缺少 workspaceId 或 bugId".to_string());
            }
            let value = cache.get_bug_detail::<Value>(&workspace_id, &bug_id);
            Ok(serde_json::to_value(cached(value)).unwrap_or_else(|_| Value::Null))
        }
        "cache_workspace_members" => {
            let workspace_id = payload
                .get("workspaceId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if workspace_id.is_empty() {
                return Err("缺少 workspaceId".to_string());
            }
            let value = cache.get_workspace_members::<Value>(&workspace_id);
            Ok(serde_json::to_value(cached(value)).unwrap_or_else(|_| Value::Null))
        }
        other => Err(format!("unknown cache command: {other}")),
    }
}

fn parse_bug_query(payload: &Value) -> Result<BugQuery, String> {
    let query = payload
        .get("query")
        .cloned()
        .ok_or_else(|| "缺少 query".to_string())?;
    serde_json::from_value(query).map_err(|error| format!("无效的查询参数：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
            owner: Some("me".to_string()),
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

        let keyword = BugQuery {
            keyword: Some("CRASH".to_string()),
            owner: None,
            perpage: 1,
            page: 2,
            ..query.clone()
        };
        let (page, _) = cache.query_bugs(&keyword).expect("keyword rows");
        assert_eq!(page.total, 2);
        assert_eq!(page.bugs.len(), 1);
        assert_eq!(page.bugs[0].id, "1");
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
            md_path: "/tmp/bug.md".to_string(),
            repo_path: "/tmp/repo".to_string(),
            status: crate::agent::TaskStatus::Succeeded,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            started_at: None,
            finished_at: None,
            exit_code: Some(0),
            log_path: "/tmp/task.log".to_string(),
            error: None,
            prompt: "prompt".to_string(),
            source: "manual".to_string(),
            runtime_id: "opencode".to_string(),
            transport: "acp".to_string(),
            session_id: Some("ses_1".to_string()),
            review: None,
            approval: None,
            commit_only: false,
            extra_prompt: String::new(),
            attachments: Vec::new(),
            baseline_dirty: Vec::new(),
            baseline_head: None,
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
            assert!(payload.contains("\"sessionId\":\"ses_1\""));
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
        assert_eq!(tasks, 0, "pre-1.0 task rows have no payload and are dropped");
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
