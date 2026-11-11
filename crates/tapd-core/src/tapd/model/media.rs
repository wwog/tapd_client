//! Images/videos referenced by a bug.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Image,
    Video,
    File,
}

impl MediaKind {
    pub fn from_content_type(content_type: &str, filename: &str) -> Self {
        let content_type = content_type.to_ascii_lowercase();
        if content_type.starts_with("image/") {
            return Self::Image;
        }
        if content_type.starts_with("video/") {
            return Self::Video;
        }

        let extension = filename
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        match extension.as_str() {
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" => Self::Image,
            "mp4" | "mov" | "webm" | "m4v" | "avi" => Self::Video,
            _ => Self::File,
        }
    }
}

/// An image/video embedded in the rich-text description or a comment.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRef {
    pub url: String,
    pub kind: MediaKind,
    pub filename_hint: String,
}
