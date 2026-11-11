use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::tapd::model::{
    Attachment, BugDetail, BugListPage, BugSummary, Comment, Workspace, WorkspaceMember,
};

pub const TAPD_BASE: &str = "https://www.tapd.cn";

pub const PATH_BUG_LIST: &str = "/api/aggregation/bug_aggregation/get_bugs_list";
pub const PATH_BUG_DETAIL: &str =
    "/api/aggregation/workitem_aggregation/common_get_info";
pub const PATH_USER_WORKSPACE: &str =
    "/api/aggregation/user_and_workspace_aggregation/get_user_and_workspace_basic_info";
pub const PATH_WORKSPACE_MEMBERS: &str = "/api/basic/user/get_workspace_members";
pub const PATH_USER_CHOOSER: &str = "/api/basic/user/user_chooser";

/// Fields that the aggregation list only returns when explicitly requested.
pub const LIST_SHOW_FIELDS: &[&str] = &[
    "id",
    "short_id",
    "title",
    "status",
    "priority",
    "severity",
    "current_owner",
    "reporter",
    "created",
    "assigned_time",
    "modified",
    "lastmodify",
    "due",
    "iteration_id",
    "iteration_name",
    "module",
    "version_report",
    "story_id",
    "BugStoryRelation_relative_id",
    "BugStoryRelation_story_name",
];

const DEFAULT_FILTER_IDENTIFIER: &str = "app_for_list_tools,app_for_list_operation";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BugQuery {
    pub workspace_id: String,
    /// Exact TAPD nickname.
    pub owner: Option<String>,
    /// Creator (TAPD `reporter`) nickname.
    pub creator: Option<String>,
    /// Status keys such as `new`, `in_progress`, `reopened`.
    pub statuses: Vec<String>,
    /// Priority keys such as `urgent`, `high`, `medium`, `low`.
    pub priorities: Vec<String>,
    /// Severity keys such as `fatal`, `serious`, `normal`, `prompt`, `advice`.
    pub severities: Vec<String>,
    pub keyword: Option<String>,
    /// `YYYY-MM-DD HH:MM:SS`; matched with an open-ended range.
    pub modified_after: Option<String>,
    /// `YYYY-MM-DD HH:MM:SS`; matched with an open-ended range.
    pub created_after: Option<String>,
    pub sort_name: String,
    pub order: String,
    pub page: u32,
    pub perpage: u32,
    /// Optional saved view id; when set it is used in addition to explicit filters.
    pub conf_id: Option<String>,
}

impl Default for BugQuery {
    fn default() -> Self {
        Self {
            workspace_id: String::new(),
            owner: None,
            creator: None,
            statuses: Vec::new(),
            priorities: Vec::new(),
            severities: Vec::new(),
            keyword: None,
            modified_after: None,
            created_after: None,
            sort_name: "created".to_string(),
            order: "desc".to_string(),
            page: 1,
            perpage: 50,
            conf_id: None,
        }
    }
}

