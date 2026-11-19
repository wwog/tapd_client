//! Task workflow over dsh sessions (docs/AGENT_TASK_FLOW.md).
//!
//! `command` is the feature surface both windows and the paired phone use; the
//! unified task list, the worktree, the review gate and the host-driven finish
//! all live behind it.
//!
//! One list holds every task. `workflow` is the only state machine:
//!
//! ```text
//! queued ──slot──▶ running ──task_submit / turn end, no changes──▶ done
//!                    │  └──task_submit / turn end, changes──▶ awaiting_review
//!                    │                                        │ approve
//!                    │                                        ▼
//!                    │                     finalizing (commit → merge → cleanup
//!                    │                                     → writeback) ──▶ done
//!                    └──cancel / failure──▶ canceled / failed
//! ```
//!
//! Terminal states never move. Every write is a compare-and-swap on the stored
//! `workflow`, so a late `turn/end`, a cancel pressed during a merge, or two
//! buttons at once cannot rewrite a newer state.
//!
//! All bug / local tasks run in an isolated worktree. Enqueue prepares the
//! export, the worktree and the prompt, then parks the task in `Queued`; the
//! scheduler starts it when a slot frees up. Free conversations never join the
//! queue.
//!
//! Persistence is [`super::task_store`] (the `dsh_tasks` table). There is no
//! in-memory registry: the DB row is the one source, which makes a restart
//! behave exactly like the live path.
//!
//! The bridge owns the turn signal: [`observe`] is called from its publish path
//! for every committed entry, and the plugin's `host` frames reach [`host_rpc`].

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;

use dsh_host::transcript::{DshEntry, DshSession, SessionStatus, TurnState};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use tapd_i18n::{tr, tr_args};
use tapd_local::WorkItemStatus;
use tapd_workspace::{ChangeKind, ChangeSummary, TaskWorkspace};
use tauri::{AppHandle, Emitter, Manager};

use super::bridge::BridgeState;
use super::runtime::RuntimeState;
use crate::agent_settings::{self, AgentConfig, PromptVars};
use crate::coworker;
use crate::state::SharedState;

// The three collaborators live next to this file but are private to the task
// module: nothing outside `dsh::tasks` may write a task row, run task git
// plumbing or build write-back text. `#[path]` expresses that privacy instead
// of widening the crate surface.
#[path = "task_store.rs"]
mod task_store;
#[path = "worktree.rs"]
mod worktree;
#[path = "writeback.rs"]
mod writeback;

/// Emitted whenever the task list changes. Payload: `{ tasks: DshTask[] }`.
pub const EVENT_TASKS: &str = "dsh://tasks";

// ---------------------------------------------------------------------------
// Model (docs/AGENT_TASK_FLOW.md §12.1)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    /// A free conversation: no workflow, no project task, no review.
    Chat,
    Bug,
    LocalItem,
}

impl TaskKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Bug => "bug",
            Self::LocalItem => "local_item",
        }
    }

    fn is_task(self) -> bool {
        self != Self::Chat
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectKind {
    Tapd,
    Local,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Workflow {
    /// Waiting for an execution slot.
    Queued,
    /// The model is changing code.
    Running,
    /// Changes exist and the user has to approve them.
    AwaitingReview,
    /// Commit → merge → cleanup → TAPD write-back.
    Finalizing,
    Done,
    Failed,
    Canceled,
}

impl Workflow {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::AwaitingReview => "awaiting_review",
            Self::Finalizing => "finalizing",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "awaiting_review" => Some(Self::AwaitingReview),
            "finalizing" => Some(Self::Finalizing),
            "done" => Some(Self::Done),
            "failed" => Some(Self::Failed),
            "canceled" => Some(Self::Canceled),
            _ => None,
        }
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Canceled)
    }
}

impl Serialize for Workflow {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Workflow {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).ok_or_else(|| {
            serde::de::Error::custom(format!("unknown task workflow: {raw}"))
        })
    }
}

/// One step of the finishing chain. `step` on [`TaskFinalize`] is where a
/// failure stopped; retrying starts from exactly there.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinalizeStep {
    Commit,
    Merge,
    Cleanup,
    Writeback,
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

/// What the model wrote with `task_submit`; the review screen renders it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReview {
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risks: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
}

/// Host-side finishing progress. Replaces the old `merge` object.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskFinalize {
    pub step: Option<FinalizeStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

/// The three revisions a finished round reports. `start` is the round's own
/// baseline (`meta.start`), not necessarily the task's first worktree.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge: Option<String>,
}

/// What the finishing chain wrote back to TAPD, for the done card.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWriteback {
    pub comment: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_to: Option<String>,
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
    #[serde(default)]
    pub review: Option<TaskReview>,
    #[serde(default)]
    pub finalize: Option<TaskFinalize>,
}

/// Internal facts the contract does not expose. They travel in the same JSON
/// payload (bare rows stay readable) and never reach `dsh_tasks`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct TaskMeta {
    pub workspace_id: Option<String>,
    /// Commit the task started from; the diff baseline. A continued round
    /// moves this to the previous round's commit so the review only shows the
    /// new work.
    pub baseline: Option<String>,
    /// The round's own starting revision, for display. Kept across baseline
    /// moves; old rows fall back to `baseline`.
    pub start: Option<String>,
    /// Whether the session works in an isolated worktree (chats toggle this;
    /// workflow tasks always set it at enqueue).
    pub worktree: bool,
    /// This round works directly in the repository: the finished task's
    /// worktree was removed, so continuing runs in the main checkout and the
    /// finishing chain skips the merge step.
    pub direct: bool,
    /// Team collaboration chosen when the task was created. `None` keeps the
    /// runtime default; a task's choice is fixed for its whole life.
    pub team: Option<bool>,
    pub local_project_id: Option<String>,
    pub local_item_id: Option<String>,
    /// Status the item had before `attach_task` moved it to in_progress; a
    /// canceled or failed launch puts it back here.
    pub local_previous_status: Option<String>,
    /// Prompt waiting for an execution slot. Cleared once the session starts.
    pub pending_prompt: Option<String>,
    /// Commit the finishing chain created in the worktree.
    pub commit: Option<String>,
    /// Merge commit the finishing chain created in the main repository.
    pub merge: Option<String>,
    /// The branch was already merged; a retry does not merge it twice.
    pub merged: bool,
    /// The write-back comment was posted, so `tapd_add_comment` is idempotent.
    pub comment_posted: bool,
    /// The status transition already ran.
    pub status_updated: bool,
    /// Hidden write-back turns the host has sent for this task. After
    /// [`HOST_WRITEBACK_ATTEMPTS`] the host finishes the missing writes itself.
    pub writeback_attempts: u32,
    pub status_from: Option<String>,
    pub status_to: Option<String>,
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

    /// The directory the session and the review operate on. A finished task
    /// whose worktree was removed falls back to the repository.
    fn work_dir(&self) -> String {
        match self
            .task
            .worktree_path
            .clone()
            .filter(|path| !path.trim().is_empty())
        {
            Some(path) => path,
            None => self.task.repo_path.clone(),
        }
    }

    /// Whether this round runs directly in the repository: a workflow task
    /// whose worktree was already merged and removed.
    fn works_direct(&self) -> bool {
        self.meta.worktree
            && !self
                .task
                .worktree_path
                .as_deref()
                .is_some_and(|path| !path.trim().is_empty() && std::path::Path::new(path).is_dir())
    }
}

fn workspace_for(record: &TaskRecord) -> TaskWorkspace {
    // A direct round lives in the repository itself: its baseline is the HEAD
    // captured at reopen, so the working tree is the right diff target.
    // After the finishing chain removes a clean worktree, the branch is the
    // precise target: the repository's live tree may since have gained commits
    // that have nothing to do with this task.
    let cleaned = record.meta.worktree && record.task.worktree_path.is_none();
    let work_dir = if record.meta.direct {
        record.task.repo_path.clone()
    } else if cleaned {
        String::new()
    } else {
        record.work_dir()
    };
    TaskWorkspace::new(
        record.task.repo_path.clone(),
        work_dir,
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
        Queued => matches!(to, Running | Canceled | Failed),
        Running => matches!(to, AwaitingReview | Done | Canceled | Failed),
        AwaitingReview => matches!(to, Finalizing | Canceled),
        Finalizing => matches!(to, Done),
        Done | Failed | Canceled => false,
    }
}

/// A finished or failed task that receives a new user turn is active again.
///
/// This is deliberately *not* an edge in [`can_move`]: a log replay or a late
/// event must never reopen a task. Only a path that accepted fresh input calls
/// it, so "已完成" stops being true exactly when the user asks for more work.
///
/// `AwaitingReview` is included per the contract: sending another message is
/// the "继续修改" path, and the pending review is cleared with it.
fn reopen_target(workflow: Workflow) -> Option<Workflow> {
    matches!(
        workflow,
        Workflow::Done | Workflow::Failed | Workflow::AwaitingReview
    )
    .then_some(Workflow::Running)
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

fn change_counts(summary: &ChangeSummary) -> TaskChanges {
    TaskChanges {
        files: summary.file_count,
        additions: summary.additions,
        deletions: summary.deletions,
    }
}

// ---------------------------------------------------------------------------
// Phase (docs/AGENT_TASK_FLOW.md §4.1)
// ---------------------------------------------------------------------------

/// The one phase a root session can be in. Sent to the plugin as a string so
/// the plugin map stays a plain data structure.
fn phase_of(record: &TaskRecord) -> &'static str {
    if record.task.kind == TaskKind::Chat {
        return "chat";
    }
    match record.task.workflow {
        Workflow::Running => "execute",
        Workflow::AwaitingReview => "review",
        Workflow::Finalizing => {
            let step = record.task.finalize.as_ref().and_then(|finalize| finalize.step);
            if step == Some(FinalizeStep::Writeback) {
                "writeback"
            } else {
                "none"
            }
        }
        _ => "none",
    }
}

fn phase_row(record: &TaskRecord) -> Value {
    json!({
        "sessionId": record.task.id,
        "phase": phase_of(record),
        "kind": record.task.kind.as_str(),
    })
}

/// Pushes the full phase map. Sent after `hello` (and on every list change) so
/// a reconnected plugin cannot keep a stale map.
pub async fn publish_phases(app: &AppHandle) {
    let Ok(state) = shared(app) else {
        return;
    };
    let cache = state.cache.clone();
    let Ok(records) = blocking(move || task_store::load_all(&cache)).await else {
        return;
    };
    let phases: Vec<Value> = records.iter().map(phase_row).collect();
    if let Ok(bridge) = bridge(app) {
        if let Err(error) = bridge.send_task_phases(Value::Array(phases)) {
            tracing::debug!(%error, "task phases were not pushed");
        }
    }
}

/// One session's phase, queued ahead of a host reply so the plugin's `when`
/// predicates are already correct when the model continues.
fn push_phase(app: &AppHandle, record: &TaskRecord) {
    if let Ok(bridge) = bridge(app) {
        let _ = bridge.send_task_phase(&record.task.id, phase_of(record), record.task.kind.as_str());
    }
}

