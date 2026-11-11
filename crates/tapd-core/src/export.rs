//! Markdown export for handing a TAPD bug to a human or an AI agent.

use std::collections::{BTreeMap, HashSet};

use chrono::Local;
use serde::{Deserialize, Serialize};

use crate::tapd::{
    api::{html_to_text, preview_to_download},
    model::{Attachment, BugDetail, Comment},
};
use crate::tapd::api::TAPD_BASE;

pub use crate::tapd::model::{MediaKind, MediaRef};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub url: String,
    /// Path relative to the export directory, e.g. `assets/att-1-log.ips`.
    pub relative_path: String,
    pub filename: String,
    pub kind: MediaKind,
    pub size: u64,
    pub content_type: String,
}

/// Collects images/videos embedded in the description and comments.
///
/// TAPD does not list these under `attachments`; they only exist inside the
/// rich-text HTML, which is why a bug can look like it has no resources.
pub fn collect_embedded_media(detail: &BugDetail) -> Vec<MediaRef> {
    let mut media = Vec::new();
    scan_html_media(&detail.description_html, &mut media);
    for comment in &detail.comments {
        scan_comment_media(comment, &mut media);
    }

    dedupe(media)
}

/// Collects every image/video/file referenced by the bug.
pub fn collect_media(detail: &BugDetail) -> Vec<MediaRef> {
    let mut media = collect_embedded_media(detail);
    for attachment in &detail.attachments {
        push_attachment(attachment, &mut media);
    }

    dedupe(media)
}

fn dedupe(media: Vec<MediaRef>) -> Vec<MediaRef> {
    let mut seen = HashSet::new();
    media
        .into_iter()
        .filter(|item| !item.url.is_empty() && seen.insert(item.url.clone()))
        .collect()
}

fn push_attachment(attachment: &Attachment, media: &mut Vec<MediaRef>) {
    if attachment.download_url.is_empty() {
        return;
    }
    media.push(MediaRef {
        url: attachment.download_url.clone(),
        kind: MediaKind::from_content_type(&attachment.content_type, &attachment.filename),
        filename_hint: attachment.filename.clone(),
    });
}

fn scan_comment_media(comment: &Comment, media: &mut Vec<MediaRef>) {
    scan_html_media(&comment.description_html, media);
    for reply in &comment.replies {
        scan_comment_media(reply, media);
    }
}

pub fn scan_html_media(html: &str, media: &mut Vec<MediaRef>) {
    let lower = html.to_ascii_lowercase();
    let mut index = 0usize;

    while let Some(offset) = lower[index..].find('<') {
        let start = index + offset;
        let Some(end_offset) = lower[start..].find('>') else {
            break;
        };
        let end = start + end_offset;
        let tag_lower = &lower[start..=end];
        let tag = &html[start..=end];

        let is_img = tag_lower.starts_with("<img");
        let is_video = tag_lower.starts_with("<video");
        let is_source = tag_lower.starts_with("<source");

        if is_img || is_video || is_source {
            if let Some(src) = attribute_value(tag, "src") {
                let url = normalize_media_url(&src);
                media.push(MediaRef {
                    kind: if is_img {
                        MediaKind::Image
                    } else {
                        MediaKind::Video
                    },
                    filename_hint: filename_hint(&url),
                    url,
                });
            }
        }

        index = end + 1;
    }
}

fn attribute_value(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{name}=");
    let mut search_from = 0usize;

    while let Some(found) = lower[search_from..].find(&needle) {
        let position = search_from + found;
        let before = lower[..position].chars().next_back();
        if before.is_some_and(|character| !character.is_whitespace() && character != '<') {
            search_from = position + needle.len();
            continue;
        }
        let mut rest = &tag[position + needle.len()..];
        rest = rest.trim_start();
        let quote = rest.chars().next()?;
        if quote == '"' || quote == '\'' {
            rest = &rest[quote.len_utf8()..];
            let end = rest.find(quote)?;
            return Some(crate::tapd::api::decode_entities(&rest[..end]));
        }
        let end = rest
            .find(|character: char| character.is_whitespace() || character == '>')
            .unwrap_or(rest.len());
        if end == 0 {
            return None;
        }
        return Some(crate::tapd::api::decode_entities(&rest[..end]));
    }

    None
}

fn normalize_media_url(url: &str) -> String {
    let url = crate::tapd::api::decode_entities(url.trim());
    if let Some(rest) = url.strip_prefix("//") {
        return format!("https://{rest}");
    }
    if url.starts_with('/') {
        return format!("{TAPD_BASE}{url}");
    }
    url
}

fn filename_hint(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let last = path.rsplit('/').next().unwrap_or_default();
    if last.is_empty() || last == "bug_description" {
        "asset".to_string()
    } else {
        last.to_string()
    }
}

