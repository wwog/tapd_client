//! The `dsh_*` feature surface.
//!
//! One implementation serves both adapters: the Tauri commands in
//! [`super::commands`] and the `feature_router` / companion allowlist used by
//! the paired phone. Frontends therefore cannot diverge on behavior or shapes.
//!
//! Session state lives in [`BridgeState`]; these functions only translate
//! JSON payloads, call the runtime, and return the documented shapes.

use std::sync::Arc;

use dsh_host::protocol::{
    AnswerItem, ApprovalOutcome, ApprovalRequestResult, ContentBlock, UserQuestionResult,
};
use dsh_host::transcript::ModelSelection;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::bridge::BridgeState;
use super::runtime::{DshStatus, Phase, RuntimeState};
use crate::agent_settings::PermissionMode;
use tapd_i18n::{tr, tr_args};

fn runtime(app: &AppHandle) -> Result<Arc<RuntimeState>, String> {
    app.try_state::<Arc<RuntimeState>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| tr("dsh.state.unavailable").to_string())
}

fn bridge(app: &AppHandle) -> Result<Arc<BridgeState>, String> {
    app.try_state::<Arc<BridgeState>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| tr("dsh.bridge.unavailable").to_string())
}

// ---------------------------------------------------------------------------
// Operations (shared by both adapters)
// ---------------------------------------------------------------------------

pub fn status(app: &AppHandle) -> Result<DshStatus, String> {
    Ok(runtime(app)?.status_for(app))
}

pub async fn start(app: &AppHandle) -> Result<DshStatus, String> {
    let status = runtime(app)?.ensure_ready(app).await?;
    after_runtime_up(app).await;
    // Any start path clears a startup failure the guard recorded, so the
    // failure modal cannot outlive the runtime it was about.
    crate::service_guard::mark_up(app, crate::service_guard::Service::Agent);
    Ok(status)
}

/// Stops and starts in one step so startup-only settings (permission mode,
/// model catalog, coworkers) take effect. Unlike `start`, it is not a no-op
/// while the process is alive.
pub async fn restart(app: &AppHandle) -> Result<DshStatus, String> {
    let status = runtime(app)?.restart(app).await?;
    after_runtime_up(app).await;
    crate::service_guard::mark_up(app, crate::service_guard::Service::Agent);
    Ok(status)
}

/// Post-start work shared by `start` and `restart`: re-arm the queue against
/// the live sessions, then recover tasks the previous process left mid-merge.
///
/// App restart semantics: queued tasks are rescheduled against the live
/// sessions the new runtime has. A row persisted as running without a live
/// session does not hold a slot; it is marked interrupted and waits for the user
/// to continue it.
async fn after_runtime_up(app: &AppHandle) {
    if let Err(error) = super::tasks::schedule(app).await {
        tracing::warn!(%error, "queued dsh tasks were not scheduled");
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        super::tasks::recover_finalizing(&handle).await;
        // Rows whose turn died with the previous process: the workflow stays
        // running, but the list must not paint them as working.
        super::tasks::recover_interrupted(&handle).await;
    });
}

/// Stops the current turn of one session without ending the task. `turn/end`
/// follows from the runtime, so the workflow still settles normally. Requests
/// the turn was blocked on are answered `cancelled` and removed here: leaving
/// them pending would keep a card that can never do anything.
pub async fn cancel_turn(app: &AppHandle, session_id: &str) -> Result<Value, String> {
    if let Ok(runtime) = runtime(app) {
        for request in runtime.pending_for_session(session_id) {
            let result = match request.kind {
                super::runtime::PendingKind::Approval => json!({ "outcome": "cancelled" }),
                super::runtime::PendingKind::Question => json!({ "cancelled": true }),
            };
            let _ = runtime.respond(request.rpc_id, result).await;
            let _ = app.emit(super::EVENT_SETTLED, json!({ "rpcId": request.rpc_id }));
        }
    }
    // A restored task has no live turn; the cancel is still a success.
    if let Err(error) = bridge(app)?.cancel_session(session_id).await {
        tracing::debug!(%error, session = session_id, "no live turn to cancel");
    }
    Ok(json!({ "ok": true }))
}

pub async fn stop(app: &AppHandle) -> Result<DshStatus, String> {
    let state = runtime(app)?;
    state.stop(app).await?;
    Ok(state.status())
}