/// Awaits the plugin's ack for the session's current phase.
///
/// The phase frame and the SDK prompt travel on different channels, so a
/// fire-and-forget update can lose the race against the first model step: the
/// model would then see the previous phase's tool set and prompt section (or
/// none at all). Every path that is about to send a real turn calls this
/// first. A missing task row (a draft chat) has no phase; the plugin's map is
/// already keyed by session id, so the call is cheap and idempotent.
pub async fn sync_phase(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let Some(record) = load_record(app, session_id).await? else {
        return Ok(());
    };
    // Chats have no task tools or prompt section, so their phase never has to
    // be awaited before the first turn (a cold plugin socket would only add
    // latency). A snapshot still publishes `chat` for the plugin's mirror.
    if record.task.kind == TaskKind::Chat {
        return Ok(());
    }
    let Ok(bridge) = bridge(app) else {
        return Ok(());
    };
    // Best effort: a cold plugin socket must not block the user's turn. The
    // next snapshot corrects the map, and the server-side phase checks still
    // protect every TAPD write. The write-back path awaits its ack separately.
    if let Err(error) = bridge
        .request_task_phase(session_id, phase_of(&record), record.task.kind.as_str())
        .await
    {
        tracing::debug!(%error, session = session_id, "phase ack was not received");
    }
    Ok(())
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
        "dsh_task_retry_finalize" => retry_finalize(app, parse(payload, name)?).await,
        "dsh_task_cancel" => cancel(app, parse(payload, name)?).await,
        "dsh_task_changes" => changes(app, parse(payload, name)?).await,
        "dsh_task_diff" => diff(app, parse(payload, name)?).await,
        "dsh_task_resume" => resume(app, parse(payload, name)?).await,
        "dsh_task_delete" => delete_session(app, parse(payload, name)?).await,
        // `dsh_task_merge` is gone: the finishing chain owns the merge and the
        // write-back now. Old callers get the localized invalid-state error.
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
    /// Team collaboration for this task; `None` keeps the runtime default.
    #[serde(default)]
    team: Option<bool>,
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
    /// Team collaboration for this task; `None` keeps the runtime default.
    #[serde(default)]
    team: Option<bool>,
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

/// One project a free conversation can be created under.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRef {
    pub kind: ProjectKind,
    pub id: String,
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
    // Overlaid times can differ from the stored column, so sort after the
    // overlay: newest activity first, which is also the order the UI paints.
    let mut tasks: Vec<(String, Value)> = records
        .into_iter()
        .map(|record| {
            let mut task = record.task.clone();
            overlay(&mut task, &live);
            let updated = task.updated_at.clone();
            (updated, json!(task_view(&record, &task)))
        })
        .collect();
    tasks.sort_by(|left, right| right.0.cmp(&left.0));
    Ok(json!({
        "tasks": tasks.into_iter().map(|(_, task)| task).collect::<Vec<_>>(),
    }))
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

/// The persisted kind of a session, when it has a task row at all. Draft ids
/// the UI knows but the store does not return `None`.
pub async fn kind_of(app: &AppHandle, session_id: &str) -> Option<TaskKind> {
    let record = load_record(app, session_id).await.ok()??;
    Some(record.task.kind)
}

/// Schedules the review of a finished turn. Idempotent: a task that already
/// left `running` only has its change counts refreshed.
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
        if let Err(problem) =
            finish_turn(&app, &session_id, &at, reason.as_deref(), error.as_deref()).await
        {
            tracing::warn!(%problem, session = session_id, "failed to settle a finished dsh turn");
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
    let Some(record) = load_record(app, session_id).await? else {
        return Ok(());
    };
    match record.task.workflow {
        Workflow::Running => {}
        // Already reviewed: a second turn end only refreshes the counts. The
        // turn that just ended is what frees the slot, so the queue is asked
        // for a start here.
        Workflow::AwaitingReview => {
            refresh_review(app, record, session_id, at).await?;
            reschedule(app);
            return Ok(());
        }
        // The write-back turn ended: finish only when both writes happened.
        Workflow::Finalizing => {
            settle_writeback(app, record, at).await?;
            reschedule(app);
            return Ok(());
        }
        // A settled task receiving a late turn end holds no slot; the scheduler
        // may still have been waiting on the session's live status.
        Workflow::Done | Workflow::Failed | Workflow::Canceled => {
            reschedule(app);
            return Ok(());
        }
        Workflow::Queued => return Ok(()),
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
        if save_record(app, record, expected).await? {
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
    // "done" precisely because the model never ran. A failed turn that *did*
    // change files still needs the review it earned.
    if failed_turn(reason) && summary.file_count == 0 {
        fail_task(app, session_id, error.unwrap_or("turn failed")).await;
        return Ok(());
    }

    let Some(mut record) = load_record(app, session_id).await? else {
        return Ok(());
    };
    if record.task.workflow != Workflow::Running {
        // A cancel (or an earlier turn end) won while the diff was computed.
        return Ok(());
    }
    let (next, changes) = review_outcome(&summary);
    let expected = transition(&mut record, next)?;
    record.task.changes = changes;
    record.task.finalize = None;
    record.task.message_count = live_sessions(app)
        .get(session_id)
        .map(|session| session.message_count as u32)
        .unwrap_or(record.task.message_count);
    record.touch_at(at);

    if !save_record(app, record.clone(), expected).await? {
        return Ok(());
    }
    complete_local(app, &record).await;
    push_phase(app, &record);
    emit(app);
    if next == Workflow::AwaitingReview {
        crate::notification::review::raise(&record.task);
    }
    // A turn leaving `running` frees its execution slot.
    reschedule(app);
    Ok(())
}

/// Refreshes the change counts of a task already waiting for review. The
/// workflow is not touched: the user is still looking at the same review.
async fn refresh_review(
    app: &AppHandle,
    record: TaskRecord,
    session_id: &str,
    at: &str,
) -> Result<(), String> {
    let workspace = workspace_for(&record);
    let Ok(summary) = blocking(move || {
        workspace
            .summary()
            .map_err(|error| error.message().to_string())
    })
    .await
    else {
        return Ok(());
    };
    let mut record = record;
    if summary.file_count > 0 {
        record.task.changes = Some(change_counts(&summary));
    }
    record.task.message_count = live_sessions(app)
        .get(session_id)
        .map(|session| session.message_count as u32)
        .unwrap_or(record.task.message_count);
    record.touch_at(at);
    let expected = record.task.workflow;
    if save_record(app, record.clone(), expected).await? {
        emit(app);
        crate::notification::review::raise(&record.task);
    }
    Ok(())
}

/// Startup recovery for a write-back that lost its live turn (app exit, runtime
/// restart, or a host prompt queued before the Agent existed). The git steps are
/// already done, so the safe move is the host write-back rather than leaving the
/// task in `finalizing` forever.
pub async fn recover_finalizing(app: &AppHandle) {
    let Ok(state) = shared(app) else {
        return;
    };
    let cache = state.cache.clone();
    let Ok(records) = blocking(move || task_store::load_all(&cache)).await else {
        return;
    };
    for record in records {
        if record.task.workflow != Workflow::Finalizing
            || record
                .task
                .finalize
                .as_ref()
                .and_then(|finalize| finalize.step)
                != Some(FinalizeStep::Writeback)
            || (record.meta.comment_posted && record.meta.status_updated)
            || live_running(app, &record.task.id)
        {
            continue;
        }
        let mut record = record;
        record.meta.writeback_attempts = HOST_WRITEBACK_ATTEMPTS;
        record.touch();
        if save_record(app, record.clone(), Workflow::Finalizing)
            .await
            .unwrap_or(false)
        {
            let _ = settle_writeback(app, record, &now()).await;
        }
    }
}

/// Hidden write-back turns the host gives the model before it takes over.
/// The first prompt is attempt 1; the retry after the first incomplete turn is
/// attempt 2, and when *that* turn also ends incomplete the host writes TAPD
/// itself so a finished task cannot sit in `finalizing` forever.
const HOST_WRITEBACK_ATTEMPTS: u32 = 2;

/// What the write-back still owes TAPD. Read from the persisted flags, so a
/// retry only repeats the missing half.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WritebackGaps {
    comment: bool,
    status: bool,
}

impl WritebackGaps {
    fn is_empty(self) -> bool {
        !self.comment && !self.status
    }
}

fn writeback_gaps(meta: &TaskMeta) -> WritebackGaps {
    WritebackGaps {
        comment: !meta.comment_posted,
        status: !meta.status_updated,
    }
}

/// Counts one more hidden turn. Saturating: the number only grows and never
/// needs to hold anything beyond "the model had its attempts".
fn next_writeback_attempt(attempts: u32) -> u32 {
    attempts.saturating_add(1)
}

/// Whether the model has used its write-back turns and the host must finish.
fn host_writeback_due(attempts: u32) -> bool {
    attempts >= HOST_WRITEBACK_ATTEMPTS
}

/// The write-back turn ended. `task_complete` occasionally loses the race with
/// the turn end (the model calls it as its last step), so both are accepted.
async fn settle_writeback(app: &AppHandle, record: TaskRecord, at: &str) -> Result<(), String> {
    let step = record
        .task
        .finalize
        .as_ref()
        .and_then(|finalize| finalize.step);
    if step != Some(FinalizeStep::Writeback) {
        return Ok(());
    }
    let gaps = writeback_gaps(&record.meta);
    if gaps.is_empty() {
        return finish_writeback(app, record, at, None).await;
    }
    // The host only takes over when the model is out of turns. Until then the
    // task stays retryable and the model gets its next hidden turn.
    if host_writeback_due(record.meta.writeback_attempts) {
        return host_writeback(app, record, at).await;
    }
    incomplete_writeback(
        app,
        record,
        at,
        tr("dsh.task.finalize.incomplete").to_string(),
    )
    .await
}

/// Both writes are in: the task is done. The notice (when the host wrote the
/// missing half) survives on the row so the done screen can explain it.
async fn finish_writeback(
    app: &AppHandle,
    mut record: TaskRecord,
    at: &str,
    notice: Option<String>,
) -> Result<(), String> {
    let expected = transition(&mut record, Workflow::Done)?;
    record.task.finalize = notice.map(|notice| TaskFinalize {
        step: Some(FinalizeStep::Writeback),
        notice: Some(notice),
        ..TaskFinalize::default()
    });
    record.touch_at(at);
    if save_record(app, record.clone(), expected).await? {
        complete_local(app, &record).await;
        emit(app);
        if let Ok(bridge) = bridge(app) {
            let _ = bridge.send_task_phase(&record.task.id, "none", record.task.kind.as_str());
        }
    }
    Ok(())
}

/// Keeps the task in `finalizing` with the reason the write-back is unfinished.
/// Every flag written so far stays persisted, so a retry resumes mid-way.
async fn incomplete_writeback(
    app: &AppHandle,
    mut record: TaskRecord,
    at: &str,
    error: String,
) -> Result<(), String> {
    {
        let finalize = record.task.finalize.get_or_insert_with(TaskFinalize::default);
        finalize.step = Some(FinalizeStep::Writeback);
        finalize.error = Some(error);
        finalize.instructions = Some(tr("dsh.task.finalize.instructions.writeback").to_string());
    }
    record.touch_at(at);
    let expected = record.task.workflow;
    if save_record(app, record, expected).await? {
        emit(app);
    }
    Ok(())
}

/// Deterministic host write-back. Runs only after the model's hidden turns ran
/// out, and only for the parts still missing: `tapd_comment` / `tapd_status`
/// set the same flags, so a half-finished write-back is never repeated.
async fn host_writeback(app: &AppHandle, record: TaskRecord, at: &str) -> Result<(), String> {
    // The same lock the tools take: a call still in flight must finish (and
    // persist its flag) before the host decides what is missing.
    let _guard = writeback_lock().lock().await;
    let Some(mut record) = load_record(app, &record.task.id).await? else {
        return Ok(());
    };
    // Re-read under the lock: a cancel, a retry or `task_complete` may have
    // settled the row while the turn was ending.
    if record.task.workflow != Workflow::Finalizing {
        return Ok(());
    }
    let (workspace, bug) = match writeback_bug(&record) {
        Ok(pair) => pair,
        Err(error) => return incomplete_writeback(app, record, at, error).await,
    };
    let bug = resolved_bug_id(app, &workspace, &bug).await;

    let gaps = writeback_gaps(&record.meta);
    if gaps.comment {
        let comment = host_comment(&record);
        if let Err(error) = crate::bug_write::add_comment(app, &workspace, &bug, &comment).await {
            let failure = tr_args("dsh.task.writeback.failed", &[&error]);
            return incomplete_writeback(app, record, at, failure).await;
        }
        record.meta.comment_posted = true;
        record.touch_at(at);
        // Persisted right away: a crash before the status step must not post
        // the comment twice.
        if !save_record(app, record.clone(), Workflow::Finalizing).await? {
            return Err(tr("dsh.task.busy").to_string());
        }
    }

    if gaps.status {
        // Same helper as the tool and the bug panel: a `new` bug is accepted
        // first, and an illegal target surfaces TAPD's own list as the error.
        let outcome = match crate::bug_write::perform_transition(
            app,
            &workspace,
            &bug,
            "resolved",
            &Value::Null,
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                let failure = tr_args("dsh.task.writeback.failed", &[&error]);
                return incomplete_writeback(app, record, at, failure).await;
            }
        };
        record.meta.status_updated = true;
        record.meta.status_from = Some(outcome.original_status);
        record.meta.status_to = Some(outcome.status);
        record.touch_at(at);
        if !save_record(app, record.clone(), Workflow::Finalizing).await? {
            return Err(tr("dsh.task.busy").to_string());
        }
    }

    finish_writeback(
        app,
        record,
        at,
        Some(tr("dsh.task.writeback.hostNotice").to_string()),
    )
    .await
}

/// The comment the host posts when the model never wrote one. The facts come
/// from the task row (review summary, branch, commit, change counts), so the
/// text matches what the model was told.
fn host_comment(record: &TaskRecord) -> String {
    let review = record.task.review.as_ref();
    let summary = review
        .map(|review| review.summary.trim())
        .filter(|summary| !summary.is_empty())
        .unwrap_or_else(|| record.task.title.trim());
    let verification = review
        .and_then(|review| review.verification.as_deref())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("-");
    let risks = review
        .and_then(|review| review.risks.as_deref())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("-");
    let branch = text_or(record.task.branch.as_deref().unwrap_or_default(), "-");
    let commit = text_or(record.meta.commit.as_deref().unwrap_or_default(), "-");
    let changes = record.task.changes.clone().unwrap_or_default();
    tr_args(
        "dsh.task.writeback.hostComment",
        &[
            &summary,
            &verification,
            &risks,
            &branch,
            &commit,
            &changes.files.to_string(),
            &changes.additions.to_string(),
            &changes.deletions.to_string(),
            &bug_page_link(&record.task),
        ],
    )
}

/// The bug page, matching the link the write-back prompt hands the model.
fn bug_page_link(task: &DshTask) -> String {
    let workspace = task
        .project
        .as_ref()
        .map(|project| project.id.trim())
        .filter(|id| !id.is_empty());
    let bug = task
        .bug_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    match (workspace, bug) {
        (Some(workspace), Some(bug)) => {
            format!("https://www.tapd.cn/{workspace}/bugtrace/bugs/view?bug_id={bug}")
        }
        _ => "-".to_string(),
    }
}

async fn fail_task(app: &AppHandle, session_id: &str, reason: &str) {
    tracing::warn!(session = session_id, %reason, "dsh task failed");
    let Ok(Some(mut record)) = load_record(app, session_id).await else {
        return;
    };
    let Ok(expected) = transition(&mut record, Workflow::Failed) else {
        return;
    };
    record.touch();
    if let Ok(true) = save_record(app, record, expected).await {
        emit(app);
        reschedule(app);
    }
}

/// Reopens a finished or failed task for the turn about to start.
///
/// Called only from paths that just accepted new input (a prompt, a retry).
/// Log replay and late events never reach it, so a restored session cannot
/// resurrect a task it already settled.
pub async fn reopen_for_input(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let Some(mut record) = load_record(app, session_id).await? else {
        return Ok(());
    };
    let Some(next) = reopen_target(record.task.workflow) else {
        return Ok(());
    };
    let expected = record.task.workflow;
    let left_review = expected == Workflow::AwaitingReview;
    record.task.workflow = next;

    // A task whose worktree was merged and removed continues in the main
    // checkout. The round starts at the repository's current HEAD, commits
    // directly there, and has no merge step.
    let direct = record.works_direct();
    let repo = record.task.repo_path.trim().to_string();
    let (head, branch) = if direct {
        let head = if repo.is_empty() {
            None
        } else {
            let repo_hint = repo.clone();
            blocking(move || worktree::head(&repo_hint))
                .await
                .ok()
                .flatten()
        };
        let branch = if repo.is_empty() {
            None
        } else {
            let repo_hint = repo.clone();
            blocking(move || worktree::current_branch(&repo_hint))
                .await
                .ok()
                .flatten()
        };
        (head, branch)
    } else {
        (None, None)
    };
    start_round(&mut record, direct, head, branch);

    let saved = save_record(app, record, expected).await?;
    if saved {
        emit(app);
        if left_review {
            crate::notification::review::settle(session_id);
        }
    }
    Ok(())
}

/// Opens a new round on the task row: picks its starting revision, clears the
/// previous round's result flags, and appends the `reopened` entry.
///
/// Kept synchronous and separate from [`reopen_for_input`]'s git lookups so the
/// revision rules are unit tested.
fn start_round(
    record: &mut TaskRecord,
    direct: bool,
    head: Option<String>,
    branch: Option<String>,
) {
    let previous_commit = record.meta.commit.clone();
    if direct {
        // A direct round starts at the repository's current HEAD and has no
        // task branch of its own; the branch is shown for orientation only.
        if let Some(head) = head {
            record.meta.baseline = Some(head.clone());
            record.meta.start = Some(head);
        }
        record.task.branch = branch;
    } else if let Some(commit) = previous_commit {
        // The next review only shows the new round's work.
        record.meta.baseline = Some(commit.clone());
        record.meta.start = Some(commit);
    } else if record.meta.start.is_none() {
        record.meta.start = record.meta.baseline.clone();
    }

    record.meta.direct = direct;
    // A fresh turn reviews afresh: nothing pending from the previous round.
    record.task.review = None;
    record.task.changes = None;
    record.task.finalize = None;
    record.meta.commit = None;
    record.meta.merge = None;
    record.meta.merged = false;
    record.meta.comment_posted = false;
    record.meta.status_updated = false;
    record.meta.status_from = None;
    record.meta.status_to = None;
    // A new round gives the model its hidden turns again; only a retry inside
    // one round counts attempts.
    record.meta.writeback_attempts = 0;
}

/// Points a live session at the directory its task row says it works in. A
/// worktree the finishing chain removed falls back to the repository, so a
/// restored session cannot keep a deleted cwd.
///
/// Best effort: the turn that triggered this call is more valuable than a
/// control frame, and every later prompt repeats the assignment.
pub async fn ensure_session_cwd(app: &AppHandle, session_id: &str) {
    let Ok(Some(record)) = load_record(app, session_id).await else {
        return;
    };
    // Free chats resolve their own cwd (worktree / repository / scratch);
    // `feature::prompt` already assigns that one.
    if !record.task.kind.is_task() {
        return;
    }
    let mut target = record.work_dir();
    if target.trim().is_empty() || !std::path::Path::new(&target).is_dir() {
        target = record.task.repo_path.trim().to_string();
    }
    if target.trim().is_empty() {
        return;
    }
    if let Ok(bridge) = bridge(app) {
        if let Err(error) = bridge.assign_session(session_id, &target).await {
            tracing::warn!(%error, session = session_id, "task cwd was not assigned");
        }
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
    // TAPD's comment/transition APIs need the long entity id; the short id is
    // only for display, the bug link and the branch name.
    let long_id = detail.summary.id.trim().to_string();
    let bug_id = if long_id.is_empty() {
        request.bug_id.clone()
    } else {
        long_id
    };
    // The first bug handed over from a workspace learns its display name; the
    // session list keeps grouping by it instead of the repository folder name.
    remember_project_name(app, request.workspace_id.trim(), &detail.workspace_name);
    let export =
        crate::export::export_detail(app, &state.paths, &request.workspace_id, None, &detail)
            .await
            .map_err(|error| tr_args("dsh.task.export.failed", &[&error]))?;

    let session_id = uuid::Uuid::new_v4().to_string();
    // Every workflow task runs in its own worktree; there is no other branch.
    let (work_dir, branch) = prepare_worktree(
        app,
        &repo_path,
        &session_id,
        "tapd",
        &request.bug_id,
    )
    .await?;

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
        bug_id: Some(bug_id.clone()),
        workflow: Workflow::Queued,
        status: SessionStatus::Idle,
        repo_path: repo_path.clone(),
        worktree_path: Some(work_dir.path.clone()),
        branch: Some(branch),
        json_path: export.bug_json.clone(),
        created_at: created_at.clone(),
        updated_at: created_at,
        message_count: 0,
        changes: None,
        review: None,
        finalize: None,
    };

    let vars = PromptVars {
        task_id: session_id.clone(),
        title,
        json_path: export.bug_json,
        repo_path: work_dir.path.clone(),
        workspace_name,
        bug_id,
        severity,
        priority,
        user_prompt: request.extra_prompt.unwrap_or_default(),
        attachments: request.attachments,
        coworker: coworker_section(app, &config),
    };
    let prompt = build_prompt(&config, vars, &project.rule, false);
    let record = TaskRecord {
        task,
        meta: TaskMeta {
            workspace_id: Some(request.workspace_id),
            baseline: Some(work_dir.baseline.clone()),
            start: Some(work_dir.baseline),
            worktree: true,
            team: request.team,
            pending_prompt: Some(prompt),
            ..TaskMeta::default()
        },
    };
    launch(app, record, None).await
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
    let (work_dir, branch) =
        prepare_worktree(app, &repo_path, &session_id, "local", &item.id).await?;

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
        workflow: Workflow::Queued,
        status: SessionStatus::Idle,
        repo_path: repo_path.clone(),
        worktree_path: Some(work_dir.path.clone()),
        branch: Some(branch),
        json_path: json_path.clone(),
        created_at: created_at.clone(),
        updated_at: created_at,
        message_count: 0,
        changes: None,
        review: None,
        finalize: None,
    };

    let vars = PromptVars {
        task_id: session_id,
        title: item.title,
        json_path: json_path.clone(),
        repo_path: work_dir.path.clone(),
        workspace_name: project.name.clone(),
        bug_id: String::new(),
        severity: String::new(),
        priority: String::new(),
        user_prompt: request.extra_prompt.unwrap_or_default(),
        attachments: request.attachments,
        coworker: coworker_section(app, &config),
    };
    let prompt = build_prompt(&config, vars, &project.rule, true);
    let record = TaskRecord {
        task,
        meta: TaskMeta {
            baseline: Some(work_dir.baseline.clone()),
            start: Some(work_dir.baseline),
            worktree: true,
            team: request.team,
            local_project_id: Some(project.id.clone()),
            local_item_id: Some(item.id.clone()),
            local_previous_status: Some(item.status.as_str().to_string()),
            pending_prompt: Some(prompt),
            ..TaskMeta::default()
        },
    };
    let link = LocalLink {
        item_id: item.id,
        previous_status: item.status,
    };
    launch(app, record, Some(link)).await
}

