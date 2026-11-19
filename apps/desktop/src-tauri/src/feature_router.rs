//! Single Tauri command used by feature windows (notifications / agent console).
//!
//! Each feature owns its own module. Keeping one router avoids concurrent edits
//! to `lib.rs` and `generate_handler!` while features are developed.

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::state::SharedState;

pub async fn dispatch(
    app: &AppHandle,
    state: &SharedState,
    name: &str,
    payload: Value,
) -> Result<Value, String> {
    if name.starts_with("notification_") {
        crate::notification::command(app, state, name, payload).await
    } else if name.starts_with("settings_") {
        crate::agent_settings::command(app, name, payload).await
    } else if name.starts_with("coworker_") {
        crate::coworker::command(app, state, name, payload).await
    } else if name.starts_with("terminal_") {
        crate::terminal::command(app, name, payload).await
    } else if name.starts_with("cache_") {
        crate::cache::command(state, name, payload).await
    } else if name.starts_with("mcp_") {
        crate::mcp_import::command(state, name, payload).await
    } else if name.starts_with("local_") {
        crate::local::command::dispatch(app, state, name, payload).await
    } else if name.starts_with("dsh_") {
        // Built-in agent: the paired phone drives the same operations as the
        // desktop commands (`dsh::feature::command`).
        crate::dsh::feature::command(app, name, payload).await
    } else {
        Err(format!("unknown feature command: {name}"))
    }
}

#[tauri::command]
pub async fn feature_command(
    app: AppHandle,
    state: State<'_, SharedState>,
    name: String,
    payload: Value,
) -> Result<Value, String> {
    dispatch(&app, state.inner(), &name, payload).await
}
