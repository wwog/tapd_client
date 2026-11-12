//! TAPD web-session endpoints: request paths, bodies and query construction.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::tapd::model::Attachment;

use super::value::non_empty;

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
    /// Exact TAPD nicknames; several people match with OR.
    pub owners: Vec<String>,
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
            owners: Vec::new(),
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

        let owners: Vec<&str> = self
            .owners
            .iter()
            .map(|owner| owner.trim())
            .filter(|owner| !owner.is_empty())
            .collect();
        match owners.as_slice() {
            // One owner keeps TAPD's verified `equal` form; several owners use
            // the `in` form that every other multi-value field takes.
            [] => {}
            [owner] => filters.push(filter_expr(
                "current_owner",
                "user_chooser",
                "equal",
                json!(owner),
            )),
            multi => filters.push(filter_expr(
                "current_owner",
                "user_chooser",
                "in",
                json!(multi),
            )),
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
