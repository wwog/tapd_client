//! Tauri commands for the built-in agent runtime.
//!
//! Every command is a thin typed wrapper over [`super::feature`], which is also
//! what the paired phone reaches through `feature_router`. Keeping one
//! implementation means the desktop and the phone cannot drift apart.

use dsh_host::protocol::AnswerItem;
use dsh_host::transcript::ModelSelection;
use serde::Serialize;
use serde_json::{json, Value};
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
pub async fn dsh_session_entries(
    app: AppHandle,
    session_id: String,
    since_seq: Option<u64>,
) -> Result<Value, String> {
    feature::session_entries(&app, &session_id, since_seq).await
}

/// Approvals and questions the runtime is blocked on.
#[tauri::command]
pub async fn dsh_pending(app: AppHandle) -> Result<Value, String> {
    super::feature::pending(&app)
}

/// Maps a path written in an agent reply onto a workbench file target.
///
/// `sessionId` supplies the base for relative paths; the result names the
/// workspace id (project, `__session__:<id>` or `__root__`) and the path
/// relative to it, so the desktop can open a file tab in the right scope.
#[tauri::command]
pub async fn dsh_file_target(
    app: AppHandle,
    session_id: String,
    path: String,
) -> Result<super::files::FileTarget, String> {
    super::files::resolve(&app, &session_id, &path)
}

/// Queues one user message on a session. `images` are encoded attachments
/// (canonical base64 + media type); an image-only prompt is legal, so `text`
/// may be empty when images are present.
#[tauri::command]
pub async fn dsh_prompt(
    app: AppHandle,
    session_id: String,
    text: String,
    images: Option<Vec<feature::PromptImage>>,
) -> Result<Value, String> {
    feature::prompt(&app, &session_id, &text, images.unwrap_or_default()).await
}

/// The engine's human slash-command catalog (globals plus the session's own
/// scoped rows). Omit `session_id` for a chat that has no session yet.
#[tauri::command]
pub async fn dsh_commands(app: AppHandle, session_id: Option<String>) -> Result<Value, String> {
    feature::commands(&app, session_id.as_deref()).await
}

/// Runs one slash-command line through the engine registry.
#[tauri::command]
pub async fn dsh_command_run(
    app: AppHandle,
    session_id: String,
    line: String,
) -> Result<Value, String> {
    feature::run_command(&app, &session_id, &line).await
}

/// Packs one session's raw log into `dir` (`/export`).
#[tauri::command]
pub async fn dsh_session_export(
    app: AppHandle,
    session_id: String,
    dir: String,
) -> Result<Value, String> {
    feature::export_session(&app, &session_id, &dir).await
}

/// Workspace files the composer's `@` panel may mention. `root` is the
/// session's execution root; without a session the composer passes the project
/// repository, so a brand-new chat completes against the same tree.
#[tauri::command]
pub async fn dsh_mentions(
    app: AppHandle,
    session_id: Option<String>,
    root: Option<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Value, String> {
    let resolved = match session_id.as_deref() {
        Some(session) if !session.is_empty() => {
            match super::tasks::session_dir(&app, session).await {
                Ok(value) => value
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                Err(_) => root.unwrap_or_default(),
            }
        }
        _ => root.unwrap_or_default(),
    };
    if resolved.trim().is_empty() {
        return Ok(json!({ "root": "", "items": [] }));
    }
    let limit = limit.unwrap_or(20);
    let search_root = resolved.clone();
    let items = tauri::async_runtime::spawn_blocking(move || {
        super::mentions::list(&search_root, &query, limit)
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(json!({ "root": resolved, "items": items }))
}

/// Newest distinct composer prompts across sessions (the ↑ history panel).
#[tauri::command]
pub async fn dsh_prompt_history(app: AppHandle, limit: Option<u32>) -> Result<Value, String> {
    feature::prompt_history(&app, limit.unwrap_or(50)).await
}

/// Every stored composer queue (`{ queues: [...] }`), read once on startup.
#[tauri::command]
pub async fn dsh_queue_load(app: AppHandle) -> Result<Value, String> {
    feature::queue_load(&app).await
}

/// Replaces one session's queue; an empty `items` array deletes the row.
#[tauri::command]
pub async fn dsh_queue_save(
    app: AppHandle,
    session_id: String,
    items: String,
    pause: Option<String>,
) -> Result<(), String> {
    feature::queue_save(&app, &session_id, &items, pause.as_deref()).await
}

/// Switches one session's model route; the choice is durable in its session log.
#[tauri::command]
pub async fn dsh_select_model(
    app: AppHandle,
    session_id: String,
    provider: String,
    model: String,
    reasoning_effort: Option<String>,
) -> Result<Value, String> {
    feature::select_model(
        &app,
        &session_id,
        ModelSelection {
            provider,
            model,
            reasoning_effort,
        },
    )
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
