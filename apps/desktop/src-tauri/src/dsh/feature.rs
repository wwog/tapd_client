//! The `dsh_*` feature surface.
//!
//! One implementation serves both adapters: the Tauri commands in
//! [`super::commands`] and the `feature_router` / companion allowlist used by
//! the paired phone. Frontends therefore cannot diverge on behavior or shapes.
//!
//! Session state lives in [`BridgeState`]; these functions only translate
//! JSON payloads, call the runtime, and return the documented shapes.

use std::sync::Arc;

use dsh_host::protocol::{AnswerItem, ApprovalOutcome, ApprovalRequestResult, UserQuestionResult};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::bridge::BridgeState;
use super::runtime::{DshStatus, RuntimeState};
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
    Ok(runtime(app)?.status())
}

pub async fn start(app: &AppHandle) -> Result<DshStatus, String> {
    runtime(app)?.ensure_ready(app).await
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

pub fn session_entries(
    app: &AppHandle,
    session_id: &str,
    since_seq: Option<u64>,
) -> Result<Value, String> {
    let bridge = bridge(app)?;
    let since = since_seq.unwrap_or(0);
    // A persisted selection from before a restart names a session this process
    // has not seen yet. That is a "gone" state, not a failure: `known: false`
    // lets the UI fall back instead of rendering an error panel.
    let known = bridge.entries_since(session_id, since).or_else(|| {
        // The runtime resumes sessions lazily and may not even be running, so
        // fall back to dsh's own log: history must not depend on either.
        let sessions_dir = dsh_sessions_dir(app)?;
        if !bridge.hydrate_from_log(&sessions_dir, session_id) {
            return None;
        }
        // The log carries the usage counters too; publish them so the session
        // row (and its token figures) survives a restart.
        bridge.publish_sessions(app);
        bridge.entries_since(session_id, since)
    });
    let Some((entries, last_seq)) = known else {
        return Ok(json!({
            "sessionId": session_id,
            "known": false,
            "entries": [],
            "lastSeq": 0,
        }));
    };
    Ok(json!({
        "sessionId": session_id,
        "known": true,
        "entries": entries,
        "lastSeq": last_seq,
    }))
}

/// Where dsh keeps its own session logs (`$DSH_HOME/sessions`).
fn dsh_sessions_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.try_state::<std::sync::Arc<crate::state::AppState>>()
        .map(|state| state.paths.data_dir.join("dsh").join("home").join("sessions"))
}

/// Allocates an id and its (empty) registry row. The runtime creates the real
/// session on the first prompt.
pub async fn new_session(app: &AppHandle) -> Result<Value, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    bridge(app)?.create_session(app, &session_id);
    // Chats live in the same unified list as tasks, so the row exists before
    // the first message; `tasks::observe` names it from the first user line.
    super::tasks::create_chat(app, &session_id).await?;
    Ok(json!({ "sessionId": session_id }))
}

/// Ensures the runtime is up, then queues one prompt. The registry row exists
/// before the call, so the session is listable even if the model call fails.
pub async fn prompt(app: &AppHandle, session_id: &str, text: &str) -> Result<Value, String> {
    bridge(app)?.create_session(app, session_id);
    let state = runtime(app)?;
    state.ensure_ready(app).await?;
    // A session restored from a previous run is not open in the runtime: the
    // SDK would answer with a fresh empty session under the same id. History
    // loads from the log, so the attach has to happen before the first send.
    if let Some(dir) = dsh_sessions_dir(app) {
        if super::session_log::path(&dir, session_id).is_some() {
            state.resume_session(session_id).await?;
        }
    }
    let receipt = state.query(session_id, text).await?;
    Ok(json!({ "sessionId": session_id, "receipt": receipt }))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptPayload {
    session_id: String,
    text: String,
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
        "dsh_sessions" => sessions(app),
        name if name.starts_with("dsh_team_") => super::team::command(app, name, payload).await,
        name if name.starts_with("dsh_task") => super::tasks::command(app, name, payload).await,
        name if name.starts_with("dsh_policy_") => super::policy::command(app, name, payload).await,
        "dsh_pending" => pending(app),
        "dsh_session_entries" => {
            let request: SessionEntriesPayload = parse(payload, "dsh_session_entries")?;
            session_entries(app, &request.session_id, request.since_seq)
        }
        "dsh_prompt" => {
            let request: PromptPayload = parse(payload, "dsh_prompt")?;
            prompt(app, &request.session_id, &request.text).await
        }
        "dsh_new_session" => new_session(app).await,
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
