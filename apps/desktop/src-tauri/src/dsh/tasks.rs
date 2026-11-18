//! Task workflow over dsh sessions (P4).
//!
//! Contract: docs/DSH.md §9. `command` is the feature surface both windows and
//! the paired phone use; the unified task list, worktree, review and merge all
//! live behind it.
//!
//! One list holds every task. `workflow` is the only state machine:
//!
//! ```text
//! running ──turn end, no changes──────────────▶ done
//!    │  └──turn end, changes──▶ awaiting_review
//!    │                                │ approve (worktree off) ──▶ done
//!    ├──approve (worktree on)─────────┴──▶ awaiting_merge ──merge──▶ done
//!    └──cancel / merge failure / inspection failure
//!        (cancel)  ──▶ canceled
//!        (failure) ──▶ failed
//! ```
//!
//! Terminal states never move. Every write is a compare-and-swap on the stored
//! `workflow`, so a late `turn/end`, a cancel pressed during a merge, or two
//! buttons at once cannot rewrite a newer state.
//!
//! Persistence is [`super::task_store`] (the `dsh_tasks` table). There is no
//! in-memory registry: the DB row is the one source, which makes a restart
//! behave exactly like the live path.
//!
//! The bridge owns the turn signal: [`observe`] is called from its publish path
//! for every committed entry.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use dsh_host::transcript::{DshEntry, DshSession, SessionStatus, TurnState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tapd_i18n::{tr, tr_args};
use tapd_local::WorkItemStatus;
use tapd_workspace::{ChangeSummary, TaskWorkspace};
use tauri::{AppHandle, Emitter, Manager};

use super::bridge::BridgeState;
use super::runtime::RuntimeState;
use crate::agent_settings::{self, AgentConfig, PromptVars};
use crate::coworker;
use crate::state::SharedState;

// The three collaborators live next to this file but are private to the task
// module: nothing outside `dsh::tasks` may write a task row, run task git
// plumbing or write TAPD back. `#[path]` expresses that privacy instead of
// widening the crate surface.
#[path = "task_store.rs"]
mod task_store;
#[path = "worktree.rs"]
mod worktree;
#[path = "writeback.rs"]
mod writeback;

/// Emitted whenever the task list changes. Payload: `{ tasks: DshTask[] }`.
pub const EVENT_TASKS: &str = "dsh://tasks";

// ---------------------------------------------------------------------------
// Model (docs/DSH.md §9.1)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    /// A free conversation with no project behind it. No P4 flow creates one
    /// yet; the variant is part of the §9.1 contract.
    #[allow(dead_code)]
    Chat,
    Bug,
    LocalItem,
}