/// Creates the isolated worktree a task runs in and names its branch.
async fn prepare_worktree(
    app: &AppHandle,
    repo_path: &str,
    session_id: &str,
    prefix: &str,
    key: &str,
) -> Result<(worktree::CreatedWorktree, String), String> {
    let state = shared(app)?;
    let target = state.paths.worktrees_dir.join(session_id);
    let repo = repo_path.to_string();
    let branch = worktree::branch_name(prefix, key, session_id);
    let branch_for_create = branch.clone();
    let created = blocking(move || worktree::create(&repo, &target, &branch_for_create))
        .await
        .map_err(|error| tr_args("dsh.task.worktree.failed", &[&error]))?;
    Ok((created, branch))
}

/// Item facts for rolling a local link back when the launch fails.
struct LocalLink {
    item_id: String,
    previous_status: WorkItemStatus,
}

/// Writes the row, links the local item, then asks the scheduler to run it.
/// The session itself starts only when a slot is available; any failure removes
/// the row and the worktree, because the list must never show a half task.
async fn launch(
    app: &AppHandle,
    record: TaskRecord,
    local: Option<LocalLink>,
) -> Result<Value, String> {
    if let Err(error) = insert_task(app, &record).await {
        remove_worktree_dir(&record).await;
        return Err(error);
    }

    if let Some(link) = local.as_ref() {
        let Ok(state) = shared(app) else {
            rollback(app, &record, local.as_ref()).await;
            return Err(tr("dsh.state.unavailable").to_string());
        };
        let store = state.local.clone();
        let item_id = link.item_id.clone();
        let task_id = record.task.id.clone();
        let at = now();
        if let Err(error) = blocking(move || store.attach_task(&item_id, &task_id, &at)).await {
            rollback(app, &record, local.as_ref()).await;
            return Err(error);
        }
        if let Some(project_id) = record.meta.local_project_id.as_deref() {
            crate::local::emit_items_changed(
                app,
                Some(project_id),
                Some(link.item_id.as_str()),
                Some(WorkItemStatus::InProgress.as_str()),
            );
        }
    }

    emit(app);
    schedule(app).await?;

    let task_id = record.task.id.clone();
    let Some(mut fresh) = load_record(app, &task_id).await? else {
        return Err(not_found(&task_id));
    };
    overlay(&mut fresh.task, &live_sessions(app));
    Ok(json!({ "task": task_view(&fresh, &fresh.task) }))
}

/// Best-effort cleanup for a task that never reached the store.
async fn rollback(app: &AppHandle, record: &TaskRecord, local: Option<&LocalLink>) {
    let Ok(state) = shared(app) else {
        return;
    };
    let cache = state.cache.clone();
    let id = record.task.id.clone();
    if let Err(error) = blocking(move || task_store::delete(&cache, &id)).await {
        tracing::error!(%error, "failed to remove a rolled-back dsh task row");
    }
    remove_worktree_dir(record).await;
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
        if let Some(project_id) = record.meta.local_project_id.as_deref() {
            crate::local::emit_items_changed(
                app,
                Some(project_id),
                Some(link.item_id.as_str()),
                Some(link.previous_status.as_str()),
            );
        }
    }
}

async fn remove_worktree_dir(record: &TaskRecord) {
    let Some(path) = record
        .task
        .worktree_path
        .clone()
        .filter(|path| !path.trim().is_empty())
    else {
        return;
    };
    let repo = record.task.repo_path.clone();
    if let Err(error) = blocking(move || worktree::remove(&repo, &path)).await {
        tracing::warn!(%error, "failed to remove the worktree");
    }
}

// ---------------------------------------------------------------------------
// Queue scheduling (docs/AGENT_TASK_FLOW.md §9)
// ---------------------------------------------------------------------------

static SCHEDULE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn schedule_lock() -> &'static tokio::sync::Mutex<()> {
    SCHEDULE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Number of workflow tasks that hold a slot: a task whose live session is
/// still `running`. The workflow value is deliberately not consulted: a task
/// that called `task_submit` moves to review while its turn (and the worktree it
/// is writing) is still live, so that turn keeps its slot until it ends. Rows
/// persisted as running without a live session (an app restart) do not count;
/// they wait for the user to open them.
fn active_slots(records: &[TaskRecord], live: &HashMap<String, DshSession>) -> usize {
    records
        .iter()
        .filter(|record| {
            record.task.kind.is_task()
                && live
                    .get(&record.task.id)
                    .is_some_and(|session| session.status == SessionStatus::Running)
        })
        .count()
}

fn next_queued(records: &[TaskRecord]) -> Option<TaskRecord> {
    records
        .iter()
        .filter(|record| record.task.kind.is_task() && record.task.workflow == Workflow::Queued)
        .min_by(|left, right| {
            left.task
                .created_at
                .cmp(&right.task.created_at)
                .then_with(|| left.task.id.cmp(&right.task.id))
        })
        .cloned()
}

/// Starts queued tasks while a slot is free, oldest first. Safe to call from
/// any path: the lock serialises schedulers and every start claims its row with
/// a compare-and-swap.
pub async fn schedule(app: &AppHandle) -> Result<(), String> {
    let _guard = schedule_lock().lock().await;
    let units = agent_settings::config_for(app).execution_units.clamp(1, 8) as usize;
    // Tasks this run already started. They hold a slot before the plugin has
    // reported their first turn as running; once it does, `active_slots` counts
    // them and this marker stops (so no task is counted twice).
    let mut started: HashSet<String> = HashSet::new();
    for _ in 0..32 {
        let state = shared(app)?;
        let cache = state.cache.clone();
        let records = blocking(move || task_store::load_all(&cache)).await?;
        let live = live_sessions(app);
        let starting = started
            .iter()
            .filter(|id| {
                live.get(*id)
                    .map_or(true, |session| session.status != SessionStatus::Running)
            })
            .count();
        if active_slots(&records, &live) + starting >= units {
            return Ok(());
        }
        let Some(record) = next_queued(&records) else {
            return Ok(());
        };
        let id = record.task.id.clone();
        if start_queued(app, record).await {
            started.insert(id);
        }
    }
    Ok(())
}

