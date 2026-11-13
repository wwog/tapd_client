//! Shared TAPD write-back helpers for bugs.
//!
//! Both the in-app detail panel and the MCP sidecar need the same internal
//! endpoints for comments, inline field edits and workflow transitions. They
//! live here so the two callers cannot drift apart; policy/audit decisions stay
//! in the caller.

use std::time::Duration;

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tapd_i18n::{tr, tr_args};
use tauri::{AppHandle, Manager};

use crate::{commands::auth::session_request_json, session};

const COMMENT_URL: &str = "https://www.tapd.cn/api/entity/comments/add_comment";
const INLINE_UPDATE_URL: &str = "https://www.tapd.cn/api/entity/bugs/inline_update";
const TRANSITION_INFO_URL: &str =
    "https://www.tapd.cn/api/aggregation/bug_aggregation/get_bug_transition_info";
/// Query values are free-form labels/ids, so encode everything that is not
/// unreserved for a query component.
const TRANSITION_FIELDS_URL: &str =
    "https://www.tapd.cn/api/entity/workflow/get_transition_fields";
const CHANGE_STATUS_URL: &str = "https://www.tapd.cn/api/entity/workflow/change_bug_status";
const QUERY_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');
const STARTING_STATUSES: &[&str] = &["new", "open", "reopened"];
const PROCESSING_STATUSES: &[&str] = &["in_progress", "progressing"];

/// One row of TAPD's transition form. `value` is already in TAPD's storage
/// shape (user fields as `昵称;`) so it can go straight into the request body.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransitionField {
    pub name: String,
    pub label: String,
    pub html_type: String,
    pub value: String,
    pub required: bool,
    pub disabled: bool,
    pub options: Vec<TransitionOption>,
}

/// One selectable value of a `select` / `radio` / `checkbox` transition field.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransitionOption {
    pub value: String,
    pub label: String,
}

/// Fields the detail panel may edit inline. `current_owner` is 处理人 and `de`
/// is 开发人员; everything else keeps TAPD's own UI as the source of truth.
pub const EDITABLE_USER_FIELDS: &[&str] = &["current_owner", "de"];

#[derive(Clone, Debug, Default)]
pub(crate) struct TransitionInfo {
    pub current_status: String,
    /// Current 处理人 as TAPD stores it (`昵称;` or a bare nickname). The
    /// notification claim flow re-sends it so an `accept` transition whose
    /// default is `reporter` cannot silently undo the claim.
    pub current_owner: String,
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
    ensure_api_ok(&root, tr("bug.comment.add"))?;

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
    ensure_api_ok(&root, tr("bug.field.update"))?;

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
    ensure_api_ok(&root, tr("bug.transition.load"))?;

