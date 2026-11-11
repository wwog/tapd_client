//! Notification domain model.
//!
//! Wire/serde shapes (camelCase for the React window), settings defaults and
//! clamping, plus the small key helpers shared by the store, the poller and the
//! command handlers. Pure data: no I/O, no locks.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{MAX_POLL_INTERVAL_SECS, MIN_POLL_INTERVAL_SECS};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationKind {
    New,
    Transferred,
    Reopened,
    /// Raised by an MCP client (agent / external AI). The card is rendered
    /// from the generic `ai` payload instead of the bug fields.
    Ai,
}

impl NotificationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Transferred => "transferred",
            Self::Reopened => "reopened",
            Self::Ai => "ai",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "new" => Some(Self::New),
            "transferred" => Some(Self::Transferred),
            "reopened" => Some(Self::Reopened),
            "ai" => Some(Self::Ai),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationSource {
    #[default]
    Tapd,
    Ai,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationState {
    Pending,
    Handled,
    Viewed,
    Ignored,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationScope {
    #[default]
    Mine,
    Project,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QuietHours {
    pub enabled: bool,
    pub start: String,
    pub end: String,
}

impl Default for QuietHours {
    fn default() -> Self {
        Self {
            enabled: false,
            start: "22:00".to_string(),
            end: "09:00".to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationSettings {
    pub enabled: bool,
    pub scope: NotificationScope,
    pub include_new: bool,
    pub include_transferred: bool,
    pub include_reopened: bool,
    pub poll_interval_secs: u64,
    pub quiet_hours: QuietHours,
    pub max_visible: u32,
    /// Allows MCP clients to raise capsule notifications. Independent from
    /// `enabled`, which only controls TAPD bug polling.
    pub ai_enabled: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            scope: NotificationScope::Mine,
            include_new: true,
            include_transferred: true,
            include_reopened: true,
            poll_interval_secs: super::DEFAULT_POLL_INTERVAL_SECS,
            quiet_hours: QuietHours::default(),
            max_visible: 3,
            ai_enabled: true,
        }
    }
}

impl NotificationSettings {
    pub fn allows(&self, kind: NotificationKind) -> bool {
        match kind {
            NotificationKind::New => self.include_new,
            NotificationKind::Transferred => self.include_transferred,
            NotificationKind::Reopened => self.include_reopened,
            NotificationKind::Ai => self.ai_enabled,
        }
    }

    pub(super) fn normalized(mut self) -> Self {
        self.poll_interval_secs = self
            .poll_interval_secs
            .clamp(MIN_POLL_INTERVAL_SECS, MAX_POLL_INTERVAL_SECS);
        self.max_visible = self.max_visible.clamp(1, 5);
        if !super::rules::is_hhmm(&self.quiet_hours.start) {
            self.quiet_hours.start = QuietHours::default().start;
        }
        if !super::rules::is_hhmm(&self.quiet_hours.end) {
            self.quiet_hours.end = QuietHours::default().end;
        }
        self
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationItem {
    pub id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub bug_id: String,
    pub title: String,
    pub kind: NotificationKind,
    pub owner: String,
    pub creator: String,
    pub severity: String,
    pub priority: String,
    pub created: String,
    pub detected_at: String,
    pub state: NotificationState,
    #[serde(default)]
    pub source: NotificationSource,
    /// Populated only for `source = ai`; keeps the bug fields above untouched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<AiPayload>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiTone {
    #[default]
    Info,
    Success,
    Warning,
    Error,
    Progress,
}

impl AiTone {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "info" => Some(Self::Info),
            "success" => Some(Self::Success),
            "warning" => Some(Self::Warning),
            "error" => Some(Self::Error),
            "progress" => Some(Self::Progress),
            _ => None,
        }
    }
}

/// One content block in an AI notification. Unknown future block types are
/// rejected at the MCP boundary, so the renderer can stay exhaustive while the
/// schema grows.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiBlock {
    Text {
        text: String,
    },
    Code {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
    },
    Fields {
        fields: Vec<AiField>,
    },
    Progress {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        percent: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Divider,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiField {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAction {
    pub id: String,
    pub label: String,
    /// `primary` / `secondary` / `danger`; unknown values render as secondary.
    pub style: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResolution {
    /// `action`, `dismissed` or `replaced`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_label: Option<String>,
    pub at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPayload {
    pub tone: AiTone,
    /// MCP client that raised the notification (shown in the card header).
    pub client: String,
    pub blocks: Vec<AiBlock>,
    pub actions: Vec<AiAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<AiResolution>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SeenBug {
    pub status: String,
    pub owner: String,
    pub created: String,
    pub assigned_time: String,
    /// Notification kinds already emitted for this bug, used for de-duplication.
    pub kinds: Vec<String>,
    /// Last poll that observed this bug (`YYYY-MM-DD HH:MM:SS`); drives pruning.
    pub last_seen: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationStore {
    pub settings: NotificationSettings,
    pub items: Vec<NotificationItem>,
    pub seen: BTreeMap<String, SeenBug>,
    /// `workspaceId:bugId` keys the user ignored.
    pub ignored: Vec<String>,
    /// Workspace id -> cursor timestamp (`YYYY-MM-DD HH:MM:SS`). Presence also
    /// means the workspace has been polled before: a missing cursor is the
    /// first-round baseline.
    pub cursors: BTreeMap<String, String>,
}

impl Default for NotificationStore {
    fn default() -> Self {
        Self {
            settings: NotificationSettings::default(),
            items: Vec::new(),
            seen: BTreeMap::new(),
            ignored: Vec::new(),
            cursors: BTreeMap::new(),
        }
    }
}

pub fn bug_key(workspace_id: &str, bug_id: &str) -> String {
    format!("{}:{}", workspace_id.trim(), bug_id.trim())
}

pub fn scope_allows(scope: NotificationScope, owner: &str, me: &str) -> bool {
    match scope {
        NotificationScope::Project => true,
        NotificationScope::Mine => {
            let me = me.trim();
            !me.is_empty() && owner.trim() == me
        }
    }
}

/// Keeps at most `max` items, dropping the oldest ones first. Returns whether
/// anything was dropped (the poll persists a trim only when this is true).
pub(super) fn trim_oldest_items(items: &mut Vec<NotificationItem>, max: usize) -> bool {
    if items.len() <= max {
        return false;
    }
    let excess = items.len() - max;
    items.drain(0..excess);
    true
}