impl TaskKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Bug => "bug",
            Self::LocalItem => "local_item",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectKind {
    Tapd,
    Local,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Workflow {
    Running,
    AwaitingReview,
    AwaitingMerge,
    Done,
    Failed,
    Canceled,
}

impl Workflow {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::AwaitingReview => "awaiting_review",
            Self::AwaitingMerge => "awaiting_merge",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Canceled)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProject {
    pub id: String,
    pub name: String,
    pub kind: ProjectKind,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskChanges {
    pub files: usize,
    pub additions: usize,
    pub deletions: usize,
}

/// Reserved for a model-written review. Nothing produces it yet: the built-in
/// runtime has no summarizer, and duplicating `changes` here would be a second
/// source for the same fact.
#[allow(dead_code)] // contract field; no producer until a review step exists
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReview {
    pub summary: String,
    pub files: Vec<String>,
    pub risk: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMerge {
    pub error: String,
    pub instructions: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshTask {
    pub id: String,
    pub kind: TaskKind,
    pub project: Option<TaskProject>,
    pub title: String,
    pub bug_id: Option<String>,
    pub workflow: Workflow,
    pub status: SessionStatus,
    pub repo_path: String,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub json_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: u32,
    pub changes: Option<TaskChanges>,
    pub review: Option<TaskReview>,
    pub merge: Option<TaskMerge>,
}

/// Internal facts the contract does not expose. They travel in the same JSON
/// payload (bare rows stay readable) and never reach `dsh_tasks`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct TaskMeta {
    pub workspace_id: Option<String>,
    /// Commit the task started from; the diff and review baseline.
    pub baseline: Option<String>,
    /// Whether the task ran in an isolated worktree (it still owns a branch
    /// after the directory is removed).
    pub worktree: bool,
    pub local_project_id: Option<String>,
    pub local_item_id: Option<String>,
    /// Status the item had before `attach_task` moved it to in_progress; a
    /// canceled or failed launch puts it back here.
    pub local_previous_status: Option<String>,
    /// Package directory holding `bug.json` / `quest.json`.
    pub export_dir: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskRecord {
    pub task: DshTask,
    #[serde(default)]
    pub meta: TaskMeta,
}

impl TaskRecord {
    fn touch(&mut self) {
        self.task.updated_at = now();
    }

    /// Records an event that already happened: replaying a log must restore the
    /// activity time it had, not claim the session is active right now — the
    /// list is ordered by this field.
    fn touch_at(&mut self, at: &str) {
        if !at.is_empty() {
            self.task.updated_at = at.to_string();
        }
    }

    /// The directory the session and the review operate on.
    fn work_dir(&self) -> String {
        if self.meta.worktree {
            self.task.worktree_path.clone().unwrap_or_default()
        } else {
            self.task.repo_path.clone()
        }
    }
}

fn workspace_for(record: &TaskRecord) -> TaskWorkspace {
    TaskWorkspace::new(
        record.task.repo_path.clone(),
        record.work_dir(),
        record.task.branch.clone(),
        record.meta.baseline.clone(),
        Vec::new(),
    )
}

// ---------------------------------------------------------------------------
// State machine (single entry point, unit tested)
// ---------------------------------------------------------------------------

/// The only place a workflow value moves. Everything else calls this and then
/// writes the row with the returned expectation, so a stale caller fails the
/// compare-and-swap instead of regressing a terminal state.
fn transition(record: &mut TaskRecord, next: Workflow) -> Result<Workflow, String> {
    let current = record.task.workflow;
    if !can_move(current, next) {
        return Err(tr("dsh.task.state.invalid").to_string());
    }
    record.task.workflow = next;
    Ok(current)
}

fn can_move(from: Workflow, to: Workflow) -> bool {
    use Workflow::*;
    match from {
        Running => matches!(
            to,
            AwaitingReview | AwaitingMerge | Done | Canceled | Failed
        ),
        AwaitingReview => matches!(to, AwaitingMerge | Done | Canceled),
        AwaitingMerge => matches!(to, Done | Canceled),
        Done | Failed | Canceled => false,
    }
}

/// A finished or failed task that receives a new user turn is active again.
///
/// This is deliberately *not* an edge in [`can_move`]: a log replay or a late
/// event must never reopen a task. Only a path that accepted fresh input calls
/// it, so "已完成" stops being true exactly when the user asks for more work.
fn reopen_target(workflow: Workflow) -> Option<Workflow> {
    matches!(workflow, Workflow::Done | Workflow::Failed).then_some(Workflow::Running)
}

/// Whether a turn end means the work itself did not finish. Reviewing the
/// worktree after one of these reports "done" precisely because the model
/// never got to touch it, which is the opposite of what happened.
fn failed_turn(reason: Option<&str>) -> bool {
    matches!(reason, Some("error") | Some("blocked"))
}

/// What a finished turn means for the task: any change at all (committed or
/// still in the working tree) needs review; nothing means the task is done.
fn review_outcome(summary: &ChangeSummary) -> (Workflow, Option<TaskChanges>) {
    if summary.file_count == 0 {
        (Workflow::Done, None)
    } else {
        (
            Workflow::AwaitingReview,
            Some(TaskChanges {
                files: summary.file_count,
                additions: summary.additions,
                deletions: summary.deletions,
            }),
        )
    }
}

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

/// Dispatches `dsh_task*` / `dsh_tasks`.
pub async fn command(app: &AppHandle, name: &str, payload: Value) -> Result<Value, String> {
    match name {
        "dsh_tasks" => list(app).await,
        "dsh_task_enqueue_bug" => enqueue_bug(app, parse(payload, name)?).await,
        "dsh_task_enqueue_local" => enqueue_local(app, parse(payload, name)?).await,
        "dsh_task_approve" => approve(app, parse(payload, name)?).await,
        "dsh_task_merge" => merge(app, parse(payload, name)?).await,
        "dsh_task_cancel" => cancel(app, parse(payload, name)?).await,
        "dsh_task_diff" => diff(app, parse(payload, name)?).await,
        "dsh_task_resume" => resume(app, parse(payload, name)?).await,
        "dsh_task_delete" => delete_session(app, parse(payload, name)?).await,
        other => Err(format!("unknown dsh task command: {other}")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnqueueBugRequest {
    workspace_id: String,
    bug_id: String,
    #[serde(default)]
    extra_prompt: Option<String>,
    #[serde(default)]
    attachments: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnqueueLocalRequest {
    project_id: String,
    item_id: String,
    #[serde(default)]
    extra_prompt: Option<String>,
    #[serde(default)]
    attachments: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRequest {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelRequest {
    session_id: String,
    #[serde(default)]
    stash: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffRequest {
    session_id: String,
    #[serde(default)]
    file: Option<String>,
}

fn parse<T: for<'de> Deserialize<'de>>(payload: Value, name: &str) -> Result<T, String> {
    serde_json::from_value(payload).map_err(|error| tr_args("dsh.args.invalid", &[&name, &error]))
}

async fn list(app: &AppHandle) -> Result<Value, String> {
    tasks_payload(app).await
}

async fn tasks_payload(app: &AppHandle) -> Result<Value, String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let records = blocking(move || task_store::load_all(&cache)).await?;
    let live = live_sessions(app);
    let mut tasks: Vec<DshTask> = records
        .into_iter()
        .map(|mut record| {
            overlay(&mut record.task, &live);
            record.task
        })
        .collect();
    // Overlaid times can differ from the stored column, so order here too:
    // newest activity first, which is also the order the UI paints.
    tasks.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(json!({ "tasks": tasks }))
}

// ---------------------------------------------------------------------------
// Turn-end observation
// ---------------------------------------------------------------------------

/// One committed entry from the bridge: turn ends settle the workflow, and the
/// first user line names a chat.
pub fn observe(app: &AppHandle, session_id: &str, entry: &DshEntry) {
    let at = entry.at();
    match entry {
        DshEntry::Turn {
            state: TurnState::End,
            reason,
            error,
            ..
        } => on_turn_end(app, session_id, at, reason.as_deref(), error.as_deref()),
        // A chat starts untitled; the first human line names it in the list.
        DshEntry::User { text, .. } => retitle_chat(app, session_id, text, at),
        _ => {}
    }
}

/// Names a chat task from its first user message. Tasks with a real title
/// (bug / local item) are never touched.
fn retitle_chat(app: &AppHandle, session_id: &str, text: &str, at: &str) {
    let Some(title) = first_line(text) else {
        return;
    };
    let app = app.clone();
    let session_id = session_id.to_string();
    let at = at.to_string();
    tauri::async_runtime::spawn(async move {
        let Ok(state) = shared(&app) else {
            return;
        };
        let cache = state.cache.clone();
        let id = session_id.clone();
        let updated = blocking(move || {
            let Some(mut record) = task_store::load(&cache, &id)? else {
                return Ok::<_, String>(None);
            };
            if record.task.kind != TaskKind::Chat || !record.task.title.trim().is_empty() {
                return Ok(None);
            }
            record.task.title = title;
            record.touch_at(&at);
            task_store::update_if(&cache, &record, Workflow::Running)?;
            Ok(Some(record.task))
        })
        .await;
        match updated {
            Ok(Some(_)) => emit(&app),
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "failed to title a chat task"),
        }
    });
}

/// First non-empty line, trimmed and capped the same way the transcript
/// registry caps session titles.
fn first_line(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(line.chars().take(60).collect())
}

/// Registers a plain chat session so the unified list holds it too. Idempotent:
/// the row exists as soon as the UI asks for a new session.
pub async fn create_chat(app: &AppHandle, session_id: &str) -> Result<Value, String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = session_id.to_string();
    let record = blocking(move || {
        if task_store::load(&cache, &id)?.is_some() {
            return Ok::<_, String>(None);
        }
        let at = now();
        let record = TaskRecord {
            task: DshTask {
                id: id.clone(),
                kind: TaskKind::Chat,
                project: None,
                title: String::new(),
                bug_id: None,
                workflow: Workflow::Running,
                status: SessionStatus::Idle,
                repo_path: String::new(),
                worktree_path: None,
                branch: None,
                json_path: String::new(),
                created_at: at.clone(),
                updated_at: at,
                message_count: 0,
                changes: None,
                review: None,
                merge: None,
            },
            meta: TaskMeta::default(),
        };
        task_store::insert(&cache, &record)?;
        Ok(Some(record.task))
    })
    .await?;
    if record.is_some() {
        emit(app);
    }
    Ok(json!({ "sessionId": session_id }))
}

/// The persisted kind of a session, when it has a task row at all. Draft ids
/// the UI knows but the store does not return `None`.
pub async fn kind_of(app: &AppHandle, session_id: &str) -> Option<TaskKind> {
    let state = shared(app).ok()?;
    let cache = state.cache.clone();
    let id = session_id.to_string();
    let loaded = blocking(move || task_store::load(&cache, &id)).await.ok()??;
    Some(loaded.task.kind)
}

/// Deletes a free conversation: its list row, its normalized state and the
/// files only it owns. Work handed over from a bug or a local item keeps its
/// worktree and its history, so only chats qualify.
/// Removes one session: its row, its mode, its log and whatever directory the
/// app created for it. The repository a task was opened from is never touched;
/// a worktree is removed with `--force`, because the account that can delete a
/// session is the one that owns its uncommitted changes.
async fn delete_session(app: &AppHandle, request: SessionRequest) -> Result<Value, String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = request.session_id.clone();
    let Some(record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Err(not_found(&request.session_id));
    };
    let running = live_sessions(app)
        .get(&request.session_id)
        .is_some_and(|session| session.status == SessionStatus::Running);
    if running {
        return Err(tr("dsh.chat.delete.running").to_string());
    }
    let worktree = record
        .task
        .worktree_path
        .clone()
        .filter(|path| !path.trim().is_empty());
    let repo = record.task.repo_path.clone();

    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = request.session_id.clone();
    blocking(move || task_store::delete(&cache, &id)).await?;
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = request.session_id.clone();
    let _ = blocking(move || super::mode_store::delete(&cache, &id)).await
        .map_err(|error| {
            tracing::warn!(%error, session = %request.session_id, "failed to delete the session mode");
        });
    if let Ok(bridge) = bridge(app) {
        bridge.forget_session(app, &request.session_id);
    }

    // The conversation file and the chat's scratch workspace exist for this
    // session only; leaving either behind lets a later hydrate resurrect it.
    if let Some(sessions_dir) = super::session_log::dir(app) {
        if let Some(dir) = super::session_log::path(&sessions_dir, &request.session_id)
            .and_then(|log| log.parent().map(|parent| parent.to_path_buf()))
        {
            let _ = blocking(move || {
                std::fs::remove_dir_all(&dir).map_err(|error| error.to_string())
            })
            .await;
        }
    }
    let workspace = state
        .paths
        .data_dir
        .join("dsh")
        .join("chats")
        .join(&request.session_id);
    let _ = blocking(move || {
        std::fs::remove_dir_all(&workspace).map_err(|error| error.to_string())
    })
    .await;

    // Best effort: a repository that moved away must not keep a dead row in the
    // list, and the project page still lists whatever directory is left over.
    if let Some(path) = worktree {
        let target = path.clone();
        let removed = blocking(move || worktree::remove(&repo, &target)).await;
        if let Err(error) = removed {
            tracing::warn!(%error, %path, "failed to remove the deleted session's worktree");
        }
    }

    emit(app);
    Ok(json!({ "sessionId": request.session_id }))
}

/// The directory one session works in, resolved without the runtime.
///
/// Chats own a scratch dir under the data directory; tasks use their worktree
/// while it exists and fall back to the repository. A session with no task row
/// can still own a chat directory (a draft that already prompted), so that
/// case answers only when the directory is there. The file viewer scopes a tab
/// to this root through the `__session__:<id>` workspace id.
pub(crate) fn session_root(app: &AppHandle, session_id: &str) -> Option<PathBuf> {
    let state = shared(app).ok()?;
    let chat = state
        .paths
        .data_dir
        .join("dsh")
        .join("chats")
        .join(session_id);
    let Some(record) = task_store::load(&state.cache, session_id).ok().flatten() else {
        return chat.is_dir().then_some(chat);
    };
    if record.task.kind == TaskKind::Chat {
        return Some(chat);
    }
    if let Some(worktree) = record
        .task
        .worktree_path
        .clone()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
    {
        // A worktree the user already removed must not shadow the repository.
        if worktree.is_dir() {
            return Some(worktree);
        }
    }
    let repo = record.task.repo_path.trim().to_string();
    (!repo.is_empty()).then(|| PathBuf::from(repo))
}

/// The directory one session works in. Used by "在 Finder 中打开" on the
/// session list, which must not guess these paths on its own. Unlike
/// [`session_root`] this reports the configured worktree even when it is
/// already gone, so the UI can say the directory is missing.
pub async fn session_dir(app: &AppHandle, session_id: &str) -> Result<Value, String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = session_id.to_string();
    let Some(record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Err(not_found(session_id));
    };
    let path = match record.task.kind {
        TaskKind::Chat => state
            .paths
            .data_dir
            .join("dsh")
            .join("chats")
            .join(&record.task.id)
            .to_string_lossy()
            .to_string(),
        _ => record
            .task
            .worktree_path
            .clone()
            .filter(|path| !path.trim().is_empty())
            .unwrap_or_else(|| record.task.repo_path.clone()),
    };
    Ok(json!({
        "path": path,
        "exists": !path.is_empty() && std::path::Path::new(&path).is_dir(),
    }))
}

// ---------------------------------------------------------------------------
// Worktrees on disk (project settings)
// ---------------------------------------------------------------------------

/// Every directory under the app's worktree root, paired with the task that
/// opened it (absent = a leftover from a session that is already gone).
pub async fn worktrees(app: &AppHandle) -> Result<Value, String> {
    let state = shared(app)?;
    let root = state.paths.worktrees_dir.clone();
    let root_display = root.to_string_lossy().to_string();
    let root_path = root.clone();
    let cache = state.cache.clone();
    let rows = blocking(move || {
        let mut rows: Vec<Value> = Vec::new();
        let Ok(entries) = std::fs::read_dir(&root_path) else {
            return Ok::<_, String>(rows);
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let session_id = entry.file_name().to_string_lossy().to_string();
            if session_id.starts_with('.') {
                continue;
            }
            let record = task_store::load(&cache, &session_id)?;
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .map(|time| {
                    let at: chrono::DateTime<chrono::Utc> = time.into();
                    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                })
                .unwrap_or_default();
            rows.push(json!({
                "sessionId": session_id,
                "path": path.to_string_lossy(),
                "updatedAt": modified,
                "title": record.as_ref().map(|row| row.task.title.clone()).unwrap_or_default(),
                "project": record.as_ref().and_then(|row| row.task.project.clone()),
                "repoPath": record.as_ref().map(|row| row.task.repo_path.clone()).unwrap_or_default(),
                "orphan": record.is_none(),
            }));
        }
        // Newest first: a leftover from yesterday is the one to look at.
        rows.sort_by(|left, right| {
            right["updatedAt"]
                .as_str()
                .unwrap_or("")
                .cmp(left["updatedAt"].as_str().unwrap_or(""))
        });
        Ok(rows)
    })
    .await?;
    Ok(json!({ "root": root_display, "worktrees": rows }))
}

/// Removes one worktree directory. Only paths inside the app's own worktree
/// root are accepted, so this can never be pointed at a user's repository.
pub async fn remove_worktree(app: &AppHandle, path: &str) -> Result<Value, String> {
    let state = shared(app)?;
    let root = state.paths.worktrees_dir.clone();
    let cache = state.cache.clone();
    let target = std::path::Path::new(path).to_path_buf();
    let removed = blocking(move || {
        let root = root.canonicalize().unwrap_or(root);
        let target = target.canonicalize().unwrap_or_else(|_| target.clone());
        if !target.starts_with(&root) || target == root {
            return Err(tr("dsh.worktree.outside").to_string());
        }
        let session_id = target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let record = task_store::load(&cache, &session_id)?;
        let repo = record
            .as_ref()
            .map(|row| row.task.repo_path.clone())
            .filter(|path| !path.trim().is_empty())
            .unwrap_or_else(|| repo_of(&target).unwrap_or_default());
        if repo.is_empty() {
            // No task row and no `.git` link: a plain directory the app made.
            return std::fs::remove_dir_all(&target).map_err(|error| error.to_string());
        }
        worktree::remove(&repo, &target.to_string_lossy())?;
        if let Some(mut record) = record {
            record.task.worktree_path = None;
            let expected = record.task.workflow;
            let _ = task_store::update_if(&cache, &record, expected);
        }
        Ok(())
    })
    .await;
    removed?;
    emit(app);
    Ok(json!({ "path": path }))
}

/// The repository a worktree directory belongs to, from its `.git` link file
/// (`gitdir: <repo>/.git/worktrees/<name>`).
fn repo_of(worktree: &std::path::Path) -> Option<String> {
    let link = std::fs::read_to_string(worktree.join(".git")).ok()?;
    let gitdir = link.trim().strip_prefix("gitdir:")?.trim();
    let gitdir = std::path::Path::new(gitdir);
    // <repo>/.git/worktrees/<name> → <repo>
    let repo = gitdir.ancestors().nth(3)?;
    Some(repo.to_string_lossy().to_string())
}

/// Schedules the review of a finished turn. Idempotent: a task that already
/// left `running` is ignored, so a replayed snapshot cannot restart the work.
pub fn on_turn_end(
    app: &AppHandle,
    session_id: &str,
    at: &str,
    reason: Option<&str>,
    error: Option<&str>,
) {
    let app = app.clone();
    let session_id = session_id.to_string();
    let at = at.to_string();
    let reason = reason.map(str::to_string);
    let error = error.map(str::to_string);
    tauri::async_runtime::spawn(async move {
        if let Err(problem) = finish_turn(&app, &session_id, &at, reason.as_deref(), error.as_deref()).await {
            tracing::warn!(%problem, session = session_id, "failed to review a finished dsh turn");
        }
    });
}

async fn finish_turn(
    app: &AppHandle,
    session_id: &str,
    at: &str,
    reason: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = session_id.to_string();
    let Some(record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Ok(());
    };
    if record.task.workflow != Workflow::Running {
        return Ok(());
    }
    // A chat has no repository, so there is nothing to review; its workflow
    // stays `running`. The row still records activity: the list sorts and
    // displays chats by it long after the live session is gone.
    if record.task.kind == TaskKind::Chat {
        let mut record = record;
        record.task.message_count = live_sessions(app)
            .get(session_id)
            .map(|session| session.message_count as u32)
            .unwrap_or(record.task.message_count);
        record.touch_at(at);
        let expected = record.task.workflow;
        let state = shared(app)?;
        let cache = state.cache.clone();
        let stored = record.clone();
        if blocking(move || task_store::update_if(&cache, &stored, expected)).await? {
            emit(app);
        }
        return Ok(());
    }

    // A user stop is settled by the cancel command that owns `canceled` here;
    // reviewing an aborted turn would race that transition.
    if reason == Some("aborted") {
        return Ok(());
    }

    let workspace = workspace_for(&record);
    let summary = match blocking(move || {
        workspace
            .summary()
            .map_err(|error| error.message().to_string())
    })
    .await
    {
        Ok(summary) => summary,
        Err(error) => {
            // The task cannot be reviewed, so it must not claim to be running
            // forever. `failed` is terminal; the turn row still carries the
            // model's own failure reason.
            fail_task(app, session_id, &error).await;
            return Err(error);
        }
    };

    // A failed turn on a clean tree did no work: reviewing it would report
    // "done" precisely because the model never ran. `done` is terminal, which
    // is how a task ticked "已完成" while its retry was still working. A failed
    // turn that *did* change files still needs the review it earned.
    if failed_turn(reason) && summary.file_count == 0 {
        fail_task(app, session_id, error.unwrap_or("turn failed")).await;
        return Ok(());
    }

    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = session_id.to_string();
    let Some(mut record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Ok(());
    };
    if record.task.workflow != Workflow::Running {
        // A cancel (or an earlier turn end) won while the diff was computed.
        return Ok(());
    }
    let (next, changes) = review_outcome(&summary);
    let expected = transition(&mut record, next)?;
    record.task.changes = changes;
    record.task.merge = None;
    record.task.message_count = live_sessions(app)
        .get(session_id)
        .map(|session| session.message_count as u32)
        .unwrap_or(record.task.message_count);
    record.touch_at(at);

    let state = shared(app)?;
    let cache = state.cache.clone();
    let stored = record.clone();
    let changed = blocking(move || task_store::update_if(&cache, &stored, expected)).await?;
    if !changed {
        return Ok(());
    }
    complete_local(app, &record).await;
    emit(app);
    Ok(())
}

async fn fail_task(app: &AppHandle, session_id: &str, reason: &str) {
    tracing::warn!(session = session_id, %reason, "dsh task failed");
    let Ok(state) = shared(app) else {
        return;
    };
    let cache = state.cache.clone();
    let id = session_id.to_string();
    let reloaded = blocking(move || task_store::load(&cache, &id)).await;
    let Ok(Some(mut record)) = reloaded else {
        return;
    };
    let Ok(expected) = transition(&mut record, Workflow::Failed) else {
        return;
    };
    record.touch();
    let state = match shared(app) {
        Ok(state) => state,
        Err(_) => return,
    };
    let cache = state.cache.clone();
    if let Ok(true) = blocking(move || task_store::update_if(&cache, &record, expected)).await {
        emit(app);
    }
}

/// Reopens a finished or failed task for the turn about to start.
///
/// Called only from paths that just accepted new input (a prompt, a retry).
/// Log replay and late events never reach it, so a restored session cannot
/// resurrect a task it already settled.
pub async fn reopen_for_input(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = session_id.to_string();
    let reopened = blocking(move || {
        let Some(mut record) = task_store::load(&cache, &id)? else {
            return Ok::<_, String>(false);
        };
        let Some(next) = reopen_target(record.task.workflow) else {
            return Ok(false);
        };
        let expected = record.task.workflow;
        record.task.workflow = next;
        // Deliberately not `touch()`: the new turn's own events carry the time,
        // and reopening must not jump the row to the top by itself.
        task_store::update_if(&cache, &record, expected)
    })
    .await?;
    if reopened {
        emit(app);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Enqueue: bug
// ---------------------------------------------------------------------------

async fn enqueue_bug(app: &AppHandle, request: EnqueueBugRequest) -> Result<Value, String> {
    let state = shared(app)?;
    let config = agent_settings::config_for(app);
    let project = config
        .projects
        .get(request.workspace_id.trim())
        .cloned()
        .filter(|project| !project.repo_path.trim().is_empty())
        .ok_or_else(|| tr("dsh.task.repo.missing").to_string())?;

    let repo_hint = project.repo_path.clone();
    let repo_path = blocking(move || worktree::repo_root(&repo_hint))
        .await
        .map_err(|error| tr_args("dsh.task.git.failed", &[&error]))?;

    let detail =
        crate::commands::bugs::fetch_bug_detail(app, &request.workspace_id, &request.bug_id)
            .await?;
    let export =
        crate::export::export_detail(app, &state.paths, &request.workspace_id, None, &detail)
            .await
            .map_err(|error| tr_args("dsh.task.export.failed", &[&error]))?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let branch = config
        .worktree_enabled
        .then(|| worktree::branch_name("tapd", &request.bug_id, &session_id));
    let work_dir = prepare_work_dir(&state, &repo_path, &session_id, branch.clone()).await?;

    let title = text_or(&detail.summary.title, &request.bug_id);
    let severity = labelled(&detail.summary.severity_label, &detail.summary.severity);
    let priority = labelled(&detail.summary.priority_label, &detail.summary.priority);
    let workspace_name = text_or(&detail.workspace_name, &request.workspace_id);
    let created_at = now();
    let task = DshTask {
        id: session_id.clone(),
        kind: TaskKind::Bug,
        project: Some(TaskProject {
            id: request.workspace_id.clone(),
            name: workspace_name.clone(),
            kind: ProjectKind::Tapd,
        }),
        title: title.clone(),
        bug_id: Some(request.bug_id.clone()),
        workflow: Workflow::Running,
        status: SessionStatus::Idle,
        repo_path: repo_path.clone(),
        worktree_path: work_dir.worktree_path.clone(),
        branch: branch.clone(),
        json_path: export.bug_json.clone(),
        created_at: created_at.clone(),
        updated_at: created_at,
        message_count: 0,
        changes: None,
        review: None,
        merge: None,
    };
    let record = TaskRecord {
        task,
        meta: TaskMeta {
            workspace_id: Some(request.workspace_id.clone()),
            baseline: work_dir.baseline,
            worktree: config.worktree_enabled,
            export_dir: Some(export.dir),
            ..TaskMeta::default()
        },
    };

    let vars = PromptVars {
        task_id: session_id.clone(),
        title,
        json_path: export.bug_json,
        repo_path: work_dir.path,
        workspace_name,
        bug_id: request.bug_id,
        severity,
        priority,
        user_prompt: request.extra_prompt.unwrap_or_default(),
        attachments: request.attachments,
        coworker: coworker_section(app, &config),
    };
    let prompt = build_prompt(&config, vars, &project.rule, false);
    launch(app, record, prompt, None).await
}

// ---------------------------------------------------------------------------
// Enqueue: local work item
// ---------------------------------------------------------------------------

async fn enqueue_local(app: &AppHandle, request: EnqueueLocalRequest) -> Result<Value, String> {
    let state = shared(app)?;
    let store = state.local.clone();
    let item_id = request.item_id.clone();
    let (item, project) = blocking(move || store.item_with_project(&item_id)).await?;
    if item.project_id != request.project_id.trim() {
        return Err(tr("local.item.notfound").to_string());
    }

    let repo_hint = project.repo_path.clone();
    let repo_path = blocking(move || worktree::repo_root(&repo_hint))
        .await
        .map_err(|_| tr("dsh.task.local.repo").to_string())?;

    let config = agent_settings::config_for(app);
    let session_id = uuid::Uuid::new_v4().to_string();
    let branch = config
        .worktree_enabled
        .then(|| worktree::branch_name("local", &item.id, &session_id));
    let work_dir = prepare_work_dir(&state, &repo_path, &session_id, branch.clone()).await?;

    let document = crate::export::local::LocalExportDocument {
        id: item.id.clone(),
        title: item.title.clone(),
        description: item.description.clone(),
        project_id: project.id.clone(),
        project_name: project.name.clone(),
        repo_path: repo_path.clone(),
        project_rule: project.rule.clone(),
        created_at: item.created_at.clone(),
    };
    let paths = state.paths.clone();
    let json_path = blocking(move || {
        crate::export::local::run_local_export(&paths, &document)
            .map(|path| path.to_string_lossy().to_string())
    })
    .await?;

    let created_at = now();
    let task = DshTask {
        id: session_id.clone(),
        kind: TaskKind::LocalItem,
        project: Some(TaskProject {
            id: project.id.clone(),
            name: project.name.clone(),
            kind: ProjectKind::Local,
        }),
        title: item.title.clone(),
        bug_id: None,
        workflow: Workflow::Running,
        status: SessionStatus::Idle,
        repo_path: repo_path.clone(),
        worktree_path: work_dir.worktree_path.clone(),
        branch: branch.clone(),
        json_path: json_path.clone(),
        created_at: created_at.clone(),
        updated_at: created_at,
        message_count: 0,
        changes: None,
        review: None,
        merge: None,
    };
    let record = TaskRecord {
        task,
        meta: TaskMeta {
            baseline: work_dir.baseline,
            worktree: config.worktree_enabled,
            local_project_id: Some(project.id.clone()),
            local_item_id: Some(item.id.clone()),
            local_previous_status: Some(item.status.as_str().to_string()),
            export_dir: Some(
                std::path::Path::new(&json_path)
                    .parent()
                    .map(|parent| parent.to_string_lossy().to_string())
                    .unwrap_or_default(),
            ),
            ..TaskMeta::default()
        },
    };

    let vars = PromptVars {
        task_id: session_id,
        title: item.title,
        json_path,
        repo_path: work_dir.path,
        workspace_name: project.name.clone(),
        bug_id: String::new(),
        severity: String::new(),
        priority: String::new(),
        user_prompt: request.extra_prompt.unwrap_or_default(),
        attachments: request.attachments,
        coworker: coworker_section(app, &config),
    };
    let prompt = build_prompt(&config, vars, &project.rule, true);
    let link = LocalLink {
        item_id: item.id,
        previous_status: item.status,
    };
    launch(app, record, prompt, Some(link)).await
}

/// Where a task runs: an isolated worktree (with a baseline) or the project
/// repository itself.
struct WorkDir {
    path: String,
    baseline: Option<String>,
    worktree_path: Option<String>,
}

async fn prepare_work_dir(
    state: &SharedState,
    repo_path: &str,
    session_id: &str,
    branch: Option<String>,
) -> Result<WorkDir, String> {
    match branch {
        Some(branch) => {
            let repo = repo_path.to_string();
            let target = state.paths.worktrees_dir.join(session_id);
            let created = blocking(move || worktree::create(&repo, &target, &branch))
                .await
                .map_err(|error| tr_args("dsh.task.worktree.failed", &[&error]))?;
            Ok(WorkDir {
                path: created.path.clone(),
                baseline: Some(created.baseline),
                worktree_path: Some(created.path),
            })
        }
        None => {
            let repo = repo_path.to_string();
            let baseline = blocking(move || worktree::head(&repo))
                .await
                .map_err(|error| tr_args("dsh.task.git.failed", &[&error]))?;
            Ok(WorkDir {
                path: repo_path.to_string(),
                baseline,
                worktree_path: None,
            })
        }
    }
}

/// Item facts for rolling a local link back when the launch fails.
struct LocalLink {
    item_id: String,
    previous_status: WorkItemStatus,
}

/// Writes the row, links the local item, then starts the session. Any failure
/// removes the row and the worktree: the list must never show a half task.
async fn launch(
    app: &AppHandle,
    record: TaskRecord,
    prompt: String,
    local: Option<LocalLink>,
) -> Result<Value, String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = record.task.id.clone();
    let work_dir = record.work_dir();

    {
        let cache = cache.clone();
        let record = record.clone();
        blocking(move || task_store::insert(&cache, &record)).await?;
    }

    if let Some(link) = local.as_ref() {
        let store = state.local.clone();
        let item_id = link.item_id.clone();
        let task_id = id.clone();
        let at = now();
        if let Err(error) = blocking(move || store.attach_task(&item_id, &task_id, &at)).await {
            rollback(app, &record, local.as_ref()).await;
            return Err(error);
        }
    }

    if let Err(error) = start_session(app, &id, &work_dir, &prompt).await {
        rollback(app, &record, local.as_ref()).await;
        return Err(error);
    }

    emit(app);
    let mut task = record.task;
    overlay(&mut task, &live_sessions(app));
    Ok(json!({ "task": task }))
}

/// Best-effort cleanup. The row is authoritative, so its deletion goes first;
/// the worktree and the local link are secondary and only logged on failure.
async fn rollback(app: &AppHandle, record: &TaskRecord, local: Option<&LocalLink>) {
    let Ok(state) = shared(app) else {
        return;
    };
    let cache = state.cache.clone();
    let id = record.task.id.clone();
    if let Err(error) = blocking(move || task_store::delete(&cache, &id)).await {
        tracing::error!(%error, "failed to remove a rolled-back dsh task row");
    }
    if record.meta.worktree {
        if let Some(path) = record.task.worktree_path.clone() {
            let repo = record.task.repo_path.clone();
            if let Err(error) = blocking(move || worktree::remove(&repo, &path)).await {
                tracing::warn!(%error, "failed to remove the rolled-back worktree");
            }
        }
    }
    if let Some(link) = local {
        let store = state.local.clone();
        let item_id = link.item_id.clone();
        let task_id = record.task.id.clone();
        let at = now();
        // `attach_task` also moved the item to in_progress; a failed launch must
        // put it back exactly where the user had it. `forget_task` matches on
        // the stored task id, not the item id.
        let previous = link.previous_status.as_str().to_string();
        if let Err(error) = blocking(move || {
            store.forget_task(&task_id, &at)?;
            store
                .update_item(&item_id, None, None, Some(previous.as_str()))
                .map(|_| ())
        })
        .await
        {
            tracing::warn!(%error, "failed to roll back a local item link");
        }
    }
}

/// The session starting directory is assigned before the first prompt. The
/// runtime boots first: the bridge only accepts control frames once its plugin
/// has connected, and a cold start needs a moment for that socket.
async fn start_session(
    app: &AppHandle,
    session_id: &str,
    work_dir: &str,
    prompt: &str,
) -> Result<(), String> {
    let runtime = runtime(app)?;
    runtime.ensure_ready(app).await?;
    // Create the Agent and lock in the configured model before the first turn;
    // the worktree assignment below then moves its directory.
    runtime.prepare_session(app, session_id, true).await;
    assign_session_with_retry(app, session_id, work_dir).await?;
    runtime.query(app, session_id, prompt).await?;
    Ok(())
}

/// Waits briefly for the plugin connection instead of failing the enqueue on
/// the first frame. After the budget the error is surfaced: running in the
/// wrong directory is worse than not starting.
async fn assign_session_with_retry(
    app: &AppHandle,
    session_id: &str,
    work_dir: &str,
) -> Result<(), String> {
    let bridge = bridge(app)?;
    let mut last_error = None;
    for attempt in 0..30 {
        match bridge.assign_session(session_id, work_dir).await {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if attempt == 29 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err(last_error.unwrap_or_else(|| tr("dsh.bridge.unavailable").to_string()))
}

/// The roster belongs to the solo path. With team collaboration on, work is
/// assigned on the board and the prompt carries no coworker names at all.
fn coworker_section(app: &AppHandle, config: &AgentConfig) -> String {
    if config.team_enabled() {
        String::new()
    } else {
        coworker::prompt_section(app, &config.coworker_ids)
    }
}

fn build_prompt(config: &AgentConfig, vars: PromptVars, rule: &str, local: bool) -> String {
    let template = if local {
        tr(agent_settings::LOCAL_PROMPT_KEY)
    } else {
        config.prompt_template.as_str()
    };
    let mut prompt = agent_settings::render_prompt(template, &vars);
    let rule = rule.trim();
    if !rule.is_empty() {
        // The template contract has no `{{project_rule}}` slot (it was removed
        // with the external-tool flow), so project rules are appended.
        prompt.push_str(tr("dsh.task.prompt.rule"));
        prompt.push_str(rule);
    }
    prompt
}

// ---------------------------------------------------------------------------
// Approve / merge
// ---------------------------------------------------------------------------

async fn approve(app: &AppHandle, request: SessionRequest) -> Result<Value, String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = request.session_id.clone();
    let Some(record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Err(not_found(&request.session_id));
    };
    // Approving commits the tree, so it is only safe once the turn stopped:
    // a live turn would keep writing after the snapshot, and the merge path
    // would then discard those writes with the worktree. The persisted row
    // does not carry the live status (`overlay` computes it for output), so
    // the bridge registry is the authoritative source.
    let live_running = live_sessions(app)
        .get(&request.session_id)
        .is_some_and(|session| session.status == SessionStatus::Running);
    if live_running {
        return Err(tr("dsh.task.approve.busy").to_string());
    }
    if !matches!(
        record.task.workflow,
        Workflow::Running | Workflow::AwaitingReview
    ) {
        return Err(tr("dsh.task.state.invalid").to_string());
    }

    let work_dir = record.work_dir();
    let message = commit_message(&record.task);
    blocking(move || worktree::commit_all(&work_dir, &message))
        .await
        .map_err(|error| tr_args("dsh.task.commit.failed", &[&error]))?;

    // The commit can take a while; a `turn/end` may have moved the workflow in
    // the meantime, so the transition is applied to the fresh row.
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = request.session_id.clone();
    let Some(mut record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Err(not_found(&request.session_id));
    };
    // The comment reports the task's product, not whatever a stale turn end
    // recorded; the committed tree is the authoritative count.
    let workspace = workspace_for(&record);
    if let Ok(summary) = blocking(move || {
        workspace
            .summary()
            .map_err(|error| error.message().to_string())
    })
    .await
    {
        record.task.changes = Some(TaskChanges {
            files: summary.file_count,
            additions: summary.additions,
            deletions: summary.deletions,
        });
    }
    record.task.merge = None;
    let next = if record.meta.worktree {
        Workflow::AwaitingMerge
    } else {
        Workflow::Done
    };

    let writeback_error = if record.meta.worktree {
        None
    } else {
        // Without worktree isolation the change is already in the main
        // repository; the TAPD write-back is what remains.
        match writeback::write_back(
            app,
            &record.task,
            record.meta.workspace_id.as_deref().unwrap_or_default(),
            record.task.changes.as_ref(),
        )
        .await
        {
            Ok(()) => None,
            Err(error) => Some(error),
        }
    };

    let expected = match writeback_error {
        Some(error) => {
            // The task is already `awaiting_review` here; keeping the workflow
            // and surfacing the error is the retry contract. A transition to
            // the same state is not a legal move, and asking for one would
            // replace the real write-back error with "invalid state".
            record.task.merge = Some(TaskMerge {
                error,
                instructions: String::new(),
            });
            if record.task.workflow == Workflow::Running {
                transition(&mut record, Workflow::AwaitingReview)?
            } else {
                record.task.workflow
            }
        }
        None => {
            record.task.merge = None;
            transition(&mut record, next)?
        }
    };
    record.touch();

    let state = shared(app)?;
    let cache = state.cache.clone();
    let stored = record.clone();
    let changed = blocking(move || task_store::update_if(&cache, &stored, expected)).await?;
    if !changed {
        return Err(tr("dsh.task.state.invalid").to_string());
    }
    complete_local(app, &record).await;
    emit(app);
    Ok(task_value(app, record.task))
}

/// One merge at a time: two merges into the same repository would interleave
/// their index lock and conflict resolution.
static MERGE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn merge_lock() -> &'static tokio::sync::Mutex<()> {
    MERGE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

enum MergeAttempt {
    Merged {
        worktree_removed: bool,
        changes: Option<TaskChanges>,
    },
    Failed(String),
}

/// A worktree that still holds uncommitted work (or cannot be inspected) is
/// kept: `remove --force` would silently discard edits made after approval.
fn keep_worktree(path: &str) -> bool {
    std::path::Path::new(path).is_dir() && worktree::is_dirty(path).unwrap_or(true)
}

async fn merge(app: &AppHandle, request: SessionRequest) -> Result<Value, String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = request.session_id.clone();
    let Some(record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Err(not_found(&request.session_id));
    };
    if record.task.workflow != Workflow::AwaitingMerge {
        return Err(tr("dsh.task.state.invalid").to_string());
    }
    let Ok(_guard) = merge_lock().try_lock() else {
        return Err(tr("dsh.task.busy").to_string());
    };
    // `cancel` takes the same lock, but a transition can still win between the
    // first read and the lock; re-read so a canceled task is never merged.
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = request.session_id.clone();
    let Some(record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Err(not_found(&request.session_id));
    };
    if record.task.workflow != Workflow::AwaitingMerge {
        return Ok(task_value(app, record.task));
    }
    let Some(branch) = record
        .task
        .branch
        .clone()
        .filter(|branch| !branch.trim().is_empty())
    else {
        return Err(tr("dsh.task.state.invalid").to_string());
    };

    let repo = record.task.repo_path.clone();
    let merge_message = format!("Merge branch '{branch}'");
    let branch_for_merge = branch.clone();
    let baseline = record.meta.baseline.clone();
    let workspace = workspace_for(&record);
    let worktree_path = record.task.worktree_path.clone();
    let attempt = blocking(move || {
        if worktree::is_dirty(&repo)? {
            return Err(tr("dsh.task.merge.dirty").to_string());
        }
        // `merge --no-ff` exits 0 ("Already up to date") when the branch never
        // advanced, and the ancestor proof would then pass vacuously. A task
        // whose changes were reverted must not be declared merged.
        if let Some(baseline) = baseline.as_deref() {
            if worktree::branch_tip(&repo, &branch_for_merge)? == baseline {
                return Ok(MergeAttempt::Failed(
                    tr("dsh.task.merge.empty").to_string(),
                ));
            }
        }
        match worktree::merge_no_ff(&repo, &branch_for_merge, &merge_message) {
            Ok(()) => {}
            Err(error) => return Ok(MergeAttempt::Failed(error)),
        }
        if !worktree::is_ancestor(&repo, &branch_for_merge, "HEAD")? {
            return Ok(MergeAttempt::Failed(
                tr("dsh.task.merge.ancestor").to_string(),
            ));
        }
        let worktree_removed = match worktree_path {
            Some(path) => {
                if keep_worktree(&path) {
                    tracing::warn!(
                        worktree = %path,
                        "merged with uncommitted worktree changes; keeping the directory"
                    );
                    false
                } else {
                    match worktree::remove(&repo, &path) {
                        Ok(()) => true,
                        Err(error) => {
                            tracing::warn!(%error, "merged but failed to remove the worktree");
                            false
                        }
                    }
                }
            }
            None => false,
        };
        // The branch survives the worktree, so the summary still describes the
        // change for the TAPD comment.
        let changes = workspace.summary().ok().map(|summary| TaskChanges {
            files: summary.file_count,
            additions: summary.additions,
            deletions: summary.deletions,
        });
        Ok(MergeAttempt::Merged {
            worktree_removed,
            changes,
        })
    })
    .await
    .map_err(|error| tr_args("dsh.task.git.failed", &[&error]))?;

    let attempt = match attempt {
        MergeAttempt::Merged {
            worktree_removed,
            changes,
        } => Ok((worktree_removed, changes)),
        MergeAttempt::Failed(error) => Err(tr_args("dsh.task.merge.failed", &[&error])),
    };

    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = request.session_id.clone();
    let Some(mut record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Err(not_found(&request.session_id));
    };
    if record.task.workflow != Workflow::AwaitingMerge {
        // Defensive: `cancel` is serialized on the merge lock, so a canceled
        // task should not reach the physical merge; if something else moved
        // the row, leave it untouched and let the UI see the fresh value.
        emit(app);
        return Ok(task_value(app, record.task));
    }
    let expected = record.task.workflow;

    let outcome = match attempt {
        Ok((worktree_removed, changes)) => {
            if worktree_removed {
                record.task.worktree_path = None;
            }
            if let Some(changes) = changes.clone() {
                record.task.changes = Some(changes);
            }
            match writeback::write_back(
                app,
                &record.task,
                record.meta.workspace_id.as_deref().unwrap_or_default(),
                record.task.changes.as_ref(),
            )
            .await
            {
                Ok(()) => {
                    record.task.merge = None;
                    transition(&mut record, Workflow::Done)?
                }
                Err(error) => {
                    record.task.merge = Some(TaskMerge {
                        error,
                        instructions: merge_instructions(&branch),
                    });
                    expected
                }
            }
        }
        Err(error) => {
            record.task.merge = Some(TaskMerge {
                error,
                instructions: merge_instructions(&branch),
            });
            expected
        }
    };
    record.touch();

    let state = shared(app)?;
    let cache = state.cache.clone();
    let stored = record.clone();
    let changed = blocking(move || task_store::update_if(&cache, &stored, outcome)).await?;
    if !changed {
        return Err(tr("dsh.task.busy").to_string());
    }
    complete_local(app, &record).await;
    emit(app);
    Ok(task_value(app, record.task))
}

fn merge_instructions(branch: &str) -> String {
    tr_args("dsh.task.merge.instructions", &[&branch])
}

/// Deterministic commit subject; no model turn participates in approvals.
fn commit_message(task: &DshTask) -> String {
    let title: String = task
        .title
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let title: String = title.chars().take(120).collect();
    match task.bug_id.as_deref().filter(|id| !id.trim().is_empty()) {
        Some(bug_id) => format!("tapd({bug_id}): {title}"),
        None => format!(
            "local({}): {title}",
            task.project
                .as_ref()
                .map(|project| project.id.as_str())
                .unwrap_or("item")
        ),
    }
}

// ---------------------------------------------------------------------------
// Cancel / resume / diff
// ---------------------------------------------------------------------------

async fn cancel(app: &AppHandle, request: CancelRequest) -> Result<Value, String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = request.session_id.clone();
    let Some(record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Err(not_found(&request.session_id));
    };
    if record.task.workflow.is_terminal() {
        // Canceling a finished task is a no-op: terminal states never regress.
        return Ok(task_value(app, record.task));
    }

    // Merging and canceling must not interleave: the branch merge and its
    // write-back are one physical step, and a cancel landing mid-merge would
    // leave a canceled task already in main.
    let Ok(_guard) = merge_lock().try_lock() else {
        return Err(tr("dsh.task.cancel.busy").to_string());
    };

    if let Ok(bridge) = bridge(app) {
        if let Err(error) = bridge.cancel_session(&record.task.id).await {
            // A task restored from a previous app run has no live turn; the
            // cancel still has to persist.
            tracing::debug!(%error, session = %record.task.id, "no live turn to cancel");
        }
    }

    if request.stash {
        let work_dir = record.work_dir();
        if !work_dir.is_empty() {
            let id = record.task.id.clone();
            let message = format!("tapd task {id} canceled");
            blocking(move || worktree::stash_all(&work_dir, &message))
                .await
                .map_err(|error| tr_args("dsh.task.cancel.stash", &[&error]))?;
        }
    }

    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = request.session_id.clone();
    let Some(mut record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Err(not_found(&request.session_id));
    };
    let expected = transition(&mut record, Workflow::Canceled)?;
    record.task.merge = None;
    record.task.message_count = live_sessions(app)
        .get(&request.session_id)
        .map(|session| session.message_count as u32)
        .unwrap_or(record.task.message_count);
    record.touch();

    let state = shared(app)?;
    let cache = state.cache.clone();
    let stored = record.clone();
    let changed = blocking(move || task_store::update_if(&cache, &stored, expected)).await?;
    if !changed {
        return Err(tr("dsh.task.state.invalid").to_string());
    }
    // Canceling a local-item task used to leave the item stuck in in_progress
    // with a dangling agentTaskId: `attach_task` is the only thing that moves
    // it, and `complete_local` only runs for Done. Undo the link here.
    if record.task.kind == TaskKind::LocalItem {
        if let Some(item_id) = record.meta.local_item_id.clone() {
            let store = shared(app)?.local.clone();
            let task_id = record.task.id.clone();
            let previous = record
                .meta
                .local_previous_status
                .clone()
                .unwrap_or_else(|| WorkItemStatus::InProgress.as_str().to_string());
            let at = now();
            if let Err(error) = blocking(move || {
                store.forget_task(&task_id, &at)?;
                store
                    .update_item(&item_id, None, None, Some(previous.as_str()))
                    .map(|_| ())
            })
            .await
            {
                tracing::warn!(%error, "failed to revert the canceled item link");
            }
        }
    }
    emit(app);
    Ok(task_value(app, record.task))
}

async fn resume(app: &AppHandle, request: SessionRequest) -> Result<Value, String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = request.session_id.clone();
    let Some(record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Err(not_found(&request.session_id));
    };

    let runtime = runtime(app)?;
    runtime.ensure_ready(app).await?;
    // The shared helper also snapshots the session's model choice before the
    // SDK resume resets it to the runtime default.
    if let Err(error) = runtime.resume_session(app, &request.session_id).await {
        return Err(tr_args("dsh.task.resume.failed", &[&error]));
    }

    // Re-attaching a persisted session is not activity: bumping `updated_at`
    // here reordered the list every time a row was opened.
    let mut record = record;
    record.task.status = SessionStatus::Idle;
    let expected = record.task.workflow;
    let state = shared(app)?;
    let cache = state.cache.clone();
    let stored = record.clone();
    let changed = blocking(move || task_store::update_if(&cache, &stored, expected)).await?;
    if !changed {
        let state = shared(app)?;
        let cache = state.cache.clone();
        let id = request.session_id.clone();
        let Some(fresh) = blocking(move || task_store::load(&cache, &id)).await? else {
            return Err(not_found(&request.session_id));
        };
        return Ok(task_value(app, fresh.task));
    }
    emit(app);
    Ok(task_value(app, record.task))
}

async fn diff(app: &AppHandle, request: DiffRequest) -> Result<Value, String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = request.session_id.clone();
    let Some(record) = blocking(move || task_store::load(&cache, &id)).await? else {
        return Err(not_found(&request.session_id));
    };
    let workspace = workspace_for(&record);
    let file = request.file;
    let view = blocking(move || {
        workspace
            .diff(file.as_deref())
            .map_err(|error| error.message().to_string())
    })
    .await?;
    debug_assert!(view.text.chars().count() <= tapd_workspace::MAX_DIFF_CHARS);
    Ok(json!({ "diff": view.text, "truncated": view.truncated }))
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn shared(app: &AppHandle) -> Result<SharedState, String> {
    app.try_state::<SharedState>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| tr("dsh.state.unavailable").to_string())
}

fn bridge(app: &AppHandle) -> Result<std::sync::Arc<BridgeState>, String> {
    app.try_state::<std::sync::Arc<BridgeState>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| tr("dsh.bridge.unavailable").to_string())
}

fn runtime(app: &AppHandle) -> Result<std::sync::Arc<RuntimeState>, String> {
    app.try_state::<std::sync::Arc<RuntimeState>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| tr("dsh.state.unavailable").to_string())
}

async fn blocking<T: Send + 'static>(
    run: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(run)
        .await
        .map_err(|error| error.to_string())?
}

/// The live session registry, keyed by id. Tasks persisted from a previous app
/// run have no row here; they are shown as `idle`, not hidden.
fn live_sessions(app: &AppHandle) -> HashMap<String, DshSession> {
    app.try_state::<std::sync::Arc<BridgeState>>()
        .map(|state| {
            state
                .sessions()
                .into_iter()
                .map(|session| (session.id.clone(), session))
                .collect()
        })
        .unwrap_or_default()
}

fn overlay(task: &mut DshTask, live: &HashMap<String, DshSession>) {
    match live.get(&task.id) {
        Some(session) => {
            task.status = session.status;
            task.message_count = session.message_count.min(u32::MAX as u64) as u32;
            // The transcript knows when the session last actually moved. Rows
            // written by older builds carry a bumped time, so the list would
            // otherwise stay out of order until the task ran again.
            task.updated_at = session.updated_at.clone();
        }
        None => task.status = SessionStatus::Idle,
    }
}

/// One command response. Applies the same live overlay as the list so a
/// returned task is not a stale copy of what `dsh://tasks` is about to emit.
fn task_value(app: &AppHandle, mut task: DshTask) -> Value {
    overlay(&mut task, &live_sessions(app));
    json!({ "task": task })
}

/// Loads the list and emits it. Runs after the write's lock is released: an
/// event listener that calls back into `dsh_tasks` cannot deadlock.
fn emit(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match tasks_payload(&app).await {
            Ok(payload) => {
                let _ = app.emit(EVENT_TASKS, payload);
            }
            Err(error) => tracing::warn!(%error, "failed to emit the dsh task list"),
        }
    });
}

