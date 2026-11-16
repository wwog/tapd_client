//! Helpers for the rich-text HTML TAPD embeds in descriptions and comments.
//!
//! TAPD stores rich text as HTML. Embedded images/videos are `<img>` /
//! `<video>` / `<source>` tags, and files dragged into the editor are
//! `data-is-tapd-attachment` anchors (TAPD renders them as resource cards, not
//! as attachments), so both the parser (plain-text preview) and the exporter
//! (resource collection) need the same tag handling.

use crate::tapd::model::{MediaKind, MediaRef};

use super::endpoints::{TAPD_BASE, TAPD_FILE_BASE};

/// Strips tags, decodes entities and collapses whitespace into a single line.
///
/// Inline attachment cards are dropped entirely: they are listed under
/// resources, and keeping the card markup would duplicate the filename in the
/// description text.
pub fn html_to_text(html: &str) -> String {
    let html = without_attachment_cards(html);
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

    collapse_whitespace(&decode_entities(&text))
}

/// Collapses every whitespace run to one space and trims the ends.
pub(crate) fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
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

/// Appends every embedded resource found in `html`: images/videos and the
/// file cards TAPD's editor stores as `<a data-is-tapd-attachment>` anchors.
///
/// The scan is intentionally shallow (no DOM): TAPD emits well-formed tags and
/// removing the dependency would cost more than the tag walk it replaces.
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
                    size: 0,
                });
            }
        } else if tag_lower.starts_with("<a") && tag_lower.contains("data-is-tapd-attachment") {
            if let Some(attachment) = inline_attachment(tag) {
                media.push(attachment);
            }
        }

        index = end + 1;
    }
}

/// Turns an editor attachment card into a downloadable [`MediaRef`].
///
/// The card's `href` points at `www.tapd.cn/.../attachments/preview_attachments`
/// which only redirects to `file.tapd.cn`; that redirect drops the session
/// cookie, so the canonical `file.tapd.cn/.../attachments/download/{id}/{name}`
/// URL is built here and is downloaded directly.
fn inline_attachment(tag: &str) -> Option<MediaRef> {
    let href = attribute_value(tag, "href")?;
    let name = attribute_value(tag, "data-name").unwrap_or_default();
    let declared_type = attribute_value(tag, "data-file-type").unwrap_or_default();
    let size = attribute_value(tag, "data-size")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);

    let url = canonical_attachment_url(&href, &name).unwrap_or_else(|| normalize_media_url(&href));
    let filename = if name.trim().is_empty() {
        filename_hint(&url)
    } else {
        name.trim().to_string()
    };

    Some(MediaRef {
        kind: attachment_kind(&declared_type, &filename),
        filename_hint: filename,
        url,
        size,
    })
}

/// Rewrites `/ {workspace} /attachments/(preview_attachments|download) / {id} /
/// {field}` into the downloadable `file.tapd.cn` URL, keeping the real filename
/// so the cached copy gets the right extension.
fn canonical_attachment_url(href: &str, name: &str) -> Option<String> {
    let relative = tapd_relative_path(href)?;
    let path = relative
        .split(['?', '#'])
        .next()
        .unwrap_or(relative.as_str());
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let attachments = segments.iter().position(|part| *part == "attachments")?;
    if attachments == 0 {
        return None;
    }

    let workspace = segments[attachments - 1];
    let id = segments.get(attachments + 2)?;
    let numeric = |value: &str| value.chars().all(|character| character.is_ascii_digit());
    if workspace.is_empty() || id.is_empty() || !numeric(workspace) || !numeric(id) {
        return None;
    }

    let filename = if name.trim().is_empty() {
        segments
            .get(attachments + 3)
            .copied()
            .unwrap_or("attachment")
    } else {
        name.trim()
    };

    Some(format!(
        "{TAPD_FILE_BASE}/{workspace}/attachments/download/{id}/{}",
        encode_path_segment(filename)
    ))
}

/// Root-relative path of a TAPD URL; `None` for any other host.
fn tapd_relative_path(href: &str) -> Option<String> {
    let trimmed = href.trim();
    if trimmed.starts_with('/') && !trimmed.starts_with("//") {
        return Some(trimmed.to_string());
    }

    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .or_else(|| trimmed.strip_prefix("//"))?;
    let (host, path) = rest.split_once('/')?;
    let host = host.to_ascii_lowercase();
    if host != "tapd.cn" && !host.ends_with(".tapd.cn") {
        return None;
    }
    Some(format!("/{path}"))
}

/// Percent-encodes one path segment; TAPD filenames carry spaces and CJK.
fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn attachment_kind(declared_type: &str, filename: &str) -> MediaKind {
    match declared_type.trim().to_ascii_lowercase().as_str() {
        "image" => MediaKind::Image,
        "video" => MediaKind::Video,
        _ => MediaKind::from_content_type("", filename),
    }
}

