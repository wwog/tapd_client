//! TAPD write-back tools: transitions, comments and status changes.

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::{
    bug_write::{self, add_comment, load_transition_info, resolve_status_key},
    state::SharedState,
};

use super::{args::string_arg, session::resolve_call_workspace};

pub(super) async fn get_bug_transitions(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let (workspace_id, _) = resolve_call_workspace(app, state, arguments).await?;

    let info = load_transition_info(app, &workspace_id, &bug_id).await?;
    let transitions: Vec<Value> = info
        .transitions
        .iter()
        .map(|(key, label)| json!({ "key": key, "label": label }))
        .collect();

    Ok(json!({
        "bugId": bug_id,
        "currentStatus": info.current_status,
        "currentLabel": info.status_alias.get(&info.current_status),
        "statusOptions": info.status_alias,
        "transitions": transitions,
    }))
}

pub(super) async fn add_bug_comment(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let comment = string_arg(arguments, "comment")
        .or_else(|| string_arg(arguments, "body"))
        .ok_or_else(|| "comment is required".to_string())?;
    let (workspace_id, _) = resolve_call_workspace(app, state, arguments).await?;

    let data = add_comment(app, &workspace_id, &bug_id, &comment).await?;
    Ok(json!({
        "ok": true,
        "bugId": bug_id,
        "comment": data,
    }))
}

pub(super) async fn update_bug_status(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let target_input = string_arg(arguments, "status")
        .or_else(|| string_arg(arguments, "next_status"))
        .ok_or_else(|| "status is required".to_string())?;
    let (workspace_id, _) = resolve_call_workspace(app, state, arguments).await?;
    // The working accept workflow sends an empty array; keep the same shape
    // unless the caller supplies explicit transition fields.
    let fields = arguments
        .get("fields")
        .cloned()
        .unwrap_or_else(|| json!([]));

    // Comment first so a rejected transition still leaves the reason on record.
    let comment = string_arg(arguments, "comment");
    if let Some(comment) = comment.as_deref() {
        add_comment(app, &workspace_id, &bug_id, comment).await?;
    }

    let info = load_transition_info(app, &workspace_id, &bug_id).await?;
    let target = resolve_status_key(&target_input, &info)?;
    let policy = state.config_snapshot().mcp_policy;
    if !policy.allowed_statuses.is_empty()
        && !policy.allows_status(&target)
        && !policy.allows_status(&target_input)
    {
        return Err(format!(
            "状态「{}」不在 MCP 策略的状态白名单中",
            target_input
        ));
    }

    let outcome =
        bug_write::perform_transition(app, &workspace_id, &bug_id, &target, &fields).await?;

    Ok(json!({
        "ok": true,
        "bugId": bug_id,
        "from": outcome.original_status,
        "status": outcome.status,
        "label": outcome.label,
        "changed": !outcome.steps.is_empty(),
        "steps": outcome.steps,
        "commented": comment.is_some(),
    }))
}
