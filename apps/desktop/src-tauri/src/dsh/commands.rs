//! Tauri commands for the built-in agent runtime.
//!
//! Every command is a thin typed wrapper over [`super::feature`], which is also
//! what the paired phone reaches through `feature_router`. Keeping one
//! implementation means the desktop and the phone cannot drift apart.

use dsh_host::protocol::AnswerItem;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use super::feature;
use super::payload::{self, PayloadStatus};
use super::runtime::DshStatus;

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
pub async fn dsh_status(app: AppHandle) -> Result<DshStatus, String> {
    feature::status(&app)
}

/// Extracts the payload (first run) and starts + initializes the runtime.
#[tauri::command]
pub async fn dsh_start(app: AppHandle) -> Result<DshStatus, String> {
    feature::start(&app).await
}

#[tauri::command]
pub async fn dsh_stop(app: AppHandle) -> Result<DshStatus, String> {
    feature::stop(&app).await
}

/// Sessions, newest first, as `{ sessions: DshSession[] }`.
#[tauri::command]
pub async fn dsh_sessions(app: AppHandle) -> Result<Value, String> {
    feature::sessions(&app)
}

/// Normalized committed entries for one session.
#[tauri::command]
pub async fn dsh_session_entries(app: AppHandle, session_id: String) -> Result<Value, String> {
    feature::session_entries(&app, &session_id)
}

/// Approvals and questions the runtime is blocked on.
#[tauri::command]
pub async fn dsh_pending(app: AppHandle) -> Result<Value, String> {
    super::feature::pending(&app)
}

/// Allocates a session id and its registry row. The runtime creates the real
/// session on the first prompt.
#[tauri::command]
pub async fn dsh_new_session(app: AppHandle) -> Result<Value, String> {
    feature::new_session(&app).await
}

/// Queues one user message on a session.
#[tauri::command]
pub async fn dsh_prompt(
    app: AppHandle,
    session_id: String,
    text: String,
) -> Result<Value, String> {
    feature::prompt(&app, &session_id, &text).await
}

/// Answers one approval request. Only `allowed-once` grants the operation.
#[tauri::command]
pub async fn dsh_approval_answer(
    app: AppHandle,
    rpc_id: u64,
    outcome: String,
) -> Result<(), String> {
    feature::approval_answer(&app, rpc_id, &outcome).await
}

/// Answers a batch of questions; `answers: null` dismisses the whole request.
#[tauri::command]
pub async fn dsh_question_answer(
    app: AppHandle,
    rpc_id: u64,
    answers: Option<Vec<AnswerItem>>,
) -> Result<(), String> {
    feature::question_answer(&app, rpc_id, answers).await
}
