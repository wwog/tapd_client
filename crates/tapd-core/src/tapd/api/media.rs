//! Media referenced by a bug.
//!
//! Turns the parsed detail into the flat [`MediaRef`] list the detail page and
//! the Markdown exporter both consume, from attachments and from the rich-text
//! HTML.

use std::collections::HashSet;

use crate::tapd::model::{Attachment, BugDetail, Comment, MediaKind, MediaRef};

use super::html::scan_html_media;

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
