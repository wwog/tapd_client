//! Write-through snapshot store plus the typed helpers used by the live TAPD
//! commands. The payload is stored exactly as the frontend renders it, so the
//! cache stays shape-free when `BugListPage`/`BugDetail` evolve.

use rusqlite::{params, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};
use tapd_core::tapd::BugQuery;

use super::{unix_now, Cache};

const KIND_WORKSPACES: &str = "workspace_context";
const KIND_BUG_LIST: &str = "bug_list";
const KIND_BUG_DETAIL: &str = "bug_detail";
const KIND_WORKSPACE_MEMBERS: &str = "workspace_members";

impl Cache {
    fn get(&self, kind: &str, key: &str) -> Option<(String, i64)> {
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
}

pub(super) fn bug_list_key(query: &BugQuery) -> String {
    serde_json::to_string(query).unwrap_or_default()
}

pub(super) fn bug_detail_key(workspace_id: &str, bug_id: &str) -> String {
    format!("{workspace_id}:{bug_id}")
}