/// Starts one queued task. The row is claimed (`queued → running`) before the
/// session exists, so a second scheduler cannot start it twice; a failed start
/// becomes a terminal `failed` instead of a stuck queue entry.
async fn start_queued(app: &AppHandle, record: TaskRecord) -> bool {
    let id = record.task.id.clone();
    let prompt = record.meta.pending_prompt.clone().unwrap_or_default();
    let mut record = record;
    let Ok(expected) = transition(&mut record, Workflow::Running) else {
        return false;
    };
    record.meta.pending_prompt = None;
    record.touch();
    match save_record(app, record.clone(), expected).await {
        Ok(true) => {}
        Ok(false) => return false,
        Err(error) => {
            tracing::warn!(%error, session = id, "failed to claim a queued task");
            return false;
        }
    }
    push_phase(app, &record);
    emit(app);

    if prompt.trim().is_empty() {
        fail_task(app, &id, tr("dsh.task.state.invalid")).await;
        return false;
    }
    if let Err(error) = start_session(app, &id, &record.work_dir(), &prompt, record.meta.team).await
    {
        fail_task(app, &id, &error).await;
        return false;
    }
    true
}

/// A scheduler run triggered after a slot frees up.
fn reschedule(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = schedule(&app).await {
            tracing::warn!(%error, "failed to reschedule queued dsh tasks");
        }
    });
}

/// The session starting directory is assigned before the first prompt. The
/// runtime boots first: the bridge only accepts control frames once its plugin
/// has connected, and a cold start needs a moment for that socket.
async fn start_session(
    app: &AppHandle,
    session_id: &str,
    work_dir: &str,
    prompt: &str,
    team: Option<bool>,
) -> Result<(), String> {
    if let Ok(bridge) = bridge(app) {
        // Register the row before the runtime reports events for it, so the
        // slot count and the unified list see a live session.
        bridge.create_session(app, session_id);
    }
    let runtime = runtime(app)?;
    runtime.ensure_ready(app).await?;
    // Create the Agent and lock in the configured model before the first turn;
    // the worktree assignment below then moves its directory.
    runtime.prepare_session(app, session_id, true).await;
    assign_session_with_retry(app, session_id, work_dir).await?;
    // The task was created with its own team choice; the plugin applies it to
    // the Agent `prepare_session` just created. `None` keeps the runtime
    // default, which the profile already carries.
    if let Some(team) = team {
        match bridge(app) {
            Ok(bridge) => {
                if let Err(error) = bridge.set_team_mode(session_id, team).await {
                    // Best effort: the turn is more valuable than the flag, and
                    // a cold socket is the only way here (assign just succeeded).
                    tracing::warn!(%error, session = session_id, team, "team mode was not applied");
                }
            }
            Err(error) => {
                tracing::warn!(%error, session = session_id, "the bridge was unavailable for team mode");
            }
        }
    }
    // The first step must already see the execute-phase tool and prompt.
    sync_phase(app, session_id).await?;
    runtime.query(app, session_id, prompt).await?;
    Ok(())
}

/// Waits briefly for the plugin connection instead of failing the launch on
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
    if config.team_enabled {
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
// Approve / finalize (docs/AGENT_TASK_FLOW.md §8)
// ---------------------------------------------------------------------------

static FINALIZE_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn finalize_lock() -> &'static tokio::sync::Mutex<()> {
    FINALIZE_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Approves a reviewed task and runs the finishing chain. The task enters
/// `finalizing` before any git command, so a crash mid-chain leaves a retryable
/// row instead of a half-merged one.
async fn approve(app: &AppHandle, request: SessionRequest) -> Result<Value, String> {
    let Some(record) = load_record(app, &request.session_id).await? else {
        return Err(not_found(&request.session_id));
    };
    if record.task.kind == TaskKind::Chat {
        return Err(tr("dsh.task.state.invalid").to_string());
    }
    // Approving commits the tree, so it is only safe once the turn stopped:
    // a live turn would keep writing after the snapshot.
    if live_running(app, &request.session_id) {
        return Err(tr("dsh.task.approve.busy").to_string());
    }
    if record.task.workflow != Workflow::AwaitingReview {
        return Err(tr("dsh.task.state.invalid").to_string());
    }
    let Ok(_guard) = finalize_lock().try_lock() else {
        return Err(tr("dsh.task.finalize.busy").to_string());
    };
    // Re-read under the lock: a cancel or a second approve may have moved it.
    let Some(record) = load_record(app, &request.session_id).await? else {
        return Err(not_found(&request.session_id));
    };
    if record.task.workflow != Workflow::AwaitingReview {
        return Ok(task_value(app, &record));
    }
    let mut record = record;
    let expected = transition(&mut record, Workflow::Finalizing)?;
    record.task.finalize = Some(TaskFinalize {
        step: Some(FinalizeStep::Commit),
        ..TaskFinalize::default()
    });
    record.touch();
    if !save_record(app, record, expected).await? {
        return Err(tr("dsh.task.busy").to_string());
    }
    emit(app);
    crate::notification::review::settle(&request.session_id);
    let task = run_finalize(app, &request.session_id).await?;
    // The chain writes meta (commit/merge); reload so the reply and
    // the following event carry the same view.
    let Some(record) = load_record(app, &task.id).await? else {
        return Err(not_found(&task.id));
    };
    Ok(task_value(app, &record))
}

/// Retries the finishing chain from `finalize.step`. Each step is idempotent:
/// an existing commit is not repeated, an already merged branch is not merged
/// again, and a removed worktree is skipped.
async fn retry_finalize(app: &AppHandle, request: SessionRequest) -> Result<Value, String> {
    let Some(record) = load_record(app, &request.session_id).await? else {
        return Err(not_found(&request.session_id));
    };
    if record.task.workflow != Workflow::Finalizing {
        return Err(tr("dsh.task.state.invalid").to_string());
    }
    if live_running(app, &request.session_id) {
        return Err(tr("dsh.task.approve.busy").to_string());
    }
    let Ok(_guard) = finalize_lock().try_lock() else {
        return Err(tr("dsh.task.finalize.busy").to_string());
    };
    let Some(mut record) = load_record(app, &request.session_id).await? else {
        return Err(not_found(&request.session_id));
    };
    if record.task.workflow != Workflow::Finalizing {
        return Ok(task_value(app, &record));
    }
    // The retry starts a clean attempt; the failed step itself stays recorded.
    if let Some(finalize) = record.task.finalize.as_mut() {
        finalize.error = None;
        finalize.instructions = None;
    }
    record.touch();
    if !save_record(app, record, Workflow::Finalizing).await? {
        return Err(tr("dsh.task.busy").to_string());
    }
    emit(app);
    let task = run_finalize(app, &request.session_id).await?;
    let Some(record) = load_record(app, &task.id).await? else {
        return Err(not_found(&task.id));
    };
    Ok(task_value(app, &record))
}

/// Runs (or resumes) the commit → merge → cleanup → writeback chain. A failed
/// step is recorded on the row and the task stays `finalizing` for a retry.
async fn run_finalize(app: &AppHandle, session_id: &str) -> Result<DshTask, String> {
    for _ in 0..8 {
        let Some(record) = load_record(app, session_id).await? else {
            return Err(not_found(session_id));
        };
        if record.task.workflow != Workflow::Finalizing {
            return Ok(record.task);
        }
        let step = record
            .task
            .finalize
            .as_ref()
            .and_then(|finalize| finalize.step)
            .unwrap_or(FinalizeStep::Commit);
        match step {
            FinalizeStep::Commit => {
                let work_dir = record.work_dir();
                if work_dir.trim().is_empty() {
                    return fail_finalize(
                        app,
                        record,
                        FinalizeStep::Commit,
                        tr("dsh.task.state.invalid").to_string(),
                        tr("dsh.task.finalize.instructions.commit").to_string(),
                    )
                    .await;
                }
                let message = commit_message(&record.task);
                let committed = blocking(move || worktree::commit_all(&work_dir, &message)).await;
                let committed = match committed {
                    Ok(commit) => commit,
                    Err(error) => {
                        let failure = tr_args("dsh.task.commit.failed", &[&error]);
                        return fail_finalize(
                            app,
                            record,
                            FinalizeStep::Commit,
                            failure,
                            tr("dsh.task.finalize.instructions.commit").to_string(),
                        )
                        .await;
                    }
                };
                let mut record = record;
                if let Some(commit) = committed {
                    record.meta.commit = Some(commit);
                }
                if let Some(changes) = summary_changes(&record).await {
                    record.task.changes = Some(changes);
                }
                if !advance_finalize(app, record, FinalizeStep::Merge, None).await? {
                    return Err(tr("dsh.task.busy").to_string());
                }
            }
            FinalizeStep::Merge => {
                // A direct round already committed in the repository; there is
                // no task branch to merge and no worktree to clean up.
                if record.meta.direct {
                    if !advance_finalize(app, record, FinalizeStep::Writeback, None).await? {
                        return Err(tr("dsh.task.busy").to_string());
                    }
                    continue;
                }
                let Some(branch) = record
                    .task
                    .branch
                    .clone()
                    .filter(|branch| !branch.trim().is_empty())
                else {
                    return fail_finalize(
                        app,
                        record,
                        FinalizeStep::Merge,
                        tr("dsh.task.state.invalid").to_string(),
                        tr("dsh.task.finalize.instructions.commit").to_string(),
                    )
                    .await;
                };
                let mut merge_commit = None;
                if !record.meta.merged && !branch_merged(&record, &branch).await {
                    let repo = record.task.repo_path.clone();
                    let branch_for_merge = branch.clone();
                    let baseline = record.meta.baseline.clone();
                    let message = format!("Merge branch '{branch}'");
                    let attempt = blocking(move || {
                        if worktree::is_dirty(&repo)? {
                            return Err(tr("dsh.task.merge.dirty").to_string());
                        }
                        // `merge --no-ff` exits 0 ("Already up to date") when
                        // the branch never advanced, and then the ancestor proof
                        // would pass vacuously. A reverted task must not be
                        // declared merged.
                        if let Some(baseline) = baseline.as_deref() {
                            if worktree::branch_tip(&repo, &branch_for_merge)? == baseline {
                                return Err(tr("dsh.task.merge.empty").to_string());
                            }
                        }
                        let merged = worktree::merge_no_ff(&repo, &branch_for_merge, &message)?;
                        if !worktree::is_ancestor(&repo, &branch_for_merge, "HEAD")? {
                            return Err(tr("dsh.task.merge.ancestor").to_string());
                        }
                        Ok(merged)
                    })
                    .await;
                    match attempt {
                        Ok(merged) => merge_commit = Some(merged),
                        Err(error) => {
                            let failure = tr_args("dsh.task.merge.failed", &[&error]);
                            return fail_finalize(
                                app,
                                record,
                                FinalizeStep::Merge,
                                failure,
                                merge_instructions(&branch),
                            )
                            .await;
                        }
                    }
                }
                let mut record = record;
                if let Some(merged) = merge_commit {
                    record.meta.merge = Some(merged);
                }
                record.meta.merged = true;
                if !advance_finalize(app, record, FinalizeStep::Cleanup, None).await? {
                    return Err(tr("dsh.task.busy").to_string());
                }
            }
            FinalizeStep::Cleanup => {
                let mut record = record;
                let mut notice = None;
                if let Some(path) = record
                    .task
                    .worktree_path
                    .clone()
                    .filter(|path| !path.trim().is_empty())
                {
                    if std::path::Path::new(&path).is_dir() {
                        let probe = path.clone();
                        let dirty = blocking(move || worktree::is_dirty(&probe))
                            .await
                            .unwrap_or(true);
                        if dirty {
                            // `remove --force` would silently discard edits made
                            // after approval; keep the directory and say so.
                            notice = Some(tr("dsh.task.finalize.dirty").to_string());
                        } else {
                            let repo = record.task.repo_path.clone();
                            let target = path.clone();
                            match blocking(move || worktree::remove(&repo, &target)).await {
                                Ok(()) => {
                                    record.task.worktree_path = None;
                                    // The write-back turn runs next; it must not
                                    // inherit a directory that no longer exists.
                                    let repo = record.task.repo_path.clone();
                                    if let Err(error) =
                                        assign_session_with_retry(app, &record.task.id, &repo)
                                            .await
                                    {
                                        tracing::warn!(
                                            %error,
                                            session = %record.task.id,
                                            "task cwd was not returned to the repository"
                                        );
                                    }
                                }
                                Err(error) => {
                                    let failure = tr_args("dsh.task.git.failed", &[&error]);
                                    return fail_finalize(
                                        app,
                                        record,
                                        FinalizeStep::Cleanup,
                                        failure,
                                        tr("dsh.task.finalize.instructions.cleanup").to_string(),
                                    )
                                    .await;
                                }
                            }
                        }
                    } else {
                        record.task.worktree_path = None;
                    }
                }
                if !advance_finalize(app, record, FinalizeStep::Writeback, notice).await? {
                    return Err(tr("dsh.task.busy").to_string());
                }
            }
            FinalizeStep::Writeback => return begin_writeback(app, record).await,
        }
    }
    Err(tr("dsh.task.state.invalid").to_string())
}

/// The git steps are done. Local items finish here; a bug gets a hidden
/// `host-prompt` turn whose conditional tools write TAPD.
async fn begin_writeback(app: &AppHandle, record: TaskRecord) -> Result<DshTask, String> {
    let mut record = record;
    if record.task.kind != TaskKind::Bug
        || (record.meta.comment_posted && record.meta.status_updated)
    {
        let expected = transition(&mut record, Workflow::Done)?;
        record.task.finalize = None;
        record.touch();
        if !save_record(app, record.clone(), expected).await? {
            return Err(tr("dsh.task.busy").to_string());
        }
        complete_local(app, &record).await;
        emit(app);
        if let Ok(bridge) = bridge(app) {
            let _ = bridge.send_task_phase(&record.task.id, "none", record.task.kind.as_str());
        }
        return Ok(record.task);
    }

    // A `tapd_*` tool must not exist one moment before the phase frame. The
    // plugin acks, so the prompt that follows cannot race the map update.
    let ack = match bridge(app) {
        Ok(bridge) => {
            bridge
                .request_task_phase(&record.task.id, "writeback", record.task.kind.as_str())
                .await
        }
        Err(error) => Err(error),
    };
    if let Err(error) = ack {
        return fail_finalize(
            app,
            record,
            FinalizeStep::Writeback,
            error,
            tr("dsh.task.finalize.instructions.writeback").to_string(),
        )
        .await;
    }
    let workspace_state = writeback::workspace_state(&record.task, record.meta.direct);
    let text = writeback::prompt(
        &record.task,
        record.task.changes.as_ref(),
        record.meta.commit.as_deref(),
        record.meta.merge.as_deref(),
        &workspace_state,
    );
    // Count the hidden turn before it is sent and persist it: a crash during
    // the turn must still remember that the model had this attempt.
    record.meta.writeback_attempts = next_writeback_attempt(record.meta.writeback_attempts);
    {
        let finalize = record.task.finalize.get_or_insert_with(TaskFinalize::default);
        finalize.step = Some(FinalizeStep::Writeback);
        finalize.error = None;
        finalize.instructions = None;
    }
    record.touch();
    if !save_record(app, record.clone(), Workflow::Finalizing).await? {
        return Err(tr("dsh.task.busy").to_string());
    }
    if let Err(error) = bridge(app).and_then(|bridge| bridge.send_host_prompt(&record.task.id, &text))
    {
        return fail_finalize(
            app,
            record,
            FinalizeStep::Writeback,
            error,
            tr("dsh.task.finalize.instructions.writeback").to_string(),
        )
        .await;
    }
    emit(app);
    spawn_writeback_watchdog(app.clone(), record.task.id.clone(), record.meta.writeback_attempts);
    Ok(record.task)
}

/// A write-back turn that never ends must not sit in `finalizing` forever: a
/// model can keep retrying a tool that returns the same error. After the stall
/// window this counts the attempt as consumed, stops the turn, and lets the
/// host fallback finish the missing TAPD writes.
const WRITEBACK_STALL_SECS: u64 = 300;

fn spawn_writeback_watchdog(app: AppHandle, session_id: String, attempt: u32) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(WRITEBACK_STALL_SECS)).await;
        let Ok(Some(record)) = load_record(&app, &session_id).await else {
            return;
        };
        if record.task.workflow != Workflow::Finalizing
            || record
                .task
                .finalize
                .as_ref()
                .and_then(|finalize| finalize.step)
                != Some(FinalizeStep::Writeback)
            || (record.meta.comment_posted && record.meta.status_updated)
        {
            return;
        }
        // A retry or a newer attempt owns the row now.
        if record.meta.writeback_attempts != attempt {
            return;
        }
        let mut record = record;
        // A stalled turn is the last attempt: the settle path then writes the
        // missing half itself instead of asking the model again.
        record.meta.writeback_attempts = HOST_WRITEBACK_ATTEMPTS;
        record.touch();
        if !save_record(&app, record.clone(), Workflow::Finalizing)
            .await
            .unwrap_or(false)
        {
            return;
        }
        if live_running(&app, &session_id) {
            if let Ok(bridge) = bridge(&app) {
                let _ = bridge.cancel_session(&session_id).await;
            }
        }
        // Let `finish_turn` settle a cancelled turn; an already-idle row with
        // no live session (for example after a restart) is settled here.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let Ok(Some(fresh)) = load_record(&app, &session_id).await else {
            return;
        };
        if fresh.task.workflow == Workflow::Finalizing {
            let _ = settle_writeback(&app, fresh, &now()).await;
        }
    });
}

