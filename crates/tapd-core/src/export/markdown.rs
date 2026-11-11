//! `bug.md` rendering.
//!
//! Everything here is pure formatting over [`BugDetail`] and the downloaded
//! assets, so the same document is produced wherever the export is triggered
//! from (desktop or MCP).

use std::collections::BTreeMap;

use chrono::Local;

use crate::tapd::api::{
    attribute_value, collect_embedded_media, html_to_text, normalize_media_url,
};
use crate::tapd::model::{BugDetail, Comment, MediaKind};

use super::MediaAsset;

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
                let (link, downloaded) = asset_link(&attachment.download_url, &asset_map);
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
                    if downloaded {
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
                let (link, downloaded) = asset_link(&item.url, &asset_map);
                let label = match item.kind {
                    MediaKind::Image => {
                        format!("![{}]({})", escape_inline(&item.filename_hint), link)
                    }
                    _ => format!("[{}]({})", escape_inline(&item.filename_hint), link),
                };
                out.push_str(&format!(
                    "- {label} · 内嵌于描述/评论 · {}\n",
                    if downloaded {
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

/// Resolves a media URL to the downloaded asset's relative path.
///
/// Returns the original URL and `false` when the download failed, so the
/// document keeps a working link and can say so.
fn asset_link(url: &str, assets: &BTreeMap<&str, &MediaAsset>) -> (String, bool) {
    match assets.get(url) {
        Some(asset) => (asset.relative_path.clone(), true),
        None => (url.to_string(), false),
    }
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
