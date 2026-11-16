//! SQLite persistence for [`TaskRecord`] (table `dsh_tasks`, schema v9).
//!
//! The row is the single source of truth for the task list: `tasks.rs` keeps no
//! in-memory registry, so every read sees the same rows a restart will. The
//! metadata travels as one JSON payload; the columns exist for ordering and for
//! the workflow compare-and-swap that keeps late turn events from overriding a
//! newer state.
//!
//! The database is the shared offline cache (`cache.sqlite3`); when it failed to
//! open the store reports the localized "unavailable" error instead of losing
//! tasks silently.

use rusqlite::{params, Connection, OptionalExtension};
use tapd_i18n::tr;

use super::{TaskRecord, Workflow};
use crate::cache::Cache;

/// Every task, newest first (`updatedAt`, then insertion order for ties).
pub(super) fn load_all(cache: &Cache) -> Result<Vec<TaskRecord>, String> {
    with_conn(cache, |conn| {
        let mut statement = conn
            .prepare("SELECT payload FROM dsh_tasks ORDER BY updated_at DESC, rowid DESC")
            .map_err(sql_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(sql_error)?;
        let mut records = Vec::new();
        for row in rows {
            let payload = row.map_err(sql_error)?;
            match serde_json::from_str::<TaskRecord>(&payload) {
                Ok(record) => records.push(record),
                // One unreadable row must not hide the rest; it is also not
                // worth failing the whole list a user is looking at.
                Err(error) => tracing::warn!(%error, "skipped an unreadable dsh task row"),
            }
        }
        Ok(records)
    })
}

pub(super) fn load(cache: &Cache, id: &str) -> Result<Option<TaskRecord>, String> {
    with_conn(cache, |conn| {
        let payload = conn
            .query_row("SELECT payload FROM dsh_tasks WHERE id = ?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(sql_error)?;
        payload
            .map(|payload| {
                serde_json::from_str::<TaskRecord>(&payload).map_err(|error| error.to_string())
            })
            .transpose()
    })
}

pub(super) fn insert(cache: &Cache, record: &TaskRecord) -> Result<(), String> {
    let payload = serde_json::to_string(record).map_err(|error| error.to_string())?;
    with_conn(cache, |conn| {
        conn.execute(
            "INSERT INTO dsh_tasks (id, kind, project_id, workflow, updated_at, payload) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                record.task.id,
                record.task.kind.as_str(),
                project_id(record),
                record.task.workflow.as_str(),
                updated_millis(record),
                payload
            ],
        )
        .map_err(sql_error)?;
        Ok(())
    })
}

/// Compare-and-swap on the workflow column: the row only changes while it is
/// still in `expected`. This is the one guard that makes a late `turn/end`
/// (or two buttons pressed at once) unable to rewrite a newer state.
pub(super) fn update_if(
    cache: &Cache,
    record: &TaskRecord,
    expected: Workflow,
) -> Result<bool, String> {
    let payload = serde_json::to_string(record).map_err(|error| error.to_string())?;
    with_conn(cache, |conn| {
        let changed = conn
            .execute(
                "UPDATE dsh_tasks SET kind = ?2, project_id = ?3, workflow = ?4, \
                        updated_at = ?5, payload = ?6 WHERE id = ?1 AND workflow = ?7",
                params![
                    record.task.id,
                    record.task.kind.as_str(),
                    project_id(record),
                    record.task.workflow.as_str(),
                    updated_millis(record),
                    payload,
                    expected.as_str()
                ],
            )
            .map_err(sql_error)?;
        Ok(changed == 1)
    })
}

/// Removes a row. Only enqueue rollback uses it: a task that never launched
/// must not stay visible as a half-created entry.
pub(super) fn delete(cache: &Cache, id: &str) -> Result<(), String> {
    with_conn(cache, |conn| {
        conn.execute("DELETE FROM dsh_tasks WHERE id = ?1", [id])
            .map_err(sql_error)?;
        Ok(())
    })
}

/// Column value for filtering: the TAPD workspace or the local project.
fn project_id(record: &TaskRecord) -> String {
    record
        .meta
        .local_project_id
        .clone()
        .or_else(|| record.meta.workspace_id.clone())
        .or_else(|| {
            record
                .task
                .project
                .as_ref()
                .map(|project| project.id.clone())
        })
        .unwrap_or_default()
}

/// The JSON timestamp is fixed-width RFC3339; the column is epoch millis so
/// SQLite orders numerically and a future query can window by time.
fn updated_millis(record: &TaskRecord) -> i64 {
    chrono::DateTime::parse_from_rfc3339(&record.task.updated_at)
        .map(|time| time.timestamp_millis())
        .unwrap_or(0)
}

fn with_conn<T>(
    cache: &Cache,
    run: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    cache
        .with_conn(run)
        .unwrap_or_else(|| Err(tr("dsh.task.store").to_string()))
}

fn sql_error(error: rusqlite::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsh::tasks::{DshTask, TaskKind, TaskMeta};
    use dsh_host::transcript::SessionStatus;
    fn cache() -> Cache {
        Cache::open(std::env::temp_dir().join(format!(
            "tapd-dsh-task-store-{}.sqlite3",
            uuid::Uuid::new_v4().simple()
        )))
    }

    fn record(id: &str, workflow: Workflow, updated_at: &str) -> TaskRecord {
        TaskRecord {
            task: DshTask {
                id: id.to_string(),
                kind: TaskKind::Bug,
                project: None,
                title: "t".to_string(),
                bug_id: Some("42".to_string()),
                workflow,
                status: SessionStatus::Idle,
                repo_path: "/repo".to_string(),
                worktree_path: None,
                branch: None,
                json_path: "/tmp/bug.json".to_string(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                updated_at: updated_at.to_string(),
                message_count: 0,
                changes: None,
                review: None,
                merge: None,
            },
            meta: TaskMeta {
                workspace_id: Some("ws".to_string()),
                ..TaskMeta::default()
            },
        }
    }

    #[test]
    fn rows_round_trip_newest_first() {
        let cache = cache();
        insert(
            &cache,
            &record("a", Workflow::Running, "2026-01-01T00:00:00.000Z"),
        )
        .expect("a");
        insert(
            &cache,
            &record("b", Workflow::Done, "2026-01-02T00:00:00.000Z"),
        )
        .expect("b");

        let rows = load_all(&cache).expect("load");
        assert_eq!(
            rows.iter()
                .map(|record| record.task.id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "a"]
        );
        assert_eq!(
            load(&cache, "a").expect("load one").unwrap().task.workflow,
            Workflow::Running
        );
        assert!(load(&cache, "missing").expect("missing").is_none());
    }

    #[test]
    fn update_if_only_changes_the_expected_state() {
        let cache = cache();
        insert(
            &cache,
            &record("a", Workflow::Running, "2026-01-01T00:00:00.000Z"),
        )
        .expect("insert");

        let mut done = record("a", Workflow::Done, "2026-01-02T00:00:00.000Z");
        assert!(
            !update_if(&cache, &done, Workflow::AwaitingReview).expect("cas"),
            "the row is running, not awaiting review"
        );
        assert!(update_if(&cache, &done, Workflow::Running).expect("cas"));
        assert!(
            !update_if(&cache, &done, Workflow::Running).expect("stale cas"),
            "a second late writer must not overwrite the newer state"
        );
        assert_eq!(
            load(&cache, "a").expect("load").unwrap().task.workflow,
            Workflow::Done
        );

        // The payload is replaced wholesale once the CAS window is open.
        done.task.workflow = Workflow::AwaitingReview;
        done.task.changes = Some(crate::dsh::tasks::TaskChanges {
            files: 1,
            additions: 2,
            deletions: 3,
        });
        assert!(update_if(&cache, &done, Workflow::Done).expect("cas again"));
        let stored = load(&cache, "a").expect("load").unwrap();
        assert_eq!(stored.task.workflow, Workflow::AwaitingReview);
        assert_eq!(stored.task.changes.expect("changes persisted").files, 1);
    }

    #[test]
    fn delete_removes_the_row() {
        let cache = cache();
        insert(
            &cache,
            &record("a", Workflow::Running, "2026-01-01T00:00:00.000Z"),
        )
        .expect("insert");
        delete(&cache, "a").expect("delete");
        assert!(load_all(&cache).expect("load").is_empty());
    }
}