/// Records the failed step and keeps the task in `finalizing`.
async fn fail_finalize(
    app: &AppHandle,
    mut record: TaskRecord,
    step: FinalizeStep,
    error: String,
    instructions: String,
) -> Result<DshTask, String> {
    {
        let finalize = record.task.finalize.get_or_insert_with(TaskFinalize::default);
        finalize.step = Some(step);
        finalize.error = Some(error);
        finalize.instructions = Some(instructions);
    }
    record.touch();
    let saved = save_record(app, record.clone(), Workflow::Finalizing).await?;
    emit(app);
    if !saved {
        tracing::warn!("a finalize failure was not persisted");
    }
    Ok(record.task)
}

/// Moves the finalize step forward and clears a stale error.
async fn advance_finalize(
    app: &AppHandle,
    mut record: TaskRecord,
    step: FinalizeStep,
    notice: Option<String>,
) -> Result<bool, String> {
    {
        let finalize = record.task.finalize.get_or_insert_with(TaskFinalize::default);
        finalize.step = Some(step);
        finalize.error = None;
        finalize.instructions = None;
        // The notice always describes this attempt: a kept worktree from an
        // earlier try must not survive a successful cleanup.
        finalize.notice = notice;
    }
    record.touch();
    let saved = save_record(app, record, Workflow::Finalizing).await?;
    emit(app);
    Ok(saved)
}

async fn summary_changes(record: &TaskRecord) -> Option<TaskChanges> {
    let workspace = workspace_for(record);
    blocking(move || {
        workspace
            .summary()
            .map(|summary| change_counts(&summary))
            .map_err(|error| error.message().to_string())
    })
    .await
    .ok()
}

async fn branch_merged(record: &TaskRecord, branch: &str) -> bool {
    let repo = record.task.repo_path.clone();
    let branch = branch.to_string();
    blocking(move || {
        Ok::<_, String>(worktree::is_ancestor(&repo, &branch, "HEAD").unwrap_or(false))
    })
    .await
    .unwrap_or(false)
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
// Host RPC: the plugin's conditional tools call back here
// ---------------------------------------------------------------------------

/// Handles one `{type:"host"}` frame. Runs off the socket reader so a slow
/// TAPD call cannot block transcript frames; the reply goes through the same
/// control channel.
pub async fn host_rpc(app: &AppHandle, frame: &Value) {
    let Some(request_id) = frame.get("requestId").and_then(Value::as_str) else {
        tracing::warn!("agent bridge: host frame without a request id");
        return;
    };
    let method = frame
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let session_id = frame
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = dispatch_host(app, method, session_id, &params).await;
    if let Ok(bridge) = bridge(app) {
        bridge.send_host_reply(request_id, result);
    }
}

async fn dispatch_host(
    app: &AppHandle,
    method: &str,
    session_id: &str,
    params: &Value,
) -> Result<Value, String> {
    match method {
        "task.submit" => task_submit(app, session_id, params).await,
        "task.complete" => task_complete(app, session_id).await,
        "tapd.transitions" => tapd_transitions(app, session_id).await,
        "tapd.comment" => tapd_comment(app, session_id, params).await,
        "tapd.status" => tapd_status(app, session_id, params).await,
        other => Err(tr_args("dsh.task.host.unknown", &[&other])),
    }
}

/// `task_submit`: the execute-phase tool. Changes move the task to review;
/// nothing means the model found nothing to do.
async fn task_submit(app: &AppHandle, session_id: &str, params: &Value) -> Result<Value, String> {
    let Some(record) = load_record(app, session_id).await? else {
        return Err(not_found(session_id));
    };
    if !record.task.kind.is_task() {
        return Err(tr("dsh.task.state.invalid").to_string());
    }
    match record.task.workflow {
        // Repeated calls are harmless: report the outcome without rewriting.
        Workflow::AwaitingReview | Workflow::Done => {
            return Ok(json!({ "outcome": "already", "phase": phase_of(&record) }));
        }
        Workflow::Running => {}
        _ => return Err(tr("dsh.task.state.invalid").to_string()),
    }
    let summary_text = params
        .get("summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| tr("dsh.task.submit.summary").to_string())?
        .to_string();
    let verification = optional_text(params, "verification");
    let risks = optional_text(params, "risks");

    let workspace = workspace_for(&record);
    let summary = blocking(move || {
        workspace
            .summary()
            .map_err(|error| error.message().to_string())
    })
    .await?;

    // Re-read: the turn may have ended while the diff ran.
    let Some(mut record) = load_record(app, session_id).await? else {
        return Err(not_found(session_id));
    };
    if record.task.workflow != Workflow::Running {
        return Ok(json!({ "outcome": "already", "phase": phase_of(&record) }));
    }
    let (next, changes) = review_outcome(&summary);
    record.task.review = Some(TaskReview {
        summary: summary_text,
        verification,
        risks,
        files: summary.files.iter().map(|file| file.path.clone()).collect(),
    });
    record.task.changes = changes;
    record.task.finalize = None;
    let expected = transition(&mut record, next)?;
    record.touch();
    let phase = phase_of(&record);
    if !save_record(app, record.clone(), expected).await? {
        return Ok(json!({ "outcome": "already", "phase": phase }));
    }
    complete_local(app, &record).await;
    push_phase(app, &record);
    emit(app);
    // The review card waits for `finish_turn`: the turn is still running here,
    // and an approve click would bounce off `dsh.task.approve.busy`.
    // The slot is *not* released here: this turn is still running in the
    // worktree, and `finish_turn` hands the slot back when it ends.
    let outcome = if next == Workflow::Done {
        "done"
    } else {
        "review"
    };
    Ok(json!({ "outcome": outcome, "phase": phase }))
}

/// `task_complete`: only after both the comment and the status transition.
async fn task_complete(app: &AppHandle, session_id: &str) -> Result<Value, String> {
    let _guard = writeback_lock().lock().await;
    let Some(record) = load_record(app, session_id).await? else {
        return Err(not_found(session_id));
    };
    writeback_bug(&record)?;
    if !(record.meta.comment_posted && record.meta.status_updated) {
        return Err(tr("dsh.task.complete.pending").to_string());
    }
    let mut record = record;
    let expected = transition(&mut record, Workflow::Done)?;
    record.task.finalize = None;
    record.touch();
    if !save_record(app, record.clone(), expected).await? {
        return Err(tr("dsh.task.busy").to_string());
    }
    complete_local(app, &record).await;
    emit(app);
    if let Ok(bridge) = bridge(app) {
        let _ = bridge.send_task_phase(&record.task.id, "none", record.task.kind.as_str());
    }
    Ok(json!({ "done": true }))
}

async fn tapd_transitions(app: &AppHandle, session_id: &str) -> Result<Value, String> {
    let Some(record) = load_record(app, session_id).await? else {
        return Err(not_found(session_id));
    };
    let (workspace, bug) = writeback_bug(&record)?;
    let bug = resolved_bug_id(app, &workspace, &bug).await;
    let info = crate::bug_write::load_transition_info(app, &workspace, &bug).await?;
    let transitions: Vec<Value> = info
        .transitions
        .iter()
        .map(|(key, label)| json!({ "key": key, "label": label }))
        .collect();
    Ok(json!({
        "current": info.current_status,
        "alias": crate::bug_write::info_label(&info.current_status, &info),
        "transitions": transitions,
    }))
}

async fn tapd_comment(
    app: &AppHandle,
    session_id: &str,
    params: &Value,
) -> Result<Value, String> {
    let _guard = writeback_lock().lock().await;
    let Some(record) = load_record(app, session_id).await? else {
        return Err(not_found(session_id));
    };
    let (workspace, bug) = writeback_bug(&record)?;
    let bug = resolved_bug_id(app, &workspace, &bug).await;
    let comment = params
        .get("comment")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| tr("dsh.task.comment.empty").to_string())?
        .to_string();
    if comment.chars().count() > 8000 {
        return Err(tr("dsh.task.comment.tooLong").to_string());
    }
    // Idempotent: a retry (or two tool calls in one turn) posts once.
    if record.meta.comment_posted {
        return Ok(json!({ "duplicate": true }));
    }
    crate::bug_write::add_comment(app, &workspace, &bug, &comment)
        .await
        .map_err(|error| tr_args("dsh.task.writeback.failed", &[&error]))?;

    let Some(mut record) = load_record(app, session_id).await? else {
        return Err(not_found(session_id));
    };
    record.meta.comment_posted = true;
    record.touch();
    if !save_record(app, record, Workflow::Finalizing).await? {
        return Err(tr("dsh.task.busy").to_string());
    }
    emit(app);
    Ok(json!({}))
}

async fn tapd_status(app: &AppHandle, session_id: &str, params: &Value) -> Result<Value, String> {
    let _guard = writeback_lock().lock().await;
    let Some(record) = load_record(app, session_id).await? else {
        return Err(not_found(session_id));
    };
    let (workspace, bug) = writeback_bug(&record)?;
    let bug = resolved_bug_id(app, &workspace, &bug).await;
    if record.meta.status_updated {
        return Ok(json!({
            "from": record.meta.status_from,
            "to": record.meta.status_to,
        }));
    }
    let status = params
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("resolved")
        .to_string();
    // Reuses the same helper as the bug panel: a `new` bug is accepted before
    // it can be resolved, and illegal targets surface TAPD's own list.
    let outcome =
        crate::bug_write::perform_transition(app, &workspace, &bug, &status, &Value::Null)
            .await
            .map_err(|error| tr_args("dsh.task.writeback.failed", &[&error]))?;

    let Some(mut record) = load_record(app, session_id).await? else {
        return Err(not_found(session_id));
    };
    record.meta.status_updated = true;
    record.meta.status_from = Some(outcome.original_status.clone());
    record.meta.status_to = Some(outcome.status.clone());
    record.touch();
    if !save_record(app, record, Workflow::Finalizing).await? {
        return Err(tr("dsh.task.busy").to_string());
    }
    emit(app);
    Ok(json!({ "from": outcome.original_status, "to": outcome.status }))
}

/// The row every `tapd.*` tool operates on: a bug task in the write-back step.
/// Everything else (chat, local item, wrong step, missing bug binding) is a
/// tool error, so a forged or stale call cannot write another bug.
fn writeback_bug(record: &TaskRecord) -> Result<(String, String), String> {
    if record.task.kind != TaskKind::Bug || record.task.workflow != Workflow::Finalizing {
        return Err(tr("dsh.task.state.invalid").to_string());
    }
    let step = record
        .task
        .finalize
        .as_ref()
        .and_then(|finalize| finalize.step);
    if step != Some(FinalizeStep::Writeback) {
        return Err(tr("dsh.task.state.invalid").to_string());
    }
    let bug = record
        .task
        .bug_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| tr("dsh.task.state.invalid").to_string())?;
    let workspace = record
        .meta
        .workspace_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| tr("dsh.task.state.invalid").to_string())?;
    Ok((workspace, bug))
}