impl BugQuery {
    pub fn new(workspace_id: impl Into<String>) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            ..Self::default()
        }
    }

    pub fn body(&self) -> Value {
        let mut filters = Vec::new();

        if let Some(owner) = non_empty(self.owner.as_deref()) {
            filters.push(filter_expr(
                "current_owner",
                "user_chooser",
                "equal",
                json!(owner),
            ));
        }
        if let Some(creator) = non_empty(self.creator.as_deref()) {
            filters.push(filter_expr(
                "reporter",
                "user_chooser",
                "equal",
                json!(creator),
            ));
        }
        if !self.statuses.is_empty() {
            filters.push(filter_expr(
                "status",
                "multi_select",
                "in",
                json!(self.statuses),
            ));
        }
        if !self.priorities.is_empty() {
            filters.push(filter_expr(
                "priority",
                "select",
                "in",
                json!(self.priorities),
            ));
        }
        if !self.severities.is_empty() {
            filters.push(filter_expr(
                "severity",
                "select",
                "in",
                json!(self.severities),
            ));
        }
        if let Some(keyword) = non_empty(self.keyword.as_deref()) {
            filters.push(filter_expr("name", "input", "like", json!(keyword)));
        }
        if let Some(after) = non_empty(self.modified_after.as_deref()) {
            filters.push(filter_expr(
                "modified",
                "datetime",
                "between",
                json!(format!("{after},")),
            ));
        }
        if let Some(after) = non_empty(self.created_after.as_deref()) {
            filters.push(filter_expr(
                "created",
                "datetime",
                "between",
                json!(format!("{after},")),
            ));
        }

        let mut body = json!({
            "workspace_id": self.workspace_id,
            "conf_id": self.conf_id.clone().unwrap_or_default(),
            "sort_name": self.sort_name,
            "confIdType": "CACHE",
            "order": self.order,
            "perpage": self.perpage.clamp(20, 200),
            "page": self.page.max(1),
            "selected_workspace_ids": "",
            "query_token": "",
            "filter_expr": null,
            "location": "/bugtrace/bugreports/my_view",
            "target": format!("{}/bug/normal", self.workspace_id),
            "entity_types": ["bug"],
            "use_scene": "bug_list",
            "return_url": format!("{TAPD_BASE}/tapd_fe/{}/bug/list", self.workspace_id),
            "identifier": DEFAULT_FILTER_IDENTIFIER,
            "multiple_group_location": "multiple_group/bug_list",
            "show_fields": LIST_SHOW_FIELDS,
        });

        if !filters.is_empty() {
            body["filter_expr"] = json!({
                "data": filters,
                "optionType": "AND",
                "needInit": true,
            });
        }

        body
    }
}

fn filter_expr(field: &str, field_type: &str, option: &str, value: Value) -> Value {
    json!({
        "fieldOption": option,
        "fieldType": field_type,
        "entity": "bug",
        "fieldSystemName": field,
        "selectOption": [],
        "value": value,
        "fieldIsSystem": "1",
    })
}

pub fn bug_list_url() -> String {
    format!("{TAPD_BASE}{PATH_BUG_LIST}")
}

pub fn bug_detail_url() -> String {
    format!("{TAPD_BASE}{PATH_BUG_DETAIL}")
}

pub fn user_workspace_url(workspace_id: &str) -> String {
    format!(
        "{TAPD_BASE}{PATH_USER_WORKSPACE}?workspace_id={workspace_id}&location=%2Ftapd_fe%2Fmy%2Fwork"
    )
}

pub fn bug_detail_body(workspace_id: &str, bug_id: &str) -> Value {
    json!({
        "workspace_id": workspace_id,
        "entity_id": bug_id,
        "entity_type": "bug",
        "api_controller_prefix": "",
        "enable_description": "true",
        "is_detail": 1,
        "blacklist_fields": [],
        "identifier": "app_for_editor,app_for_obj_more,app_for_obj_dialog_dropdown,app_for_obj_detail_panel,app_for_obj_detail_bottom_card,app_for_obj_attachment,app_for_obj_copy_link,app_for_obj_additional_panel",
        "installed_app_entity": {
            "obj_id": bug_id,
            "obj_type": "bug",
            "obj_name": "缺陷"
        },
        "has_edit_rule_fields": [],
        "is_archived": 0,
        "is_assistant_exec_log": 1,
    })
}

pub fn bug_web_url(workspace_id: &str, bug_id: &str) -> String {
    format!("{TAPD_BASE}/tapd_fe/{workspace_id}/bug/detail/{bug_id}")
}

/// Members of a workspace, used by the owner / developer pickers.
pub fn workspace_members_url(workspace_id: &str) -> String {
    format!("{TAPD_BASE}{PATH_WORKSPACE_MEMBERS}?workspace_id={workspace_id}")
}

/// Fallback member search endpoint.
pub fn user_chooser_url() -> String {
    format!("{TAPD_BASE}{PATH_USER_CHOOSER}")
}

