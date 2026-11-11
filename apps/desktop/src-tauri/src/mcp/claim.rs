//! External AI ownership: claim / release, sharing the desktop queue's
//! mutual-exclusion registry.

use serde_json::Value;
use tauri::AppHandle;

use crate::{agent, state::SharedState};

use super::{args::string_arg, session::resolve_call_workspace};

/// Registers an external AI claim so the desktop queue yields the bug and the
/// list shows who is working on it.
pub(super) async fn claim_bug(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
    client: &str,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let (workspace_id, _) = resolve_call_workspace(app, state, arguments).await?;

    let request = agent::ExternalClaimRequest {
        workspace_id,
        bug_id,
        title: string_arg(arguments, "title").unwrap_or_default(),
        client: client.to_string(),
        model: string_arg(arguments, "model").unwrap_or_default(),
        status: string_arg(arguments, "status").unwrap_or_default(),
        note: string_arg(arguments, "note").unwrap_or_default(),
    };
    agent::claim_external_from_mcp(app, request).await
}

pub(super) async fn release_bug(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
    client: &str,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let (workspace_id, _) = resolve_call_workspace(app, state, arguments).await?;

    agent::release_external_from_mcp(
        app,
        agent::ExternalReleaseRequest {
            workspace_id,
            bug_id,
            client: Some(client.to_string()),
        },
    )
}