/// Converts a URL used for in-page previews into the downloadable variant.
pub fn download_url_for(url: &str) -> String {
    preview_to_download(url)
}

/// Renders the final `bug.md` document.
pub fn render_markdown(
    detail: &BugDetail,
    assets: &[MediaAsset],
    workspace_label: &str,
) -> String {
    let asset_map: BTreeMap<&str, &MediaAsset> = assets
        .iter()
        .map(|asset| (asset.url.as_str(), asset))
        .collect();

    let mut out = String::new();
    let summary = &detail.summary;

    out.push_str("---\n");
    yaml(&mut out, "id", &summary.id);
    yaml(&mut out, "workspace", workspace_label);
    yaml(&mut out, "workspace_id", &summary.workspace_id);
    yaml(&mut out, "title", &summary.title);
    yaml(&mut out, "status", &summary.status_label);
    yaml(&mut out, "status_key", &summary.status);
    yaml(&mut out, "priority", &summary.priority_label);
    yaml(&mut out, "severity", &summary.severity_label);
    yaml(&mut out, "owner", &summary.owner);
    yaml(&mut out, "creator", &summary.creator);
    yaml(&mut out, "created", &summary.created);
    yaml(&mut out, "modified", &summary.modified);
    yaml(&mut out, "iteration", &summary.iteration_name);
    yaml(&mut out, "module", &summary.module);
    yaml(&mut out, "version_report", &summary.version_report);
    yaml(&mut out, "platform", &detail.platform);
    yaml(&mut out, "os", &detail.os);
    yaml(&mut out, "fixer", &detail.fixer);
    yaml(&mut out, "bug_url", &summary.bug_url);
    yaml(&mut out, "exported_at", &Local::now().to_rfc3339());
    yaml(&mut out, "exporter", "tapd-client/0.1.0");
    out.push_str("---\n\n");

    out.push_str(&format!("# {}\n\n", summary.title));

    out.push_str("## 基本信息\n\n");
    out.push_str("| 字段 | 值 |\n| --- | --- |\n");
    table_row(&mut out, "状态", &format!("{} ({})", summary.status_label, summary.status));
    table_row(&mut out, "优先级", &summary.priority_label);
    table_row(&mut out, "严重程度", &summary.severity_label);
    table_row(&mut out, "处理人", &summary.owner);
    table_row(&mut out, "创建人", &summary.creator);
    table_row(&mut out, "创建时间", &summary.created);
    table_row(&mut out, "最后修改", &summary.modified);
    table_row(&mut out, "发现版本", &summary.version_report);
    table_row(&mut out, "迭代", &summary.iteration_name);
    table_row(&mut out, "模块", &summary.module);
    table_row(&mut out, "修复人", &detail.fixer);
    table_row(&mut out, "解决时间", &detail.resolved);
    table_row(&mut out, "关闭时间", &detail.closed);
    if !detail.platform.is_empty() {
        table_row(&mut out, "平台", &detail.platform);
    }
    if !detail.os.is_empty() {
        table_row(&mut out, "操作系统", &detail.os);
    }
    out.push('\n');

    out.push_str("## 缺陷描述\n\n");
    let description = markdown_from_html(&detail.description_html, &asset_map);
    if description.trim().is_empty() {
        out.push_str("_暂无描述_\n\n");
    } else {
        out.push_str(description.trim());
        out.push_str("\n\n");
    }

    out.push_str("## 资源\n\n");
    let embedded = collect_embedded_media(detail);
    let has_resources = !detail.attachments.is_empty() || !embedded.is_empty();
    if !has_resources {
        out.push_str("_没有附件或内嵌图片/视频_\n\n");
    } else {
        if !detail.attachments.is_empty() {
            out.push_str("### 附件\n\n");
            for attachment in &detail.attachments {
                let downloaded = asset_map.get(attachment.download_url.as_str());
                let link = downloaded
                    .map(|asset| asset.relative_path.clone())
                    .unwrap_or_else(|| attachment.download_url.clone());
                let kind = MediaKind::from_content_type(&attachment.content_type, &attachment.filename);
                let label = match kind {
                    MediaKind::Image => {
                        format!("![{}]({})", escape_inline(&attachment.filename), link)
                    }
                    _ => format!("[{}]({})", escape_inline(&attachment.filename), link),
                };
                out.push_str(&format!(
                    "- {label} · {} · {} · {}\n",
                    format_size(attachment.size),
                    if attachment.content_type.is_empty() {
                        "unknown".to_string()
                    } else {
                        attachment.content_type.clone()
                    },
                    if downloaded.is_some() {
                        "已下载"
                    } else {
                        "下载失败，保留原始链接"
                    }
                ));
            }
            out.push('\n');
        }

        if !embedded.is_empty() {
            out.push_str("### 描述/评论内嵌\n\n");
            for item in &embedded {
                let downloaded = asset_map.get(item.url.as_str());
                let link = downloaded
                    .map(|asset| asset.relative_path.clone())
                    .unwrap_or_else(|| item.url.clone());
                let label = match item.kind {
                    MediaKind::Image => {
                        format!("![{}]({})", escape_inline(&item.filename_hint), link)
                    }
                    _ => format!("[{}]({})", escape_inline(&item.filename_hint), link),
                };
                out.push_str(&format!(
                    "- {label} · 内嵌于描述/评论 · {}\n",
                    if downloaded.is_some() {
                        "已下载"
                    } else {
                        "下载失败，保留原始链接"
                    }
                ));
            }
            out.push('\n');
        }
    }

    out.push_str("## 评论\n\n");
    if detail.comments.is_empty() {
        out.push_str("_没有评论_\n\n");
    } else {
        let mut counter = 0usize;
        for comment in &detail.comments {
            render_comment(&mut out, comment, &mut counter, 0, &asset_map);
        }
    }

    out.push_str("## 变更记录\n\n");
    render_changes(&mut out, detail);

    if !detail.custom_fields.is_empty() {
        out.push_str("## 自定义字段\n\n");
        out.push_str("| 字段 | 值 |\n| --- | --- |\n");
        for (key, value) in &detail.custom_fields {
            table_row(&mut out, key, value);
        }
        out.push('\n');
    }

    out.push_str("---\n\n");
    out.push_str(&format!(
        "> 由 TAPD Client 导出 · 原始链接：{}\n",
        summary.bug_url
    ));

    cleanup(&out)
}

