//! Cached `bugs` rows and the offline query fallback used when no exact
//! snapshot exists for a query (for example after the user changes a filter
//! while offline).

use rusqlite::params;
use tapd_core::tapd::{BugListPage, BugQuery, BugSummary};

use super::{unix_now, Cache};

impl Cache {
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
