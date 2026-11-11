use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub pretty_name: String,
    pub category: String,
    pub status: String,
    pub logo_color: Option<String>,
    pub last_visited_time: Option<String>,
    pub jump_url: Option<String>,
}

/// A workspace member offered by the owner / developer pickers.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMember {
    /// TAPD nickname; this is the value stored in user fields.
    pub nick: String,
    /// TAPD user id, when the API exposes it.
    pub user_id: String,
    /// Display name when it differs from the nickname.
    pub name: String,
    /// Avatar URL, when available.
    pub avatar: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugSummary {
    pub id: String,
    pub short_id: String,
    pub workspace_id: String,
    pub title: String,
    pub status: String,
    pub status_label: String,
    pub priority: String,
    pub priority_label: String,
    pub severity: String,
    pub severity_label: String,
    pub owner: String,
    pub creator: String,
    pub created: String,
    /// When the current owner was assigned, when TAPD exposes it. Used by the
    /// notification classifier to tell a re-assignment apart from a comment.
    #[serde(default)]
    pub assigned_time: String,
    pub modified: String,
    pub due: String,
    pub iteration_id: String,
    pub iteration_name: String,
    pub module: String,
    pub version_report: String,
    pub story_id: String,
    pub story_name: String,
    pub bug_url: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugListPage {
    pub page: u32,
    pub perpage: u32,
    pub total: u32,
    pub status_map: BTreeMap<String, String>,
    /// Status keys in the workspace's configured workflow order. TAPD exposes
    /// this as an ordered object, so it must be read before sorting/grouping;
    /// `status_map` alone loses the order.
    #[serde(default)]
    pub status_order: Vec<String>,
    pub bugs: Vec<BugSummary>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub created: String,
    pub description_html: String,
    pub plain_text: String,
    pub is_deleted: bool,
    pub replies: Vec<Comment>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size: u64,
    pub filetype: String,
    pub owner: String,
    pub created: String,
    pub entry_id: String,
    pub video_poster: String,
    pub video_origin_file: String,
    pub download_url: String,
}

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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeField {
    pub field: String,
    pub before: String,
    pub after: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEntry {
    pub seq: u32,
    pub time: String,
    pub author: String,
    pub kind: String,
    pub fields: Vec<ChangeField>,
}

/// Result of the legacy `changes_list` page, which is server-rendered HTML.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeHistory {
    pub total: u32,
    pub changes: Vec<ChangeEntry>,
    /// Why the history could not be loaded, when the request or parse failed.
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugDetail {
    #[serde(flatten)]
    pub summary: BugSummary,
    pub description_html: String,
    pub description_text: String,
    pub platform: String,
    pub os: String,
    pub testtype: String,
    pub testphase: String,
    pub source: String,
    pub resolution: String,
    pub resolved: String,
    pub closed: String,
    pub reopen_time: String,
    pub fixer: String,
    pub de: String,
    pub te: String,
    pub participants: String,
    pub cc: String,
    pub follower: String,
    pub release_name: String,
    pub workspace_name: String,
    pub custom_fields: BTreeMap<String, String>,
    pub comments: Vec<Comment>,
    pub attachments: Vec<Attachment>,
    /// Media embedded in the description/comments (TAPD does not list these
    /// under `attachments`).
    pub embedded_media: Vec<MediaRef>,
    pub changes: ChangeHistory,
}