/// Newest first (shape in `docs/DSH.md` §8.4). Wrapped so the desktop invoke
/// and the phone's feature proxy share one shape (it mirrors `dsh://sessions`).
pub fn sessions(app: &AppHandle) -> Result<Value, String> {
    let sessions = bridge(app)?.sessions();
    Ok(json!({ "sessions": sessions }))
}

/// Requests the runtime is still blocked on, so a page opened after the event
/// can still render the approval / question card.
pub fn pending(app: &AppHandle) -> Result<Value, String> {
    let requests = runtime(app)?.pending();
    Ok(json!({ "requests": requests }))
}

pub async fn session_entries(
    app: &AppHandle,
    session_id: &str,
    since_seq: Option<u64>,
) -> Result<Value, String> {
    let bridge = bridge(app)?;
    let since = since_seq.unwrap_or(0);
    // A persisted selection from before a restart names a session this process
    // has not seen yet. That is a "gone" state, not a failure: `known: false`
    // lets the UI fall back instead of rendering an error panel.
    let known = match bridge.entries_since(session_id, since) {
        Some(entries) => Some(entries),
        None => {
            // The runtime resumes sessions lazily and may not even be running,
            // so fall back to dsh's own log: history must not depend on either.
            // Decompression is file IO, so it runs off the async runtime; the
            // transcript lock is only taken for the pure ingest pass.
            let Some(sessions_dir) = dsh_sessions_dir(app) else {
                return Ok(unknown_session(session_id));
            };
            let handle = app.clone();
            let id = session_id.to_string();
            let restored = tauri::async_runtime::spawn_blocking(move || {
                let Some(bridge) = handle.try_state::<Arc<BridgeState>>() else {
                    return false;
                };
                let bridge = bridge.inner().clone();
                if !bridge.hydrate_from_log(&sessions_dir, &id) {
                    return false;
                }
                // The log carries token totals; the meter table carries the split.
                bridge.restore_meter(&handle, &id);
                // Publish so the session row (and its figures) survives a restart.
                bridge.publish_sessions(&handle);
                true
            })
            .await
            .map_err(|error| error.to_string())?;
            if restored {
                bridge.entries_since(session_id, since)
            } else {
                None
            }
        }
    };
    let Some((entries, last_seq)) = known else {
        return Ok(unknown_session(session_id));
    };
    Ok(json!({
        "sessionId": session_id,
        "known": true,
        "entries": entries,
        "lastSeq": last_seq,
    }))
}

/// The documented fallback shape for a session this process cannot see.
fn unknown_session(session_id: &str) -> Value {
    json!({
        "sessionId": session_id,
        "known": false,
        "entries": [],
        "lastSeq": 0,
    })
}

/// Where dsh keeps its own session logs (`$DSH_HOME/sessions`).
fn dsh_sessions_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    super::session_log::dir(app)
}

/// A manual session is always a free chat; the optional project only groups it
/// and supplies its default cwd (§11 of the task-flow contract).
pub async fn new_session_in(
    app: &AppHandle,
    project: Option<super::tasks::ProjectRef>,
) -> Result<Value, String> {
    super::tasks::new_session(app, project).await
}

/// Everything user input needs before it can reach a session: a registry row,
/// a live runtime, a reopened task row, the chat's own directory, a resumed
/// Agent and the mirrored task phase.
///
/// Shared by `prompt`, `retry_turn` and `run_command` so a slash command can
/// never reach a session that a prompt could not (and vice versa). A queued
/// task is rejected: a turn run now would settle back into Queued and its work
/// would never reach review, merge or writeback.
async fn prepare_for_input(
    app: &AppHandle,
    session_id: &str,
    reopen: bool,
) -> Result<(), String> {
    if super::tasks::workflow_of(app, session_id).await == Some(super::tasks::Workflow::Queued) {
        return Err(tr("dsh.task.queued").to_string());
    }
    bridge(app)?.create_session(app, session_id);
    let state = runtime(app)?;
    state.ensure_ready(app).await?;
    // Input on a finished or failed task makes it active again before the first
    // event lands: the row must not say "已完成" while it works. A slash command
    // is not work — `/compact` must not start a new round for a settled task.
    if reopen {
        if let Err(error) = super::tasks::reopen_for_input(app, session_id).await {
            tracing::warn!(%error, session = session_id, "task row was not reopened");
        }
    }
    // A free chat works in its worktree, its project repository, or its own
    // scratch directory — in that order. A session with no project must never
    // read or write a repository the user did not choose. Tasks assign their
    // worktree through the scheduler, so they never reach this branch.
    if super::tasks::kind_of(app, session_id).await == Some(super::tasks::TaskKind::Chat) {
        if let Some(cwd) = super::tasks::chat_cwd(app, session_id).await {
            if let Ok(bridge) = bridge(app) {
                if let Err(error) = bridge.assign_session(session_id, &cwd).await {
                    tracing::warn!(%error, session = session_id, "chat cwd was not assigned");
                }
            }
        }
    }
    // A session restored from a previous run is not open in the runtime: the
    // SDK would answer with a fresh empty session under the same id. History
    // loads from the log, so the attach has to happen before the first send.
    let restored = dsh_sessions_dir(app)
        .and_then(|dir| super::session_log::path(&dir, session_id))
        .is_some();
    if restored {
        state.resume_session(app, session_id).await?;
    }
    // Creates a new Agent before the input (and re-applies the route) so the
    // very first step uses the session's chosen model.
    state.prepare_session(app, session_id, !restored).await;
    // A task restored from a previous run may still point at a worktree the
    // finishing chain removed; the input must land in the repository.
    super::tasks::ensure_session_cwd(app, session_id).await;
    // The phase frame and the prompt use different channels; await the plugin's
    // ack so the first step already sees the right tools and prompt section.
    super::tasks::sync_phase(app, session_id).await?;
    Ok(())
}

