//! Shared TAPD write-back helpers for bugs.
//!
//! Both the in-app detail panel and the MCP sidecar need the same internal
//! endpoints for comments, inline field edits and workflow transitions. They
//! live here so the two callers cannot drift apart; policy/audit decisions stay
//! in the caller.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{commands::session_request_json, session};

const COMMENT_URL: &str = "https://www.tapd.cn/api/entity/comments/add_comment";
const INLINE_UPDATE_URL: &str = "https://www.tapd.cn/api/entity/bugs/inline_update";
const TRANSITION_INFO_URL: &str =
    "https://www.tapd.cn/api/aggregation/bug_aggregation/get_bug_transition_info";
const KANBAN_TRANSITION_URL: &str =
    "https://www.tapd.cn/api/aggregation/kanban_aggregation/transition";
const WORKFLOW_TRANSITION_URL: &str = "https://www.tapd.cn/api/entity/workflow/transition";
const STARTING_STATUSES: &[&str] = &["new", "open", "reopened"];
const PROCESSING_STATUSES: &[&str] = &["in_progress", "progressing"];

/// Fields the detail panel may edit inline. `current_owner` is 处理人 and `de`
/// is 开发人员; everything else keeps TAPD's own UI as the source of truth.
pub const EDITABLE_USER_FIELDS: &[&str] = &["current_owner", "de"];

#[derive(Clone, Debug, Default)]
pub(crate) struct TransitionInfo {
    pub current_status: String,
    pub status_alias: std::collections::BTreeMap<String, String>,
    pub transitions: Vec<(String, String)>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransitionStep {
    pub from: String,
    pub to: String,
    pub label: String,
}

#[derive(Clone, Debug)]
pub(crate) struct TransitionOutcome {
    pub original_status: String,
    pub status: String,
    pub label: String,
    pub steps: Vec<TransitionStep>,
}

/// Adds a plain-text comment to a bug (TAPD stores it as simple HTML).
pub(crate) async fn add_comment(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
    comment: &str,
) -> Result<Value, String> {
    let mut body = json!({
        "entity_id": bug_id,
        "workspace_id": workspace_id,
        "entity_type": "bug",
        "description": comment_html(comment),
        "markdown_description": "",
        "description_type": 1,
        "reply_id": "",
        "root_id": "",
        "program_id": "",
        "workflow_step": "",
        "comment_location": "",
        "npc_repo_path": "",
        "attachment_ids": [],
    });
    if let Some(token) = dsc_token(app) {
        body["dsc_token"] = json!(token);
    }

    let root = session_request_json(app, "POST", COMMENT_URL, Some(body), Duration::from_secs(45))
        .await?;
    ensure_api_ok(&root, "添加评论")?;

    tracing::info!(bug_id, workspace_id, "added bug comment");
    Ok(root.get("data").cloned().unwrap_or(Value::Null))
}

/// Updates one user field through TAPD's inline-edit endpoint.
///
/// `value` must already be normalized to TAPD's `nick;` storage format.
pub(crate) async fn update_field(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
    field: &str,
    value: &str,
) -> Result<(), String> {
    let mut body = json!({
        "workspace_id": workspace_id,
        "data": {
            "id": bug_id,
            "field": field,
            "value": value,
            "field_name_is_alias": false,
        },
    });
    if let Some(token) = dsc_token(app) {
        body["dsc_token"] = json!(token);
    }

    let root = session_request_json(
        app,
        "POST",
        INLINE_UPDATE_URL,
        Some(body),
        Duration::from_secs(45),
    )
    .await?;
    ensure_api_ok(&root, "修改字段")?;

    tracing::info!(bug_id, workspace_id, field, "updated bug field");
    Ok(())
}

/// Normalizes a user-field value to TAPD's `nick;nick` storage form.
pub(crate) fn normalize_user_value(value: &str) -> String {
    let names: Vec<&str> = value
        .split([';', '|', ',', '，', '、'])
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    names.join(";")
}

pub(crate) async fn load_transition_info(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<TransitionInfo, String> {
    let url = format!(
        "{TRANSITION_INFO_URL}?workspace_id={workspace_id}&bug_id={bug_id}&program_id=&has_rule_fields=undefined&check_rule_fields=undefined"
    );
    let root = session_request_json(app, "GET", &url, None, Duration::from_secs(45)).await?;
    ensure_api_ok(&root, "读取状态流转信息")?;

    let data = root
        .pointer("/data/get_workflow_by_bug/data")
        .ok_or_else(|| "unexpected transition info response".to_string())?;
    let current_status = data
        .get("current_status")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let status_alias: std::collections::BTreeMap<String, String> = data
        .get("status_alias")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|label| (key.clone(), label.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    let mut transitions: Vec<(String, String)> = Vec::new();
    if let Some(items) = data.get("my_all_transitions").and_then(Value::as_array) {
        for item in items {
            let previous = item
                .get("StepPrevious")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !previous.is_empty() && previous != current_status {
                continue;
            }
            let next = item
                .get("StepNext")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if next.is_empty() || next == current_status {
                continue;
            }
            let label = item
                .get("to_name")
                .and_then(Value::as_str)
                .filter(|label| !label.trim().is_empty())
                .map(str::to_string)
                .or_else(|| status_alias.get(next).cloned())
                .unwrap_or_else(|| next.to_string());
            if !transitions.iter().any(|(key, _)| key == next) {
                transitions.push((next.to_string(), label));
            }
        }
    }

    Ok(TransitionInfo {
        current_status,
        status_alias,
        transitions,
    })
}

pub(crate) fn resolve_status_key(input: &str, info: &TransitionInfo) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("status is empty".to_string());
    }
    if info.status_alias.contains_key(input) {
        return Ok(input.to_string());
    }
    if let Some((key, _)) = info
        .status_alias
        .iter()
        .find(|(_, label)| label.trim() == input)
    {
        return Ok(key.clone());
    }

    let normalized: String = input
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '/' && *character != '\\')
        .collect();
    let key = match normalized.as_str() {
        "新" | "新建" => "new",
        "待处理" => "open",
        "接受" | "接受处理" => "in_progress",
        "处理中" => "progressing",
        "已解决" | "已修复" => "resolved",
        "已验证" => "verified",
        "已关闭" => "closed",
        "已拒绝" => "rejected",
        "重新打开" => "reopened",
        _ => {
            let known: Vec<String> = info
                .status_alias
                .iter()
                .map(|(key, label)| format!("{label} ({key})"))
                .collect();
            return Err(format!(
                "未知状态「{input}」；可用状态：{}",
                if known.is_empty() {
                    "无".to_string()
                } else {
                    known.join("、")
                }
            ));
        }
    };