    let data = root
        .pointer("/data/get_workflow_by_bug/data")
        .ok_or_else(|| "unexpected transition info response".to_string())?;
    let current_status = data
        .get("current_status")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let current_owner = data
        .pointer("/current_bug/Bug/current_owner")
        .map(|value| value_text(Some(value)))
        .unwrap_or_default()
        .trim()
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
            // TAPD marks transitions the current operator cannot perform
            // (`has_permission`) or that are hidden by workflow rules
            // (`condition_hidden`); offering them would only fail on submit.
            if flag_value(item.get("has_permission")) == Some(false)
                || flag_value(item.get("condition_hidden")) == Some(true)
            {
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
        current_owner,
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
        "新" | "新建" => "new", // i18n-exempt: parse token
        "待处理" => "open", // i18n-exempt: parse token
        "接受" | "接受处理" => "in_progress", // i18n-exempt: parse token
        "处理中" => "progressing", // i18n-exempt: parse token
        "已解决" | "已修复" => "resolved", // i18n-exempt: parse token
        "已验证" => "verified", // i18n-exempt: parse token
        "已关闭" => "closed", // i18n-exempt: parse token
        "已拒绝" => "rejected", // i18n-exempt: parse token
        "重新打开" => "reopened", // i18n-exempt: parse token
        _ => {
            let known: Vec<String> = info
                .status_alias
                .iter()
                .map(|(key, label)| format!("{label} ({key})"))
                .collect();
            let known = if known.is_empty() {
                tr("bug.none").to_string()
            } else {
                known.join(tr("bug.separator"))
            };
            return Err(tr_args("bug.status.unknown", &[&input, &known]));
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

    // Re-send the current 处理人: some workflows default `accept` to the
    // reporter, which would undo the claim the notification card just made.
    let overrides = if info.current_owner.trim().is_empty() {
        Value::Null
    } else {
        json!({ "current_owner": info.current_owner.trim() })
    };

    transition_once(
        app,
        workspace_id,
        bug_id,
        &info.current_status,
        &target,
        &overrides,
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
///
/// `overrides` carries caller-supplied values for the transition form; it is
/// either an object (`{"current_owner": "张三"}`) or an array of
/// `{"name"/"field"/"key", "value"}` rows. Workflow-provided defaults win for
/// fields the caller does not mention. The same `overrides` are applied to
/// every step, but each step loads its own field list because the form differs
/// per (from, to) pair.
pub(crate) async fn perform_transition(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
    target_input: &str,
    overrides: &Value,
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
                    overrides,
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
                let allowed_labels = if allowed_labels.is_empty() {
                    tr("bug.none").to_string()
                } else {
                    allowed_labels.join(tr("bug.separator"))
                };
                let from = info
                    .status_alias
                    .get(&current_status)
                    .cloned()
                    .unwrap_or_else(|| current_status.clone());
                let to = info
                    .status_alias
                    .get(&target)
                    .cloned()
                    .unwrap_or_else(|| target.clone());
                return Err(tr_args("bug.transition.blocked",
                    &[&from, &to, &allowed_labels],
                ));
            }

            transition_once(
                app,
                workspace_id,
                bug_id,
                &current_status,
                &target,
                overrides,
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

/// Loads the transition form TAPD renders on the bug detail page.
async fn load_transition_fields(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
    current_status: &str,
    next_status: &str,
) -> Result<Vec<TransitionField>, String> {
    let url = format!(
        "{TRANSITION_FIELDS_URL}?workspace_id={}&current_status={}&next_status={}&entity_id={}&entity_type=bug&current_alias_status=&next_alias_status=",
        encode_query(workspace_id),
        encode_query(current_status),
        encode_query(next_status),
        encode_query(bug_id),
    );
    let root = session_request_json(app, "GET", &url, None, Duration::from_secs(45)).await?;
    ensure_api_ok(&root, tr("bug.transition.fields"))?;

    Ok(parse_transition_fields_response(&root))
}

/// Loads the form TAPD would show for one direct transition.
///
/// Unlike [`perform_transition`] this never auto-advances through an
/// intermediate step: the confirmation dialog must show exactly the fields of
/// the step the user picked. Returns `(current_status, target, label, fields)`.
pub(crate) async fn load_transition_form(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
    target_input: &str,
) -> Result<(String, String, String, Vec<TransitionField>), String> {
    let info = load_transition_info(app, workspace_id, bug_id).await?;
    let target = resolve_status_key(target_input, &info)?;

    let Some((_, label)) = info.transitions.iter().find(|(key, _)| *key == target) else {
        let allowed_labels: Vec<String> = info
            .transitions
            .iter()
            .map(|(key, label)| format!("{label} ({key})"))
            .collect();
        let allowed_labels = if allowed_labels.is_empty() {
            tr("bug.none").to_string()
        } else {
            allowed_labels.join(tr("bug.separator"))
        };
        return Err(tr_args("bug.transition.blocked",
            &[
                &info_label(&info.current_status, &info),
                &info_label(&target, &info),
                &allowed_labels,
            ],
        ));
    };
    let label = label.clone();

    let fields =
        load_transition_fields(app, workspace_id, bug_id, &info.current_status, &target).await?;

    Ok((info.current_status, target, label, fields))
}

/// A successful response without a usable `/data/fields` array means the
/// workflow has no fields to fill (e.g. `{"data":""}` or `{"data":{}}`), which
/// is not an error: transport and `meta` failures are handled by the caller.
fn parse_transition_fields_response(root: &Value) -> Vec<TransitionField> {
    match root.pointer("/data/fields").and_then(Value::as_array) {
        Some(items) => parse_transition_fields(items),
        None => {
            let data = root.get("data").cloned().unwrap_or(Value::Null);
            tracing::warn!(%data, "transition fields response has no /data/fields array");
            Vec::new()
        }
    }
}

fn encode_query(value: &str) -> String {
    utf8_percent_encode(value, QUERY_ENCODE_SET).to_string()
}

fn parse_transition_fields(items: &[Value]) -> Vec<TransitionField> {
    items.iter().filter_map(parse_transition_field).collect()
}

fn parse_transition_field(item: &Value) -> Option<TransitionField> {
    let name = item.get("name").and_then(Value::as_str)?.trim();
    if name.is_empty() {
        return None;
    }
    let html_type = item
        .get("html_type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let label = item
        .get("label")
        .and_then(Value::as_str)
        .filter(|label| !label.trim().is_empty())
        .unwrap_or(name)
        .to_string();
    // `default_value` is the resolved display value; older payloads only carry
    // the raw `value`.
    let raw_value = item
        .get("default_value")
        .filter(|value| !value.is_null())
        .or_else(|| item.get("value"));
    let value = normalize_transition_value(&html_type, &value_text(raw_value));

    Some(TransitionField {
        name: name.to_string(),
        label,
        html_type,
        value,
        required: flag_value(item.get("required")).unwrap_or(false),
        disabled: flag_value(item.get("disabled")).unwrap_or(false),
        options: parse_transition_options(item.get("options")),
    })
}

/// Parses a field's option list. TAPD varies between `[{value, name}]`,
/// `["a", "b"]` and `{key: label}` depending on the field type.
fn parse_transition_options(value: Option<&Value>) -> Vec<TransitionOption> {
    match value {
        Some(Value::Array(items)) => items.iter().filter_map(parse_transition_option).collect(),
        Some(Value::Object(map)) => map
            .iter()
            .map(|(key, label)| TransitionOption {
                value: key.clone(),
                label: label
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| key.clone()),
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_transition_option(item: &Value) -> Option<TransitionOption> {
    match item {
        Value::String(text) => Some(TransitionOption {
            value: text.clone(),
            label: text.clone(),
        }),
        Value::Object(object) => {
            let pick = |keys: &[&str]| {
                keys.iter()
                    .find_map(|key| object.get(*key).and_then(Value::as_str))
                    .map(str::to_string)
            };
            let value = pick(&["value"]).or_else(|| pick(&["name", "label"]))?;
            let label = pick(&["name", "label"]).unwrap_or_else(|| value.clone());
            Some(TransitionOption { value, label })
        }
        _ => None,
    }
}

/// Accepts TAPD's scalar-ish field values: strings, numbers, booleans, arrays
/// and `{nick, name, value}` objects all collapse to one storage string.
fn value_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        // Multi-select keeps TAPD's `|` separator; `user_chooser` splits and
        // re-joins with `;` in `normalize_transition_value`.
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| value_text(Some(item)))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("|"),
        // User values need the nickname, not the login name.
        Some(Value::Object(object)) => ["nick", "name", "value"]
            .iter()
            .find_map(|key| object.get(*key).and_then(Value::as_str))
            .unwrap_or_default()
            .to_string(),
    }
}

/// Coerces TAPD's "1"/"0" strings, booleans and 0/1 numbers to `Option<bool>`.
fn flag_value(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(flag) => Some(*flag),
        Value::Number(number) => number.as_i64().map(|number| number != 0),
        Value::String(text) => match text.trim() {
            "1" | "true" => Some(true),
            "0" | "false" => Some(false),
            // Empty means "not set": treat it as unknown so
            // `has_permission: ""` does not hide a valid transition.
            _ => None,
        },
        _ => None,
    }
}

/// Normalizes a raw transition value into TAPD's storage form: user fields
/// store `昵称;昵称;`, everything else is trimmed as-is.
fn normalize_transition_value(html_type: &str, value: &str) -> String {
    if html_type == "user_chooser" {
        let names = normalize_user_value(value);
        if names.is_empty() {
            String::new()
        } else {
            format!("{names};")
        }
    } else {
        value.trim().to_string()
    }
}

/// Applies caller overrides on top of the workflow defaults.
///
/// Accepts `{"current_owner": "张三"}` or `[{"name": "current_owner", "value":
/// "张三"}]`. Null, an empty array and an empty object mean "no overrides".
/// Names the workflow does not offer are ignored with a warning: the form is
/// the source of truth for what TAPD will accept.
fn apply_transition_overrides(fields: &mut [TransitionField], overrides: &Value) {
    match overrides {
        Value::Object(map) => {
            for (name, value) in map {
                apply_one_override(fields, name, value);
            }
        }
        Value::Array(items) => {
            for item in items {
                let Some(object) = item.as_object() else {
                    continue;
                };
                let Some(name) = ["name", "field", "key"]
                    .iter()
                    .find_map(|key| object.get(*key).and_then(Value::as_str))
                else {
                    continue;
                };
                let Some(value) = object.get("value") else {
                    continue;
                };
                apply_one_override(fields, name, value);
            }
        }
        _ => {}
    }
}

fn apply_one_override(fields: &mut [TransitionField], name: &str, value: &Value) {
    let text = value_text(Some(value));
    match fields.iter_mut().find(|field| field.name == name) {
        Some(field) => {
            // Disabled means read-only in the dialog, not immutable: claim
            // flows legitimately override it. Never do so silently.
            if field.disabled {
                tracing::warn!(field = name, "overriding disabled transition field");
            }
            field.value = normalize_transition_value(&field.html_type, &text);
        }
        None => tracing::warn!(
            field = name,
            "ignoring transition override not offered by the workflow"
        ),
    }
}

/// Collects the `STATUS_<from>-<to>` payload.
///
/// The web form submits every field, including disabled ones (read-only means
/// the user cannot change it, not that it is omitted). Only
/// `enable_add_timesheet` is dropped: it toggles the timesheet UI and is not a
/// bug field. Disabled fields are exempt from the required check because a
/// locked empty field is not user-fixable.
fn transition_field_values(fields: &[TransitionField]) -> Result<Map<String, Value>, String> {
    let mut values = Map::new();
    let mut missing: Vec<&str> = Vec::new();
    for field in fields {
        if field.name == "enable_add_timesheet" {
            continue;
        }
        if field.required && !field.disabled && field.value.trim().is_empty() {
            missing.push(field.label.as_str());
            continue;
        }
        values.insert(field.name.clone(), Value::String(field.value.clone()));
    }

    if missing.is_empty() {
        Ok(values)
    } else {
        Err(tr_args("bug.transition.required",
            &[&missing.join(tr("bug.separator"))],
        ))
    }
}

/// Builds the `change_bug_status` payload the detail page sends. Comments are
/// not part of it; they go through [`add_comment`] separately.
fn transition_body(
    workspace_id: &str,
    bug_id: &str,
    current_status: &str,
    next_status: &str,
    values: &Map<String, Value>,
) -> Value {
    let mut status_fields = Map::new();
    status_fields.insert("remarks".to_string(), json!(""));
    status_fields.extend(values.iter().map(|(name, value)| (name.clone(), value.clone())));

    let mut data = Map::new();
    data.insert(
        "Bug".to_string(),
        json!({
            "current_status": current_status,
            "id": bug_id,
            "complete_effort": false,
        }),
    );
    data.insert("new_status".to_string(), json!(next_status));
    data.insert(
        "Comment".to_string(),
        json!({
            "description": "",
            "markdown_description": "",
            "description_type": 1,
            "comment_location": "workflow_classic_bottom",
            "npc_repo_path": "",
        }),
    );
    data.insert("is_editor_or_markdown".to_string(), json!(1));
    data.insert("branch".to_string(), json!({}));
    data.insert(
        format!("STATUS_{current_status}-{next_status}"),
        Value::Object(status_fields),
    );

    json!({
        "workspace_id": workspace_id,
        "data": Value::Object(data),
    })
}

/// Performs one status change through the same endpoint the web detail page
/// uses, so TAPD's own defaults/user fields apply.
///
/// No fallback to the legacy kanban/workflow endpoints: a TAPD business error
/// (non-zero `meta`) is authoritative, and a transport error would hit those
/// endpoints just the same, so retrying them would only hide the real failure.
/// The previous code posted caller `fields` (usually `[]`), which made TAPD
/// silently reset `current_owner` to the operator.
async fn transition_once(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
    current_status: &str,
    next_status: &str,
    overrides: &Value,
) -> Result<(), String> {
    let mut fields =
        load_transition_fields(app, workspace_id, bug_id, current_status, next_status)
            .await
            .map_err(|error| {
                tr_args("bug.transition.form", &[&error])
            })?;
    apply_transition_overrides(&mut fields, overrides);
    let values = transition_field_values(&fields)?;

    let mut body = transition_body(workspace_id, bug_id, current_status, next_status, &values);
    if let Some(token) = dsc_token(app) {
        body["dsc_token"] = json!(token);
    }

    let root = session_request_json(
        app,
        "POST",
        CHANGE_STATUS_URL,
        Some(body),
        Duration::from_secs(45),
    )
    .await?;
    ensure_api_ok(&root, tr("bug.transition.change"))?;

    tracing::info!(
        bug_id,
        current_status,
        next_status,
        "transitioned bug (change_bug_status)"
    );
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
        Err(tr_args("bug.action.failed", &[&action, &api_message(root)]))
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
        assert_eq!(normalize_user_value(" 王小明 "), "王小明");
        assert_eq!(normalize_user_value("张三;李四;"), "张三;李四");
        assert_eq!(normalize_user_value("张三，李四"), "张三;李四");
        assert_eq!(normalize_user_value("  "), "");
    }

    fn fixture_fields() -> Vec<TransitionField> {
        let root = json!({
            "meta": {"code": 0},
            "data": {
                "fields": [
                    {
                        "name": "remarks",
                        "label": "备注",
                        "html_type": "textarea",
                        "required": "0",
                        "disabled": "1",
                        "default_value": null
                    },
                    {
                        "name": "current_owner",
                        "label": "处理人",
                        "html_type": "user_chooser",
                        "required": "1",
                        "disabled": 0,
                        "default_value": "庞震天"
                    },
                    {
                        "name": "de",
                        "label": "开发人员",
                        "html_type": "user_chooser",
                        "required": false,
                        "disabled": false,
                        "default_value": ["庞震天"]
                    }
                ]
            }
        });
        parse_transition_fields(root["data"]["fields"].as_array().unwrap())
    }

    #[test]
    fn missing_or_malformed_fields_response_is_empty() {
        for root in [
            json!({"data": ""}),
            json!({"data": {}}),
            json!({"data": {"fields": ""}}),
            json!({"data": {"fields": {}}}),
            json!({"data": {"fields": []}}),
        ] {
            assert!(
                parse_transition_fields_response(&root).is_empty(),
                "expected no fields for {root}"
            );
        }
    }

    #[test]
    fn parses_transition_fields_and_fills_user_values() {
        let fields = fixture_fields();
        let owner = fields
            .iter()
            .find(|field| field.name == "current_owner")
            .expect("current_owner field");
        assert!(owner.required);
        assert!(!owner.disabled);

        let values = transition_field_values(&fields).unwrap();
        assert_eq!(values.get("current_owner"), Some(&json!("庞震天;")));
        assert_eq!(values.get("de"), Some(&json!("庞震天;")));
        // `remarks` is disabled but still part of the form, so it is submitted
        // with its (empty) default value.
        assert_eq!(values.get("remarks"), Some(&json!("")));
    }

    #[test]
    fn disabled_fields_are_submitted_with_defaults() {
        let node = json!([
            {
                "name": "current_owner",
                "label": "处理人",
                "html_type": "user_chooser",
                "required": "1",
                "disabled": "1",
                "default_value": "庞震天"
            },
            {
                "name": "resolution",
                "label": "解决方案",
                "html_type": "select",
                "required": "1",
                "disabled": true,
                "default_value": ""
            }
        ]);
        let fields = parse_transition_fields(node.as_array().unwrap());

        // A locked required user field keeps its default (the web form submits
        // it) and a locked empty scalar must not block the transition.
        let values = transition_field_values(&fields).unwrap();
        assert_eq!(values.get("current_owner"), Some(&json!("庞震天;")));
        assert_eq!(values.get("resolution"), Some(&json!("")));
    }

    #[test]
    fn remarks_override_reaches_status_map() {
        let mut fields = fixture_fields();
        apply_transition_overrides(&mut fields, &json!({"remarks": "已线下确认"}));
        let values = transition_field_values(&fields).unwrap();
        assert_eq!(values.get("remarks"), Some(&json!("已线下确认")));

        let body = transition_body("workspace-1", "9001", "new", "in_progress", &values);
        assert_eq!(
            body["data"]["STATUS_new-in_progress"]["remarks"],
            json!("已线下确认")
        );
    }

    #[test]
    fn required_remarks_empty_reports_label() {
        let fields = vec![TransitionField {
            name: "remarks".to_string(),
            label: "备注".to_string(),
            html_type: "textarea".to_string(),
            value: String::new(),
            required: true,
            disabled: false,
            options: Vec::new(),
        }];
        let error = transition_field_values(&fields).unwrap_err();
        assert!(error.contains("备注"), "unexpected error: {error}");
    }

    #[test]
    fn required_empty_field_reports_its_label() {
        let fields = vec![TransitionField {
            name: "resolution".to_string(),
            label: "解决方案".to_string(),
            html_type: "radio".to_string(),
            value: String::new(),
            required: true,
            disabled: false,
            options: Vec::new(),
        }];
        let error = transition_field_values(&fields).unwrap_err();
        assert!(error.contains("解决方案"), "unexpected error: {error}");
    }

    #[test]
    fn overrides_accept_object_and_array() {
        let mut fields = fixture_fields();
        apply_transition_overrides(&mut fields, &json!({"current_owner": "张三，李四"}));
        assert_eq!(
            transition_field_values(&fields)
                .unwrap()
                .get("current_owner"),
            Some(&json!("张三;李四;"))
        );

        let mut fields = fixture_fields();
        apply_transition_overrides(
            &mut fields,
            &json!([{"name": "current_owner", "value": "王五"}]),
        );
        assert_eq!(
            transition_field_values(&fields)
                .unwrap()
                .get("current_owner"),
            Some(&json!("王五;"))
        );

        let mut fields = fixture_fields();
        apply_transition_overrides(
            &mut fields,
            &json!([
                {"field": "de", "value": "赵六"},
                {"key": "not_in_workflow", "value": "ignored"},
            ]),
        );
        let values = transition_field_values(&fields).unwrap();
        assert_eq!(values.get("de"), Some(&json!("赵六;")));
        assert!(!values.contains_key("not_in_workflow"));

        // Null / empty array / empty object are no-ops.
        let mut fields = fixture_fields();
        for overrides in [Value::Null, json!([]), json!({})] {
            apply_transition_overrides(&mut fields, &overrides);
            assert_eq!(
                transition_field_values(&fields)
                    .unwrap()
                    .get("current_owner"),
                Some(&json!("庞震天;"))
            );
        }
    }

    #[test]
    fn parses_select_field_options() {
        let field = parse_transition_field(&json!({
            "name": "resolution",
            "label": "解决方案",
            "html_type": "select",
            "options": [
                {"value": "fixed", "name": "已修改"},
                {"value": "wontfix", "label": "不予处理"},
                "duplicate"
            ]
        }))
        .expect("field");
        assert_eq!(
            field
                .options
                .iter()
                .map(|option| (option.value.as_str(), option.label.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("fixed", "已修改"),
                ("wontfix", "不予处理"),
                ("duplicate", "duplicate"),
            ]
        );

        // Object-map form: `{key: label}`.
        let field = parse_transition_field(&json!({
            "name": "severity",
            "html_type": "radio",
            "options": {"normal": "一般", "serious": "严重"}
        }))
        .expect("field");
        let pairs: Vec<(String, String)> = field
            .options
            .into_iter()
            .map(|option| (option.value, option.label))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("normal".to_string(), "一般".to_string()),
                ("serious".to_string(), "严重".to_string()),
            ]
        );

        // Missing options stays empty.
        let field = parse_transition_field(&json!({"name": "f"})).expect("field");
        assert!(field.options.is_empty());
    }

    #[test]
    fn value_text_prefers_nick_and_keeps_pipe_separator() {
        assert_eq!(
            value_text(Some(&json!({"nick": "庞震天", "name": "pangzt", "value": "42"}))),
            "庞震天"
        );
        assert_eq!(
            value_text(Some(&json!({"name": "pangzt", "value": "42"}))),
            "pangzt"
        );
        assert_eq!(value_text(Some(&json!({"value": "42"}))), "42");
        // Arrays keep `|` so multi_select values survive; user_chooser fields
        // split it again in `normalize_transition_value`.
        assert_eq!(value_text(Some(&json!(["a", "b"]))), "a|b");

        // `default_value` wins; raw `value` is the fallback.
        let with_default =
            parse_transition_field(&json!({"name": "f", "value": "raw", "default_value": "显示"}))
                .expect("field");
        assert_eq!(with_default.value, "显示");
        let without_default =
            parse_transition_field(&json!({"name": "f", "value": "raw"})).expect("field");
        assert_eq!(without_default.value, "raw");
    }

    #[test]
    fn null_default_value_falls_back_to_raw_value() {
        // A present-but-null `default_value` means "no resolved default", not
        // "empty field": the raw `value` is still the user's stored value.
        let field = parse_transition_field(&json!({
            "name": "current_owner",
            "label": "处理人",
            "html_type": "user_chooser",
            "default_value": null,
            "value": "张三"
        }))
        .expect("field");
        assert_eq!(field.value, "张三;");
    }

    #[test]
    fn flag_value_treats_empty_string_as_unknown() {
        assert_eq!(flag_value(Some(&json!(""))), None);
        assert_eq!(flag_value(Some(&json!("  "))), None);
        assert_eq!(flag_value(Some(&json!("1"))), Some(true));
        assert_eq!(flag_value(Some(&json!("0"))), Some(false));
        assert_eq!(flag_value(Some(&json!(true))), Some(true));
        assert_eq!(flag_value(None), None);
    }

    #[test]
    fn transition_body_matches_web_payload() {
        let mut values = Map::new();
        values.insert("current_owner".to_string(), json!("庞震天;"));
        values.insert("de".to_string(), json!("庞震天;"));

        let body = transition_body("workspace-1", "9001", "new", "in_progress", &values);
        assert_eq!(body["data"]["Bug"]["current_status"], json!("new"));
        assert_eq!(body["data"]["Bug"]["id"], json!("9001"));
        assert_eq!(body["data"]["Bug"]["complete_effort"], json!(false));
        assert_eq!(body["data"]["new_status"], json!("in_progress"));
        assert_eq!(
            body["data"]["STATUS_new-in_progress"]["current_owner"],
            json!("庞震天;")
        );
        assert_eq!(
            body["data"]["STATUS_new-in_progress"]["de"],
            json!("庞震天;")
        );
        assert_eq!(
            body["data"]["STATUS_new-in_progress"]["remarks"],
            json!("")
        );
        assert_eq!(
            body["data"]["Comment"]["comment_location"],
            json!("workflow_classic_bottom")
        );
        assert_eq!(body["data"]["is_editor_or_markdown"], json!(1));
        assert_eq!(body["workspace_id"], json!("workspace-1"));
    }
}