/// One encoded image the composer attaches to a prompt. dsh admits exactly
/// these four media types; the bytes are canonical base64 without a `data:`
/// prefix.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptImage {
    pub data: String,
    pub mime_type: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// Ensures the runtime is up, then queues one prompt. The registry row exists
/// before the call, so the session is listable even if the model call fails.
pub async fn prompt(
    app: &AppHandle,
    session_id: &str,
    text: &str,
    images: Vec<PromptImage>,
) -> Result<Value, String> {
    prepare_for_input(app, session_id, true).await?;
    let state = runtime(app)?;
    let mut blocks = Vec::with_capacity(images.len() + 1);
    for image in images {
        blocks.push(ContentBlock::Image {
            data: image.data,
            mime_type: image.mime_type,
            name: image.name,
        });
    }
    if !text.trim().is_empty() {
        blocks.push(ContentBlock::Text {
            text: text.to_string(),
        });
    }
    let receipt = state.query_blocks(app, session_id, blocks).await?;
    // The composer's ↑ history: recorded here so every prompt a human typed
    // (chat, continue, retry follow-up) is remembered, while the task
    // scheduler's own prompts bypass this function and stay out of it.
    if !text.trim().is_empty() {
        remember_prompt(app, session_id, text);
    }
    Ok(json!({ "sessionId": session_id, "receipt": receipt }))
}

/// The engine's human slash-command catalog for one session (globals plus that
/// Agent's scoped shadows). A chat with no session yet lists the global layer.
///
/// Every failure answers with an empty catalog instead of an error: the palette
/// keeps its own eight commands, so a stopped or missing runtime must not turn
/// opening `/` into a failed IPC.
pub async fn commands(app: &AppHandle, session_id: Option<&str>) -> Result<Value, String> {
    let empty = || json!({ "commands": [] });
    let Ok(state) = runtime(app) else {
        return Ok(empty());
    };
    if state.ensure_ready(app).await.is_err() {
        return Ok(empty());
    }
    let Ok(bridge) = bridge(app) else {
        return Ok(empty());
    };
    match bridge.list_commands(session_id).await {
        Ok(commands) => Ok(json!({ "commands": commands })),
        Err(error) => {
            tracing::debug!(%error, "command catalog is unavailable");
            Ok(empty())
        }
    }
}

/// Runs one slash-command line through the engine registry. Only admission is
/// awaited; the row and its result follow as `command/run` / `command/done`.
pub async fn run_command(
    app: &AppHandle,
    session_id: &str,
    line: &str,
) -> Result<Value, String> {
    // A command never reopens a settled task: it is not a work round.
    prepare_for_input(app, session_id, false).await?;
    let reply = bridge(app)?.run_command(session_id, line).await?;
    Ok(json!({
        "sessionId": session_id,
        "name": reply.get("name").cloned().unwrap_or(Value::Null),
    }))
}

/// Records one human prompt for the composer's ↑ history. Best effort: a cache
/// that is disabled (or a failed write) must never fail the prompt it describes.
fn remember_prompt(app: &AppHandle, session_id: &str, text: &str) {
    let Some(state) = app.try_state::<Arc<crate::state::AppState>>() else {
        return;
    };
    let cache = state.inner().cache.clone();
    let session_id = session_id.to_string();
    let text = text.to_string();
    let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = super::prompt_store::remember(&cache, &session_id, &text, &at) {
            tracing::warn!(%error, session = %session_id, "prompt history was not written");
        }
    });
}