/// TAPD's write APIs want the long entity id; a row created before the enqueue
/// fix may still carry the short display id. Resolve it once for the call (the
/// row itself is not rewritten; the user's data is disposable and the new
/// enqueue stores the long id).
async fn resolved_bug_id(app: &AppHandle, workspace: &str, bug: &str) -> String {
    if bug.len() >= 16 {
        return bug.to_string();
    }
    match crate::commands::bugs::fetch_bug_detail(app, workspace, bug).await {
        Ok(detail) => {
            let long = detail.summary.id.trim();
            if long.is_empty() {
                bug.to_string()
            } else {
                long.to_string()
            }
        }
        Err(error) => {
            tracing::warn!(%error, bug, "short bug id was not resolved");
            bug.to_string()
        }
    }
}

static WRITEBACK_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn writeback_lock() -> &'static tokio::sync::Mutex<()> {
    WRITEBACK_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn optional_text(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// Changes / cancel / resume / diff
// ---------------------------------------------------------------------------

/// The changed files of a task's worktree, for the review list.
async fn changes(app: &AppHandle, request: SessionRequest) -> Result<Value, String> {
    let Some(record) = load_record(app, &request.session_id).await? else {
        return Err(not_found(&request.session_id));
    };
    if record.task.kind == TaskKind::Chat {
        return Err(tr("dsh.task.state.invalid").to_string());
    }
    let workspace = workspace_for(&record);
    let summary = blocking(move || {
        workspace
            .summary()
            .map_err(|error| error.message().to_string())
    })
    .await?;
    let dir = record.work_dir();
    let kinds = if !dir.trim().is_empty() && std::path::Path::new(&dir).is_dir() {
        blocking(move || worktree::status_kinds(&dir))
            .await
            .unwrap_or_default()
    } else {
        HashMap::new()
    };
    let files: Vec<Value> = summary
        .files
        .iter()
        .map(|file| {
            let status = kinds
                .get(&file.path)
                .cloned()
                .unwrap_or_else(|| change_kind_name(file.status).to_string());
            json!({
                "path": file.path,
                "status": status,
                "additions": file.additions,
                "deletions": file.deletions,
                "binary": file.binary,
            })
        })
        .collect();
    Ok(json!({
        "files": files,
        "truncated": summary.file_count > summary.files.len(),
    }))
}

fn change_kind_name(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::Added => "added",
        ChangeKind::Modified => "modified",
        ChangeKind::Deleted => "deleted",
    }
}