/// `load_all=1` returns the whole chooser directory for a workspace.
pub fn user_chooser_all_body(workspace_id: &str) -> Value {
    json!({
        "key_word": "",
        "workspace_id": workspace_id,
        "multi_workspace_ids": "",
        "disabled": 0,
        "show_child_user": 1,
        "extelnal": 1,
        "per_page": 200,
        "load_all": 1,
        "is_batch": "",
        "select_type": "fuzzy_match",
        "size": 0,
        "chooser_type": "userspinyin",
    })
}

pub fn attachment_download_url(workspace_id: &str, attachment: &Attachment) -> String {
    format!(
        "https://file.tapd.cn/{workspace_id}/attachments/download/{}/{}",
        attachment.id, attachment.filename
    )
}

/// Turns a `preview_attachments` URL (description media) into a downloadable one.
pub fn preview_to_download(url: &str) -> String {
    url.replace(
        "/attachments/preview_attachments/",
        "/attachments/download/",
    )
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

pub fn parse_workspaces(root: &Value) -> Result<Vec<Workspace>, String> {
    let entries = root
        .pointer("/data/my_workspaces/data")
        .and_then(Value::as_array)
        .ok_or_else(|| api_error(root))?;

    Ok(entries
        .iter()
        .filter_map(|item| {
            let id = text(item, "id");
            if id.is_empty() {
                return None;
            }
            Some(Workspace {
                id,
                name: text(item, "project_name"),
                pretty_name: text(item, "pretty_name"),
                category: text(item, "category"),
                status: text(item, "status"),
                logo_color: opt_text(item, "logo_color"),
                last_visited_time: opt_text(item, "last_visited_time"),
                jump_url: opt_text(item, "jump_url"),
            })
        })
        .collect())
}

/// Extracts workspace members from either `get_workspace_members` or
/// `user_chooser`.
///
/// `get_workspace_members` returns `{"data":{"members":[{"user":"昵称"}]}}`:
/// each entry carries only the nickname under `user`, so it is read explicitly
/// before the recursive scan (which looks for `nick`/`user_name` and would
/// otherwise drop every member). The chooser nests users by department, hence
/// the generic scan for any remaining user-shaped object.
pub fn parse_workspace_members(root: &Value) -> Vec<WorkspaceMember> {
    let mut members = Vec::new();
    let mut seen = std::collections::BTreeSet::new();

    if let Some(items) = root.pointer("/data/members").and_then(Value::as_array) {
        for item in items {
            let nick = item
                .get("user")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if !nick.is_empty() && seen.insert(nick.to_string()) {
                members.push(WorkspaceMember {
                    nick: nick.to_string(),
                    ..Default::default()
                });
            }
        }
    }

    collect_members(root, &mut members, &mut seen);
    members
}

fn collect_members(
    value: &Value,
    members: &mut Vec<WorkspaceMember>,
    seen: &mut std::collections::BTreeSet<String>,
) {
    match value {
        Value::Object(object) => {
            let nick = ["nick", "user_nick"]
                .iter()
                .find_map(|key| object.get(*key).and_then(Value::as_str))
                .map(str::trim)
                .filter(|nick| !nick.is_empty());

            if let Some(nick) = nick {
                if seen.insert(nick.to_string()) {
                    members.push(WorkspaceMember {
                        nick: nick.to_string(),
                        user_id: ["user_id", "id", "userId"]
                            .iter()
                            .find_map(|key| object.get(*key).and_then(Value::as_str))
                            .unwrap_or_default()
                            .to_string(),
                        name: ["name", "user_name"]
                            .iter()
                            .find_map(|key| object.get(*key).and_then(Value::as_str))
                            .unwrap_or_default()
                            .to_string(),
                        avatar: ["avatar", "avatar_url", "head"]
                            .iter()
                            .find_map(|key| object.get(*key).and_then(Value::as_str))
                            .unwrap_or_default()
                            .to_string(),
                    });
                }
            }

            for child in object.values() {
                collect_members(child, members, seen);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_members(item, members, seen);
            }
        }
        _ => {}
    }
}

pub fn parse_bug_list(root: &Value) -> Result<BugListPage, String> {
    let data = root
        .pointer("/data/bugs_list_ret/data")
        .ok_or_else(|| api_error(root))?;

    let status_map = parse_status_map(data.get("status_map"));
    let workspace_id = text(data, "result_workspace_ids");
    let workspace_id = if workspace_id.is_empty() {
        data.get("result_workspace_ids")
            .and_then(Value::as_array)
            .and_then(|ids| ids.first())
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    } else {
        workspace_id
    };

    let bugs = data
        .get("bugs_list")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let bug = item.get("Bug").unwrap_or(item);
                    parse_summary(bug, &workspace_id, &status_map)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let status_order = parse_status_order(data, &workspace_id, &status_map, &bugs);

    Ok(BugListPage {
        page: number(data, "page").unwrap_or(1),
        perpage: number(data, "perpage").unwrap_or(50),
        total: number(data, "total_count").unwrap_or(bugs.len() as u32),
        status_map,
        status_order,
        bugs,
    })
}

/// Status keys in the workspace's configured workflow order.
///
/// TAPD returns `workspace_configs.workflow_infos.bug.status_map` as a
/// workspace-keyed object, and its key order is exactly the order the workflow
/// settings page renders the status columns in (both are built from the
/// workspace's transition configuration). `serde_json` keeps that insertion
/// order because the workspace enables its `preserve_order` feature.
///
/// The top-level `status_map` is only a label lookup: it also carries the
/// synthetic `start`/`end` keys and its own key order is not meaningful.
fn parse_status_order(
    data: &Value,
    workspace_id: &str,
    status_map: &BTreeMap<String, String>,
    bugs: &[BugSummary],
) -> Vec<String> {
    let mut ordered: Vec<String> = Vec::new();

    // `result_workspace_ids` is absent on some responses; the bug rows still
    // carry `project_id`, so borrow it rather than dropping to the fallback.
    let workspace_id = if workspace_id.trim().is_empty() {
        bugs.first()
            .map(|bug| bug.workspace_id.as_str())
            .unwrap_or_default()
    } else {
        workspace_id
    };

    if let Some(entry) = data
        .pointer("/workspace_configs/workflow_infos/bug/status_map")
        .and_then(Value::as_object)
        .and_then(|map| map.get(workspace_id))
        .and_then(Value::as_object)
    {
        for key in entry.keys() {
            if key != "start" && key != "end" {
                ordered.push(key.clone());
            }
        }
    }

    // Older responses omit `workspace_configs`: fall back to the known TAPD
    // status order, kept only for keys this workspace actually uses.
    if ordered.is_empty() {
        ordered.extend(
            DEFAULT_STATUS_ORDER
                .iter()
                .filter(|key| status_map.contains_key(**key))
                .map(|key| (*key).to_string()),
        );
    }

    // Defensive: a bug with a status outside the configured list must still be
    // selectable in the filter menu.
    for bug in bugs {
        if !bug.status.is_empty() && !ordered.iter().any(|key| key == &bug.status) {
            ordered.push(bug.status.clone());
        }
    }

    ordered
}

pub fn parse_bug_detail(root: &Value) -> Result<BugDetail, String> {
    let data = root
        .pointer("/data/get_info_ret/data")
        .ok_or_else(|| api_error(root))?;
    let bug = data.get("Bug").ok_or_else(|| api_error(root))?;

    let workspace_id = {
        let id = text(bug, "workspace_id");
        if id.is_empty() {
            text(bug, "project_id")
        } else {
            id
        }
    };
    let status_map = parse_status_map(
        data.pointer("/workspace/workflow_infos/bug/status_map"),
    );
    let summary = parse_summary(bug, &workspace_id, &status_map)
        .ok_or_else(|| "bug detail is missing an id".to_string())?;

    let description_html = text(bug, "description");
    let comments = data
        .pointer("/comment_list/comments")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(parse_comment).collect())
        .unwrap_or_default();

    let mut attachments = data
        .pointer("/attachment_list/attachments")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| parse_attachment(workspace_id.as_str(), item))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // Some files are returned in `file_list` instead of `attachment_list`.
    if let Some(items) = data.get("file_list").and_then(Value::as_array) {
        for item in items {
            if let Some(attachment) = parse_attachment(&workspace_id, item) {
                if !attachments.iter().any(|existing| existing.id == attachment.id) {
                    attachments.push(attachment);
                }
            }
        }
    }

    let mut detail = BugDetail {
        summary,
        description_html: description_html.clone(),
        description_text: html_to_text(&description_html),
        platform: text(bug, "platform"),
        os: text(bug, "os"),
        testtype: text(bug, "testtype"),
        testphase: text(bug, "testphase"),
        source: text(bug, "source"),
        resolution: text(bug, "resolution"),
        resolved: text(bug, "resolved"),
        closed: text(bug, "closed"),
        reopen_time: text(bug, "reopen_time"),
        fixer: clean_people(text(bug, "fixer")),
        de: clean_people(text(bug, "de")),
        te: clean_people(text(bug, "te")),
        participants: clean_people(text(bug, "participator")),
        cc: clean_people(text(bug, "cc")),
        follower: clean_people(text(bug, "follower")),
        release_name: text(bug, "release_name"),
        workspace_name: text(bug, "workspace_name"),
        custom_fields: parse_custom_fields(bug),
        comments,
        attachments,
        embedded_media: Vec::new(),
        changes: Default::default(),
    };
    // Images/videos in the rich text are only discoverable by scanning the HTML.
    detail.embedded_media = crate::export::collect_embedded_media(&detail);

    Ok(detail)
}