/// Marks a local work item done when its task is finished. Best effort: the
/// task state is already committed, and a store failure only leaves the item
/// in progress.
async fn complete_local(app: &AppHandle, record: &TaskRecord) {
    if record.task.workflow != Workflow::Done {
        return;
    }
    let (Some(project_id), Some(item_id)) = (
        record.meta.local_project_id.clone(),
        record.meta.local_item_id.clone(),
    ) else {
        return;
    };
    let Ok(state) = shared(app) else {
        return;
    };
    let store = state.local.clone();
    let task_id = record.task.id.clone();
    let logged_item = item_id.clone();
    let at = now();
    if let Err(error) = blocking(move || {
        store
            .complete_work_item(&project_id, &item_id, &task_id, &at)
            .map(|_| ())
    })
    .await
    {
        tracing::warn!(%error, item = %logged_item, "failed to complete the local work item");
    }
}

fn not_found(session_id: &str) -> String {
    tr_args("dsh.task.notFound", &[&session_id])
}

/// First non-empty label, then the raw key: TAPD's labels are what the prompt
/// should read, but a workspace without labels must still pass something.
fn labelled(label: &str, key: &str) -> String {
    let label = label.trim();
    if label.is_empty() {
        key.trim().to_string()
    } else {
        label.to_string()
    }
}

