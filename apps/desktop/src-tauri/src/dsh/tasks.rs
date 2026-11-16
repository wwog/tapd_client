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
//! The bridge owns the turn signal; [`set_turn_observer`] is the startup hook
//! and [`on_turn_end`] / [`observe`] are the call from its publish path (see
//! the module report for the exact one-liner).

use std::collections::HashMap;
use std::sync::OnceLock;

use dsh_host::rpc;
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
    let tasks: Vec<DshTask> = records
        .into_iter()
        .map(|mut record| {
            overlay(&mut record.task, &live);
            record.task
        })
        .collect();
    Ok(json!({ "tasks": tasks }))
}

// ---------------------------------------------------------------------------
// Turn-end observation
// ---------------------------------------------------------------------------

/// Startup hook: loads the persisted list once so the first turn end does not
/// pay for opening the table, and logs whether the store is usable at all.
///
/// Wiring (owned by the bridge): call `tasks::set_turn_observer(&handle)` once
/// in `setup`, and `tasks::observe(app, session_id, &entry)` from
/// `BridgeState::publish_entry` for every emitted entry.
#[allow(dead_code)] // wired by bridge.rs (see the module report)
pub fn set_turn_observer(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match tasks_payload(&app).await {
            Ok(payload) => {
                let count = payload["tasks"].as_array().map(Vec::len).unwrap_or(0);
                tracing::info!(tasks = count, "dsh task store loaded");
            }
            Err(error) => tracing::warn!(%error, "dsh task store is unavailable"),
        }
    });
}

/// One committed entry from the bridge. Only `turn/end` matters here.
#[allow(dead_code)] // wired by bridge.rs (see the module report)
pub fn observe(app: &AppHandle, session_id: &str, entry: &DshEntry) {
    match entry {
        DshEntry::Turn {
            state: TurnState::End,
            ..
        } => on_turn_end(app, session_id),
        // A chat starts untitled; the first human line names it in the list.
        DshEntry::User { text, .. } => retitle_chat(app, session_id, text),
        _ => {}
    }
}

/// Names a chat task from its first user message. Tasks with a real title
/// (bug / local item) are never touched.
fn retitle_chat(app: &AppHandle, session_id: &str, text: &str) {
    let Some(title) = first_line(text) else {
        return;
    };
    let app = app.clone();
    let session_id = session_id.to_string();
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
            record.touch();
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

/// Schedules the review of a finished turn. Idempotent: a task that already
/// left `running` is ignored, so a replayed snapshot cannot restart the work.
#[allow(dead_code)] // wired by bridge.rs (see the module report)
pub fn on_turn_end(app: &AppHandle, session_id: &str) {
    let app = app.clone();
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = finish_turn(&app, &session_id).await {
            tracing::warn!(%error, session = session_id, "failed to review a finished dsh turn");
        }
    });
}

async fn finish_turn(app: &AppHandle, session_id: &str) -> Result<(), String> {
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
    // stays `running` and the UI renders chat rows without a chip.
    if record.task.kind == TaskKind::Chat {
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
    record.touch();

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
    tracing::warn!(session = session_id, %reason, "dsh task inspection failed");
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
        coworker: coworker::prompt_section(app, &config.coworker_ids),
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
        coworker: coworker::prompt_section(app, &config.coworker_ids),
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
    assign_session_with_retry(app, session_id, work_dir).await?;
    runtime.query(session_id, prompt).await?;
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
            // Keep `awaiting_review` (with the error) so approving again can
            // retry only the failed write-back.
            record.task.merge = Some(TaskMerge {
                error,
                instructions: String::new(),
            });
            transition(&mut record, Workflow::AwaitingReview)?
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
    let workspace = workspace_for(&record);
    let worktree_path = record.task.worktree_path.clone();
    let attempt = blocking(move || {
        if worktree::is_dirty(&repo)? {
            return Err(tr("dsh.task.merge.dirty").to_string());
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
            Some(path) => match worktree::remove(&repo, &path) {
                Ok(()) => true,
                Err(error) => {
                    tracing::warn!(%error, "merged but failed to remove the worktree");
                    false
                }
            },
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
        // A cancel won the race; the branch is merged physically, but the
        // task must not be written back to TAPD behind the user's back.
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
    match runtime
        .call(
            rpc::METHOD_SESSION_RESUME,
            json!({ "sessionId": request.session_id }),
        )
        .await
    {
        // The SDK reports an already-open session as an error; for a resume
        // that is exactly the state we wanted.
        Ok(_) => {}
        Err(error) if error.contains("already open") => {}
        Err(error) => return Err(tr_args("dsh.task.resume.failed", &[&error])),
    }

    let mut record = record;
    record.task.status = SessionStatus::Idle;
    record.touch();
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