/// Removes the editor attachment cards (markup and card text) from `html`.
fn without_attachment_cards(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut stripped = String::with_capacity(html.len());
    let mut index = 0usize;

    while let Some(offset) = lower[index..].find('<') {
        let start = index + offset;
        let Some(end_offset) = lower[start..].find('>') else {
            break;
        };
        let end = start + end_offset;
        let tag_lower = &lower[start..=end];

        if tag_lower.starts_with("<a") && tag_lower.contains("data-is-tapd-attachment") {
            match lower[end + 1..].find("</a>") {
                Some(close) => index = end + 1 + close + "</a>".len(),
                None => index = end + 1,
            }
            continue;
        }

        stripped.push_str(&html[index..=end]);
        index = end + 1;
    }

    stripped.push_str(&html[index..]);
    stripped
}

/// Reads one quoted or bare attribute value out of a single tag.
pub(crate) fn attribute_value(tag: &str, name: &str) -> Option<String> {
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
            return Some(decode_entities(&rest[..end]));
        }
        let end = rest
            .find(|character: char| character.is_whitespace() || character == '>')
            .unwrap_or(rest.len());
        if end == 0 {
            return None;
        }
        return Some(decode_entities(&rest[..end]));
    }

    None
}

/// Resolves protocol-relative and root-relative media URLs against TAPD.
pub(crate) fn normalize_media_url(url: &str) -> String {
    let url = decode_entities(url.trim());
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Markup copied from a real bug description: TAPD's editor stores a
    /// dragged-in file as an anchor card, not as an `attachment_list` entry.
    const CARD: &str = "<p><a data-is-tapd-attachment=\"true\" contenteditable=\"false\" target=\"_blank\" rel=\"noopener\" data-can-preview=\"false\" data-file-type=\"text\" type=\"text\" data-name=\"接听方用户B.xlog\" data-size=\"2109993\" href=\"/45336192/attachments/preview_attachments/1145336192001002881/bug_description_attachment\" class=\"tapd-editor__attachment-item\"><span class=\"tapd-editor__attachment-item__title\">接听方用户B.xlog</span><span class=\"tapd-editor__attachment-item__size\">2.01MB</span></a></p>";

    #[test]
    fn inline_attachment_cards_become_downloadable_resources() {
        let mut media = Vec::new();
        scan_html_media(CARD, &mut media);

        assert_eq!(media.len(), 1);
        let item = &media[0];
        assert_eq!(item.kind, MediaKind::File);
        assert_eq!(item.filename_hint, "接听方用户B.xlog");
        assert_eq!(item.size, 2_109_993);
        // The `www.tapd.cn` href would redirect to the file host and drop the
        // session cookie, so the download URL must already point there.
        assert_eq!(
            item.url,
            "https://file.tapd.cn/45336192/attachments/download/1145336192001002881/%E6%8E%A5%E5%90%AC%E6%96%B9%E7%94%A8%E6%88%B7B.xlog"
        );
    }

    #[test]
    fn inline_cards_are_not_repeated_in_the_plain_text() {
        let html = format!("<p>复现步骤</p>{CARD}<p>结束</p>");
        assert_eq!(html_to_text(&html), "复现步骤 结束");
    }

    #[test]
    fn ordinary_links_and_images_are_untouched() {
        let mut media = Vec::new();
        scan_html_media(
            "<p><a href=\"https://example.com/x\">链接</a><img src=\"//file.tapd.cn/1/a.png\"></p>",
            &mut media,
        );

        assert_eq!(media.len(), 1);
        assert_eq!(media[0].kind, MediaKind::Image);
        assert_eq!(media[0].url, "https://file.tapd.cn/1/a.png");
        assert_eq!(
            html_to_text("<p><a href=\"https://example.com/x\">链接</a></p>"),
            "链接"
        );
    }

    #[test]
    fn attachment_kind_follows_the_card_metadata() {
        assert_eq!(attachment_kind("image", "a.bin"), MediaKind::Image);
        assert_eq!(attachment_kind("video", "a.bin"), MediaKind::Video);
        assert_eq!(attachment_kind("text", "a.xlog"), MediaKind::File);
    }

    #[test]
    fn canonical_url_rejects_foreign_hrefs() {
        assert_eq!(
            canonical_attachment_url("/45336192/attachments/download/1/a.xlog", "a.xlog"),
            Some("https://file.tapd.cn/45336192/attachments/download/1/a.xlog".to_string())
        );
        assert_eq!(
            canonical_attachment_url("https://example.com/45336192/attachments/download/1/a", ""),
            None
        );
    }
}