/// The newest distinct prompts across sessions, newest first (↑ history).
pub async fn prompt_history(app: &AppHandle, limit: u32) -> Result<Value, String> {
    let state = app
        .try_state::<Arc<crate::state::AppState>>()
        .ok_or_else(|| tr("dsh.state.unavailable").to_string())?;
    let cache = state.inner().cache.clone();
    let texts = tauri::async_runtime::spawn_blocking(move || {
        super::prompt_store::recent(&cache, limit)
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(json!({ "prompts": texts }))
}

/// Packs one session's raw log into `dir` (`/export`).
pub async fn export_session(
    app: &AppHandle,
    session_id: &str,
    dir: &str,
) -> Result<Value, String> {
    let app = app.clone();
    let session_id = session_id.to_string();
    let dir = std::path::PathBuf::from(dir);
    tauri::async_runtime::spawn_blocking(move || {
        super::export::export(&app, &session_id, &dir)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Re-runs a failed turn without sending its prompt a second time.
///
/// dsh's own retry shape is an empty user message tagged `source.kind = retry`:
/// the turn runs again from the same context and the transcript skips the
/// message, so the prompt never lands in the model's context twice. The SDK
/// exposes no such call, so it travels over the bridge control channel the same
/// way `cancel` does. A retry is new input, so a task that had settled as
/// done/failed is working again.
pub async fn retry_turn(app: &AppHandle, session_id: &str) -> Result<Value, String> {
    // Same prelude as a prompt, including the chat cwd: a retried round must not
    // inherit a worktree that no longer exists.
    prepare_for_input(app, session_id, true).await?;
    bridge(app)?.retry_session(session_id)?;
    Ok(json!({ "sessionId": session_id, "ok": true }))
}

/// Switches one session's model route. The choice is durable in that session's
/// log (dsh records `model/selection`), and it is remembered for the next
/// prompt even when the runtime is stopped.
pub fn select_model(
    app: &AppHandle,
    session_id: &str,
    selection: ModelSelection,
) -> Result<Value, String> {
    let bridge = bridge(app)?;
    let runtime = runtime(app)?;
    // Only a ready runtime has a fixed profile. A stopped one renders the
    // current settings on the next start, so any configured route is accepted.
    if runtime.status().phase == Phase::Ready {
        if !runtime.route_available(&selection) {
            return Err(tr("dsh.model.unavailable").to_string());
        }
        // A control frame can race the plugin's connect; the choice is already
        // remembered and the next prompt retries it, so this stays best effort.
        if let Err(error) = bridge.select_model(session_id, &selection) {
            tracing::warn!(%error, session = session_id, "model selection was not queued");
        }
    } else {
        bridge.remember_selection(session_id, selection);
    }
    Ok(json!({ "ok": true }))
}

/// One session's permission mode; `mode: null` means "inherit the default".
pub async fn session_mode(app: &AppHandle, session_id: &str) -> Result<Value, String> {
    let state = app
        .try_state::<Arc<crate::state::AppState>>()
        .ok_or_else(|| tr("dsh.state.unavailable").to_string())?;
    let cache = state.inner().cache.clone();
    let id = session_id.to_string();
    let mode = tauri::async_runtime::spawn_blocking(move || super::mode_store::load(&cache, &id))
        .await
        .map_err(|error| error.to_string())??;
    Ok(json!({ "sessionId": session_id, "mode": mode }))
}

/// Sets one session's permission mode and/or plan flag. Both take effect on the
/// next tool call: the policy gate reads them per call, and the engine applies a
/// queued plan selection at the next accepted step. A stopped runtime keeps the
/// choice and replays it on the next prompt.
pub async fn set_session_mode(
    app: &AppHandle,
    session_id: &str,
    mode: Option<&str>,
    plan: Option<bool>,
) -> Result<Value, String> {
    let parsed = match mode {
        Some(raw) => Some(
            PermissionMode::parse(raw)
                .ok_or_else(|| tr_args("dsh.policy.unknown", &[&raw]))?,
        ),
        None => None,
    };
    if let Some(mode) = parsed {
        let state = app
            .try_state::<Arc<crate::state::AppState>>()
            .ok_or_else(|| tr("dsh.state.unavailable").to_string())?;
        let cache = state.inner().cache.clone();
        let id = session_id.to_string();
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        tauri::async_runtime::spawn_blocking(move || {
            super::mode_store::save(&cache, &id, mode, &at)
        })
        .await
        .map_err(|error| error.to_string())??;
    }

    let bridge = bridge(app)?;
    if let Some(mode) = parsed {
        // Remembered inside the bridge call; a missing plugin only means the
        // frame waits for the next prompt.
        if let Err(error) = bridge.set_session_mode(session_id, mode) {
            tracing::debug!(%error, session = session_id, "session mode was not queued");
        }
    }
    if let Some(active) = plan {
        if let Err(error) = bridge.set_plan(session_id, active) {
            tracing::debug!(%error, session = session_id, "plan mode was not queued");
        }
    }
    Ok(json!({
        "sessionId": session_id,
        "mode": parsed,
        "plan": plan,
    }))
}

/// Only `allowed-once` grants the operation.
pub async fn approval_answer(app: &AppHandle, rpc_id: u64, outcome: &str) -> Result<(), String> {
    let outcome = match outcome {
        "allowed-once" | "allowed_once" | "allow" => ApprovalOutcome::AllowedOnce,
        "rejected" | "reject" => ApprovalOutcome::Rejected,
        _ => ApprovalOutcome::Cancelled,
    };
    let result = serde_json::to_value(ApprovalRequestResult { outcome })
        .map_err(|error| error.to_string())?;
    runtime(app)?.respond(rpc_id, result).await?;
    emit_settled(app, rpc_id);
    Ok(())
}

/// `answers: None` dismisses the whole request; dismissal is never approval.
pub async fn question_answer(
    app: &AppHandle,
    rpc_id: u64,
    answers: Option<Vec<AnswerItem>>,
) -> Result<(), String> {
    let result = match answers {
        Some(answers) => serde_json::to_value(UserQuestionResult::Answers { answers }),
        None => serde_json::to_value(UserQuestionResult::Cancelled { cancelled: true }),
    }
    .map_err(|error| error.to_string())?;
    runtime(app)?.respond(rpc_id, result).await?;
    emit_settled(app, rpc_id);
    Ok(())
}

/// Tells every other surface that one request was answered. The answering
/// surface removes its card itself; the capsule polls `pending`, but the
/// webview (and the phone) only learn about the answer through this event.
fn emit_settled(app: &AppHandle, rpc_id: u64) {
    let _ = app.emit(super::EVENT_SETTLED, json!({ "rpcId": rpc_id }));
}

// ---------------------------------------------------------------------------
// JSON dispatch (feature_router)
// ---------------------------------------------------------------------------

/// `sinceSeq` is optional so the desktop's full read stays byte-identical; the
/// phone passes the previous `lastSeq` and receives only the new rows.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionEntriesPayload {
    session_id: String,
    #[serde(default)]
    since_seq: Option<u64>,
}

/// A command that is about one existing session id.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRequest {
    session_id: String,
}

/// One worktree directory under the app's own worktree root.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeRequest {
    path: String,
}

/// A new session, optionally scoped to one project group.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewSessionPayload {
    #[serde(default)]
    project: Option<super::tasks::ProjectRef>,
}

/// The chat worktree toggle.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatWorktreePayload {
    session_id: String,
    enabled: bool,
}

