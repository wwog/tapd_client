//! SQLite persistence for local projects and their work items.
//!
//! The database is a separate file from the TAPD cache (`local.sqlite3`), so a
//! TAPD logout or "清理缓存" can never delete the user's own projects. One
//! `Mutex<Option<Connection>>` owns every access; a failed open leaves the
//! store disabled and every read/write reports the localized "unavailable"
//! error instead of pretending to succeed.

use std::{path::PathBuf, sync::Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use tapd_i18n::{tr, tr_args};
use tapd_local::{
    project_id, work_item_id, LocalError, LocalProject, WorkItem, WorkItemImportance,
    WorkItemStatus,
};

/// Version written to `PRAGMA user_version`. New schema changes bump it and add
/// an explicit migration; no silent upgrade chain.
const SCHEMA_VERSION: i64 = 3;

const SCHEMA: &str = "\
CREATE TABLE IF NOT EXISTS local_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    rule TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_work_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    importance TEXT NOT NULL DEFAULT 'normal',
    agent_task_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS local_work_items_project_updated
    ON local_work_items(project_id, updated_at DESC);
";

/// v1 -> v2: project rules. Everything else is unchanged; work-item status is
/// free text, so `done` needs no migration.
const MIGRATE_1_TO_2: &str = "ALTER TABLE local_projects ADD COLUMN rule TEXT NOT NULL DEFAULT '';";

/// v2 -> v3: item importance. Existing rows become `normal`.
const MIGRATE_2_TO_3: &str =
    "ALTER TABLE local_work_items ADD COLUMN importance TEXT NOT NULL DEFAULT 'normal';";

/// SQLite-backed local project store. A failed open leaves it disabled rather
/// than aborting application startup.
pub struct LocalStore {
    conn: Mutex<Option<Connection>>,
}

impl LocalStore {
    pub fn open(path: PathBuf) -> Self {
        let conn = match Self::open_connection(&path) {
            Ok(conn) => Some(conn),
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "failed to open local store");
                None
            }
        };
        Self {
            conn: Mutex::new(conn),
        }
    }

    fn open_connection(path: &std::path::Path) -> Result<Connection, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let conn = Connection::open(path).map_err(sql_error)?;
        conn.busy_timeout(std::time::Duration::from_millis(2_000))
            .map_err(sql_error)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(sql_error)?;
        if version != 0 && version != 1 && version != 2 && version != SCHEMA_VERSION {
            // Known older versions migrate in one transaction; an unknown
            // (newer) file stays untouched so an older build cannot rewrite it.
            return Err(format!(
                "local store schema version {version} is not {SCHEMA_VERSION}"
            ));
        }
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(sql_error)?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(sql_error)?;
        match version {
            0 | 1 | 2 => {
                // Serialize the whole migration: two processes opening an old
                // file must not both run the ALTER (the loser would fail and
                // keep its store disabled for the rest of the process).
                conn.execute_batch("BEGIN IMMEDIATE").map_err(sql_error)?;
                let migrated = (|| -> Result<(), String> {
                    // `CREATE TABLE IF NOT EXISTS` is safe for every old
                    // version and repairs a file whose tables are incomplete.
                    conn.execute_batch(SCHEMA).map_err(sql_error)?;
                    // An older build could have created its tables before
                    // stamping the version. `CREATE TABLE IF NOT EXISTS` then
                    // leaves the table without the newer columns, so finish
                    // those migrations before stamping. The column checks also
                    // make a crash between an ALTER and the stamp recoverable.
                    add_column_if_missing(&conn, "local_projects", "rule", MIGRATE_1_TO_2)?;
                    add_column_if_missing(
                        &conn,
                        "local_work_items",
                        "importance",
                        MIGRATE_2_TO_3,
                    )?;
                    // Stamp only after the schema exists: writing the version
                    // first would make a failed creation look complete.
                    conn.pragma_update(None, "user_version", SCHEMA_VERSION)
                        .map_err(sql_error)?;
                    Ok(())
                })();
                match migrated {
                    Ok(()) => conn.execute_batch("COMMIT").map_err(sql_error)?,
                    Err(error) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(error);
                    }
                }
            }
            _ => {}
        }
        Ok(conn)
    }

    /// Runs `run` against the shared connection. `None` means the database
    /// failed to open, so the caller reports "store unavailable".
    fn with_conn<T>(
        &self,
        run: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self.conn.lock().expect("local store lock");
        let Some(conn) = guard.as_ref() else {
            return Err(tr("local.store.unavailable").to_string());
        };
        run(conn)
    }

    // -----------------------------------------------------------------------
    // Projects
    // -----------------------------------------------------------------------

    pub fn projects(&self) -> Result<Vec<LocalProject>, String> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT id, name, repo_path, rule, created_at, updated_at \
                     FROM local_projects ORDER BY updated_at DESC, name ASC",
                )
                .map_err(sql_error)?;
            let rows = statement
                .query_map([], project_from_row)
                .map_err(sql_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_error)
        })
    }

    pub fn create_project(
        &self,
        name: Option<&str>,
        repo_path: &str,
        rule: Option<&str>,
    ) -> Result<LocalProject, String> {
        let repo_path = resolve_repo_path(repo_path)?;
        let now = now_rfc3339();
        self.with_conn(|conn| {
            if repo_path_taken(conn, &repo_path, None)? {
                return Err(tr("local.project.duplicate").to_string());
            }
            let name = name
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| LocalProject::derive_project_name(&repo_path));
            let mut project = LocalProject::new(new_project_id(), &name, &repo_path, &now)
                .map_err(local_error)?;
            if let Some(rule) = rule {
                project.set_rule(rule, &now);
            }
            conn.execute(
                "INSERT INTO local_projects (id, name, repo_path, rule, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    project.id,
                    project.name,
                    project.repo_path,
                    project.rule,
                    project.created_at,
                    project.updated_at
                ],
            )
            .map_err(sql_error)?;
            Ok(project)
        })
    }

    pub fn update_project(
        &self,
        id: &str,
        name: Option<&str>,
        repo_path: Option<&str>,
        rule: Option<&str>,
    ) -> Result<LocalProject, String> {
        let id = id.trim();
        let repo_path = match repo_path {
            Some(path) => Some(resolve_repo_path(path)?),
            None => None,
        };
        let now = now_rfc3339();
        self.with_conn(|conn| {
            let mut project = read_project(conn, id)?;
            if let Some(repo_path) = repo_path.as_deref() {
                if repo_path != project.repo_path && repo_path_taken(conn, repo_path, Some(id))? {
                    return Err(tr("local.project.duplicate").to_string());
                }
                project.move_to(repo_path, &now).map_err(local_error)?;
            }
            if let Some(name) = name {
                project.rename(name, &now).map_err(local_error)?;
            }
            // An empty string is meaningful here: it clears the rules.
            if let Some(rule) = rule {
                project.set_rule(rule, &now);
            }
            conn.execute(
                "UPDATE local_projects \
                 SET name = ?1, repo_path = ?2, rule = ?3, updated_at = ?4 WHERE id = ?5",
                params![
                    project.name,
                    project.repo_path,
                    project.rule,
                    project.updated_at,
                    project.id
                ],
            )
            .map_err(sql_error)?;
            Ok(project)
        })
    }

    /// Deletes the project and every item under it in one transaction.
    pub fn delete_project(&self, id: &str) -> Result<(), String> {
        let id = id.trim();
        self.with_conn(|conn| {
            read_project(conn, id)?;
            let transaction = conn.unchecked_transaction().map_err(sql_error)?;
            transaction
                .execute("DELETE FROM local_work_items WHERE project_id = ?1", [id])
                .map_err(sql_error)?;
            transaction
                .execute("DELETE FROM local_projects WHERE id = ?1", [id])
                .map_err(sql_error)?;
            transaction.commit().map_err(sql_error)
        })
    }

    // -----------------------------------------------------------------------
    // Work items
    // -----------------------------------------------------------------------

    pub fn items(&self, project_id: &str) -> Result<Vec<WorkItem>, String> {
        let project_id = project_id.trim();
        self.with_conn(|conn| {
            ensure_project(conn, project_id)?;
            let mut statement = conn
                .prepare(
                    "SELECT id, project_id, title, description, status, importance, \
                            agent_task_id, created_at, updated_at \
                     FROM local_work_items WHERE project_id = ?1 \
                     ORDER BY updated_at DESC, created_at DESC",
                )
                .map_err(sql_error)?;
            let rows = statement
                .query_map([project_id], item_columns)
                .map_err(sql_error)?;
            let mut items = Vec::new();
            for row in rows {
                items.push(item_from_columns(row.map_err(sql_error)?)?);
            }
            Ok(items)
        })
    }

    /// One item by id, for the detail panel. The project page still lists the
    /// whole project in one call; this only avoids loading siblings for a panel.
    pub fn item(&self, id: &str) -> Result<WorkItem, String> {
        let id = id.trim();
        self.with_conn(|conn| read_item(conn, id))
    }

    pub fn create_item(
        &self,
        project_id: &str,
        title: &str,
        description: Option<&str>,
        importance: Option<&str>,
    ) -> Result<WorkItem, String> {
        let project_id = project_id.trim();
        let importance = match importance {
            Some(value) => WorkItemImportance::parse(value)
                .ok_or_else(|| tr_args("local.item.importance", &[&value]))?,
            None => WorkItemImportance::Normal,
        };
        let now = now_rfc3339();
        self.with_conn(|conn| {
            ensure_project(conn, project_id)?;
            let item = WorkItem::new(
                new_work_item_id(),
                project_id.to_string(),
                title,
                description.unwrap_or(""),
                importance,
                &now,
            )
            .map_err(local_error)?;
            conn.execute(
                "INSERT INTO local_work_items \
                    (id, project_id, title, description, status, importance, agent_task_id, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    item.id,
                    item.project_id,
                    item.title,
                    item.description,
                    item.status.as_str(),
                    item.importance.as_str(),
                    item.agent_task_id,
                    item.created_at,
                    item.updated_at
                ],
            )
            .map_err(sql_error)?;
            Ok(item)
        })
    }

    pub fn update_item(
        &self,
        id: &str,
        title: Option<&str>,
        description: Option<&str>,
        status: Option<&str>,
        importance: Option<&str>,
    ) -> Result<WorkItem, String> {
        let id = id.trim();
        let status = match status {
            Some(value) => Some(
                WorkItemStatus::parse(value)
                    .ok_or_else(|| tr_args("local.item.status", &[&value]))?,
            ),
            None => None,
        };
        let importance = match importance {
            Some(value) => Some(
                WorkItemImportance::parse(value)
                    .ok_or_else(|| tr_args("local.item.importance", &[&value]))?,
            ),
            None => None,
        };
        let now = now_rfc3339();
        self.with_conn(|conn| {
            let mut item = read_item(conn, id)?;
            item.edit(title, description, importance, &now)
                .map_err(local_error)?;
            if let Some(status) = status {
                item.set_status(status, &now);
            }
            write_item(conn, &item)?;
            Ok(item)
        })
    }

    pub fn delete_item(&self, id: &str) -> Result<(), String> {
        let id = id.trim();
        self.with_conn(|conn| {
            let deleted = conn
                .execute("DELETE FROM local_work_items WHERE id = ?1", [id])
                .map_err(sql_error)?;
            if deleted == 0 {
                return Err(tr("local.item.notfound").to_string());
            }
            Ok(())
        })
    }

    /// Links an agent task to the item. The caller attaches only after the task
    /// exists, so a failed enqueue leaves the item untouched.
    pub fn attach_task(&self, item_id: &str, task_id: &str, now: &str) -> Result<WorkItem, String> {
        let item_id = item_id.trim();
        self.with_conn(|conn| {
            let mut item = read_item(conn, item_id)?;
            item.attach_task(task_id, now).map_err(local_error)?;
            write_item(conn, &item)?;
            Ok(item)
        })
    }

    /// Marks the work item that this successful task ran for as done.
    ///
    /// Matching is by `(project, item)` rather than by `agent_task_id` because
    /// retrying a local task creates a new task id; the item must still complete
    /// and now point at the task that actually succeeded. Only items still in
    /// progress are touched, so a manual move back to pending is respected.
    pub fn complete_work_item(
        &self,
        project_id: &str,
        item_id: &str,
        task_id: &str,
        now: &str,
    ) -> Result<usize, String> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE local_work_items SET status = 'done', agent_task_id = ?3, updated_at = ?4 \
                 WHERE project_id = ?1 AND id = ?2 AND status = 'in_progress'",
                params![project_id.trim(), item_id.trim(), task_id.trim(), now],
            )
            .map_err(sql_error)
        })
    }

    /// Drops the link when a task record is deleted. The status is the user's
    /// own field (see `WorkItem::clear_task`), so unlinking never moves an item
    /// back to pending behind their back.
    pub fn forget_task(&self, task_id: &str, now: &str) -> Result<usize, String> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE local_work_items SET agent_task_id = NULL, updated_at = ?2 \
                 WHERE agent_task_id = ?1",
                params![task_id.trim(), now],
            )
            .map_err(sql_error)
        })
    }

    /// One item together with its project, loaded in the same critical section
    /// so an enqueue cannot mix two different project edits.
    pub fn item_with_project(&self, item_id: &str) -> Result<(WorkItem, LocalProject), String> {
        let item_id = item_id.trim();
        self.with_conn(|conn| {
            let item = read_item(conn, item_id)?;
            let project = read_project(conn, &item.project_id)?;
            Ok((item, project))
        })
    }

    // -----------------------------------------------------------------------
    // Fallbacks for file and terminal roots
    // -----------------------------------------------------------------------

    /// Repository path of a local project, or `None` when the id is not a local
    /// project or the store is unavailable. Callers fall back to their default.
    pub fn repo_path(&self, project_id: &str) -> Option<String> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT repo_path FROM local_projects WHERE id = ?1",
                [project_id.trim()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(sql_error)
        })
        .ok()
        .flatten()
    }

    /// Every project repository path, used as the browse allowlist roots.
    pub fn repo_paths(&self) -> Result<Vec<String>, String> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare("SELECT repo_path FROM local_projects")
                .map_err(sql_error)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(sql_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_error)
        })
    }
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

