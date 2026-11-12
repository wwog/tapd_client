//! Response parsing: TAPD's aggregation JSON -> model values.
//!
//! All reads are defensive because TAPD omits fields and changes scalar types
//! between endpoints (see [`super::value`]).

use std::collections::BTreeMap;

use serde_json::Value;

use crate::tapd::model::{
    Attachment, BugDetail, BugListPage, BugSummary, Comment, Workspace, WorkspaceMember,
};

use super::endpoints::{attachment_download_url, bug_web_url};
use super::html::html_to_text;
use super::labels::{
    default_status_map, priority_label, severity_label, status_label, STATUS_LABELS,
};
use super::media::collect_embedded_media;
use super::value::{api_error, first_text, number, opt_text, text};

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
            STATUS_LABELS
                .iter()
                .map(|(key, _)| *key)
                .filter(|key| status_map.contains_key(*key))
                .map(str::to_string),
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

    let workspace_id = first_text(bug, &["workspace_id", "project_id"]);
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
    detail.embedded_media = collect_embedded_media(&detail);

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
    let modified = first_text(bug, &["modified", "lastmodify"]);
    let story_id = first_text(bug, &["story_id", "BugStoryRelation_relative_id"]);
    let story_name = first_text(bug, &["story_name", "BugStoryRelation_story_name"]);

    Some(BugSummary {
        short_id: short_id(bug, &id),
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
        assigned_time: first_text(bug, &["assigned_time", "current_owner_time"]),
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

/// TAPD's short id, falling back to the long id's trailing 7 digits.
///
/// The list endpoint returns `short_id` (it is in
/// [`super::LIST_SHOW_FIELDS`]) but the detail endpoint omits it. Without the
/// fallback the detail header shows `id.slice(-7)` while copy-to-clipboard
/// hands out the full 19-digit id, so the two disagree. TAPD's short id is the
/// tail of the numeric long id, which makes the fallback exact rather than
/// cosmetic.
fn short_id(bug: &Value, id: &str) -> String {
    let short = text(bug, "short_id");
    if !short.is_empty() {
        return short;
    }
    if id.len() > 7 && id.chars().all(|ch| ch.is_ascii_digit()) {
        return id[id.len() - 7..].to_string();
    }
    id.to_string()
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

    for key in object.keys() {
        if !key.starts_with("custom_field_") && !key.starts_with("custom_plan_field_") {
            continue;
        }
        // Scalars only; arrays/objects stringify to "" and are skipped.
        let value = text(bug, key).trim().to_string();
        if !value.is_empty() && value != "0" {
            fields.insert(key.clone(), value);
        }
    }

    fields
}

/// Trims TAPD's trailing `;` from people fields (`"张三;"` -> `"张三"`).
fn clean_people(value: String) -> String {
    value.trim().trim_end_matches(';').trim().to_string()
}