fn parse_summary(
    bug: &Value,
    workspace_id: &str,
    status_map: &BTreeMap<String, String>,
) -> Option<BugSummary> {
    let id = text(bug, "id");
    if id.is_empty() {
        return None;
    }

    let workspace_id = {
        let from_bug = text(bug, "project_id");
        if from_bug.is_empty() {
            workspace_id.to_string()
        } else {
            from_bug
        }
    };
    let status = text(bug, "status");
    let priority = text(bug, "priority");
    let severity = text(bug, "severity");
    let modified = {
        let modified = text(bug, "modified");
        if modified.is_empty() {
            text(bug, "lastmodify")
        } else {
            modified
        }
    };
    let story_id = {
        let id = text(bug, "story_id");
        if id.is_empty() {
            text(bug, "BugStoryRelation_relative_id")
        } else {
            id
        }
    };
    let story_name = {
        let name = text(bug, "story_name");
        if name.is_empty() {
            text(bug, "BugStoryRelation_story_name")
        } else {
            name
        }
    };

    Some(BugSummary {
        short_id: text(bug, "short_id"),
        title: text(bug, "title"),
        status_label: status_label(&status, status_map),
        priority_label: priority_label(&priority),
        severity_label: severity_label(&severity),
        status,
        priority,
        severity,
        owner: clean_people(text(bug, "current_owner")),
        creator: clean_people(text(bug, "reporter")),
        created: text(bug, "created"),
        assigned_time: {
            let assigned = text(bug, "assigned_time");
            if assigned.is_empty() {
                text(bug, "current_owner_time")
            } else {
                assigned
            }
        },
        modified,
        due: text(bug, "due"),
        iteration_id: text(bug, "iteration_id"),
        iteration_name: text(bug, "iteration_name"),
        module: text(bug, "module"),
        version_report: text(bug, "version_report"),
        story_id,
        story_name,
        bug_url: bug_web_url(&workspace_id, &id),
        workspace_id,
        id,
    })
}