type ItemColumns = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
);

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalProject> {
    Ok(LocalProject {
        id: row.get(0)?,
        name: row.get(1)?,
        repo_path: row.get(2)?,
        rule: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn item_columns(row: &rusqlite::Row<'_>) -> rusqlite::Result<ItemColumns> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
    ))
}

fn item_from_columns(
    (id, project_id, title, description, status, importance, agent_task_id, created_at, updated_at): ItemColumns,
) -> Result<WorkItem, String> {
    let status =
        WorkItemStatus::parse(&status).ok_or_else(|| tr_args("local.item.status", &[&status]))?;
    // A value written by a newer build is not a hard failure for an older row;
    // normal keeps the item readable and editable.
    let importance = WorkItemImportance::parse(&importance).unwrap_or_default();
    Ok(WorkItem {
        id,
        project_id,
        title,
        description,
        status,
        importance,
        agent_task_id,
        created_at,
        updated_at,
    })
}

fn read_project(conn: &Connection, id: &str) -> Result<LocalProject, String> {
    conn.query_row(
        "SELECT id, name, repo_path, rule, created_at, updated_at \
         FROM local_projects WHERE id = ?1",
        [id],
        project_from_row,
    )
    .optional()
    .map_err(sql_error)?
    .ok_or_else(|| tr("local.project.notfound").to_string())
}

fn read_item(conn: &Connection, id: &str) -> Result<WorkItem, String> {
    let columns = conn
        .query_row(
            "SELECT id, project_id, title, description, status, importance, \
                    agent_task_id, created_at, updated_at \
             FROM local_work_items WHERE id = ?1",
            [id],
            item_columns,
        )
        .optional()
        .map_err(sql_error)?;
    match columns {
        Some(columns) => item_from_columns(columns),
        None => Err(tr("local.item.notfound").to_string()),
    }
}

fn write_item(conn: &Connection, item: &WorkItem) -> Result<(), String> {
    conn.execute(
        "UPDATE local_work_items \
         SET project_id = ?1, title = ?2, description = ?3, status = ?4, \
             importance = ?5, agent_task_id = ?6, created_at = ?7, updated_at = ?8 \
         WHERE id = ?9",
        params![
            item.project_id,
            item.title,
            item.description,
            item.status.as_str(),
            item.importance.as_str(),
            item.agent_task_id,
            item.created_at,
            item.updated_at,
            item.id
        ],
    )
    .map_err(sql_error)?;
    Ok(())
}

fn ensure_project(conn: &Connection, project_id: &str) -> Result<(), String> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM local_projects WHERE id = ?1",
            [project_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(sql_error)?;
    if exists.is_some() {
        Ok(())
    } else {
        Err(tr("local.project.notfound").to_string())
    }
}

/// Duplicate repository paths would make the file/terminal root ambiguous.
fn repo_path_taken(
    conn: &Connection,
    repo_path: &str,
    except_id: Option<&str>,
) -> Result<bool, String> {
    let existing = conn
        .query_row(
            "SELECT id FROM local_projects WHERE repo_path = ?1",
            [repo_path],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_error)?;
    Ok(existing.is_some_and(|id| Some(id.as_str()) != except_id))
}

// ---------------------------------------------------------------------------
// Paths, ids and time
// ---------------------------------------------------------------------------

/// Expands `~`, resolves to a canonical absolute directory and stores that.
/// The canonical form makes duplicate detection and the browse allowlist
/// compare the same path the filesystem reports.
fn resolve_repo_path(repo_path: &str) -> Result<String, String> {
    let trimmed = repo_path.trim();
    if trimmed.is_empty() {
        return Err(tr("local.project.path").to_string());
    }
    let expanded = tapd_core::paths::expand_home(trimmed);
    let canonical = expanded
        .canonicalize()
        .map_err(|_| tr_args("local.project.pathInvalid", &[&expanded.display()]))?;
    if !canonical.is_dir() {
        return Err(tr_args("local.project.pathInvalid", &[&expanded.display()]));
    }
    // A project rooted at `/` would turn the phone's read-only root browser
    // into a writable whole-disk browser. Local projects must be a real folder.
    if canonical.parent().is_none() {
        return Err(tr_args(
            "local.project.pathInvalid",
            &[&canonical.display()],
        ));
    }
    Ok(canonical.to_string_lossy().to_string())
}

/// UUID v4, simple representation, first 16 hex characters.
fn new_uuid_hex() -> String {
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    uuid[..16].to_string()
}

fn new_project_id() -> String {
    project_id(&new_uuid_hex())
}

fn new_work_item_id() -> String {
    work_item_id(&new_uuid_hex())
}

/// RFC 3339 UTC, second precision.
pub(crate) fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn sql_error(error: rusqlite::Error) -> String {
    tr_args("local.store.failed", &[&error])
}

/// Runs an `ALTER TABLE` only when the column is absent. A duplicate-column
/// error is tolerated because another process may have won the same race.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    migration: &str,
) -> Result<(), String> {
    if has_column(conn, table, column)? {
        return Ok(());
    }
    if let Err(error) = conn.execute_batch(migration) {
        if !error.to_string().contains("duplicate column name") {
            return Err(sql_error(error));
        }
    }
    Ok(())
}