    Ok(key.to_string())
}

pub(crate) fn info_label(status: &str, info: &TransitionInfo) -> String {
    info.status_alias
        .get(status)
        .cloned()
        .unwrap_or_else(|| status.to_string())
}

/// Moves a starting bug (`new` / `open` / `reopened`) into the workflow's
/// processing status.
///
/// Returns the performed step, or `None` when the bug is not in a starting
/// status or this workflow has no processing transition. Used by the
/// notification "处理" action, which must never invent a status key.
pub(crate) async fn accept_into_processing(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<Option<TransitionStep>, String> {
    let info = load_transition_info(app, workspace_id, bug_id).await?;
    if !STARTING_STATUSES.contains(&info.current_status.as_str()) {
        return Ok(None);
    }
    let Some((target, label)) = info
        .transitions
        .iter()
        .find(|(key, _)| PROCESSING_STATUSES.contains(&key.as_str()))
        .cloned()
    else {
        return Ok(None);
    };

    transition_once(
        app,
        workspace_id,
        bug_id,
        &info.current_status,
        &target,
        &Value::Null,
    )
    .await?;

    Ok(Some(TransitionStep {
        from: info.current_status,
        to: target,
        label,
    }))
}

/// Moves a bug to `target_input` (key or label), accepting `new` bugs through
/// the processing step first when the workflow requires it.
pub(crate) async fn perform_transition(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
    target_input: &str,
    fields: &Value,
) -> Result<TransitionOutcome, String> {
    let mut info = load_transition_info(app, workspace_id, bug_id).await?;
    let target = resolve_status_key(target_input, &info)?;
    let original_status = info.current_status.clone();
    let mut current_status = info.current_status.clone();
    let mut steps: Vec<TransitionStep> = Vec::new();

    if target != current_status {
        let mut allowed = info.transitions.clone();

        // Workflows usually require accepting a new bug before resolving it.
        if !allowed.iter().any(|(key, _)| *key == target)
            && STARTING_STATUSES.contains(&current_status.as_str())
        {
            if let Some((processing, label)) = allowed
                .iter()
                .find(|(key, _)| PROCESSING_STATUSES.contains(&key.as_str()))
                .cloned()
            {
                transition_once(
                    app,
                    workspace_id,
                    bug_id,
                    &current_status,
                    &processing,
                    fields,
                )
                .await?;
                steps.push(TransitionStep {
                    from: current_status.clone(),
                    to: processing.clone(),
                    label,
                });
                info = load_transition_info(app, workspace_id, bug_id).await?;
                current_status = info.current_status.clone();
                allowed = info.transitions.clone();
            }
        }

        if target != current_status {
            if !allowed.iter().any(|(key, _)| *key == target) {
                let allowed_labels: Vec<String> = allowed
                    .iter()
                    .map(|(key, label)| format!("{label} ({key})"))
                    .collect();
                return Err(format!(
                    "不能从「{}」流转到「{}」；当前允许的下一步：{}",
                    info.status_alias
                        .get(&current_status)
                        .cloned()
                        .unwrap_or_else(|| current_status.clone()),
                    info.status_alias
                        .get(&target)
                        .cloned()
                        .unwrap_or_else(|| target.clone()),
                    if allowed_labels.is_empty() {
                        "无".to_string()
                    } else {
                        allowed_labels.join("、")
                    }
                ));
            }

            transition_once(
                app,
                workspace_id,
                bug_id,
                &current_status,
                &target,
                fields,
            )
            .await?;
            steps.push(TransitionStep {
                from: current_status.clone(),
                to: target.clone(),
                label: info
                    .status_alias
                    .get(&target)
                    .cloned()
                    .unwrap_or_else(|| target.clone()),
            });
            current_status = target;
        }
    }

    let label = info_label(&current_status, &info);
    Ok(TransitionOutcome {
        original_status,
        status: current_status,
        label,
        steps,
    })
}

async fn transition_once(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
    current_status: &str,
    next_status: &str,
    fields: &Value,
) -> Result<(), String> {
    let mut kanban = json!({
        "workspace_id": workspace_id,
        "entity_id": bug_id,
        "entity_type": "bug",
        "current_status": current_status,
        "next_status": next_status,
        // TAPD 要求 from 非空，空字符串会直接返回 "from:不允许为空"。
        "from": current_status,
        "fields": fields,
        "is_manual": 1,
        "auto_complete": 0,
        "close_task": 0,
        "current_alias_status": "",
        "next_alias_status": "",
        "Timesheet": Value::Null,
        "check_required_fields": 1,
        "edit_rule_fields": [],
    });
    if let Some(token) = dsc_token(app) {
        kanban["dsc_token"] = json!(token);
    }

    let kanban_result = session_request_json(
        app,
        "POST",
        KANBAN_TRANSITION_URL,
        Some(kanban),
        Duration::from_secs(45),
    )
    .await;
    if let Ok(root) = &kanban_result {
        if api_ok(root) {
            tracing::info!(bug_id, current_status, next_status, "transitioned bug (kanban)");
            return Ok(());
        }
    }

    let mut workflow = json!({
        "workspace_id": workspace_id,
        "program_id": "",
        "entity_id": bug_id,
        "entity_type": "bug",
        "current_status": current_status,
        "next_status": next_status,
        "from": current_status,
        "fields": fields,
        "is_manual": 1,
        "auto_complete": 0,
        "close_task": 0,
        "current_alias_status": "",
        "next_alias_status": "",
        "Timesheet": Value::Null,
    });
    if let Some(token) = dsc_token(app) {
        workflow["dsc_token"] = json!(token);
    }

    let root = session_request_json(
        app,
        "POST",
        WORKFLOW_TRANSITION_URL,
        Some(workflow),
        Duration::from_secs(45),
    )
    .await
    .map_err(|error| {
        let kanban_message = kanban_result
            .err()
            .map(|error| error.to_string())
            .unwrap_or_else(|| "kanban 接口被拒绝".to_string());
        format!("状态流转失败：{error}（kanban：{kanban_message}）")
    })?;
    ensure_api_ok(&root, "状态流转")?;

    tracing::info!(bug_id, current_status, next_status, "transitioned bug (workflow)");
    Ok(())
}

fn comment_html(text: &str) -> String {
    let escaped = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    escaped
        .split('\n')
        .map(|line| {
            if line.trim().is_empty() {
                "<p><br /></p>".to_string()
            } else {
                format!("<p>{line}</p>")
            }
        })
        .collect()
}

fn dsc_token(app: &AppHandle) -> Option<String> {
    app.get_webview_window(session::SESSION_LABEL)
        .and_then(|window| session::cookie_value(&window, "dsc-token"))
}

pub(crate) fn api_ok(root: &Value) -> bool {
    match root.pointer("/meta/code") {
        Some(Value::Number(number)) => number.as_i64() == Some(0),
        Some(Value::String(code)) => code == "0",
        None => true,
        _ => false,
    }
}

fn api_message(root: &Value) -> String {
    root.pointer("/meta/message")
        .and_then(Value::as_str)
        .unwrap_or("unknown TAPD error")
        .to_string()
}

pub(crate) fn ensure_api_ok(root: &Value, action: &str) -> Result<(), String> {
    if api_ok(root) {
        Ok(())
    } else {
        Err(format!("{action}失败：{}", api_message(root)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comment_html_escapes_marks_and_keeps_paragraphs() {
        let html = comment_html("根因：<script>\n已修复 & 验证\n\n影响范围：聊天列表");
        assert_eq!(
            html,
            "<p>根因：&lt;script&gt;</p><p>已修复 &amp; 验证</p><p><br /></p><p>影响范围：聊天列表</p>"
        );
    }

    #[test]
    fn api_ok_accepts_zero_number_and_string() {
        assert!(api_ok(&json!({"meta": {"code": 0}})));
        assert!(api_ok(&json!({"meta": {"code": "0"}})));
        assert!(!api_ok(&json!({"meta": {"code": 10015, "message": "no"}})));
    }

    #[test]
    fn normalizes_user_values() {
        assert_eq!(normalize_user_value(" 夏遵阳 "), "夏遵阳");
        assert_eq!(normalize_user_value("张三;李四;"), "张三;李四");
        assert_eq!(normalize_user_value("张三，李四"), "张三;李四");
        assert_eq!(normalize_user_value("  "), "");
    }
}
