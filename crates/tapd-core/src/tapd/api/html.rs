//! Helpers for the rich-text HTML TAPD embeds in descriptions and comments.
//!
//! TAPD stores rich text as HTML and only exposes embedded images/videos as
//! `<img>` / `<video>` / `<source>` tags, so both the parser (plain-text preview)
//! and the exporter (resource collection) need the same tag handling.

use crate::tapd::model::{MediaKind, MediaRef};

use super::endpoints::TAPD_BASE;

/// Strips tags, decodes entities and collapses whitespace into a single line.
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

/// Appends every `<img>` / `<video>` / `<source>` URL found in `html`.
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
                });
            }
        }

        index = end + 1;
    }
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