fn parse_comment(value: &Value) -> Option<Comment> {
    let id = text(value, "id");
    if id.is_empty() {
        return None;
    }
    let description_html = text(value, "description");
    let replies = value
        .get("replies")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(parse_comment).collect())
        .unwrap_or_default();

    Some(Comment {
        id,
        author: text(value, "author"),
        created: text(value, "created"),
        description_html: description_html.clone(),
        plain_text: {
            let plain = text(value, "plain_text");
            if plain.is_empty() {
                html_to_text(&description_html)
            } else {
                plain
            }
        },
        is_deleted: text(value, "is_delete") == "1",
        replies,
    })
}

fn parse_attachment(workspace_id: &str, value: &Value) -> Option<Attachment> {
    let id = text(value, "id");
    if id.is_empty() {
        return None;
    }
    let filename = text(value, "filename");
    let attachment = Attachment {
        id,
        filename,
        content_type: text(value, "content_type"),
        size: text(value, "size").parse::<u64>().unwrap_or(0),
        filetype: text(value, "filetype"),
        owner: text(value, "owner"),
        created: text(value, "created"),
        entry_id: text(value, "entry_id"),
        video_poster: text(value, "video_poster"),
        video_origin_file: text(value, "video_origin_file"),
        download_url: String::new(),
    };
    let download_url = attachment_download_url(workspace_id, &attachment);
    Some(Attachment {
        download_url,
        ..attachment
    })
}

