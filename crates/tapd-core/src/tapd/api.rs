//! TAPD's internal (web session) API.
//!
//! Split by responsibility:
//!
//! - `endpoints`: base URL, paths, request bodies and [`BugQuery`].
//! - `parse`: response JSON -> model values.
//! - `labels`: status / priority / severity key -> display text.
//! - `html`: the rich-text HTML TAPD embeds in descriptions and comments.
//! - `media`: the media referenced by a bug (attachments + embedded media).
//! - `value`: small `serde_json::Value` readers shared by the above.
//!
//! Everything exposed from this module before the split is re-exported here, so
//! public paths such as `tapd::api::parse_bug_list` are unchanged.

mod endpoints;
mod html;
mod labels;
mod media;
mod parse;
mod value;

pub use endpoints::{
    attachment_download_url, bug_detail_body, bug_detail_url, bug_list_url, bug_web_url,
    preview_to_download, user_chooser_all_body, user_chooser_url, user_workspace_url,
    workspace_members_url, BugQuery, LIST_SHOW_FIELDS, PATH_BUG_DETAIL, PATH_BUG_LIST,
    PATH_USER_CHOOSER, PATH_USER_WORKSPACE, PATH_WORKSPACE_MEMBERS, TAPD_BASE,
};
pub use html::{decode_entities, html_to_text, scan_html_media};
pub use labels::{priority_label, severity_label, status_label};
pub use media::{collect_embedded_media, collect_media};
pub use parse::{parse_bug_detail, parse_bug_list, parse_workspace_members, parse_workspaces};

pub(crate) use html::{attribute_value, collapse_whitespace, normalize_media_url};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

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
