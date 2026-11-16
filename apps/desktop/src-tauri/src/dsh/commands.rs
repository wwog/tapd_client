//! Tauri commands for the built-in agent runtime.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use super::payload::{self, PayloadStatus};
use super::runtime::{DshStatus, RuntimeState};
use dsh_host::protocol::{AnswerItem, ApprovalOutcome, ApprovalRequestResult, UserQuestionResult};

fn runtime(state: &State<'_, Arc<RuntimeState>>) -> Arc<RuntimeState> {
    state.inner().clone()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadReport {
    pub version: String,
    /// `env` | `dev` | `bundled` — where the payload was found.
    pub source: String,
    pub extracted: bool,
    pub archive: String,
    pub runtime_dir: String,
    pub archive_bytes: u64,
    pub unpacked_bytes: u64,
    pub files: u64,
}

fn report(status: PayloadStatus, manifest: &dsh_host::payload::PayloadManifest) -> PayloadReport {
    PayloadReport {
        version: status.version,
        source: match status.source {
            payload::PayloadSource::Env => "env",
            payload::PayloadSource::DevCheckout => "dev",
            payload::PayloadSource::Bundled => "bundled",
        }
        .to_string(),
        extracted: status.extracted,
        archive: status.archive.to_string_lossy().to_string(),
        runtime_dir: status.runtime_dir.to_string_lossy().to_string(),
        archive_bytes: manifest.bytes,
        unpacked_bytes: manifest.unpacked_bytes,
        files: manifest.files,
    }
}

/// Payload state without extracting anything (`extracted: false` means the
/// first start still has to unpack ~230 MB).
#[tauri::command]
pub async fn dsh_payload_status(app: AppHandle) -> Result<PayloadReport, String> {
    let (manifest, _, _) = payload::read_manifest(&app)?;
    let status = payload::status(&app)?;
    Ok(report(status, &manifest))
}

/// Extracts the payload ahead of the first prompt (the settings page can call
/// this while showing progress).
#[tauri::command]
pub async fn dsh_prepare(app: AppHandle) -> Result<PayloadReport, String> {
    let (manifest, _, _) = payload::read_manifest(&app)?;
    let status = tauri::async_runtime::spawn_blocking(move || payload::ensure_payload(&app))
        .await
        .map_err(|error| error.to_string())??;
    Ok(report(status, &manifest))
}

#[tauri::command]
pub async fn dsh_status(state: State<'_, Arc<RuntimeState>>) -> Result<DshStatus, String> {
    Ok(runtime(&state).status())
}

/// Extracts the payload (first run) and starts + initializes the runtime.
#[tauri::command]
pub async fn dsh_start(
    app: AppHandle,
    state: State<'_, Arc<RuntimeState>>,
) -> Result<DshStatus, String> {
    runtime(&state).ensure_ready(&app).await
}

#[tauri::command]
pub async fn dsh_stop(
    app: AppHandle,
    state: State<'_, Arc<RuntimeState>>,
) -> Result<DshStatus, String> {
    let runtime = runtime(&state);
    runtime.stop(&app).await?;
    Ok(runtime.status())
}

/// Allocates a session id. Sessions are created by the runtime on first prompt;
/// the id is ours to choose so tasks can be tracked before they start.
#[tauri::command]
pub async fn dsh_new_session() -> Result<Value, String> {
    Ok(json!({ "sessionId": uuid::Uuid::new_v4().to_string() }))
}

/// Queues one user message on a session.
#[tauri::command]
pub async fn dsh_prompt(
    app: AppHandle,
    state: State<'_, Arc<RuntimeState>>,
    session_id: String,
    text: String,
) -> Result<Value, String> {
    let runtime = runtime(&state);
    runtime.ensure_ready(&app).await?;
    runtime.query(&session_id, &text).await
}

/// Answers one approval request. Only `allowed-once` grants the operation.
#[tauri::command]
pub async fn dsh_approval_answer(
    state: State<'_, Arc<RuntimeState>>,
    rpc_id: u64,
    outcome: String,
) -> Result<(), String> {
    let outcome = match outcome.as_str() {
        "allowed-once" | "allowed_once" | "allow" => ApprovalOutcome::AllowedOnce,
        "rejected" | "reject" => ApprovalOutcome::Rejected,
        _ => ApprovalOutcome::Cancelled,
    };
    let result = serde_json::to_value(ApprovalRequestResult { outcome })
        .map_err(|error| error.to_string())?;
    runtime(&state).respond(rpc_id, result).await
}

/// Answers a batch of questions; `answers: null` dismisses the whole request.
#[tauri::command]
pub async fn dsh_question_answer(
    state: State<'_, Arc<RuntimeState>>,
    rpc_id: u64,
    answers: Option<Vec<AnswerItem>>,
) -> Result<(), String> {
    let result = match answers {
        Some(answers) => serde_json::to_value(UserQuestionResult::Answers { answers }),
        None => serde_json::to_value(UserQuestionResult::Cancelled { cancelled: true }),
    }
    .map_err(|error| error.to_string())?;
    runtime(&state).respond(rpc_id, result).await
}