fn parse_status_map(value: Option<&Value>) -> BTreeMap<String, String> {
    let mut map = default_status_map();
    let Some(object) = value.and_then(Value::as_object) else {
        return map;
    };

    // Workspace-keyed shape: { "45336192": { "new": "新", ... } }
    for inner in object.values().filter_map(Value::as_object) {
        for (key, label) in inner {
            if let Some(label) = label.as_str() {
                map.insert(key.clone(), label.to_string());
            }
        }
    }

    // Direct shape: { "new": "新", ... }
    for (key, label) in object {
        if let Some(label) = label.as_str() {
            map.insert(key.clone(), label.to_string());
        }
    }

    map
}

fn parse_custom_fields(bug: &Value) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let Some(object) = bug.as_object() else {
        return fields;
    };

    for (key, value) in object {
        if !key.starts_with("custom_field_") && !key.starts_with("custom_plan_field_") {
            continue;
        }
        let value = match value {
            Value::String(text) => text.trim().to_string(),
            Value::Number(number) => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            _ => continue,
        };
        if !value.is_empty() && value != "0" {
            fields.insert(key.clone(), value);
        }
    }

    fields
}

/// TAPD's built-in status order, used only when a response carries no
/// workspace workflow configuration.
const DEFAULT_STATUS_ORDER: &[&str] = &[
    "new",
    "in_progress",
    "resolved",
    "verified",
    "reopened",
    "rejected",
    "closed",
    "open",
    "progressing",
    "done",
];

fn default_status_map() -> BTreeMap<String, String> {
    [
        ("new", "新"),
        ("in_progress", "接受/处理"),
        ("resolved", "已解决"),
        ("verified", "已验证"),
        ("reopened", "重新打开"),
        ("rejected", "已拒绝"),
        ("closed", "已关闭"),
        ("open", "未开始"),
        ("progressing", "进行中"),
        ("done", "已完成"),
    ]
    .into_iter()
    .map(|(key, label)| (key.to_string(), label.to_string()))
    .collect()
}

pub fn status_label(key: &str, map: &BTreeMap<String, String>) -> String {
    map.get(key)
        .cloned()
        .unwrap_or_else(|| key.to_string())
}

pub fn priority_label(key: &str) -> String {
    match key {
        "urgent" => "紧急",
        "high" => "高",
        "medium" => "中",
        "low" => "低",
        "insignificant" => "无关紧要",
        other => other,
    }
    .to_string()
}

pub fn severity_label(key: &str) -> String {
    match key {
        "fatal" => "致命",
        "serious" => "严重",
        "normal" => "一般",
        "prompt" => "提示",
        "advice" => "建议",
        other => other,
    }
    .to_string()
}

fn clean_people(value: String) -> String {
    value.trim().trim_end_matches(';').trim().to_string()
}