async fn cancel(app: &AppHandle, request: CancelRequest) -> Result<Value, String> {
    let Some(record) = load_record(app, &request.session_id).await? else {
        return Err(not_found(&request.session_id));
    };
    if record.task.workflow.is_terminal() {
        // Canceling a finished task is a no-op: terminal states never regress.
        return Ok(task_value(app, &record));
    }
    // `finalizing` changes are already in the main repository; there is nothing
    // left to abandon. The contract forbids canceling it.
    if record.task.workflow == Workflow::Finalizing {
        return Err(tr("dsh.task.cancel.busy").to_string());
    }

    // Merging and canceling must not interleave: the branch merge and its
    // write-back are one physical step.
    let Ok(_guard) = finalize_lock().try_lock() else {
        return Err(tr("dsh.task.cancel.busy").to_string());
    };

    if let Ok(bridge) = bridge(app) {
        if let Err(error) = bridge.cancel_session(&record.task.id).await {
            // A task restored from a previous app run has no live turn; the
            // cancel still has to persist.
            tracing::debug!(%error, session = %record.task.id, "no live turn to cancel");
        }
    }

    let was_queued = record.task.workflow == Workflow::Queued;
    if request.stash && !was_queued {
        let work_dir = record.work_dir();
        if !work_dir.is_empty() {
            let id = record.task.id.clone();
            let message = format!("tapd task {id} canceled");
            blocking(move || worktree::stash_all(&work_dir, &message))
                .await
                .map_err(|error| tr_args("dsh.task.cancel.stash", &[&error]))?;
        }
    }

    let Some(mut record) = load_record(app, &request.session_id).await? else {
        return Err(not_found(&request.session_id));
    };
    let expected = transition(&mut record, Workflow::Canceled)?;
    record.task.finalize = None;
    record.task.message_count = live_sessions(app)
        .get(&request.session_id)
        .map(|session| session.message_count as u32)
        .unwrap_or(record.task.message_count);
    if was_queued {
        // Nothing ran, so the fresh worktree is only clutter.
        remove_worktree_dir(&record).await;
        record.task.worktree_path = None;
        record.meta.pending_prompt = None;
    }
    record.touch();

    if !save_record(app, record.clone(), expected).await? {
        return Err(tr("dsh.task.state.invalid").to_string());
    }
    // Canceling a local-item task used to leave the item stuck in in_progress
    // with a dangling agentTaskId: `attach_task` is the only thing that moves
    // it, and `complete_local` only runs for Done. Undo the link here.
    if record.task.kind == TaskKind::LocalItem {
        let restored = record
            .meta
            .local_previous_status
            .clone()
            .unwrap_or_else(|| WorkItemStatus::InProgress.as_str().to_string());
        if let Some(item_id) = record.meta.local_item_id.clone() {
            let store = shared(app)?.local.clone();
            let task_id = record.task.id.clone();
            let previous = restored.clone();
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
        if let Some(project_id) = record.meta.local_project_id.as_deref() {
            crate::local::emit_items_changed(
                app,
                Some(project_id),
                record.meta.local_item_id.as_deref(),
                Some(&restored),
            );
        }
    }
    push_phase(app, &record);
    emit(app);
    crate::notification::review::settle(&record.task.id);
    // A canceled running task frees its slot.
    reschedule(app);
    Ok(task_value(app, &record))
}

async fn resume(app: &AppHandle, request: SessionRequest) -> Result<Value, String> {
    let Some(record) = load_record(app, &request.session_id).await? else {
        return Err(not_found(&request.session_id));
    };
    // A queued task has no session yet. Opening it asks the scheduler for a
    // slot instead of resuming a session the runtime never created.
    if record.task.workflow == Workflow::Queued {
        schedule(app).await?;
        let Some(fresh) = load_record(app, &request.session_id).await? else {
            return Err(not_found(&request.session_id));
        };
        return Ok(task_value(app, &fresh));
    }

    let runtime = runtime(app)?;
    runtime.ensure_ready(app).await?;
    // The shared helper also snapshots the session's model choice before the
    // SDK resume resets it to the runtime default.
    if let Err(error) = runtime.resume_session(app, &request.session_id).await {
        return Err(tr_args("dsh.task.resume.failed", &[&error]));
    }
    // The stored session cwd may be a worktree the finishing chain removed;
    // re-point it before the user's next turn.
    ensure_session_cwd(app, &request.session_id).await;

    // Re-attaching a persisted session is not activity: bumping `updated_at`
    // here reordered the list every time a row was opened.
    let mut record = record;
    record.task.status = SessionStatus::Idle;
    let expected = record.task.workflow;
    if !save_record(app, record.clone(), expected).await? {
        let Some(fresh) = load_record(app, &request.session_id).await? else {
            return Err(not_found(&request.session_id));
        };
        return Ok(task_value(app, &fresh));
    }
    emit(app);
    // Opening a queued task must not jump the queue, but the scheduler may have
    // a free slot now that the runtime is up.
    reschedule(app);
    Ok(task_value(app, &record))
}

async fn diff(app: &AppHandle, request: DiffRequest) -> Result<Value, String> {
    let Some(record) = load_record(app, &request.session_id).await? else {
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
// Projects / free conversations (docs/AGENT_TASK_FLOW.md §10, §11)
// ---------------------------------------------------------------------------

/// Fills a project's display name once, from the first bug handed over. Only
/// that one field is written: repositories and rules are edited elsewhere and
/// a background repair must not overwrite them.
fn remember_project_name(app: &AppHandle, workspace_id: &str, name: &str) {
    let name = name.trim();
    if workspace_id.is_empty() || name.is_empty() {
        return;
    }
    // Read right before writing: a settings edit may have landed while the bug
    // detail was fetched.
    let mut config = agent_settings::config_for(app);
    let Some(project) = config.projects.get_mut(workspace_id) else {
        return;
    };
    if !project.name.trim().is_empty() {
        return;
    }
    project.name = name.to_string();
    if let Err(error) = agent_settings::save_for(app, &config) {
        tracing::warn!(%error, workspace = workspace_id, "failed to remember a project name");
    }
}

/// The display name of a configured TAPD project: its saved TAPD name, or the
/// repository folder name for rows written before names were stored.
fn project_display_name(project: &agent_settings::ProjectAgentConfig) -> String {
    let saved = project.name.trim();
    if saved.is_empty() {
        tapd_local::LocalProject::derive_project_name(&project.repo_path)
    } else {
        saved.to_string()
    }
}

/// All project groups a free conversation can be created under: configured
/// TAPD projects plus every local project.
pub async fn projects(app: &AppHandle) -> Result<Value, String> {
    let config = agent_settings::config_for(app);
    let mut projects: Vec<Value> = config
        .projects
        .iter()
        .filter(|(_, project)| !project.repo_path.trim().is_empty())
        .map(|(id, project)| {
            json!({
                "kind": "tapd",
                "id": id,
                "name": project_display_name(project),
                "repoPath": project.repo_path,
            })
        })
        .collect();
    let state = shared(app)?;
    let store = state.local.clone();
    let locals = blocking(move || store.projects()).await?;
    projects.extend(locals.into_iter().map(|project| {
        json!({
            "kind": "local",
            "id": project.id,
            "name": project.name,
            "repoPath": project.repo_path,
        })
    }));
    Ok(json!({ "projects": projects }))
}

/// Allocates a session id and its chat row. A project binds the group, the
/// default cwd and the worktree toggle's repository; a manual session stays a
/// scratch chat.
pub async fn new_session(app: &AppHandle, project: Option<ProjectRef>) -> Result<Value, String> {
    let (project, repo_path) = match project {
        Some(reference) => resolve_project(app, &reference).await?,
        None => (None, String::new()),
    };
    let session_id = uuid::Uuid::new_v4().to_string();
    if let Ok(bridge) = bridge(app) {
        bridge.create_session(app, &session_id);
    }
    // The composer work bar shows the project's checked-out branch until the
    // chat opts into a worktree. Display only: nothing switches branches.
    let branch = if repo_path.trim().is_empty() {
        None
    } else {
        let repo = repo_path.clone();
        blocking(move || worktree::current_branch(&repo))
            .await
            .ok()
            .flatten()
    };
    create_chat(app, &session_id, project, repo_path, branch).await?;
    Ok(json!({ "sessionId": session_id }))
}

async fn resolve_project(
    app: &AppHandle,
    reference: &ProjectRef,
) -> Result<(Option<TaskProject>, String), String> {
    match reference.kind {
        ProjectKind::Tapd => {
            let config = agent_settings::config_for(app);
            let project = config
                .projects
                .get(&reference.id)
                .cloned()
                .filter(|project| !project.repo_path.trim().is_empty())
                .ok_or_else(|| tr("dsh.task.repo.missing").to_string())?;
            let name = project_display_name(&project);
            Ok((
                Some(TaskProject {
                    id: reference.id.clone(),
                    name,
                    kind: ProjectKind::Tapd,
                }),
                project.repo_path,
            ))
        }
        ProjectKind::Local => {
            let state = shared(app)?;
            let store = state.local.clone();
            let id = reference.id.clone();
            let projects = blocking(move || store.projects()).await?;
            let project = projects
                .into_iter()
                .find(|project| project.id == id)
                .ok_or_else(|| tr("local.project.notfound").to_string())?;
            Ok((
                Some(TaskProject {
                    id: project.id,
                    name: project.name,
                    kind: ProjectKind::Local,
                }),
                project.repo_path,
            ))
        }
    }
}

/// Registers a plain chat session so the unified list holds it too. Idempotent:
/// the row exists as soon as the UI asks for a new session.
async fn create_chat(
    app: &AppHandle,
    session_id: &str,
    project: Option<TaskProject>,
    repo_path: String,
    branch: Option<String>,
) -> Result<(), String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = session_id.to_string();
    let inserted = blocking(move || {
        if task_store::load(&cache, &id)?.is_some() {
            return Ok::<_, String>(false);
        }
        let at = now();
        let record = TaskRecord {
            task: DshTask {
                id: id.clone(),
                kind: TaskKind::Chat,
                project,
                title: String::new(),
                bug_id: None,
                // Chats have no workflow; `running` is the neutral value the
                // list has always used for them and the scheduler ignores it.
                workflow: Workflow::Running,
                status: SessionStatus::Idle,
                repo_path,
                worktree_path: None,
                branch,
                json_path: String::new(),
                created_at: at.clone(),
                updated_at: at,
                message_count: 0,
                changes: None,
                review: None,
                finalize: None,
            },
            meta: TaskMeta::default(),
        };
        task_store::insert(&cache, &record)?;
        Ok(true)
    })
    .await?;
    if inserted {
        emit(app);
    }
    Ok(())
}

/// The cwd a chat prompt should assign: its worktree, its project repository,
/// or its own scratch directory. `None` means the session has no task row.
pub(crate) async fn chat_cwd(app: &AppHandle, session_id: &str) -> Option<String> {
    let record = load_record(app, session_id).await.ok()??;
    if record.task.kind != TaskKind::Chat {
        return None;
    }
    // A chat worktree wins: the toggle moved the session there.
    if let Some(path) = record
        .task
        .worktree_path
        .clone()
        .filter(|path| !path.trim().is_empty())
    {
        if std::path::Path::new(&path).is_dir() {
            return Some(path);
        }
    }
    let repo = record.task.repo_path.trim().to_string();
    if !repo.is_empty() {
        return Some(repo);
    }
    let state = shared(app).ok()?;
    let dir = state.paths.data_dir.join("dsh").join("chats").join(session_id);
    let created = dir.clone();
    blocking(move || {
        std::fs::create_dir_all(&created).map_err(|error| error.to_string())?;
        Ok::<_, String>(created.to_string_lossy().to_string())
    })
    .await
    .ok()
}

/// Turns a chat's worktree on or off (docs/AGENT_TASK_FLOW.md §10).
pub async fn chat_worktree(
    app: &AppHandle,
    session_id: &str,
    enabled: bool,
) -> Result<Value, String> {
    let Some(record) = load_record(app, session_id).await? else {
        return Err(not_found(session_id));
    };
    if record.task.kind != TaskKind::Chat {
        return Err(tr("dsh.chat.worktree.notChat").to_string());
    }
    if live_running(app, session_id) {
        return Err(tr("dsh.task.approve.busy").to_string());
    }
    if enabled {
        enable_chat_worktree(app, record).await
    } else {
        disable_chat_worktree(app, record).await
    }
}

async fn enable_chat_worktree(app: &AppHandle, record: TaskRecord) -> Result<Value, String> {
    if let Some(path) = record
        .task
        .worktree_path
        .clone()
        .filter(|path| !path.trim().is_empty())
    {
        if std::path::Path::new(&path).is_dir() {
            return Ok(task_value(app, &record));
        }
    }
    let repo_hint = record.task.repo_path.trim().to_string();
    if repo_hint.is_empty() {
        return Err(tr("dsh.chat.worktree.repo").to_string());
    }
    let repo = blocking(move || worktree::repo_root(&repo_hint))
        .await
        .map_err(|error| tr_args("dsh.task.git.failed", &[&error]))?;
    let state = shared(app)?;
    let target = state.paths.worktrees_dir.join(&record.task.id);
    let branch = worktree::chat_branch(&record.task.id);
    let created = {
        let repo = repo.clone();
        let branch = branch.clone();
        blocking(move || worktree::create(&repo, &target, &branch))
            .await
            .map_err(|error| tr_args("dsh.task.worktree.failed", &[&error]))?
    };
    // Point the live session at the worktree before the row claims it.
    if let Err(error) = assign_session_with_retry(app, &record.task.id, &created.path).await {
        let repo = repo.clone();
        let path = created.path.clone();
        let _ = blocking(move || worktree::remove(&repo, &path)).await;
        return Err(error);
    }
    let mut record = record;
    let expected = record.task.workflow;
    record.task.repo_path = repo;
    record.task.worktree_path = Some(created.path);
    record.task.branch = Some(branch);
    record.meta.worktree = true;
    record.meta.baseline = Some(created.baseline);
    record.touch();
    if !save_record(app, record.clone(), expected).await? {
        return Err(tr("dsh.task.busy").to_string());
    }
    emit(app);
    Ok(task_value(app, &record))
}

async fn disable_chat_worktree(app: &AppHandle, record: TaskRecord) -> Result<Value, String> {
    let Some(path) = record
        .task
        .worktree_path
        .clone()
        .filter(|path| !path.trim().is_empty())
    else {
        return Ok(task_value(app, &record));
    };
    let repo = record.task.repo_path.trim().to_string();
    if std::path::Path::new(&path).is_dir() {
        let probe = path.clone();
        let dirty = blocking(move || worktree::is_dirty(&probe))
            .await
            .unwrap_or(true);
        if dirty {
            return Err(tr("dsh.chat.worktree.dirty").to_string());
        }
        let target = path.clone();
        let repo_for_remove = repo.clone();
        blocking(move || worktree::remove(&repo_for_remove, &target))
            .await
            .map_err(|error| tr_args("dsh.task.git.failed", &[&error]))?;
    }
    // A branch with commits is the user's work; only an untouched branch goes.
    if let Some(branch) = record
        .task
        .branch
        .clone()
        .filter(|branch| !branch.trim().is_empty())
    {
        let keep = match record.meta.baseline.clone() {
            Some(baseline) => {
                let repo_for_tip = repo.clone();
                let branch_for_tip = branch.clone();
                blocking(move || worktree::branch_tip(&repo_for_tip, &branch_for_tip))
                    .await
                    .map(|tip| tip != baseline)
                    .unwrap_or(true)
            }
            None => true,
        };
        if !keep {
            let repo_for_delete = repo.clone();
            let _ = blocking(move || worktree::delete_branch(&repo_for_delete, &branch)).await;
        }
    }

    let mut record = record;
    let expected = record.task.workflow;
    record.task.worktree_path = None;
    // Back to the project's checked-out branch for the work bar; a chat with
    // no repository has no branch to show.
    record.task.branch = if repo.trim().is_empty() {
        None
    } else {
        let repo = repo.clone();
        blocking(move || worktree::current_branch(&repo))
            .await
            .ok()
            .flatten()
    };
    record.meta.worktree = false;
    record.meta.baseline = None;
    record.touch();
    if !save_record(app, record.clone(), expected).await? {
        return Err(tr("dsh.task.busy").to_string());
    }
    emit(app);

    // The cwd goes back to the project repository (or the chat scratch area).
    if let Some(cwd) = chat_cwd(app, &record.task.id).await {
        if let Ok(bridge) = bridge(app) {
            if let Err(error) = bridge.assign_session(&record.task.id, &cwd).await {
                tracing::warn!(%error, session = %record.task.id, "chat cwd was not restored");
            }
        }
    }
    Ok(task_value(app, &record))
}

// ---------------------------------------------------------------------------
// Session directories
// ---------------------------------------------------------------------------

/// The directory one session works in, resolved without the runtime.
///
/// Chats use their worktree, then their project repository, then a scratch dir
/// under the data directory. Task rows use their worktree while it exists and
/// fall back to the repository. A session with no task row can still own a chat
/// directory (a draft that already prompted), so that case answers only when
/// the directory is there. The file viewer scopes a tab to this root through
/// the `__session__:<id>` workspace id.
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
    if record.task.kind == TaskKind::Chat {
        if !repo.is_empty() {
            return Some(PathBuf::from(repo));
        }
        return chat.is_dir().then_some(chat);
    }
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
    let path = match record
        .task
        .worktree_path
        .clone()
        .filter(|path| !path.trim().is_empty())
    {
        Some(worktree) => worktree,
        None if record.task.kind == TaskKind::Chat => {
            let repo = record.task.repo_path.trim().to_string();
            if repo.is_empty() {
                state
                    .paths
                    .data_dir
                    .join("dsh")
                    .join("chats")
                    .join(&record.task.id)
                    .to_string_lossy()
                    .to_string()
            } else {
                repo
            }
        }
        None => record.task.repo_path.clone(),
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

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/// Removes one session: its row, its mode, its log and whatever directory the
/// app created for it. The repository a task was opened from is never touched;
/// a worktree is removed with `--force`, because the account that can delete a
/// session is the one that owns its uncommitted changes.
async fn delete_session(app: &AppHandle, request: SessionRequest) -> Result<Value, String> {
    let Some(record) = load_record(app, &request.session_id).await? else {
        return Err(not_found(&request.session_id));
    };
    if live_running(app, &request.session_id) {
        return Err(tr("dsh.chat.delete.running").to_string());
    }
    let worktree = record
        .task
        .worktree_path
        .clone()
        .filter(|path| !path.trim().is_empty());
    let repo = record.task.repo_path.clone();
    // A deleted local-item task must not leave its item stuck in progress with
    // a dangling task id. A finished task keeps the item done; anything else
    // returns to the status it had before the handover.
    let local_link = (record.task.kind == TaskKind::LocalItem)
        .then(|| {
            record
                .meta
                .local_project_id
                .clone()
                .zip(record.meta.local_item_id.clone())
        })
        .flatten();
    let restore_status = (record.task.workflow != Workflow::Done).then(|| {
        record
            .meta
            .local_previous_status
            .clone()
            .unwrap_or_else(|| WorkItemStatus::InProgress.as_str().to_string())
    });

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

    if let Some((project_id, item_id)) = local_link {
        let store = state.local.clone();
        let task_id = request.session_id.clone();
        let item_for_store = item_id.clone();
        let restored = restore_status.clone();
        let at = now();
        if let Err(error) = blocking(move || {
            store.forget_task(&task_id, &at)?;
            if let Some(status) = restored {
                store
                    .update_item(&item_for_store, None, None, Some(status.as_str()))
                    .map(|_| ())?;
            }
            Ok::<_, String>(())
        })
        .await
        {
            // The item may have been deleted before its task; that is the one
            // expected miss here, not a reason to warn.
            if error != tr("local.item.notfound") {
                tracing::warn!(%error, "failed to release the deleted task's local item");
            }
        }
        crate::local::emit_items_changed(
            app,
            Some(&project_id),
            Some(&item_id),
            restore_status.as_deref(),
        );
    }

    crate::notification::review::settle(&request.session_id);
    emit(app);
    reschedule(app);
    Ok(json!({ "sessionId": request.session_id }))
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

async fn load_record(app: &AppHandle, id: &str) -> Result<Option<TaskRecord>, String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let id = id.to_string();
    blocking(move || task_store::load(&cache, &id)).await
}

async fn save_record(
    app: &AppHandle,
    record: TaskRecord,
    expected: Workflow,
) -> Result<bool, String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    blocking(move || task_store::update_if(&cache, &record, expected)).await
}

async fn insert_task(app: &AppHandle, record: &TaskRecord) -> Result<(), String> {
    let state = shared(app)?;
    let cache = state.cache.clone();
    let stored = record.clone();
    blocking(move || task_store::insert(&cache, &stored)).await
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

fn live_running(app: &AppHandle, session_id: &str) -> bool {
    live_sessions(app)
        .get(session_id)
        .is_some_and(|session| session.status == SessionStatus::Running)
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

/// The frontend contract: the task row plus the facts that are derived from
/// the internal meta and must not be persisted twice.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskView<'a> {
    #[serde(flatten)]
    task: &'a DshTask,
    git: TaskGit,
    writeback: TaskWriteback,
    direct: bool,
}

fn task_view<'a>(record: &'a TaskRecord, task: &'a DshTask) -> TaskView<'a> {
    TaskView {
        task,
        git: TaskGit {
            start: record.meta.start.clone().or_else(|| record.meta.baseline.clone()),
            commit: record.meta.commit.clone(),
            merge: record.meta.merge.clone(),
        },
        writeback: TaskWriteback {
            comment: record.meta.comment_posted,
            status_from: record.meta.status_from.clone(),
            status_to: record.meta.status_to.clone(),
        },
        direct: record.meta.direct,
    }
}

/// One command response. Applies the same live overlay as the list so a
/// returned task is not a stale copy of what `dsh://tasks` is about to emit.
fn task_value(app: &AppHandle, record: &TaskRecord) -> Value {
    let mut task = record.task.clone();
    overlay(&mut task, &live_sessions(app));
    json!({ "task": task_view(record, &task) })
}

/// Loads the list, emits it and refreshes the plugin's phase map. Runs after
/// the write's lock is released: an event listener that calls back into
/// `dsh_tasks` cannot deadlock.
fn emit(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match tasks_payload(&app).await {
            Ok(payload) => {
                let _ = app.emit(EVENT_TASKS, payload);
            }
            Err(error) => tracing::warn!(%error, "failed to emit the dsh task list"),
        }
        publish_phases(&app).await;
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
    let project_for_event = project_id.clone();
    let at = now();
    if let Err(error) = blocking(move || {
        store
            .complete_work_item(&project_id, &item_id, &task_id, &at)
            .map(|_| ())
    })
    .await
    {
        tracing::warn!(%error, item = %logged_item, "failed to complete the local work item");
    } else {
        crate::local::emit_items_changed(
            app,
            Some(&project_for_event),
            Some(&logged_item),
            Some(WorkItemStatus::Done.as_str()),
        );
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

    /// The enum, its `as_str` table, `parse` and serde must agree. Adding a
    /// variant without updating all four breaks this test instead of producing
    /// rows that can never be read back.
    #[test]
    fn every_workflow_round_trips() {
        const ALL: [Workflow; 7] = [
            Workflow::Queued,
            Workflow::Running,
            Workflow::AwaitingReview,
            Workflow::Finalizing,
            Workflow::Done,
            Workflow::Failed,
            Workflow::Canceled,
        ];
        for workflow in ALL {
            let raw = workflow.as_str();
            assert_eq!(Workflow::parse(raw), Some(workflow), "{raw}");
            let json = serde_json::to_string(&workflow).expect("serialize");
            assert_eq!(
                serde_json::from_str::<Workflow>(&json).expect("deserialize"),
                workflow,
                "{json}"
            );
        }
        // The pre-finalizing name is gone; old rows are skipped, not remapped.
        assert_eq!(Workflow::parse("awaiting_merge"), None);
    }

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
                finalize: None,
            },
            meta: TaskMeta::default(),
        }
    }

    fn session(id: &str, status: SessionStatus) -> DshSession {
        DshSession {
            id: id.to_string(),
            title: String::new(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            status,
            message_count: 0,
            usage: Default::default(),
            selection: None,
            plan_active: false,
            todos: Vec::new(),
            parent_session: None,
            agent_preset: None,
        }
    }

    #[test]
    fn workflow_moves_forward_and_terminal_states_never_regress() {
        for (from, to) in [
            (Workflow::Queued, Workflow::Running),
            (Workflow::Queued, Workflow::Canceled),
            (Workflow::Queued, Workflow::Failed),
            (Workflow::Running, Workflow::AwaitingReview),
            (Workflow::Running, Workflow::Done),
            (Workflow::Running, Workflow::Canceled),
            (Workflow::Running, Workflow::Failed),
            (Workflow::AwaitingReview, Workflow::Finalizing),
            (Workflow::AwaitingReview, Workflow::Canceled),
            (Workflow::Finalizing, Workflow::Done),
        ] {
            let mut record = record(from);
            assert_eq!(transition(&mut record, to).expect("allowed"), from);
            assert_eq!(record.task.workflow, to);
        }

        for state in [Workflow::Done, Workflow::Failed, Workflow::Canceled] {
            for next in [
                Workflow::Queued,
                Workflow::Running,
                Workflow::AwaitingReview,
                Workflow::Finalizing,
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
        let mut back = record(Workflow::Finalizing);
        assert!(transition(&mut back, Workflow::AwaitingReview).is_err());
        let mut reopen = record(Workflow::AwaitingReview);
        assert!(transition(&mut reopen, Workflow::Running).is_err());
    }

    #[test]
    fn only_input_reopens_a_settled_task() {
        // A new turn revives work that had settled either way, and the review
        // gate's "continue editing" path; a canceled task stays canceled.
        assert_eq!(reopen_target(Workflow::Done), Some(Workflow::Running));
        assert_eq!(reopen_target(Workflow::Failed), Some(Workflow::Running));
        assert_eq!(
            reopen_target(Workflow::AwaitingReview),
            Some(Workflow::Running)
        );
        assert_eq!(reopen_target(Workflow::Canceled), None);
        assert_eq!(reopen_target(Workflow::Running), None);
        assert_eq!(reopen_target(Workflow::Finalizing), None);
        assert_eq!(reopen_target(Workflow::Queued), None);
    }

    #[test]
    fn a_task_view_carries_git_writeback_and_direct() {
        let mut record = record(Workflow::Done);
        record.meta.baseline = Some("base".to_string());
        record.meta.start = Some("start".to_string());
        record.meta.commit = Some("commit".to_string());
        record.meta.merge = Some("merge".to_string());
        record.meta.comment_posted = true;
        record.meta.status_from = Some("in_progress".to_string());
        record.meta.status_to = Some("resolved".to_string());
        record.meta.direct = true;

        let task = record.task.clone();
        let view = serde_json::to_value(task_view(&record, &task)).expect("view");
        assert_eq!(view["git"]["start"], "start");
        assert_eq!(view["git"]["commit"], "commit");
        assert_eq!(view["git"]["merge"], "merge");
        assert_eq!(view["writeback"]["comment"], true);
        assert_eq!(view["writeback"]["statusFrom"], "in_progress");
        assert_eq!(view["writeback"]["statusTo"], "resolved");
        assert_eq!(view["direct"], true);

        // A row written before `start` existed still shows a starting point.
        record.meta.start = None;
        let view = serde_json::to_value(task_view(&record, &task)).expect("view");
        assert_eq!(view["git"]["start"], "base");
    }

    #[test]
    fn a_task_without_its_worktree_works_directly_in_the_repository() {
        let mut record = record(Workflow::Done);
        record.meta.worktree = true;
        record.task.worktree_path = Some("/definitely/not/here".to_string());
        assert!(record.works_direct());

        record.task.worktree_path = None;
        assert!(record.works_direct());

        // A worktree that still exists (for example kept because it was dirty)
        // keeps the isolated round.
        record.task.worktree_path = Some(
            std::env::temp_dir()
                .to_string_lossy()
                .to_string(),
        );
        assert!(!record.works_direct());

        record.meta.worktree = false;
        assert!(!record.works_direct());
    }

    #[test]
    fn a_new_round_clears_the_previous_result_and_starts_at_the_right_revision() {
        let mut direct = record(Workflow::Done);
        direct.meta.worktree = true;
        direct.meta.baseline = Some("base".to_string());
        direct.meta.commit = Some("old".to_string());
        direct.meta.merge = Some("merge".to_string());
        direct.meta.merged = true;
        direct.meta.comment_posted = true;
        direct.meta.status_from = Some("in_progress".to_string());
        direct.meta.status_to = Some("resolved".to_string());
        direct.meta.writeback_attempts = 2;
        direct.task.review = Some(TaskReview {
            summary: "s".to_string(),
            verification: None,
            risks: None,
            files: Vec::new(),
        });

        start_round(
            &mut direct,
            true,
            Some("head".to_string()),
            Some("main".to_string()),
        );
        assert!(direct.meta.direct);
        assert_eq!(direct.meta.baseline.as_deref(), Some("head"));
        assert_eq!(direct.meta.start.as_deref(), Some("head"));
        assert_eq!(direct.task.branch.as_deref(), Some("main"));
        assert!(direct.meta.commit.is_none());
        assert!(direct.meta.merge.is_none());
        assert!(!direct.meta.merged);
        assert!(!direct.meta.comment_posted);
        assert_eq!(direct.meta.writeback_attempts, 0);
        assert!(direct.task.review.is_none());

        // A kept worktree continues in isolation, starting at the previous
        // round's commit so the review only shows the new work.
        let mut isolated = record(Workflow::Done);
        isolated.meta.worktree = true;
        isolated.meta.baseline = Some("base".to_string());
        isolated.meta.commit = Some("commit".to_string());
        start_round(&mut isolated, false, None, None);
        assert!(!isolated.meta.direct);
        assert_eq!(isolated.meta.baseline.as_deref(), Some("commit"));
        assert_eq!(isolated.meta.start.as_deref(), Some("commit"));
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
    fn the_phase_follows_the_workflow_and_the_finalize_step() {
        let mut queued = record(Workflow::Queued);
        assert_eq!(phase_of(&queued), "none");
        queued.task.workflow = Workflow::Running;
        assert_eq!(phase_of(&queued), "execute");
        queued.task.workflow = Workflow::AwaitingReview;
        assert_eq!(phase_of(&queued), "review");
        queued.task.workflow = Workflow::Finalizing;
        assert_eq!(phase_of(&queued), "none", "git steps run without tools");
        queued.task.finalize = Some(TaskFinalize {
            step: Some(FinalizeStep::Writeback),
            ..TaskFinalize::default()
        });
        assert_eq!(phase_of(&queued), "writeback");
        queued.task.workflow = Workflow::Done;
        assert_eq!(phase_of(&queued), "none");

        let mut chat = record(Workflow::Running);
        chat.task.kind = TaskKind::Chat;
        assert_eq!(phase_of(&chat), "chat");
    }

    #[test]
    fn the_workflow_and_step_wire_names_are_stable() {
        assert_eq!(Workflow::Queued.as_str(), "queued");
        assert_eq!(Workflow::Finalizing.as_str(), "finalizing");
        assert_eq!(
            serde_json::to_string(&FinalizeStep::Writeback).unwrap(),
            "\"writeback\""
        );
    }

    #[test]
    fn slots_count_live_running_turns_not_the_workflow_value() {
        let mut running = record(Workflow::Running);
        running.task.id = "live".into();
        // `task_submit` moved the task to review while its turn keeps writing;
        // that turn still holds the slot.
        let mut in_review = record(Workflow::AwaitingReview);
        in_review.task.id = "review".into();
        let mut persisted = record(Workflow::Running);
        persisted.task.id = "persisted".into();
        let mut chat = record(Workflow::Running);
        chat.task.kind = TaskKind::Chat;
        chat.task.id = "chat".into();
        let mut queued = record(Workflow::Queued);
        queued.task.id = "queued".into();
        let records = vec![running, in_review, persisted, chat, queued];
        let live: HashMap<String, DshSession> = [
            ("live".to_string(), session("live", SessionStatus::Running)),
            ("review".to_string(), session("review", SessionStatus::Running)),
            // A session that exists but is not in a turn holds nothing.
            ("persisted".to_string(), session("persisted", SessionStatus::Idle)),
            ("chat".to_string(), session("chat", SessionStatus::Running)),
        ]
        .into_iter()
        .collect();
        assert_eq!(active_slots(&records, &live), 2);
    }

    #[test]
    fn writeback_attempts_grow_and_the_host_takes_over_after_two_turns() {
        assert_eq!(next_writeback_attempt(0), 1);
        assert_eq!(next_writeback_attempt(1), 2);
        assert_eq!(next_writeback_attempt(u32::MAX), u32::MAX);
        assert!(!host_writeback_due(0));
        assert!(!host_writeback_due(1));
        assert!(host_writeback_due(HOST_WRITEBACK_ATTEMPTS));
        assert!(host_writeback_due(HOST_WRITEBACK_ATTEMPTS + 1));
    }

    #[test]
    fn a_retry_only_redoes_the_write_that_is_missing() {
        let mut meta = TaskMeta::default();
        assert_eq!(
            writeback_gaps(&meta),
            WritebackGaps {
                comment: true,
                status: true
            }
        );
        // The model posted the comment but never moved the status.
        meta.comment_posted = true;
        assert_eq!(
            writeback_gaps(&meta),
            WritebackGaps {
                comment: false,
                status: true
            }
        );
        // A status already applied by a tool leaves only the comment.
        meta.comment_posted = false;
        meta.status_updated = true;
        assert_eq!(
            writeback_gaps(&meta),
            WritebackGaps {
                comment: true,
                status: false
            }
        );
        meta.comment_posted = true;
        assert!(writeback_gaps(&meta).is_empty());
    }

    #[test]
    fn the_host_comment_carries_the_task_facts_instead_of_placeholders() {
        let mut record = record(Workflow::Finalizing);
        record.task.project = Some(TaskProject {
            id: "ws".to_string(),
            name: "UU".to_string(),
            kind: ProjectKind::Tapd,
        });
        record.task.branch = Some("tapd/42-ab12cd".to_string());
        record.task.changes = Some(TaskChanges {
            files: 2,
            additions: 30,
            deletions: 4,
        });
        record.task.review = Some(TaskReview {
            summary: "根因在登录态判断".to_string(),
            verification: Some("跑了单测".to_string()),
            risks: None,
            files: Vec::new(),
        });
        record.meta.commit = Some("abc123".to_string());

        let text = host_comment(&record);
        assert!(text.contains("根因在登录态判断"));
        assert!(text.contains("跑了单测"));
        assert!(text.contains("tapd/42-ab12cd"));
        assert!(text.contains("abc123"));
        assert!(text.contains("https://www.tapd.cn/ws/bugtrace/bugs/view?bug_id=42"));
        assert!(!text.contains('{'), "no placeholder may survive");
    }

    #[test]
    fn the_queue_is_started_oldest_first_and_never_chats() {
        let mut first = record(Workflow::Queued);
        first.task.id = "b".into();
        first.task.created_at = "2026-01-01T00:00:00.000Z".into();
        let mut second = record(Workflow::Queued);
        second.task.id = "a".into();
        second.task.created_at = "2026-01-02T00:00:00.000Z".into();
        let mut chat = record(Workflow::Queued);
        chat.task.kind = TaskKind::Chat;
        chat.task.id = "c".into();
        chat.task.created_at = "2025-01-01T00:00:00.000Z".into();
        let records = vec![second, chat, first];
        assert_eq!(next_queued(&records).map(|row| row.task.id), Some("b".into()));
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

    #[test]
    fn writeback_tools_require_a_bug_at_the_writeback_step() {
        let mut record = record(Workflow::Finalizing);
        record.meta.workspace_id = Some("ws".into());
        record.task.finalize = Some(TaskFinalize {
            step: Some(FinalizeStep::Merge),
            ..TaskFinalize::default()
        });
        assert!(writeback_bug(&record).is_err(), "git steps expose no tools");

        record.task.finalize = Some(TaskFinalize {
            step: Some(FinalizeStep::Writeback),
            ..TaskFinalize::default()
        });
        assert_eq!(
            writeback_bug(&record).expect("writeback"),
            ("ws".to_string(), "42".to_string())
        );

        // A local item never has a TAPD binding.
        record.task.kind = TaskKind::LocalItem;
        record.task.bug_id = None;
        assert!(writeback_bug(&record).is_err());
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