/// Whether a table already has a column, so a migration can be re-run after a
/// crash between the ALTER and the version stamp.
fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(sql_error)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(sql_error)?;
    for name in names {
        if name.map_err(sql_error)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Domain rejections become localized text; storage never leaks English
/// validation messages to the UI.
fn local_error(error: LocalError) -> String {
    match error {
        LocalError::EmptyProjectName => tr("local.project.name").to_string(),
        LocalError::EmptyRepoPath => tr("local.project.path").to_string(),
        LocalError::EmptyTitle => tr("local.item.title").to_string(),
        LocalError::EmptyTaskId => tr("local.item.task").to_string(),
        LocalError::InvalidStatus(status) => tr_args("local.item.status", &[&status]),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    struct TempStore {
        base: PathBuf,
    }

    impl TempStore {
        fn new(label: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "tapd-local-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&base).expect("create temp root");
            Self { base }
        }

        fn dir(&self, name: &str) -> String {
            let path = self.base.join(name);
            std::fs::create_dir_all(&path).expect("create repo");
            path.canonicalize()
                .expect("canonical repo")
                .to_string_lossy()
                .to_string()
        }

        fn store(&self) -> LocalStore {
            LocalStore::open(self.base.join("local.sqlite3"))
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn creates_lists_updates_and_deletes_projects_and_items() {
        let temp = TempStore::new("crud");
        let store = temp.store();
        let first = store
            .create_project(None, &temp.dir("notes"), None)
            .expect("create project");
        assert_eq!(first.name, "notes");
        assert!(first.id.starts_with("lp_"));
        assert_eq!(first.id.len(), 3 + 16);

        let second = store
            .create_project(Some("Journal"), &temp.dir("journal"), None)
            .expect("create named");
        assert_eq!(second.name, "Journal");
        assert_eq!(store.projects().expect("list").len(), 2);

        let updated = store
            .update_project(&first.id, Some("Notes"), None, None)
            .expect("rename");
        assert_eq!(updated.name, "Notes");
        assert_eq!(updated.created_at, first.created_at);

        let item = store
            .create_item(&first.id, "Ship it", Some("body"), None)
            .expect("create item");
        assert!(item.id.starts_with("lw_"));
        assert_eq!(item.status, WorkItemStatus::Pending);

        let edited = store
            .update_item(&item.id, Some("Ship it twice"), None, Some("in_progress"), None)
            .expect("update item");
        assert_eq!(edited.title, "Ship it twice");
        assert_eq!(edited.status, WorkItemStatus::InProgress);

        let items = store.items(&first.id).expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, item.id);

        store.delete_item(&item.id).expect("delete item");
        assert!(store.items(&first.id).expect("items after").is_empty());

        store.delete_project(&first.id).expect("delete project");
        let remaining = store.projects().expect("projects after");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, second.id);
    }

    #[test]
    fn rejects_duplicate_and_missing_repository_paths() {
        let temp = TempStore::new("duplicate");
        let store = temp.store();
        let repo = temp.dir("repo");
        store.create_project(None, &repo, None).expect("first");

        assert_eq!(
            store
                .create_project(None, &repo, None)
                .expect_err("duplicate"),
            tr("local.project.duplicate")
        );
        assert_eq!(
            store
                .create_project(None, &temp.base.join("missing").to_string_lossy(), None)
                .expect_err("missing"),
            tr_args(
                "local.project.pathInvalid",
                &[&temp.base.join("missing").display()]
            )
        );
        assert_eq!(
            store.create_project(None, "   ", None).expect_err("empty"),
            tr("local.project.path")
        );
        let root = std::path::Path::new("/");
        assert_eq!(
            store
                .create_project(None, "/", None)
                .expect_err("filesystem root"),
            tr_args("local.project.pathInvalid", &[&root.display()])
        );
    }

    #[test]
    fn deleting_a_project_removes_its_items() {
        let temp = TempStore::new("cascade");
        let store = temp.store();
        let project = store
            .create_project(None, &temp.dir("repo"), None)
            .expect("project");
        store.create_item(&project.id, "One", None, None).expect("item");
        store.delete_project(&project.id).expect("delete");

        assert_eq!(
            store.items(&project.id).expect_err("project gone"),
            tr("local.project.notfound")
        );
        assert_eq!(
            store.delete_item("lw_missing").expect_err("item gone"),
            tr("local.item.notfound")
        );
    }

    #[test]
    fn attach_task_starts_the_item_and_unknown_status_is_rejected() {
        let temp = TempStore::new("attach");
        const NOW: &str = "2026-01-01T00:00:00Z";
        let store = temp.store();
        let project = store
            .create_project(None, &temp.dir("repo"), None)
            .expect("project");
        let item = store.create_item(&project.id, "Work", None, None).expect("item");

        let attached = store.attach_task(&item.id, "task-1", NOW).expect("attach");
        assert_eq!(attached.agent_task_id.as_deref(), Some("task-1"));
        assert_eq!(attached.status, WorkItemStatus::InProgress);

        let error = store
            .update_item(&item.id, None, None, Some("archived"), None)
            .expect_err("unknown status");
        assert_eq!(error, tr_args("local.item.status", &[&"archived"]));
    }

    #[test]
    fn project_rule_is_created_updated_and_cleared() {
        let temp = TempStore::new("rule");
        let store = temp.store();
        let project = store
            .create_project(None, &temp.dir("repo"), Some("  用 pnpm  "))
            .expect("create with rule");
        assert_eq!(project.rule, "用 pnpm");

        let renamed = store
            .update_project(&project.id, Some("App"), None, None)
            .expect("rename keeps the rule");
        assert_eq!(renamed.rule, "用 pnpm");

        let updated = store
            .update_project(&project.id, None, None, Some("先跑测试"))
            .expect("set rule");
        assert_eq!(updated.rule, "先跑测试");
        assert_eq!(store.projects().expect("list")[0].rule, "先跑测试");

        let cleared = store
            .update_project(&project.id, None, None, Some("  "))
            .expect("clear rule");
        assert_eq!(cleared.rule, "");
    }

    #[test]
    fn completes_relinks_and_forgets_linked_items() {
        let temp = TempStore::new("complete");
        const NOW: &str = "2026-01-01T00:00:00Z";
        const DONE_AT: &str = "2026-01-02T00:00:00Z";
        let store = temp.store();
        let project = store
            .create_project(None, &temp.dir("repo"), None)
            .expect("project");
        let linked = store
            .create_item(&project.id, "Linked", None, None)
            .expect("item");
        store
            .attach_task(&linked.id, "task-1", NOW)
            .expect("attach");
        let other = store
            .create_item(&project.id, "Other", None, None)
            .expect("other item");

        // Completion matches by (project, item), so a retried task's new id
        // still completes the item and becomes the linked id.
        assert_eq!(
            store
                .complete_work_item(&project.id, &linked.id, "task-2", DONE_AT)
                .expect("complete"),
            1
        );
        let find = |id: &str| {
            store
                .items(&project.id)
                .expect("items")
                .into_iter()
                .find(|item| item.id == id)
                .expect("item listed")
        };
        assert_eq!(find(&linked.id).status, WorkItemStatus::Done);
        assert_eq!(find(&linked.id).agent_task_id.as_deref(), Some("task-2"));
        assert_eq!(find(&other.id).status, WorkItemStatus::Pending);

        // Already done: no row changes, so the timestamp stays put.
        let done_at = find(&linked.id).updated_at;
        assert_eq!(
            store
                .complete_work_item(&project.id, &linked.id, "task-3", NOW)
                .expect("idempotent"),
            0
        );
        assert_eq!(find(&linked.id).updated_at, done_at);

        // A manual move back to pending is respected (not in_progress).
        let pending = store
            .create_item(&project.id, "Moved back", None, None)
            .expect("pending item");
        assert_eq!(
            store
                .complete_work_item(&project.id, &pending.id, "task-x", NOW)
                .expect("pending untouched"),
            0
        );

        // Deletion clears the link and leaves the user's status alone.
        store
            .attach_task(&other.id, "task-new", NOW)
            .expect("attach");
        assert_eq!(
            store
                .complete_work_item(&project.id, &other.id, "task-new", DONE_AT)
                .expect("complete"),
            1
        );
        assert_eq!(store.forget_task("task-new", NOW).expect("forget"), 1);
        let forgotten = find(&other.id);
        assert_eq!(forgotten.agent_task_id, None);
        assert_eq!(forgotten.status, WorkItemStatus::Done);
        // Unknown ids (TAPD tasks) are no-ops.
        assert_eq!(store.forget_task("tapd-1", NOW).expect("no-op"), 0);
    }

    #[test]
    fn a_v1_database_migrates_and_keeps_its_projects() {
        let temp = TempStore::new("migrate");
        let db_path = temp.base.join("local.sqlite3");
        const NOW: &str = "2026-01-01T00:00:00Z";
        {
            // The v1 schema: no `rule` column, user_version 1.
            let conn = Connection::open(&db_path).expect("open v1");
            conn.execute_batch(
                "CREATE TABLE local_projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    repo_path TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE local_work_items (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    agent_task_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                PRAGMA user_version = 1;",
            )
            .expect("v1 schema");
            conn.execute(
                "INSERT INTO local_projects (id, name, repo_path, created_at, updated_at) \
                 VALUES ('lp_old', 'Old', ?1, ?2, ?2)",
                params![temp.dir("old"), NOW],
            )
            .expect("v1 row");
        }

        let store = temp.store();
        let projects = store.projects().expect("migrated projects");
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "lp_old");
        assert_eq!(projects[0].rule, "", "existing rows get an empty rule");

        let created = store
            .create_project(None, &temp.dir("new"), Some("规则"))
            .expect("create after migration");
        assert_eq!(created.rule, "规则");

        let migrated: i64 = Connection::open(&db_path)
            .expect("reopen")
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        assert_eq!(migrated, SCHEMA_VERSION);
    }

    #[test]
    fn a_v1_database_with_the_rule_column_but_old_version_recovers() {
        let temp = TempStore::new("migrate-partial");
        let db_path = temp.base.join("local.sqlite3");
        {
            // The ALTER landed but the version stamp did not: the next open
            // must not fail with "duplicate column".
            let conn = Connection::open(&db_path).expect("open partial");
            conn.execute_batch(
                "CREATE TABLE local_projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    repo_path TEXT NOT NULL,
                    rule TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                PRAGMA user_version = 1;",
            )
            .expect("partial v1 schema");
        }

        let store = temp.store();
        assert!(store.projects().expect("recover").is_empty());
        let version: i64 = Connection::open(&db_path)
            .expect("reopen")
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn an_unknown_schema_version_is_left_untouched() {
        let temp = TempStore::new("future");
        let db_path = temp.base.join("local.sqlite3");
        {
            let conn = Connection::open(&db_path).expect("open");
            conn.pragma_update(None, "user_version", 4)
                .expect("stamp a newer version");
        }

        let store = LocalStore::open(db_path.clone());
        assert_eq!(
            store.projects().expect_err("unavailable"),
            tr("local.store.unavailable")
        );

        let version: i64 = Connection::open(&db_path)
            .expect("reopen")
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        assert_eq!(version, 4, "a newer file is never rewritten");
    }

    #[test]
    fn a_v2_database_adds_importance_without_touching_items() {
        const NOW: &str = "2026-01-01T00:00:00Z";
        let temp = TempStore::new("migrate-v2-importance");
        let db_path = temp.base.join("local.sqlite3");
        {
            let conn = Connection::open(&db_path).expect("open v2");
            conn.execute_batch(
                "CREATE TABLE local_projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    repo_path TEXT NOT NULL,
                    rule TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE local_work_items (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    agent_task_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                PRAGMA user_version = 2;",
            )
            .expect("v2 schema");
            conn.execute(
                "INSERT INTO local_projects (id, name, repo_path, rule, created_at, updated_at) \
                 VALUES ('lp_old', 'Old', ?1, '', ?2, ?2)",
                params![temp.dir("old"), NOW],
            )
            .expect("v2 project");
            conn.execute(
                "INSERT INTO local_work_items \
                    (id, project_id, title, description, status, agent_task_id, created_at, updated_at) \
                 VALUES ('lw_old', 'lp_old', 'Old item', 'body', 'pending', NULL, ?1, ?1)",
                params![NOW],
            )
            .expect("v2 item");
        }

        let store = temp.store();
        let items = store.items("lp_old").expect("migrated items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "lw_old");
        assert_eq!(items[0].importance, WorkItemImportance::Normal);

        // Importance round-trips through INSERT, UPDATE and the single-item read.
        let created = store
            .create_item("lp_old", "High", None, Some("high"))
            .expect("create with importance");
        assert_eq!(created.importance, WorkItemImportance::High);
        let updated = store
            .update_item(&created.id, None, None, None, Some("low"))
            .expect("update importance");
        assert_eq!(updated.importance, WorkItemImportance::Low);
        assert_eq!(
            store.item(&created.id).expect("read item").importance,
            WorkItemImportance::Low
        );

        let version: i64 = Connection::open(&db_path)
            .expect("reopen")
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn a_failed_open_degrades_to_the_unavailable_error() {
        let temp = TempStore::new("unavailable");
        // A directory at the database path makes SQLite refuse to open it.
        let db_path = temp.base.join("local.sqlite3");
        std::fs::create_dir(&db_path).expect("blocking directory");
        let store = LocalStore::open(db_path);

        assert_eq!(
            store.projects().expect_err("unavailable"),
            tr("local.store.unavailable")
        );
        assert_eq!(
            store
                .create_project(None, &temp.dir("repo"), None)
                .expect_err("unavailable"),
            tr("local.store.unavailable")
        );
    }
}