fn render_changes(out: &mut String, detail: &BugDetail) {
    let history = &detail.changes;
    if let Some(error) = &history.error {
        out.push_str(&format!("_变更记录获取失败：{error}_\n\n"));
        return;
    }
    if history.changes.is_empty() {
        out.push_str("_没有变更记录_\n\n");
        return;
    }

    if history.total as usize > history.changes.len() {
        out.push_str(&format!(
            "共 {} 条，以下为最近 {} 条。\n\n",
            history.total,
            history.changes.len()
        ));
    }

    for change in &history.changes {
        out.push_str(&format!(
            "### {}. {} · {} · {}\n\n",
            change.seq, change.time, change.author, change.kind
        ));
        if change.fields.is_empty() {
            out.push_str("_（无字段明细）_\n\n");
            continue;
        }
        out.push_str("| 字段 | 变更前 | 变更后 |\n| --- | --- | --- |\n");
        for field in &change.fields {
            out.push_str(&format!(
                "| {} | {} | {} |\n",
                table_cell(&field.field),
                table_cell(&field.before),
                table_cell(&field.after)
            ));
        }
        out.push('\n');
    }
}

fn render_comment(
    out: &mut String,
    comment: &Comment,
    counter: &mut usize,
    depth: usize,
    assets: &BTreeMap<&str, &MediaAsset>,
) {
    *counter += 1;
    let heading = if depth == 0 { "###" } else { "####" };
    let prefix = if depth == 0 { "" } else { "回复 · " };
    out.push_str(&format!(
        "{heading} {}. {prefix}{} · {}\n\n",
        counter, comment.author, comment.created
    ));

    let body = markdown_from_html(&comment.description_html, assets);
    if body.trim().is_empty() {
        out.push_str("_（空评论）_\n\n");
    } else {
        out.push_str(body.trim());
        out.push_str("\n\n");
    }

    for reply in &comment.replies {
        render_comment(out, reply, counter, depth + 1, assets);
    }
}

pub fn markdown_from_html(html: &str, assets: &BTreeMap<&str, &MediaAsset>) -> String {
    if html.trim().is_empty() {
        return String::new();
    }

    let mut rewritten = html.to_string();
    let mut mappings: Vec<(&str, &str)> = assets
        .iter()
        .map(|(url, asset)| (*url, asset.relative_path.as_str()))
        .collect();
    mappings.sort_by(|left, right| right.0.len().cmp(&left.0.len()));
    for (url, relative) in mappings {
        rewritten = rewritten.replace(url, relative);
        rewritten = rewritten.replace(&url.replace('&', "&amp;"), relative);
    }

    let without_videos = replace_video_tags(&rewritten, assets);

    match htmd::convert(&without_videos) {
        Ok(markdown) => cleanup(&markdown),
        Err(_) => html_to_text(html),
    }
}

