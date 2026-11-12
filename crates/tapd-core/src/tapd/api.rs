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
    fn single_owner_filter_is_a_string() {
        let query = BugQuery {
            workspace_id: "45336192".to_string(),
            owners: vec!["张三".to_string()],
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
        assert_eq!(filters[0]["value"], "张三");
        assert_eq!(filters[0]["fieldOption"], "equal");
        assert_eq!(filters[1]["fieldSystemName"], "status");
        assert_eq!(filters[1]["value"], json!(["new"]));
    }

    #[test]
    fn multiple_owners_filter_as_one_in_expr() {
        let query = BugQuery {
            workspace_id: "45336192".to_string(),
            owners: vec![
                "张三".to_string(),
                "  ".to_string(),
                "王五".to_string(),
            ],
            ..BugQuery::default()
        };
        let body = query.body();
        let filters = body
            .pointer("/filter_expr/data")
            .and_then(Value::as_array)
            .expect("filters");
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0]["fieldSystemName"], "current_owner");
        assert_eq!(filters[0]["fieldType"], "user_chooser");
        assert_eq!(filters[0]["fieldOption"], "in");
        assert_eq!(filters[0]["value"], json!(["张三", "王五"]));
    }

    #[test]
    fn creator_filter_targets_reporter() {
        let query = BugQuery {
            workspace_id: "45336192".to_string(),
            creator: Some("王五".to_string()),
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
        assert_eq!(filters[0]["value"], "王五");
    }

    #[test]
    fn digits_keyword_filters_by_bug_id() {
        let query = BugQuery {
            workspace_id: "45336192".to_string(),
            // The list column renders `#<short id>`; pasting it must work.
            keyword: Some(" #1010667 ".to_string()),
            ..BugQuery::default()
        };
        let body = query.body();
        let filters = body
            .pointer("/filter_expr/data")
            .and_then(Value::as_array)
            .expect("filters");
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0]["fieldSystemName"], "id");
        assert_eq!(filters[0]["fieldType"], "input");
        assert_eq!(filters[0]["fieldOption"], "equal");
        // A JSON number of this size loses precision in TAPD's web session.
        assert_eq!(filters[0]["value"], json!("1010667"));
    }

    #[test]
    fn text_keyword_filters_by_title() {
        let query = BugQuery {
            workspace_id: "45336192".to_string(),
            keyword: Some("崩溃".to_string()),
            ..BugQuery::default()
        };
        let body = query.body();
        let filters = body
            .pointer("/filter_expr/data")
            .and_then(Value::as_array)
            .expect("filters");
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0]["fieldSystemName"], "name");
        assert_eq!(filters[0]["fieldOption"], "like");
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
                    {"id": "u1", "nick": "张三", "name": "张三", "avatar": "https://a/1.png"},
                    {"id": "u2", "nick": "李四"}
                ],
                "departments": [{
                    "name": "测试组",
                    "members": [{"user_id": "u3", "nick": "王五", "user_name": "王五"}]
                }]
            },
            "meta": {"code": 0, "message": "success"}
        });
        let members = parse_workspace_members(&root);
        let mut nicks: Vec<&str> = members.iter().map(|member| member.nick.as_str()).collect();
        nicks.sort_unstable();
        assert_eq!(nicks, vec!["张三", "李四", "王五"]);
        let zhangsan = members.iter().find(|member| member.nick == "张三").expect("张三");
        let wangwu = members.iter().find(|member| member.nick == "王五").expect("王五");
        assert_eq!(zhangsan.user_id, "u1");
        assert_eq!(zhangsan.avatar, "https://a/1.png");
        assert_eq!(wangwu.user_id, "u3");
        assert_eq!(wangwu.name, "王五");
    }

    #[test]
    fn parses_workspace_members_used_by_get_workspace_members() {
        // Shape returned by `/api/basic/user/get_workspace_members`: the entry
        // only has `user`, no nick/user_id/name fields.
        let root = json!({
            "data": {
                "members": [
                    {"user": "赵六"},
                    {"user": "张三"},
                    {"user": "王五"},
                    {"user": "张三"}
                ]
            },
            "meta": {"code": "0", "message": "success"}
        });
        let members = parse_workspace_members(&root);
        let nicks: Vec<&str> = members.iter().map(|member| member.nick.as_str()).collect();
        assert_eq!(nicks, vec!["赵六", "张三", "王五"]);
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
                                "current_owner": "李四",
                                "reporter": "王五",
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
        assert_eq!(page.bugs[0].owner, "李四");
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
                            "current_owner": "李四",
                            "reporter": "王五",
                            "project_id": "45336192",
                            "description": "<p>hello <b>world</b></p><img src=\"https://file.tapd.cn/x\">",
                            "custom_field_one": "value",
                            "custom_field_two": ""
                        },
                        "comment_list": {
                            "comments": [{
                                "id": "1",
                                "author": "王五",
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