pub fn html_to_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for character in html.chars() {
        match character {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => text.push(character),
            _ => {}
        }
    }

    decode_entities(&text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Decodes the entities TAPD emits inside HTML attributes and text.
pub fn decode_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn api_error(root: &Value) -> String {
    let code = root.pointer("/meta/code").map(Value::to_string).unwrap_or_default();
    let message = root
        .pointer("/meta/message")
        .and_then(Value::as_str)
        .unwrap_or("unexpected TAPD response");
    format!("TAPD API error (code {code}): {message}")
}

fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

fn opt_text(value: &Value, key: &str) -> Option<String> {
    let text = text(value, key);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn number(value: &Value, key: &str) -> Option<u32> {
    match value.get(key) {
        Some(Value::Number(number)) => number.as_u64().map(|number| number as u32),
        Some(Value::String(text)) => text.parse::<u32>().ok(),
        _ => None,
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_filter_is_a_string() {
        let query = BugQuery {
            workspace_id: "45336192".to_string(),
            owner: Some("郭俊宏".to_string()),
            statuses: vec!["new".to_string()],
            ..BugQuery::default()
        };
        let body = query.body();
        let filters = body
            .pointer("/filter_expr/data")
            .and_then(Value::as_array)
            .expect("filters");
        assert_eq!(filters.len(), 2);
        assert_eq!(filters[0]["fieldSystemName"], "current_owner");
        assert_eq!(filters[0]["value"], "郭俊宏");
        assert_eq!(filters[0]["fieldOption"], "equal");
        assert_eq!(filters[1]["fieldSystemName"], "status");
        assert_eq!(filters[1]["value"], json!(["new"]));
    }

    #[test]
    fn creator_filter_targets_reporter() {
        let query = BugQuery {
            workspace_id: "45336192".to_string(),
            creator: Some("张芳兰".to_string()),
            ..BugQuery::default()
        };
        let body = query.body();
        let filters = body
            .pointer("/filter_expr/data")
            .and_then(Value::as_array)
            .expect("filters");
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0]["fieldSystemName"], "reporter");
        assert_eq!(filters[0]["fieldType"], "user_chooser");
        assert_eq!(filters[0]["value"], "张芳兰");
    }

    #[test]
    fn parses_workspace_list() {
        let root = json!({
            "data": {
                "my_workspaces": {
                    "data": [
                        {"id": "45336192", "project_name": "UU", "category": "project", "status": "normal"}
                    ]
                }
            },
            "meta": {"code": 0, "message": "success"}
        });
        let workspaces = parse_workspaces(&root).expect("workspaces");
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].name, "UU");
    }

    #[test]
    fn parses_workspace_members_from_nested_shapes() {
        let root = json!({
            "data": {
                "users": [
                    {"id": "u1", "nick": "郭俊宏", "name": "郭俊宏", "avatar": "https://a/1.png"},
                    {"id": "u2", "nick": "何帅"}
                ],
                "departments": [{
                    "name": "测试组",
                    "members": [{"user_id": "u3", "nick": "张芳兰", "user_name": "张芳兰"}]
                }]
            },
            "meta": {"code": 0, "message": "success"}
        });
        let members = parse_workspace_members(&root);
        let mut nicks: Vec<&str> = members.iter().map(|member| member.nick.as_str()).collect();
        nicks.sort_unstable();
        assert_eq!(nicks, vec!["何帅", "张芳兰", "郭俊宏"]);
        let guo = members.iter().find(|member| member.nick == "郭俊宏").expect("郭俊宏");
        let zhang = members.iter().find(|member| member.nick == "张芳兰").expect("张芳兰");
        assert_eq!(guo.user_id, "u1");
        assert_eq!(guo.avatar, "https://a/1.png");
        assert_eq!(zhang.user_id, "u3");
        assert_eq!(zhang.name, "张芳兰");
    }

    #[test]
    fn parses_workspace_members_used_by_get_workspace_members() {
        // Shape returned by `/api/basic/user/get_workspace_members`: the entry
        // only has `user`, no nick/user_id/name fields.
        let root = json!({
            "data": {
                "members": [
                    {"user": "范艺"},
                    {"user": "郭俊宏"},
                    {"user": "张芳兰"},
                    {"user": "郭俊宏"}
                ]
            },
            "meta": {"code": "0", "message": "success"}
        });
        let members = parse_workspace_members(&root);
        let nicks: Vec<&str> = members.iter().map(|member| member.nick.as_str()).collect();
        assert_eq!(nicks, vec!["范艺", "郭俊宏", "张芳兰"]);
    }

    #[test]
    fn parses_bug_list_with_status_labels() {
        let root = json!({
            "data": {
                "bugs_list_ret": {
                    "data": {
                        "page": "1",
                        "perpage": "50",
                        "total_count": "1",
                        "status_map": {
                            "45336192": {"new": "新", "start": "new", "end": ["closed"]}
                        },
                        "workspace_configs": {
                            "workflow_infos": {
                                "bug": {
                                    "status_map": {
                                        "45336192": {
                                            "new": "新",
                                            "in_progress": "接受/处理",
                                            "resolved": "已解决",
                                            "closed": "已关闭"
                                        }
                                    }
                                }
                            }
                        },
                        "bugs_list": [{
                            "Bug": {
                                "id": "1145336192001010606",
                                "short_id": "1010606",
                                "title": "示例",
                                "status": "new",
                                "priority": "high",
                                "severity": "normal",
                                "current_owner": "何帅",
                                "reporter": "张芳兰",
                                "created": "2026-11-09 19:57:06",
                                "modified": "2026-11-09 20:13:37",
                                "project_id": "45336192"
                            }
                        }]
                    }
                }
            },
            "meta": {"code": 0, "message": "success"}
        });
        let page = parse_bug_list(&root).expect("page");
        assert_eq!(page.total, 1);
        assert_eq!(page.bugs[0].status_label, "新");
        assert_eq!(page.bugs[0].priority_label, "高");
        assert_eq!(page.bugs[0].owner, "何帅");
        assert_eq!(page.bugs[0].workspace_id, "45336192");
        // Workflow order, not the alphabetical BTreeMap order, and without the
        // synthetic start/end keys.
        assert_eq!(
            page.status_order,
            vec!["new", "in_progress", "resolved", "closed"]
        );
    }

    #[test]
    fn parses_bug_detail_comments_and_attachments() {
        let root = json!({
            "data": {
                "get_info_ret": {
                    "data": {
                        "Bug": {
                            "id": "1145336192001010606",
                            "title": "示例",
                            "status": "new",
                            "priority": "high",
                            "severity": "normal",
                            "current_owner": "何帅",
                            "reporter": "张芳兰",
                            "project_id": "45336192",
                            "description": "<p>hello <b>world</b></p><img src=\"https://file.tapd.cn/x\">",
                            "custom_field_one": "value",
                            "custom_field_two": ""
                        },
                        "comment_list": {
                            "comments": [{
                                "id": "1",
                                "author": "张芳兰",
                                "created": "2026-11-09 20:00:00",
                                "description": "<p>comment</p>",
                                "is_delete": "0",
                                "replies": []
                            }]
                        },
                        "attachment_list": {
                            "attachments": [{
                                "id": "1145336192001002632",
                                "filename": "log.ips",
                                "content_type": "text/x-c",
                                "size": "398145",
                                "filetype": "text"
                            }]
                        }
                    }
                }
            },
            "meta": {"code": 0, "message": "success"}
        });
        let detail = parse_bug_detail(&root).expect("detail");
        assert_eq!(detail.summary.title, "示例");
        assert_eq!(detail.description_text, "hello world");
        assert_eq!(detail.comments.len(), 1);
        assert_eq!(detail.attachments.len(), 1);
        assert_eq!(
            detail.attachments[0].download_url,
            "https://file.tapd.cn/45336192/attachments/download/1145336192001002632/log.ips"
        );
        assert_eq!(detail.custom_fields.get("custom_field_one").map(String::as_str), Some("value"));
        assert!(!detail.custom_fields.contains_key("custom_field_two"));
    }

    #[test]
    fn converts_preview_urls_to_downloads() {
        assert_eq!(
            preview_to_download("https://file.tapd.cn/1/attachments/preview_attachments/2/a.png"),
            "https://file.tapd.cn/1/attachments/download/2/a.png"
        );
    }
}