fn text_or(value: &str, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback.trim().to_string()
    } else {
        value.to_string()
    }
}

/// Fixed-width RFC3339 (millis, UTC) so lexicographic order is chronological.
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn record(workflow: Workflow) -> TaskRecord {
        TaskRecord {
            task: DshTask {
                id: "s1".to_string(),
                kind: TaskKind::Bug,
                project: None,
                title: "登录崩溃".to_string(),
                bug_id: Some("42".to_string()),
                workflow,
                status: SessionStatus::Idle,
                repo_path: "/repo".to_string(),
                worktree_path: None,
                branch: None,
                json_path: "/tmp/bug.json".to_string(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                updated_at: "2026-01-01T00:00:00.000Z".to_string(),
                message_count: 0,
                changes: None,
                review: None,
                merge: None,
            },
            meta: TaskMeta::default(),
        }
    }

    #[test]
    fn workflow_moves_forward_and_terminal_states_never_regress() {
        for (from, to) in [
            (Workflow::Running, Workflow::AwaitingReview),
            (Workflow::Running, Workflow::AwaitingMerge),
            (Workflow::Running, Workflow::Done),
            (Workflow::Running, Workflow::Canceled),
            (Workflow::AwaitingReview, Workflow::AwaitingMerge),
            (Workflow::AwaitingReview, Workflow::Done),
            (Workflow::AwaitingMerge, Workflow::Done),
            (Workflow::AwaitingMerge, Workflow::Canceled),
        ] {
            let mut record = record(from);
            assert_eq!(transition(&mut record, to).expect("allowed"), from);
            assert_eq!(record.task.workflow, to);
        }

        for state in [Workflow::Done, Workflow::Failed, Workflow::Canceled] {
            for next in [
                Workflow::Running,
                Workflow::AwaitingReview,
                Workflow::AwaitingMerge,
                Workflow::Done,
            ] {
                let mut record = record(state);
                assert!(
                    transition(&mut record, next).is_err(),
                    "{state:?} must not move to {next:?}"
                );
                assert_eq!(record.task.workflow, state);
            }
        }

        // Going backwards is not an allowed edge either.
        let mut back = record(Workflow::AwaitingMerge);
        assert!(transition(&mut back, Workflow::AwaitingReview).is_err());
        let mut reopen = record(Workflow::AwaitingReview);
        assert!(transition(&mut reopen, Workflow::Running).is_err());
    }

    #[test]
    fn only_input_reopens_a_settled_task() {
        // A new turn revives work that had settled either way; a canceled task
        // stays canceled, and a live one has nothing to reopen.
        assert_eq!(reopen_target(Workflow::Done), Some(Workflow::Running));
        assert_eq!(reopen_target(Workflow::Failed), Some(Workflow::Running));
        assert_eq!(reopen_target(Workflow::Canceled), None);
        assert_eq!(reopen_target(Workflow::Running), None);
        assert_eq!(reopen_target(Workflow::AwaitingReview), None);
    }

    #[test]
    fn a_failed_turn_is_not_a_finished_task() {
        // Reviewing the worktree after these reports "done" because the model
        // never ran; a user stop is settled by `cancel` instead.
        assert!(failed_turn(Some("error")));
        assert!(failed_turn(Some("blocked")));
        assert!(!failed_turn(Some("aborted")));
        assert!(!failed_turn(Some("completed")));
        assert!(!failed_turn(None));
    }

    #[test]
    fn commit_subject_names_the_task_and_stays_one_line() {
        let mut task = record(Workflow::AwaitingReview).task;
        task.title = "  fix   login\ncrash  ".to_string();
        assert_eq!(commit_message(&task), "tapd(42): fix login");
        task.title = "fix login crash".to_string();
        assert_eq!(commit_message(&task), "tapd(42): fix login crash");

        task.bug_id = None;
        task.project = Some(TaskProject {
            id: "lp_1".to_string(),
            name: "notes".to_string(),
            kind: ProjectKind::Local,
        });
        assert_eq!(commit_message(&task), "local(lp_1): fix login crash");
    }

    #[test]
    fn a_clean_tree_means_done_and_any_change_needs_review() {
        let clean = ChangeSummary::empty();
        assert_eq!(review_outcome(&clean), (Workflow::Done, None));

        let changed = ChangeSummary {
            files: Vec::new(),
            file_count: 2,
            additions: 30,
            deletions: 4,
            dirty: false,
            committed: true,
            commit: None,
        };
        assert_eq!(
            review_outcome(&changed),
            (
                Workflow::AwaitingReview,
                Some(TaskChanges {
                    files: 2,
                    additions: 30,
                    deletions: 4
                })
            )
        );
    }

    struct TempRepo {
        root: PathBuf,
    }

    impl TempRepo {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "tapd-dsh-tasks-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&root).expect("temp root");
            git(&root, &["init", "--quiet"]);
            git(&root, &["config", "user.name", "Test"]);
            git(&root, &["config", "user.email", "test@example.com"]);
            std::fs::write(root.join("README.md"), "hello\n").expect("seed");
            git(&root, &["add", "-A"]);
            git(&root, &["commit", "-m", "seed", "--quiet"]);
            Self { root }
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?}");
    }

    fn workspace(root: &Path, baseline: Option<String>) -> TaskWorkspace {
        TaskWorkspace::new(
            root.to_string_lossy(),
            root.to_string_lossy(),
            None,
            baseline,
            Vec::new(),
        )
    }

    #[test]
    fn review_reads_a_real_working_tree() {
        let repo = TempRepo::new("review");
        let before = workspace(&repo.root, None).summary().expect("head");
        let baseline = before.commit.expect("seed commit");

        // A clean tree is done...
        let clean = workspace(&repo.root, Some(baseline.clone()))
            .summary()
            .expect("clean");
        assert_eq!(review_outcome(&clean).0, Workflow::Done);

        // ...and an untracked file flips it to review.
        std::fs::write(repo.root.join("app.txt"), "one\ntwo\n").expect("write");
        let changed = workspace(&repo.root, Some(baseline))
            .summary()
            .expect("changed");
        assert_eq!(changed.file_count, 1);
        assert_eq!(changed.additions, 2);
        assert_eq!(review_outcome(&changed).0, Workflow::AwaitingReview);
    }

    #[test]
    fn diff_payload_reports_truncation() {
        let repo = TempRepo::new("diff");
        let baseline = workspace(&repo.root, None)
            .summary()
            .expect("head")
            .commit
            .expect("seed commit");
        // One line longer than the cap; a single-line diff cannot be split.
        let long: String = "x".repeat(tapd_workspace::MAX_DIFF_CHARS + 10);
        std::fs::write(repo.root.join("long.txt"), format!("{long}\n")).expect("write");
        git(&repo.root, &["add", "long.txt"]);
        let view = workspace(&repo.root, Some(baseline))
            .diff(None)
            .expect("diff");
        assert!(view.truncated, "the review diff must be cut at the cap");
        assert_eq!(view.text.chars().count(), tapd_workspace::MAX_DIFF_CHARS);
    }
}