/// One session-mode write. Both fields are optional so a plan toggle does not
/// rewrite the permission mode; at least one must be present.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionModePayload {
    session_id: String,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    plan: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptPayload {
    session_id: String,
    text: String,
    #[serde(default)]
    images: Vec<PromptImage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectModelPayload {
    session_id: String,
    provider: String,
    model: String,
    #[serde(default)]
    reasoning_effort: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalPayload {
    rpc_id: u64,
    outcome: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuestionPayload {
    rpc_id: u64,
    #[serde(default)]
    answers: Option<Vec<AnswerItem>>,
}

/// One draft provider the settings page wants the model list for. The
/// provider id is display-only here: the listing comes from the endpoint, not
/// from the installed catalog, so the host needs no running runtime.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverPayload {
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api: String,
    #[serde(default)]
    api_key: Option<String>,
}

fn parse<T: for<'de> Deserialize<'de>>(payload: Value, name: &str) -> Result<T, String> {
    serde_json::from_value(payload)
        .map_err(|error| tr_args("dsh.args.invalid", &[&name, &error]))
}

/// Dispatches one `dsh_*` feature command. Every name is also an arm of the
/// companion allowlist (`companion/feature.rs`).
pub async fn command(app: &AppHandle, name: &str, payload: Value) -> Result<Value, String> {
    match name {
        "dsh_status" => serde_json::to_value(status(app)?).map_err(|error| error.to_string()),
        "dsh_start" => serde_json::to_value(start(app).await?).map_err(|error| error.to_string()),
        "dsh_stop" => serde_json::to_value(stop(app).await?).map_err(|error| error.to_string()),
        "dsh_restart" => {
            serde_json::to_value(restart(app).await?).map_err(|error| error.to_string())
        }
        "dsh_session_cancel" => {
            let request: SessionRequest = parse(payload, "dsh_session_cancel")?;
            cancel_turn(app, &request.session_id).await
        }
        "dsh_session_retry" => {
            let request: SessionRequest = parse(payload, "dsh_session_retry")?;
            retry_turn(app, &request.session_id).await
        }
        "dsh_session_mode_get" => {
            let request: SessionRequest = parse(payload, "dsh_session_mode_get")?;
            session_mode(app, &request.session_id).await
        }
        "dsh_session_mode_set" => {
            let request: SessionModePayload = parse(payload, "dsh_session_mode_set")?;
            set_session_mode(
                app,
                &request.session_id,
                request.mode.as_deref(),
                request.plan,
            )
            .await
        }
        "dsh_worktrees" => super::tasks::worktrees(app).await,
        "dsh_projects" => super::tasks::projects(app).await,
        "dsh_chat_worktree" => {
            let request: ChatWorktreePayload = parse(payload, "dsh_chat_worktree")?;
            super::tasks::chat_worktree(app, &request.session_id, request.enabled).await
        }
        "dsh_session_dir" => {
            let request: SessionRequest = parse(payload, "dsh_session_dir")?;
            super::tasks::session_dir(app, &request.session_id).await
        }        "dsh_worktree_remove" => {
            let request: WorktreeRequest = parse(payload, "dsh_worktree_remove")?;
            super::tasks::remove_worktree(app, &request.path).await
        }
        "dsh_plugins" => {
            // The panel reads the live runtime: a stopped one has no Loader.
            runtime(app)?.ensure_ready(app).await?;
            let entries = bridge(app)?.plugin_inventory().await?;
            Ok(json!({ "entries": entries }))
        }
        "dsh_tools" => {
            // Same source rule as plugins: the registry exists only while the
            // runtime is up, so the panel starts it instead of inventing rows.
            runtime(app)?.ensure_ready(app).await?;
            let tools = bridge(app)?.tool_inventory().await?;
            Ok(json!({ "tools": tools }))
        }
        "dsh_sessions" => sessions(app),
        name if name.starts_with("dsh_team_") => super::team::command(app, name, payload).await,
        name if name.starts_with("dsh_task") => super::tasks::command(app, name, payload).await,
        name if name.starts_with("dsh_policy_") => super::policy::command(app, name, payload).await,
        "dsh_pending" => pending(app),
        "dsh_session_entries" => {
            let request: SessionEntriesPayload = parse(payload, "dsh_session_entries")?;
            session_entries(app, &request.session_id, request.since_seq).await
        }
        "dsh_prompt" => {
            let request: PromptPayload = parse(payload, "dsh_prompt")?;
            prompt(app, &request.session_id, &request.text, request.images).await
        }
        "dsh_select_model" => {
            let request: SelectModelPayload = parse(payload, "dsh_select_model")?;
            select_model(
                app,
                &request.session_id,
                ModelSelection {
                    provider: request.provider,
                    model: request.model,
                    reasoning_effort: request.reasoning_effort,
                },
            )
        }
        "dsh_new_session" => {
            let request: NewSessionPayload = parse(payload, "dsh_new_session")?;
            new_session_in(app, request.project).await
        }
        "dsh_models_discover" => {
            let request: DiscoverPayload = parse(payload, "dsh_models_discover")?;
            let models = super::discovery::discover(
                &request.base_url,
                &request.api,
                request.api_key.as_deref(),
            )
            .await?;
            Ok(json!({ "models": models }))
        }
        "dsh_approval_answer" => {
            let request: ApprovalPayload = parse(payload, "dsh_approval_answer")?;
            approval_answer(app, request.rpc_id, &request.outcome).await?;
            Ok(json!({ "ok": true }))
        }
        "dsh_question_answer" => {
            let request: QuestionPayload = parse(payload, "dsh_question_answer")?;
            question_answer(app, request.rpc_id, request.answers).await?;
            Ok(json!({ "ok": true }))
        }
        other => Err(format!("unknown dsh command: {other}")),
    }
}
