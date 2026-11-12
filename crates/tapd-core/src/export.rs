//! Markdown export for handing a TAPD bug to a human or an AI agent.
//!
//! The document rendering (`markdown`) and the on-disk naming (`naming`)
//! are separate concerns; both operate on the pure data types, never on the
//! filesystem or the network. Resource collection lives in `tapd::api` so the
//! parser can reuse it without depending on the exporter.

mod markdown;
mod media;
mod naming;

pub use crate::tapd::api::{collect_embedded_media, collect_media, scan_html_media};
pub use crate::tapd::model::{MediaKind, MediaRef};
pub use markdown::{markdown_from_html, render_markdown};
pub use media::MediaAsset;
pub use naming::ascii_slug;

/// Converts a URL used for in-page previews into the downloadable variant.
pub fn download_url_for(url: &str) -> String {
    crate::tapd::api::preview_to_download(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tapd::model::{Attachment, BugDetail, BugSummary, Comment};

    fn sample_detail() -> BugDetail {
        BugDetail {
            summary: BugSummary {
                id: "1010606".to_string(),
                short_id: "1010606".to_string(),
                workspace_id: "45336192".to_string(),
                title: "示例缺陷".to_string(),
                status: "new".to_string(),
                status_label: "新".to_string(),
                priority: "high".to_string(),
                priority_label: "高".to_string(),
                severity: "normal".to_string(),
                severity_label: "一般".to_string(),
                owner: "李四".to_string(),
                creator: "王五".to_string(),
                created: "2026-11-09 19:57:06".to_string(),
                modified: "2026-11-09 20:13:37".to_string(),
                bug_url: "https://www.tapd.cn/tapd_fe/45336192/bug/detail/1010606".to_string(),
                ..BugSummary::default()
            },
            description_html: "<p>复现步骤</p><p><img src=\"https://file.tapd.cn/1/attachments/preview_attachments/2/a.png\"></p><video src=\"https://file.tapd.cn/1/attachments/preview_attachments/3/b.mp4\"></video>".to_string(),
            comments: vec![Comment {
                id: "c1".to_string(),
                author: "王五".to_string(),
                created: "2026-11-09 20:00:00".to_string(),
                description_html: "<p>补充说明</p>".to_string(),
                plain_text: "补充说明".to_string(),
                is_deleted: false,
                replies: vec![],
            }],
            attachments: vec![Attachment {
                id: "9".to_string(),
                filename: "log.ips".to_string(),
                content_type: "text/x-c".to_string(),
                size: 1024,
                download_url: "https://file.tapd.cn/1/attachments/download/9/log.ips".to_string(),
                ..Attachment::default()
            }],
            ..BugDetail::default()
        }
    }

    #[test]
    fn collects_media_from_html_comments_and_attachments() {
        let media = collect_media(&sample_detail());
        let urls: Vec<&str> = media.iter().map(|item| item.url.as_str()).collect();
        assert_eq!(urls.len(), 3);
        assert!(urls.iter().any(|url| url.ends_with("a.png")));
        assert!(urls.iter().any(|url| url.ends_with("b.mp4")));
        assert!(urls.iter().any(|url| url.ends_with("log.ips")));
    }

    #[test]
    fn renders_frontmatter_description_assets_and_comments() {
        let detail = sample_detail();
        let assets = vec![
            MediaAsset {
                url: "https://file.tapd.cn/1/attachments/preview_attachments/2/a.png".to_string(),
                relative_path: "assets/media-1-a.png".to_string(),
                filename: "media-1-a.png".to_string(),
                kind: MediaKind::Image,
                size: 100,
                content_type: "image/png".to_string(),
            },
            MediaAsset {
                url: "https://file.tapd.cn/1/attachments/preview_attachments/3/b.mp4".to_string(),
                relative_path: "assets/media-2-b.mp4".to_string(),
                filename: "media-2-b.mp4".to_string(),
                kind: MediaKind::Video,
                size: 200,
                content_type: "video/mp4".to_string(),
            },
            MediaAsset {
                url: "https://file.tapd.cn/1/attachments/download/9/log.ips".to_string(),
                relative_path: "assets/att-9-log.ips".to_string(),
                filename: "att-9-log.ips".to_string(),
                kind: MediaKind::File,
                size: 1024,
                content_type: "text/x-c".to_string(),
            },
        ];

        let markdown = render_markdown(&detail, &assets, "UU");
        assert!(markdown.contains("workspace: \"UU\""));
        assert!(markdown.contains("# 示例缺陷"));
        assert!(markdown.contains("!["));
        assert!(markdown.contains("assets/media-1-a.png"));
        assert!(markdown.contains("▶ 视频附件"));
        assert!(markdown.contains("assets/media-2-b.mp4"));
        assert!(markdown.contains("### 1. 王五"));
        assert!(markdown.contains("att-9-log.ips"));
    }

    #[test]
    fn collects_embedded_media_separately_from_attachments() {
        let detail = sample_detail();
        let embedded = collect_embedded_media(&detail);
        assert_eq!(embedded.len(), 2);
        assert!(embedded.iter().all(|item| item.kind != MediaKind::File));
        assert_eq!(collect_media(&detail).len(), 3);
    }

    #[test]
    fn renders_changes_with_before_and_after() {
        let mut detail = sample_detail();
        detail.changes = crate::tapd::model::ChangeHistory {
            total: 5,
            changes: vec![crate::tapd::model::ChangeEntry {
                seq: 1,
                time: "2026-11-09 17:03:16".to_string(),
                author: "张三".to_string(),
                kind: "手动变更".to_string(),
                fields: vec![crate::tapd::model::ChangeField {
                    field: "处理人".to_string(),
                    before: "赵六;".to_string(),
                    after: "张三".to_string(),
                }],
            }],
            error: None,
        };

        let markdown = render_markdown(&detail, &[], "UU");
        assert!(markdown.contains("## 变更记录"));
        assert!(markdown.contains("共 5 条，以下为最近 1 条"));
        assert!(markdown.contains("### 1. 2026-11-09 17:03:16 · 张三 · 手动变更"));
        assert!(markdown.contains("| 处理人 | 赵六; | 张三 |"));
    }

    #[test]
    fn renders_change_error_instead_of_failing() {
        let mut detail = sample_detail();
        detail.changes = crate::tapd::model::ChangeHistory {
            error: Some("HTTP 403".to_string()),
            ..Default::default()
        };

        let markdown = render_markdown(&detail, &[], "UU");
        assert!(markdown.contains("_变更记录获取失败：HTTP 403_"));
    }

    #[test]
    fn ascii_slug_drops_non_ascii() {
        assert_eq!(ascii_slug("【rust-会话详情】Upload Crash"), "rust-Upload-Crash");
        assert_eq!(ascii_slug("通话记录清空"), "");
        assert_eq!(ascii_slug("???"), "");
        assert_eq!(ascii_slug("BUG-1234"), "BUG-1234");
    }
}