fn replace_video_tags(html: &str, assets: &BTreeMap<&str, &MediaAsset>) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut index = 0usize;

    while let Some(offset) = lower[index..].find("<video") {
        let start = index + offset;
        out.push_str(&html[index..start]);

        let Some(close_offset) = lower[start..].find("</video>") else {
            out.push_str(&html[start..]);
            return out;
        };
        let end = start + close_offset + "</video>".len();
        let block = &html[start..end];
        let block_lower = lower[start..end].to_string();

        let mut source = attribute_value(block, "src");
        if source.is_none() {
            let mut search = 0usize;
            while let Some(relative) = block_lower[search..].find("<source") {
                let position = search + relative;
                let Some(tag_end_offset) = block_lower[position..].find('>') else {
                    break;
                };
                let tag = &block[position..=position + tag_end_offset];
                if let Some(value) = attribute_value(tag, "src") {
                    source = Some(value);
                    break;
                }
                search = position + tag_end_offset + 1;
            }
        }

        let href = source
            .map(|source| {
                let normalized = normalize_media_url(&source);
                assets
                    .get(normalized.as_str())
                    .map(|asset| asset.relative_path.clone())
                    .unwrap_or(normalized)
            })
            .unwrap_or_default();

        if href.is_empty() {
            out.push_str("[视频附件]");
        } else {
            out.push_str(&format!("<p><a href=\"{href}\">▶ 视频附件</a></p>"));
        }

        index = end;
    }

    out.push_str(&html[index..]);
    out
}

fn yaml(out: &mut String, key: &str, value: &str) {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', " ");
    out.push_str(&format!("{key}: \"{escaped}\"\n"));
}

fn table_row(out: &mut String, key: &str, value: &str) {
    out.push_str(&format!(
        "| {} | {} |\n",
        table_cell(key),
        table_cell(value)
    ));
}

fn table_cell(value: &str) -> String {
    if value.trim().is_empty() {
        "—".to_string()
    } else {
        value.replace('|', "\\|").replace('\n', "<br>")
    }
}

fn escape_inline(value: &str) -> String {
    value.replace('[', "\\[").replace(']', "\\]")
}

fn format_size(bytes: u64) -> String {
    if bytes == 0 {
        return "—".to_string();
    }
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    if bytes < 1024 * 1024 {
        return format!("{:.1} KB", bytes as f64 / 1024.0);
    }
    format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
}

fn cleanup(markdown: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    let mut blank = 0usize;

    for line in markdown.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
            lines.push("");
        } else {
            blank = 0;
            lines.push(trimmed);
        }
    }

    let mut result = lines.join("\n");
    while result.ends_with('\n') {
        result.pop();
    }
    result.push('\n');
    result
}

/// Short, filesystem-safe slug used in export directory names.
///
/// ASCII-only on purpose: TAPD titles are usually Chinese, and non-ASCII paths
/// break on some Windows toolchains. The full title still lives in `bug.md`,
/// so the directory only needs to be short and unique. Returns an empty string
/// when the title has no usable ASCII characters, letting the caller fall back
/// to the bug id.
pub fn ascii_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
        if slug.len() >= 40 {
            break;
        }
    }

    slug.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tapd::model::BugSummary;

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
                owner: "何帅".to_string(),
                creator: "张芳兰".to_string(),
                created: "2026-11-09 19:57:06".to_string(),
                modified: "2026-11-09 20:13:37".to_string(),
                bug_url: "https://www.tapd.cn/tapd_fe/45336192/bug/detail/1010606".to_string(),
                ..BugSummary::default()
            },
            description_html: "<p>复现步骤</p><p><img src=\"https://file.tapd.cn/1/attachments/preview_attachments/2/a.png\"></p><video src=\"https://file.tapd.cn/1/attachments/preview_attachments/3/b.mp4\"></video>".to_string(),
            comments: vec![Comment {
                id: "c1".to_string(),
                author: "张芳兰".to_string(),
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
        assert!(markdown.contains("### 1. 张芳兰"));
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
                author: "郭俊宏".to_string(),
                kind: "手动变更".to_string(),
                fields: vec![crate::tapd::model::ChangeField {
                    field: "处理人".to_string(),
                    before: "范艺;".to_string(),
                    after: "郭俊宏".to_string(),
                }],
            }],
            error: None,
        };

        let markdown = render_markdown(&detail, &[], "UU");
        assert!(markdown.contains("## 变更记录"));
        assert!(markdown.contains("共 5 条，以下为最近 1 条"));
        assert!(markdown.contains("### 1. 2026-11-09 17:03:16 · 郭俊宏 · 手动变更"));
        assert!(markdown.contains("| 处理人 | 范艺; | 郭俊宏 |"));
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
