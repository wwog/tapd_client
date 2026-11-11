//! M6 — new-bug detection, self-drawn notification window and the accept action.
//!
//! Everything here is owned by the M6 implementation and exposed through
//! `feature_command` names starting with `notification_`.
//!
//! Design notes:
//! - Polling never touches the UI directly; it records items in SQLite
//!   (`cache.sqlite3`, tables in `notification_db.rs`) and emits
//!   `notification://show`.
//! - The first poll for a workspace is a baseline: bugs are recorded in `seen`
//!   but no notification is produced.
//! - Classification is a set of pure functions (`classify_bug`, `quiet_hours_active`,
//!   body builders) so the business rules are unit-testable without TAPD.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use chrono::{Duration as ChronoDuration, Local, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tapd_core::{
    config::AppConfig,
    tapd::{
        api::{
            bug_detail_body, bug_detail_url, bug_list_url, parse_bug_detail, parse_bug_list,
            parse_workspaces, user_workspace_url, BugQuery,
        },
        Workspace,
    },
};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    bug_write,
    commands::session_request_json,
    notification_db::{self, PollWrite},
    state::SharedState,
};

const MAX_ITEMS: usize = 200;
const MAX_HISTORY: usize = 100;
/// AI notifications are transient prompts, so they stay in memory only.
const MAX_AI_ITEMS: usize = 20;
const MAX_AI_BLOCKS: usize = 8;
const MAX_AI_ACTIONS: usize = 4;
const MAX_AI_TITLE_CHARS: usize = 140;
const MAX_AI_TEXT_CHARS: usize = 1_500;
const MAX_AI_CODE_CHARS: usize = 4_000;
const MAX_AI_TAG_CHARS: usize = 64;
/// How long `tapd_notify_user` waits for the user by default.
const DEFAULT_NOTIFY_WAIT_SECS: u64 = 30;
const MAX_NOTIFY_WAIT_SECS: u64 = 120;
const FRESH_WINDOW_MINUTES: i64 = 5;
const OVERLAP_MINUTES: i64 = 2;
const POLL_PAGE_SIZE: u32 = 200;
/// Page cap per round. Baseline runs once and may need more; incremental
/// rounds stay small. A truncated round keeps its cursor and retries.
const MAX_BASELINE_PAGES: u32 = 25;
const MAX_POLL_PAGES: u32 = 10;
/// Small pause between pages so a baseline sweep does not burst TAPD.
const POLL_PAGE_DELAY: Duration = Duration::from_millis(120);
const MAX_DETAIL_LOOKUPS: usize = 5;
/// Seen-bug retention: drop rows untouched for this long, and cap the table.
const SEEN_RETENTION_DAYS: i64 = 90;
const MAX_SEEN_ENTRIES: usize = 20_000;

/// Default and bounds for the notification poll interval.
const DEFAULT_POLL_INTERVAL_SECS: u64 = 30;
const MIN_POLL_INTERVAL_SECS: u64 = 20;
const MAX_POLL_INTERVAL_SECS: u64 = 600;

static SERVICE: OnceLock<Arc<NotificationService>> = OnceLock::new();
/// Bumped whenever a notification session starts (app launch is implicit, login
/// and logout call `reset_session`). A poll that started under an older session
/// drops its results instead of leaking them into the new account.
static SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Domain types (serialized camelCase for the React window)
// ---------------------------------------------------------------------------

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
            poll_interval_secs: DEFAULT_POLL_INTERVAL_SECS,
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

    fn normalized(mut self) -> Self {
        self.poll_interval_secs = self
            .poll_interval_secs
            .clamp(MIN_POLL_INTERVAL_SECS, MAX_POLL_INTERVAL_SECS);
        self.max_visible = self.max_visible.clamp(1, 5);
        if !is_hhmm(&self.quiet_hours.start) {
            self.quiet_hours.start = QuietHours::default().start;
        }
        if !is_hhmm(&self.quiet_hours.end) {
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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// AI notification payload parsing
// ---------------------------------------------------------------------------

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

fn required_text(value: Option<&Value>, path: &str, max: usize) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| truncate_chars(text, max))
        .ok_or_else(|| format!("{path} 不能为空"))
}

fn parse_ai_fields(value: &Value, path: &str) -> Result<Vec<AiField>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| format!("{path} 必须是数组"))?;
    if items.len() > 8 {
        return Err(format!("{path} 最多 8 项"));
    }
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let label = required_text(item.get("label"), &format!("{path}[{index}].label"), 24)?;
            let value = item
                .get("value")
                .and_then(Value::as_str)
                .map(str::trim)
                .map(|text| truncate_chars(text, 120))
                .unwrap_or_default();
            Ok(AiField { label, value })
        })
        .collect()
}

fn parse_ai_progress(value: &Value, path: &str) -> Result<AiBlock, String> {
    let percent = value.get("percent").and_then(Value::as_f64).map(|percent| {
        if percent.is_finite() {
            percent.clamp(0.0, 100.0)
        } else {
            0.0
        }
    });
    let label = value
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(|label| truncate_chars(label, 80));
    if percent.is_none() && label.is_none() {
        return Err(format!("{path} 需要 percent 或 label"));
    }
    Ok(AiBlock::Progress { percent, label })
}

fn parse_ai_block(block: &Value, index: usize) -> Result<AiBlock, String> {
    let path = format!("blocks[{index}]");
    let kind = block
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|kind| !kind.is_empty())
        .ok_or_else(|| format!("{path}.type 不能为空"))?;

    match kind {
        "text" => Ok(AiBlock::Text {
            text: required_text(
                block.get("text"),
                &format!("{path}.text"),
                MAX_AI_TEXT_CHARS,
            )?,
        }),
        "code" => Ok(AiBlock::Code {
            text: block
                .get("text")
                .and_then(Value::as_str)
                .map(|text| truncate_chars(text, MAX_AI_CODE_CHARS))
                .unwrap_or_default(),
            language: block
                .get("language")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|language| !language.is_empty())
                .map(|language| truncate_chars(language, 24)),
        }),
        "fields" => {
            let fields = parse_ai_fields(
                block.get("fields").unwrap_or(&Value::Null),
                &format!("{path}.fields"),
            )?;
            Ok(AiBlock::Fields { fields })
        }
        "progress" => parse_ai_progress(block, &path),
        "divider" => Ok(AiBlock::Divider),
        other => Err(format!(
            "{path}.type 不支持「{other}」，可用 text / code / fields / progress / divider"
        )),
    }
}

fn parse_ai_actions(value: Option<&Value>) -> Result<Vec<AiAction>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let items = value
        .as_array()
        .ok_or_else(|| "actions 必须是数组".to_string())?;
    if items.len() > MAX_AI_ACTIONS {
        return Err(format!("actions 最多 {MAX_AI_ACTIONS} 个"));
    }

    let mut seen = BTreeSet::new();
    let mut actions = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let path = format!("actions[{index}]");
        let id = required_text(item.get("id"), &format!("{path}.id"), 48)?;
        if !seen.insert(id.clone()) {
            return Err(format!("{path}.id「{id}」重复"));
        }
        let label = required_text(item.get("label"), &format!("{path}.label"), 24)?;
        let style = match item.get("style").and_then(Value::as_str) {
            None | Some("") => "secondary".to_string(),
            Some(style @ ("primary" | "secondary" | "danger")) => style.to_string(),
            Some(_) => {
                return Err(format!("{path}.style 必须是 primary / secondary / danger"));
            }
        };
        actions.push(AiAction { id, label, style });
    }
    Ok(actions)
}

/// Parses the MCP arguments into a title plus the generic AI payload.
///
/// Supports both the shorthand (`body` / `fields` / `progress`) and the
/// explicit `blocks` array. Text is truncated so a runaway message cannot
/// break the fixed-height capsule card.
pub fn ai_payload_from_arguments(
    arguments: &Value,
    client: &str,
) -> Result<(String, AiPayload), String> {
    let title = required_text(arguments.get("title"), "title", MAX_AI_TITLE_CHARS)?;
    let tone = match arguments.get("tone").and_then(Value::as_str) {
        None => AiTone::Info,
        Some(raw) => AiTone::parse(raw)
            .ok_or_else(|| "tone 必须是 info / success / warning / error / progress".to_string())?,
    };

    let blocks = match arguments.get("blocks") {
        None => Vec::new(),
        Some(Value::Array(items)) if items.is_empty() => Vec::new(),
        Some(Value::Array(items)) => {
            if items.len() > MAX_AI_BLOCKS {
                return Err(format!("blocks 最多 {MAX_AI_BLOCKS} 个"));
            }
            items
                .iter()
                .enumerate()
                .map(|(index, block)| parse_ai_block(block, index))
                .collect::<Result<Vec<_>, _>>()?
        }
        Some(_) => return Err("blocks 必须是数组".to_string()),
    };

    let mut blocks = blocks;
    if blocks.is_empty() {
        if let Some(body) = arguments
            .get("body")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|body| !body.is_empty())
        {
            blocks.push(AiBlock::Text {
                text: truncate_chars(body, MAX_AI_TEXT_CHARS),
            });
        }
        if let Some(fields) = arguments.get("fields").filter(|fields| !fields.is_null()) {
            let fields = parse_ai_fields(fields, "fields")?;
            if !fields.is_empty() {
                blocks.push(AiBlock::Fields { fields });
            }
        }
        if let Some(progress) = arguments
            .get("progress")
            .filter(|progress| !progress.is_null())
        {
            blocks.push(parse_ai_progress(progress, "progress")?);
        }
    }

    let actions = parse_ai_actions(arguments.get("actions"))?;
    let tag = arguments
        .get("tag")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(|tag| truncate_chars(tag, MAX_AI_TAG_CHARS));

    let client = if client.trim().is_empty() {
        "AI".to_string()
    } else {
        truncate_chars(client.trim(), 40)
    };

    Ok((
        title,
        AiPayload {
            tone,
            client,
            blocks,
            actions,
            tag,
            resolution: None,
        },
    ))
}

fn notify_wait_seconds(arguments: &Value) -> u64 {
    arguments
        .get("waitSeconds")
        .or_else(|| arguments.get("wait_seconds"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_NOTIFY_WAIT_SECS)
        .min(MAX_NOTIFY_WAIT_SECS)
}

pub fn parse_tapd_time(raw: &str) -> Option<NaiveDateTime> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M"))
        .ok()
}

pub fn format_tapd_time(time: NaiveDateTime) -> String {
    time.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn is_recent(raw: &str, now: NaiveDateTime, minutes: i64) -> bool {
    let Some(time) = parse_tapd_time(raw) else {
        return false;
    };
    let delta = now - time;
    delta.num_minutes() <= minutes && delta.num_minutes() >= -1
}

fn assigned_recently(created: &str, assigned_time: &str, now: NaiveDateTime) -> bool {
    let Some(assigned) = parse_tapd_time(assigned_time) else {
        return false;
    };
    // "Assigned at creation time" means the bug was created for me, not transferred.
    if let Some(created) = parse_tapd_time(created) {
        if (assigned - created).num_seconds().abs() <= 60 {
            return false;
        }
    }
    let delta = now - assigned;
    delta.num_minutes() <= 10 && delta.num_minutes() >= -1
}

/// Classifies a bug into a notification kind.
///
/// `open` is handled exactly like `new` (both are non-reopened starting
/// statuses), so it is still split into `new` vs `transferred` by creation and
/// assignment time.
///
/// `previous` is the last observed state for this bug (`None` = first sighting
/// after the baseline). `trust_recent_assignment` is true for `scope=mine`,
/// where a newly visible bug owned by me can be assumed to have just been
/// assigned even if `assigned_time` is unavailable. For `scope=project` the
/// caller looks up the detail first; without `assigned_time` we stay silent to
/// avoid notifying on every comment.
pub fn classify_bug(
    status: &str,
    owner: &str,
    created: &str,
    assigned_time: &str,
    previous: Option<&SeenBug>,
    me: &str,
    now: NaiveDateTime,
    trust_recent_assignment: bool,
) -> Option<NotificationKind> {
    let me = me.trim();
    if me.is_empty() {
        return None;
    }
    let status = status.trim();
    let owner = owner.trim();

    if let Some(previous) = previous {
        if status == "reopened" && previous.status.trim() != "reopened" {
            return Some(NotificationKind::Reopened);
        }
        if owner == me && previous.owner.trim() != me {
            return Some(NotificationKind::Transferred);
        }
        // scope=mine never observes the bug while it is assigned to someone
        // else, so a transfer back looks like "owner unchanged". A new
        // assigned_time is the only evidence TAPD gives us; comparing it with
        // the last observed value yields one notification per assignment
        // instead of one forever (the old lifetime de-dupe).
        if owner == me
            && previous.owner.trim() == me
            && previous.assigned_time.trim() != assigned_time.trim()
            && assigned_recently(created, assigned_time, now)
        {
            return Some(NotificationKind::Transferred);
        }
        return None;
    }

    if status == "reopened" {
        return Some(NotificationKind::Reopened);
    }
    // `open` deliberately goes through the same new/transferred split as `new`.
    if is_recent(created, now, FRESH_WINDOW_MINUTES) {
        return Some(NotificationKind::New);
    }
    let recently_assigned = assigned_recently(created, assigned_time, now);
    let assumption = trust_recent_assignment && owner == me && assigned_time.trim().is_empty();
    if owner == me && (recently_assigned || assumption) {
        return Some(NotificationKind::Transferred);
    }

    None
}

fn parse_hhmm(raw: &str) -> Option<NaiveTime> {
    let (hour, minute) = raw.trim().split_once(':')?;
    let hour: u32 = hour.trim().parse().ok()?;
    let minute: u32 = minute.trim().parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    NaiveTime::from_hms_opt(hour, minute, 0)
}

pub fn is_hhmm(raw: &str) -> bool {
    parse_hhmm(raw).is_some()
}

pub fn quiet_hours_active(quiet: &QuietHours, now: NaiveTime) -> bool {
    if !quiet.enabled {
        return false;
    }
    let (Some(start), Some(end)) = (parse_hhmm(&quiet.start), parse_hhmm(&quiet.end)) else {
        return false;
    };
    if start == end {
        return false;
    }
    if start < end {
        now >= start && now < end
    } else {
        // Window crosses midnight, e.g. 22:00 -> 09:00.
        now >= start || now < end
    }
}

/// Extracts the workspace id from `https://www.tapd.cn/tapd_fe/<id>/...`.
pub fn workspace_from_session_url(raw: &str) -> Option<String> {
    let (_, rest) = raw.split_once("tapd_fe/")?;
    let segment = rest.split(['/', '?', '#']).next()?.trim();
    if !segment.is_empty() && segment.chars().all(|character| character.is_ascii_digit()) {
        Some(segment.to_string())
    } else {
        None
    }
}

/// Result of one poll round. A round can partially succeed (some projects
/// polled, others failed), so "did poll" and the error are tracked separately.
#[derive(Debug, Default)]
struct PollReport {
    polled: bool,
    /// At least one notification item was created this round.
    notified: bool,
    error: Option<String>,
}

/// The first completed round after a session starts is silent: it only records
/// state, so entering the app never replays a backlog. `baseline` (no cursor)
/// is always silent; a truncated incremental round stays unprimed and is silent
/// again until it consumes the whole window.
fn round_is_silent(baseline: bool, primed: bool) -> bool {
    baseline || !primed
}

/// Drops seen entries untouched for `SEEN_RETENTION_DAYS`, then keeps at most
/// `MAX_SEEN_ENTRIES` newest rows. Returns the removed keys for the DB mirror.
fn prune_seen(store: &mut NotificationStore, now: NaiveDateTime) -> Vec<String> {
    let cutoff = now - ChronoDuration::days(SEEN_RETENTION_DAYS);
    let mut remove: BTreeSet<String> = store
        .seen
        .iter()
        .filter(|(_, seen)| parse_tapd_time(&seen.last_seen).is_some_and(|last| last < cutoff))
        .map(|(key, _)| key.clone())
        .collect();

    if store.seen.len().saturating_sub(remove.len()) > MAX_SEEN_ENTRIES {
        let mut keep: Vec<(String, NaiveDateTime)> = store
            .seen
            .iter()
            .filter(|(key, _)| !remove.contains(key.as_str()))
            .map(|(key, seen)| (key.clone(), parse_tapd_time(&seen.last_seen).unwrap_or(now)))
            .collect();
        keep.sort_by(|left, right| right.1.cmp(&left.1));
        remove.extend(keep.into_iter().skip(MAX_SEEN_ENTRIES).map(|(key, _)| key));
    }

    for key in &remove {
        store.seen.remove(key);
    }
    // An ignored key only matters while its bug is still tracked; drop it with
    // the seen row so `notification_ignored` cannot grow forever.
    store.ignored.retain(|key| !remove.contains(key));
    remove.into_iter().collect()
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

struct NotificationService {
    app: AppHandle,
    state: SharedState,
    store: Mutex<NotificationStore>,
    /// AI / MCP notifications are transient prompts: memory only, never
    /// persisted, cleared on restart.
    ai_items: Mutex<VecDeque<NotificationItem>>,
    workspace_names: Mutex<BTreeMap<String, String>>,
    /// Workspaces whose first round in this session has completed. The first
    /// round only records state; anything after it may notify.
    primed: Mutex<BTreeSet<String>>,
    last_poll_at: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
    wake: tokio::sync::Notify,
}

impl NotificationService {
    fn settings(&self) -> NotificationSettings {
        self.store
            .lock()
            .expect("notification store lock")
            .settings
            .clone()
    }

    fn persist_settings(&self) {
        let settings = self.settings();
        notification_db::save_settings(&self.state.cache, &settings);
    }

    fn workspace_name(&self, workspace_id: &str) -> String {
        self.workspace_names
            .lock()
            .expect("workspace names lock")
            .get(workspace_id)
            .cloned()
            .unwrap_or_else(|| workspace_id.to_string())
    }

    fn find_item(&self, id: &str) -> Result<NotificationItem, String> {
        self.store
            .lock()
            .expect("notification store lock")
            .items
            .iter()
            .rev()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| "通知不存在或已被清理".to_string())
    }

    fn set_state(&self, id: &str, state: NotificationState) -> Result<NotificationItem, String> {
        let item = {
            let mut store = self.store.lock().expect("notification store lock");
            let item = store
                .items
                .iter_mut()
                .rev()
                .find(|item| item.id == id)
                .ok_or_else(|| "通知不存在或已被清理".to_string())?;
            item.state = state;
            item.clone()
        };
        notification_db::update_item_state(&self.state.cache, id, state);
        Ok(item)
    }

    fn push_item(&self, item: NotificationItem) {
        {
            let mut store = self.store.lock().expect("notification store lock");
            store.items.push(item.clone());
            if store.items.len() > MAX_ITEMS {
                let excess = store.items.len() - MAX_ITEMS;
                store.items.drain(0..excess);
            }
        }
        notification_db::insert_item(&self.state.cache, &item, MAX_ITEMS);
    }

    fn pending_payload(&self) -> (Vec<NotificationItem>, bool) {
        let (mut items, quiet_hours, max) = {
            let store = self.store.lock().expect("notification store lock");
            (
                store
                    .items
                    .iter()
                    .filter(|item| item.state == NotificationState::Pending)
                    .cloned()
                    .collect::<Vec<_>>(),
                quiet_hours_active(&store.settings.quiet_hours, Local::now().time()),
                store.settings.max_visible.max(1) as usize,
            )
        };
        {
            let ai_items = self.ai_items.lock().expect("ai notification lock");
            items.extend(
                ai_items
                    .iter()
                    .filter(|item| item.state == NotificationState::Pending)
                    .cloned(),
            );
        }
        // Explicit AI prompts come first (they may be waiting for a click),
        // then newest-first within each source.
        items.sort_by(|left, right| {
            let left_ai = left.source == NotificationSource::Ai;
            let right_ai = right.source == NotificationSource::Ai;
            right_ai
                .cmp(&left_ai)
                .then_with(|| right.detected_at.cmp(&left.detected_at))
        });
        items.truncate(max);
        // Explicit AI prompts are user-addressed; quiet hours only silence
        // background bug notifications.
        let has_ai = items
            .iter()
            .any(|item| item.source == NotificationSource::Ai);
        (items, quiet_hours && !has_ai)
    }

    /// Recent items (bugs first, newest-first overall) for settings/history.
    fn recent_items(&self, limit: usize) -> Vec<NotificationItem> {
        let mut items = self
            .store
            .lock()
            .expect("notification store lock")
            .items
            .clone();
        items.extend(
            self.ai_items
                .lock()
                .expect("ai notification lock")
                .iter()
                .cloned(),
        );
        items.sort_by(|left, right| right.detected_at.cmp(&left.detected_at));
        items.truncate(limit);
        items
    }

    fn find_ai_item(&self, id: &str) -> Result<NotificationItem, String> {
        self.ai_items
            .lock()
            .expect("ai notification lock")
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| "通知不存在或已被清理".to_string())
    }

    /// Creates an AI notification. `bypass_enabled` is used by the settings
    /// debug panel so a test card still appears while AI notifications are off.
    fn raise_ai(
        &self,
        title: String,
        payload: AiPayload,
        bypass_enabled: bool,
    ) -> Result<NotificationItem, String> {
        if !bypass_enabled && !self.settings().ai_enabled {
            return Err("AI 通知已在「设置 → 通知」中关闭".to_string());
        }

        let now = Local::now();
        let tag = payload.tag.clone();
        let item = NotificationItem {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: "ai".to_string(),
            workspace_name: payload.client.clone(),
            bug_id: String::new(),
            title,
            kind: NotificationKind::Ai,
            owner: String::new(),
            creator: payload.client.clone(),
            severity: String::new(),
            priority: String::new(),
            created: format_tapd_time(now.naive_local()),
            detected_at: now.to_rfc3339(),
            state: NotificationState::Pending,
            source: NotificationSource::Ai,
            ai: Some(payload),
        };

        {
            let mut items = self.ai_items.lock().expect("ai notification lock");
            // `tag` replaces an outstanding card in place, so rapid progress
            // updates do not collapse and re-expand the island. The replaced
            // waiter observes `replaced` on its next poll.
            if let Some(tag) = tag.as_deref() {
                for existing in items.iter_mut() {
                    if existing.state != NotificationState::Pending
                        || existing.ai.as_ref().and_then(|ai| ai.tag.as_deref()) != Some(tag)
                    {
                        continue;
                    }
                    if let Some(ai) = existing.ai.as_mut() {
                        ai.resolution = Some(AiResolution {
                            kind: "replaced".to_string(),
                            action_id: None,
                            action_label: None,
                            at: now.to_rfc3339(),
                        });
                    }
                    existing.state = NotificationState::Ignored;
                }
            }

            items.push_back(item.clone());
            while items.len() > MAX_AI_ITEMS {
                items.pop_front();
            }
        }
        self.refresh_window();
        Ok(item)
    }

    /// Stores the user's decision on an AI card. `kind` is `action`,
    /// `dismissed` or `replaced`; `action_id` is required for `action`.
    fn finish_ai(
        &self,
        id: &str,
        kind: &str,
        action_id: Option<&str>,
    ) -> Result<NotificationItem, String> {
        let item = {
            let mut items = self.ai_items.lock().expect("ai notification lock");
            let item = items
                .iter_mut()
                .find(|item| item.id == id)
                .ok_or_else(|| "通知不存在或已被清理".to_string())?;
            if let Some(ai) = item.ai.as_mut() {
                if ai.resolution.is_some() {
                    return Ok(item.clone());
                }
                let action = match action_id {
                    Some(action_id) => Some(
                        ai.actions
                            .iter()
                            .find(|action| action.id == action_id)
                            .cloned()
                            .ok_or_else(|| format!("未知操作「{action_id}」"))?,
                    ),
                    None => None,
                };
                ai.resolution = Some(AiResolution {
                    kind: kind.to_string(),
                    action_id: action.as_ref().map(|action| action.id.clone()),
                    action_label: action.as_ref().map(|action| action.label.clone()),
                    at: Local::now().to_rfc3339(),
                });
            }
            item.state = if kind == "action" {
                NotificationState::Handled
            } else {
                NotificationState::Ignored
            };
            item.clone()
        };
        self.refresh_window();
        Ok(item)
    }

    fn ai_state(&self, id: &str) -> (bool, Option<AiResolution>) {
        let items = self.ai_items.lock().expect("ai notification lock");
        match items.iter().find(|item| item.id == id) {
            Some(item) => (true, item.ai.as_ref().and_then(|ai| ai.resolution.clone())),
            None => (false, None),
        }
    }

    /// Waits for a user decision. Returns the stored resolution when the user
    /// already acted, `Pending` on timeout, `Gone` when the card was dropped.
    ///
    /// Uses a short poll instead of a notifier so a resolution that lands
    /// between the state check and the wait cannot be missed.
    async fn wait_ai(&self, id: &str, timeout: Duration) -> AiWait {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let (exists, resolution) = self.ai_state(id);
            if let Some(resolution) = resolution {
                return AiWait::Resolved(resolution);
            }
            if !exists {
                return AiWait::Gone;
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return AiWait::Pending;
            }
            tokio::time::sleep((deadline - now).min(Duration::from_millis(200))).await;
        }
    }

    /// Emits the current pending list and lays the island out accordingly.
    ///
    /// An empty list collapses the island; whether the collapsed capsule is
    /// visible at all is decided by `notification_island_visible` (the idle
    /// capsule stays hidden instead of showing a standing "standby" hint).
    fn refresh_window(&self) {
        let (items, quiet) = self.pending_payload();
        let _ = self.app.emit(
            "notification://show",
            json!({ "items": items, "quiet": quiet }),
        );

        crate::island_window::apply_island(
            &self.app,
            &self.state,
            !items.is_empty() && !quiet,
            items.len(),
            true,
        );
    }

    /// Resolves the signed-in user plus the accessible workspaces in one call.
    async fn ensure_identity(
        &self,
        workspace_id: &str,
    ) -> Result<(Option<String>, Vec<Workspace>), String> {
        let cached = self
            .state
            .config_snapshot()
            .me
            .map(|me| me.trim().to_string())
            .filter(|me| !me.is_empty());

        let root = session_request_json(
            &self.app,
            "GET",
            &user_workspace_url(workspace_id),
            None,
            Duration::from_secs(30),
        )
        .await?;

        // Propagate a failed aggregation response instead of treating it as an
        // empty project list: swallowing it made an API/auth error look like a
        // successful poll (`lastPollAt` advanced, no `lastError`).
        let workspaces = parse_workspaces(&root)?;
        {
            let mut names = self.workspace_names.lock().expect("workspace names lock");
            for workspace in &workspaces {
                names.insert(workspace.id.clone(), workspace.name.clone());
            }
        }

        let nick = root
            .pointer("/data/get_current_user_ret/data/user_nick")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();

        if !nick.is_empty() && cached.as_deref() != Some(nick.as_str()) {
            let persisted = self
                .state
                .update_config(|config| config.me = Some(nick.clone()));
            if let Err(error) = persisted {
                tracing::warn!(%error, "failed to persist current user");
            }
        }

        let resolved = if nick.is_empty() { cached } else { Some(nick) };
        Ok((resolved, workspaces))
    }

    async fn poll_once(self: &Arc<Self>) {
        let result = self.poll_inner().await;
        let mut notify_list = false;

        match result {
            Ok(report) => {
                notify_list = report.notified;
                *self.last_error.lock().expect("last error lock") = report.error;
                // Update the stamp if any project was polled: a single broken
                // project must not make an otherwise successful round look
                // like it never ran. A skipped round (logged out / no projects
                // / notifications off) still leaves the stamp untouched.
                if report.polled {
                    *self.last_poll_at.lock().expect("last poll lock") =
                        Some(Local::now().to_rfc3339());
                }
            }
            Err(error) => {
                // Pollution of the error slot is intentional: the settings page
                // shows it, but we never raise dialogs from the poll loop.
                *self.last_error.lock().expect("last error lock") = Some(error.clone());
                tracing::debug!(%error, "notification poll failed");
            }
        }

        // New bugs found by the background poll: let the main window refresh its
        // (offline-first) lists so cached data does not silently go stale. This
        // is based on emitted items, not the net item count: trimming at the
        // cap could otherwise hide a round that did produce notifications.
        if notify_list {
            let _ = self.app.emit("data://refresh", ());
        }

        self.refresh_window();
    }

    async fn poll_inner(&self) -> Result<PollReport, String> {
        let settings = self.settings();
        if !settings.enabled {
            return Ok(PollReport::default());
        }

        let config = self.state.config_snapshot();
        if !config.logged_in {
            return Ok(PollReport::default());
        }

        let (me, workspaces) = self.ensure_identity("0").await?;
        let Some(me) = me else {
            return Ok(PollReport::default());
        };
        if me.trim().is_empty() || workspaces.is_empty() {
            return Ok(PollReport::default());
        }

        // "Mine" polls every accessible project. "Project" keeps the previous
        // single-project behaviour, otherwise one busy project floods the queue.
        let workspace_ids: Vec<String> = if settings.scope == NotificationScope::Mine {
            workspaces
                .iter()
                .map(|workspace| workspace.id.clone())
                .collect()
        } else {
            current_workspace_id(&config, &workspaces)
                .into_iter()
                .collect()
        };
        if workspace_ids.is_empty() {
            return Ok(PollReport::default());
        }

        let now = Local::now().naive_local();
        let session = SESSION_SEQ.load(Ordering::SeqCst);
        let mut report = PollReport::default();
        for workspace_id in workspace_ids {
            match self
                .poll_workspace(&workspace_id, &me, &settings, now, session)
                .await
            {
                Ok(notified) => {
                    report.polled = true;
                    report.notified |= notified;
                }
                Err(error) => {
                    tracing::warn!(%workspace_id, %error, "notification poll failed");
                    if report.error.is_none() {
                        report.error = Some(error);
                    }
                }
            }
        }

        // Keep the seen table bounded (time + row cap). Runs once per round,
        // outside the per-workspace loops.
        let removed = {
            let mut store = self.store.lock().expect("notification store lock");
            prune_seen(&mut store, now)
        };
        notification_db::delete_seen_and_ignored(&self.state.cache, &removed);

        Ok(report)
    }

    /// Polls one workspace. Returns whether the round created notifications.
    async fn poll_workspace(
        &self,
        workspace_id: &str,
        me: &str,
        settings: &NotificationSettings,
        now: NaiveDateTime,
        session: u64,
    ) -> Result<bool, String> {
        let (baseline, cursor, primed) = {
            let store = self.store.lock().expect("notification store lock");
            (
                // No cursor = this workspace has never been polled for this
                // account/session. The round records state but stays silent.
                !store.cursors.contains_key(workspace_id),
                store.cursors.get(workspace_id).cloned(),
                self.primed
                    .lock()
                    .expect("notification primed lock")
                    .contains(workspace_id),
            )
        };
        // The first completed round after launch/login only primes the state;
        // notifications start from the next round. A truncated round does not
        // prime, so the unread tail is absorbed silently on the retry.
        let silent = round_is_silent(baseline, primed);

        let modified_after = if baseline {
            None
        } else {
            let base = cursor
                .as_deref()
                .and_then(parse_tapd_time)
                .unwrap_or_else(|| now - ChronoDuration::minutes(10));
            Some(format_tapd_time(
                base - ChronoDuration::minutes(OVERLAP_MINUTES),
            ))
        };

        let mut query = BugQuery::new(workspace_id);
        query.perpage = POLL_PAGE_SIZE;
        query.modified_after = modified_after;
        if settings.scope == NotificationScope::Mine {
            query.owner = Some(me.to_string());
        }

        let max_pages = if baseline {
            MAX_BASELINE_PAGES
        } else {
            MAX_POLL_PAGES
        };
        let (bugs, complete) = self.fetch_bug_pages(&mut query, max_pages).await?;
        if !complete {
            tracing::warn!(
                %workspace_id,
                pages = max_pages,
                "notification poll hit the page cap; cursor stays put for a retry"
            );
        }

        // For project scope a first-seen bug owned by me may just be an old bug
        // touched by a comment. Ask the detail once for `assigned_time`.
        let mut assigned_overrides: BTreeMap<String, String> = BTreeMap::new();
        if !silent && settings.scope == NotificationScope::Project {
            let seen = self
                .store
                .lock()
                .expect("notification store lock")
                .seen
                .clone();
            let mut budget = MAX_DETAIL_LOOKUPS;
            for bug in &bugs {
                if budget == 0 {
                    break;
                }
                if bug.workspace_id.trim().is_empty() {
                    continue;
                }
                let key = bug_key(&bug.workspace_id, &bug.id);
                if seen.contains_key(&key)
                    || bug.status.trim() == "reopened"
                    || bug.owner.trim() != me
                    || !bug.assigned_time.trim().is_empty()
                    || is_recent(&bug.created, now, FRESH_WINDOW_MINUTES)
                {
                    continue;
                }
                budget -= 1;
                if let Ok(detail) = fetch_bug(&self.app, &bug.workspace_id, &bug.id).await {
                    if !detail.summary.assigned_time.trim().is_empty() {
                        assigned_overrides.insert(key, detail.summary.assigned_time);
                    }
                }
            }
        }

        // A login/logout during the fetch invalidates this round: writing it
        // would leak the previous account's state into the new session.
        if SESSION_SEQ.load(Ordering::SeqCst) != session {
            return Ok(false);
        }

        let names = self
            .workspace_names
            .lock()
            .expect("workspace names lock")
            .clone();
        let seen_at = format_tapd_time(now);

        // Collect mutations under the store lock, then mirror only those rows to
        // SQLite in one transaction. Nothing here rewrites the whole store.
        let (seen_updates, new_items, ignore_lifted, cursor, trim_items) = {
            let mut store = self.store.lock().expect("notification store lock");
            let mut seen_updates: Vec<(String, SeenBug)> = Vec::new();
            let mut new_items: Vec<NotificationItem> = Vec::new();
            let mut ignore_lifted: Vec<String> = Vec::new();

            for bug in &bugs {
                if bug.workspace_id.trim().is_empty() || bug.id.trim().is_empty() {
                    continue;
                }
                let key = bug_key(&bug.workspace_id, &bug.id);
                let previous = store.seen.get(&key).cloned();
                let assigned_time = assigned_overrides
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| bug.assigned_time.clone());
                let mut kinds = previous
                    .as_ref()
                    .map(|previous| previous.kinds.clone())
                    .unwrap_or_default();

                if baseline {
                    let seen = SeenBug {
                        status: bug.status.clone(),
                        owner: bug.owner.clone(),
                        created: bug.created.clone(),
                        assigned_time,
                        kinds,
                        last_seen: seen_at.clone(),
                    };
                    store.seen.insert(key.clone(), seen.clone());
                    seen_updates.push((key, seen));
                    continue;
                }

                let ignored = store.ignored.iter().any(|ignored| ignored == &key);
                let in_scope = scope_allows(settings.scope, &bug.owner, &me);
                let kind = if in_scope {
                    classify_bug(
                        &bug.status,
                        &bug.owner,
                        &bug.created,
                        &assigned_time,
                        previous.as_ref(),
                        &me,
                        now,
                        settings.scope == NotificationScope::Mine,
                    )
                } else {
                    None
                };

                if matches!(kind, Some(NotificationKind::Reopened)) {
                    // Reopening lifts an ignore.
                    let before = store.ignored.len();
                    store.ignored.retain(|ignored| ignored != &key);
                    if store.ignored.len() != before {
                        ignore_lifted.push(key.clone());
                    }
                }

                let notify = if silent {
                    None
                } else {
                    match kind {
                        Some(kind) if settings.allows(kind) => {
                            let is_ignored_and_blocked =
                                ignored && kind != NotificationKind::Reopened;
                            // Reopen and transfer are transition-based (their
                            // previous state comparison already prevents
                            // repeats). "New" keys off `created`, which survives
                            // a seen-row prune, so it keeps a lifetime guard.
                            let already_sent =
                                kind == NotificationKind::New && already_notified(&kinds, kind);
                            if !is_ignored_and_blocked && !already_sent {
                                Some(kind)
                            } else {
                                None
                            }
                        }
                        _ => None,
                    }
                };

                if let Some(kind) = notify {
                    kinds.push(kind.as_str().to_string());
                    let item = NotificationItem {
                        id: uuid::Uuid::new_v4().to_string(),
                        workspace_id: bug.workspace_id.to_string(),
                        workspace_name: names
                            .get(&bug.workspace_id)
                            .cloned()
                            .unwrap_or_else(|| bug.workspace_id.to_string()),
                        bug_id: bug.id.clone(),
                        title: bug.title.clone(),
                        kind,
                        owner: bug.owner.clone(),
                        creator: bug.creator.clone(),
                        severity: bug.severity_label.clone(),
                        priority: bug.priority_label.clone(),
                        created: bug.created.clone(),
                        detected_at: Local::now().to_rfc3339(),
                        state: NotificationState::Pending,
                        source: NotificationSource::Tapd,
                        ai: None,
                    };
                    store.items.push(item.clone());
                    new_items.push(item);
                }

                let seen = SeenBug {
                    status: bug.status.clone(),
                    owner: bug.owner.clone(),
                    created: bug.created.clone(),
                    assigned_time,
                    kinds,
                    last_seen: seen_at.clone(),
                };
                store.seen.insert(key.clone(), seen.clone());
                seen_updates.push((key, seen));
            }

            // A complete round advances the cursor. An incomplete incremental
            // round keeps it so the unread tail is retried next poll; a
            // baseline always advances to avoid re-baselining every 30s.
            let cursor = if baseline || complete {
                store
                    .cursors
                    .insert(workspace_id.to_string(), seen_at.clone());
                Some(seen_at.clone())
            } else {
                None
            };
            let trim_items = if store.items.len() > MAX_ITEMS {
                let excess = store.items.len() - MAX_ITEMS;
                store.items.drain(0..excess);
                true
            } else {
                false
            };
            (seen_updates, new_items, ignore_lifted, cursor, trim_items)
        };

        notification_db::write_poll(
            &self.state.cache,
            workspace_id,
            PollWrite {
                seen: &seen_updates,
                items: &new_items,
                ignore_lifted: &ignore_lifted,
                cursor: cursor.as_deref(),
                trim_items,
                max_items: MAX_ITEMS,
            },
        );

        if baseline || complete {
            self.primed
                .lock()
                .expect("notification primed lock")
                .insert(workspace_id.to_string());
        }

        Ok(!new_items.is_empty())
    }

    /// Fetches every page of a poll query up to `max_pages`.
    ///
    /// Returns `(bugs, complete)`. `complete == false` means the page cap was
    /// hit with a full page, so the tail is still unread.
    async fn fetch_bug_pages(
        &self,
        query: &mut BugQuery,
        max_pages: u32,
    ) -> Result<(Vec<tapd_core::tapd::BugSummary>, bool), String> {
        let mut all = Vec::new();
        let mut page_no = 1;
        loop {
            query.page = page_no;
            let root = session_request_json(
                &self.app,
                "POST",
                &bug_list_url(),
                Some(query.body()),
                Duration::from_secs(60),
            )
            .await?;
            let page = parse_bug_list(&root)?;
            let fetched = page.bugs.len();
            let total = page.total as usize;
            all.extend(page.bugs);

            let short_page = fetched < POLL_PAGE_SIZE as usize;
            // `total` is unreliable (it falls back to the page length when the
            // response omits it), so a full page alone keeps the loop going.
            let reached_total = total > 0 && all.len() >= total;
            let complete = short_page || reached_total;
            if complete || page_no >= max_pages {
                return Ok((all, complete));
            }
            // A baseline can sweep many pages; pace them instead of firing a
            // burst that TAPD may throttle.
            tokio::time::sleep(POLL_PAGE_DELAY).await;
            page_no += 1;
        }
    }
}

/// The project used for `project`-scope polling: last selected, then the URL.
fn current_workspace_id(config: &AppConfig, workspaces: &[Workspace]) -> Option<String> {
    let known = |id: &str| workspaces.iter().any(|workspace| workspace.id == id);

    if let Some(id) = config.last_workspace_id.as_deref().map(str::trim) {
        if !id.is_empty() && known(id) {
            return Some(id.to_string());
        }
    }
    if let Some(id) = config
        .last_session_url
        .as_deref()
        .and_then(workspace_from_session_url)
    {
        if known(&id) {
            return Some(id);
        }
    }

    workspaces.first().map(|workspace| workspace.id.clone())
}

/// Whether this `(workspace, bug, kind)` de-dup key was already emitted.
fn already_notified(kinds: &[String], kind: NotificationKind) -> bool {
    kinds
        .iter()
        .filter_map(|sent| NotificationKind::parse(sent))
        .any(|sent| sent == kind)
}

fn service() -> Result<Arc<NotificationService>, String> {
    SERVICE
        .get()
        .cloned()
        .ok_or_else(|| "通知服务尚未初始化".to_string())
}

/// System notice for local queue events (external AI takeover, rejected claim).
/// This is not an AI request, so it bypasses the "allow AI notifications"
/// toggle: losing a queued task must always be visible. A `tag` replaces an
/// outstanding card in place, so a client that keeps retrying cannot spam the
/// island.
pub fn raise_system_note(
    title: &str,
    tone: AiTone,
    body: &str,
    tag: Option<&str>,
) -> Result<(), String> {
    let service = service()?;
    let payload = AiPayload {
        tone,
        client: "TAPD Client".to_string(),
        blocks: vec![AiBlock::Text {
            text: body.trim().to_string(),
        }],
        actions: Vec::new(),
        tag: tag.map(str::to_string),
        resolution: None,
    };
    service.raise_ai(title.trim().to_string(), payload, true)?;
    Ok(())
}

/// Redacted settings snapshot for the diagnostics bundle. Falls back to the
/// database row when the notification service is not initialized (tests).
pub fn settings_for_diagnostics(state: &SharedState) -> Value {
    if let Ok(service) = service() {
        return serde_json::to_value(service.settings()).unwrap_or(Value::Null);
    }
    notification_db::load(&state.cache)
        .and_then(|store| serde_json::to_value(store.settings).ok())
        .unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

pub use crate::island_window::set_update_mode;

/// Re-applies the correct island layout: 3x update panel while an update owns
/// the screen, otherwise the notification pill/cards.
pub fn refresh_island_layout(app: &AppHandle, state: &SharedState) {
    if crate::island_window::update_mode() {
        crate::island_window::apply_update_panel(app, state);
        return;
    }

    let (expanded, count) = service()
        .map(|service| {
            let (items, _quiet) = service.pending_payload();
            (!items.is_empty(), items.len())
        })
        .unwrap_or((false, 0));
    crate::island_window::apply_island(app, state, expanded, count, true);
}

/// Brings the main window to the front (capsule click without pending items).
fn focus_main_window(app: &AppHandle) {
    // While an update owns the screen the main window is deliberately
    // unreachable; the capsule must stay on the progress/error panel.
    if crate::update::is_updating() {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

// ---------------------------------------------------------------------------
// Init / polling loop
// ---------------------------------------------------------------------------

pub fn init(app: &AppHandle, state: SharedState) {
    let loaded = notification_db::load(&state.cache);
    let loaded_from_db = loaded.is_some();
    // Only a confirmed-missing settings row may be initialized; a failed load
    // must keep the in-memory defaults instead of wiping the stored state.
    let writable = loaded_from_db || notification_db::is_fresh(&state.cache);
    let mut store = loaded.unwrap_or_default();

    store.settings = store.settings.clone().normalized();
    if writable && !loaded_from_db {
        notification_db::save_settings(&state.cache, &store.settings);
    }

    // A new app session never inherits the previous session's cards: the user
    // sees only what changes after this launch. Poll cursors and `seen` stay,
    // but the first round per workspace (see `primed`) is silent.
    store.items.clear();
    notification_db::clear_items(&state.cache);

    let now = Local::now().naive_local();
    let removed = prune_seen(&mut store, now);
    notification_db::delete_seen_and_ignored(&state.cache, &removed);

    let service = Arc::new(NotificationService {
        app: app.clone(),
        state,
        store: Mutex::new(store),
        ai_items: Mutex::new(VecDeque::new()),
        workspace_names: Mutex::new(BTreeMap::new()),
        primed: Mutex::new(BTreeSet::new()),
        last_poll_at: Mutex::new(None),
        last_error: Mutex::new(None),
        wake: tokio::sync::Notify::new(),
    });

    if SERVICE.set(service.clone()).is_err() {
        return;
    }

    service.refresh_window();

    tauri::async_runtime::spawn(async move {
        // Give the hidden session webview time to finish its startup
        // navigation, otherwise the first poll can race the bridge.
        tokio::time::sleep(Duration::from_secs(4)).await;

        loop {
            let settings = service.settings();
            if settings.enabled {
                service.poll_once().await;
            }

            let interval = service
                .settings()
                .poll_interval_secs
                .clamp(MIN_POLL_INTERVAL_SECS, MAX_POLL_INTERVAL_SECS);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
                _ = service.wake.notified() => {}
            }
        }
    });
}

/// Starts a fresh notification session after a login or logout.
///
/// Pending cards and the per-account poll state (`seen` / `ignored` / cursors)
/// are dropped, so nothing from the previous account can leak into the new
/// session. The next round per workspace is a silent baseline; only changes
/// observed after it can raise a notification.
pub fn reset_session() {
    let Some(service) = SERVICE.get() else {
        return;
    };
    SESSION_SEQ.fetch_add(1, Ordering::SeqCst);

    {
        let mut store = service.store.lock().expect("notification store lock");
        store.items.clear();
        store.seen.clear();
        store.ignored.clear();
        store.cursors.clear();
    }
    service
        .primed
        .lock()
        .expect("notification primed lock")
        .clear();
    *service.last_poll_at.lock().expect("last poll lock") = None;
    *service.last_error.lock().expect("last error lock") = None;

    notification_db::clear_items(&service.state.cache);
    notification_db::clear_poll_state(&service.state.cache);

    service.refresh_window();
    service.wake.notify_one();
}

// ---------------------------------------------------------------------------
// AI notification entry points (MCP + settings debug)
// ---------------------------------------------------------------------------
enum AiWait {
    Resolved(AiResolution),
    /// The user did not act before the wait deadline; the card stays visible.
    Pending,
    /// The card was dropped (cap / restart) before a decision.
    Gone,
}

fn ai_outcome_json(id: &str, outcome: AiWait, waited: Duration, waited_for: bool) -> Value {
    let (status, resolution) = match outcome {
        AiWait::Resolved(resolution) => {
            // Only these three are produced by `finish_ai`; a future kind still
            // gets a stable fallback instead of leaking an internal string.
            let status = match resolution.kind.as_str() {
                "action" => "acted",
                "dismissed" => "dismissed",
                "replaced" => "replaced",
                _ => "resolved",
            };
            (status, Some(resolution))
        }
        AiWait::Pending => (if waited_for { "timeout" } else { "pending" }, None),
        AiWait::Gone => ("expired", None),
    };

    let mut result = json!({
        "id": id,
        "status": status,
        "waitedMs": waited.as_millis() as u64,
    });
    if let Some(resolution) = resolution {
        result["resolvedAt"] = Value::from(resolution.at);
        if let Some(action_id) = resolution.action_id {
            result["actionId"] = Value::from(action_id);
        }
        if let Some(action_label) = resolution.action_label {
            result["actionLabel"] = Value::from(action_label);
        }
    }
    result
}

/// MCP `tapd_notify_user`: raises the capsule and optionally waits for the
/// user's decision so the calling AI receives it in the same tool call.
pub async fn mcp_notify(arguments: &Value, client: &str) -> Result<Value, String> {
    let service = service()?;
    let (title, payload) = ai_payload_from_arguments(arguments, client)?;
    let wait_secs = notify_wait_seconds(arguments);
    let started = std::time::Instant::now();
    let item = service.raise_ai(title, payload, false)?;

    let outcome = if wait_secs == 0 {
        AiWait::Pending
    } else {
        service
            .wait_ai(&item.id, Duration::from_secs(wait_secs))
            .await
    };
    Ok(ai_outcome_json(
        &item.id,
        outcome,
        started.elapsed(),
        wait_secs > 0,
    ))
}

/// MCP `tapd_wait_notification`: waits again for a card raised earlier.
pub async fn mcp_wait(arguments: &Value) -> Result<Value, String> {
    let service = service()?;
    let id = arguments
        .get("id")
        .or_else(|| arguments.get("notificationId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "缺少参数 id".to_string())?
        .to_string();
    let wait_secs = notify_wait_seconds(arguments);
    let started = std::time::Instant::now();
    let outcome = if wait_secs == 0 {
        match service.ai_state(&id) {
            (false, _) => AiWait::Gone,
            (true, Some(resolution)) => AiWait::Resolved(resolution),
            (true, None) => AiWait::Pending,
        }
    } else {
        service.wait_ai(&id, Duration::from_secs(wait_secs)).await
    };
    Ok(ai_outcome_json(
        &id,
        outcome,
        started.elapsed(),
        wait_secs > 0,
    ))
}

// ---------------------------------------------------------------------------
// Tauri feature commands
// ---------------------------------------------------------------------------

pub async fn command(
    app: &AppHandle,
    state: &SharedState,
    name: &str,
    payload: Value,
) -> Result<Value, String> {
    match name {
        "notification_settings_get" => {
            let service = service()?;
            Ok(json!({ "settings": service.settings() }))
        }
        "notification_settings_set" => {
            let service = service()?;
            let settings = apply_settings_patch(&service, &payload)?;
            service.persist_settings();
            // `notify_one` keeps a permit when the loop is not waiting; the
            // old `notify_waiters` lost the wake-up if a poll was in flight.
            service.wake.notify_one();
            service.refresh_window();
            Ok(json!({ "settings": settings }))
        }
        "notification_state_get" => {
            let service = service()?;
            state_snapshot(&service)
        }
        "notification_handle" => {
            let service = service()?;
            let id = payload_str(&payload, "notificationId")?;
            handle_notification(app, state, &service, &id).await
        }
        "notification_view" => {
            let service = service()?;
            let id = payload_str(&payload, "notificationId")?;
            view_notification(app, &service, &id)
        }
        "notification_ignore" => {
            let service = service()?;
            let id = payload_str(&payload, "notificationId")?;
            ignore_notification(&service, &id)
        }
        "notification_island_expand" => {
            let service = service()?;
            let expanded = payload
                .get("expanded")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let (items, _quiet) = service.pending_payload();
            let expanded = expanded && !items.is_empty();
            crate::island_window::apply_island(app, state, expanded, items.len(), true);
            Ok(json!({ "ok": true, "expanded": expanded, "count": items.len() }))
        }
        "notification_island_visible" => {
            // The idle capsule is hidden: it is a status indicator only while
            // there is something to indicate (pending cards, agent work,
            // update, connection problem).
            let visible = payload
                .get("visible")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            crate::island_window::set_collapsed_visible(visible);
            if visible {
                let (expanded, count) = service()
                    .map(|service| {
                        let (items, quiet) = service.pending_payload();
                        (!items.is_empty() && !quiet, items.len())
                    })
                    .unwrap_or((false, 0));
                crate::island_window::apply_island(app, state, expanded, count, false);
            } else {
                crate::island_window::hide_collapsed(app);
            }
            Ok(json!({ "ok": true, "visible": visible }))
        }
        "notification_open_main" => {
            focus_main_window(app);
            Ok(json!({ "ok": true }))
        }
        "notification_start_drag" => {
            // Native drag: no window-plugin ACL involved, so the transparent
            // island window can be dragged like a real panel.
            let window = crate::island_window::ensure_window(app, state)?;
            window.start_dragging().map_err(|error| error.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "notification_simulate" => {
            let service = service()?;
            simulate_notification(state, &service, &payload)
        }
        "notification_ai_action" => {
            let service = service()?;
            let id = payload_str(&payload, "notificationId")?;
            let action_id = payload_str(&payload, "actionId")?;
            let item = service.finish_ai(&id, "action", Some(&action_id))?;
            Ok(json!({ "ok": true, "item": item }))
        }
        "notification_ai_debug" => {
            let service = service()?;
            let client = payload
                .get("client")
                .and_then(Value::as_str)
                .filter(|client| !client.trim().is_empty())
                .unwrap_or("调试面板");
            let (title, ai) = ai_payload_from_arguments(&payload, client)?;
            // Debug cards must show even when AI notifications are disabled.
            let item = service.raise_ai(title, ai, true)?;
            Ok(json!({ "ok": true, "item": item }))
        }
        other => Err(format!("unknown notification command: {other}")),
    }
}

fn state_snapshot(service: &NotificationService) -> Result<Value, String> {
    let items = service.recent_items(MAX_HISTORY);
    let settings = service.settings();

    Ok(json!({
        "items": items,
        "settings": settings,
        "running": settings.enabled,
        "lastPollAt": service.last_poll_at.lock().expect("last poll lock").clone(),
        "lastError": service.last_error.lock().expect("last error lock").clone(),
    }))
}

fn view_notification(
    app: &AppHandle,
    service: &NotificationService,
    id: &str,
) -> Result<Value, String> {
    let item = service.find_item(id)?;
    service.set_state(id, NotificationState::Viewed)?;

    focus_main_window(app);

    // Simulated cards have no real bug to open; just bring the main window up.
    let simulated = item.workspace_id == "simulated" || item.bug_id.starts_with("simulated-");
    if !simulated {
        let _ = app.emit(
            "notification://open-bug",
            json!({ "workspaceId": item.workspace_id, "bugId": item.bug_id }),
        );
    }

    service.refresh_window();
    Ok(json!({ "ok": true, "item": item }))
}

fn ignore_notification(service: &NotificationService, id: &str) -> Result<Value, String> {
    // AI cards are dismissed (and the waiting MCP call is released) rather
    // than added to the bug ignore list.
    if service.find_ai_item(id).is_ok() {
        let item = service.finish_ai(id, "dismissed", None)?;
        return Ok(json!({ "ok": true, "item": item }));
    }

    let item = service.find_item(id)?;
    let key = bug_key(&item.workspace_id, &item.bug_id);
    {
        let mut store = service.store.lock().expect("notification store lock");
        if !store.ignored.iter().any(|ignored| ignored == &key) {
            store.ignored.push(key.clone());
        }
    }
    notification_db::insert_ignored(&service.state.cache, &key);
    let item = service.set_state(id, NotificationState::Ignored)?;
    service.refresh_window();
    Ok(json!({ "ok": true, "item": item }))
}

fn simulate_notification(
    state: &SharedState,
    service: &NotificationService,
    payload: &Value,
) -> Result<Value, String> {
    let config = state.config_snapshot();
    let workspace_id = config
        .last_workspace_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| "simulated".to_string());
    let workspace_name = if workspace_id == "simulated" {
        "模拟项目".to_string()
    } else {
        service.workspace_name(&workspace_id)
    };
    let kind = payload
        .get("kind")
        .and_then(Value::as_str)
        .and_then(NotificationKind::parse)
        .filter(|kind| *kind != NotificationKind::Ai)
        .unwrap_or(NotificationKind::New);
    let bug_id = payload
        .get("bugId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "simulated-{}",
                &uuid::Uuid::new_v4().simple().to_string()[..8]
            )
        });
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("【模拟】新缺陷通知")
        .to_string();

    let item = NotificationItem {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id,
        workspace_name,
        bug_id,
        title,
        kind,
        owner: config.me.unwrap_or_else(|| "我".to_string()),
        creator: "模拟用户".to_string(),
        severity: "严重".to_string(),
        priority: "高".to_string(),
        created: format_tapd_time(Local::now().naive_local()),
        detected_at: Local::now().to_rfc3339(),
        state: NotificationState::Pending,
        source: NotificationSource::Tapd,
        ai: None,
    };

    service.push_item(item.clone());
    service.refresh_window();
    Ok(json!({ "ok": true, "item": item }))
}

// ---------------------------------------------------------------------------
// Accept ("处理") flow
// ---------------------------------------------------------------------------

struct AcceptPlan {
    me: String,
    status: String,
    assigned: bool,
}

async fn build_accept_plan(
    app: &AppHandle,
    state: &SharedState,
    item: &NotificationItem,
) -> Result<AcceptPlan, String> {
    let me = resolve_me(app, state, &item.workspace_id).await?;
    if me.trim().is_empty() {
        return Err("无法确定当前 TAPD 用户，请先在设置页刷新账户信息".to_string());
    }

    let detail = fetch_bug(app, &item.workspace_id, &item.bug_id).await?;
    let owner = detail.summary.owner.trim().to_string();
    let status = detail.summary.status.trim().to_string();

    Ok(AcceptPlan {
        assigned: owner != me.trim(),
        me,
        status,
    })
}

async fn resolve_me(
    app: &AppHandle,
    state: &SharedState,
    workspace_id: &str,
) -> Result<String, String> {
    if let Some(me) = state
        .config_snapshot()
        .me
        .map(|me| me.trim().to_string())
        .filter(|me| !me.is_empty())
    {
        return Ok(me);
    }

    let root = session_request_json(
        app,
        "GET",
        &user_workspace_url(workspace_id),
        None,
        Duration::from_secs(30),
    )
    .await?;
    let nick = root
        .pointer("/data/get_current_user_ret/data/user_nick")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if nick.is_empty() {
        return Ok(nick);
    }

    state
        .update_config(|config| config.me = Some(nick.clone()))
        .map_err(|error| error.to_string())?;
    Ok(nick)
}

async fn fetch_bug(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<tapd_core::tapd::model::BugDetail, String> {
    let root = session_request_json(
        app,
        "POST",
        &bug_detail_url(),
        Some(bug_detail_body(workspace_id, bug_id)),
        Duration::from_secs(45),
    )
    .await?;
    parse_bug_detail(&root)
}

async fn handle_notification(
    app: &AppHandle,
    state: &SharedState,
    service: &NotificationService,
    id: &str,
) -> Result<Value, String> {
    let item = service.find_item(id)?;
    if item.state == NotificationState::Handled {
        return Err("该通知已处理".to_string());
    }
    if item.workspace_id == "simulated" || item.bug_id.starts_with("simulated-") {
        return Err("模拟通知不能执行处理，请用真实缺陷验证".to_string());
    }

    let plan = build_accept_plan(app, state, &item).await?;

    if plan.assigned {
        bug_write::update_field(
            app,
            &item.workspace_id,
            &item.bug_id,
            "current_owner",
            &bug_write::normalize_user_value(&plan.me),
        )
        .await
        .map_err(|error| format!("改派处理人失败：{error}"))?;
    }

    // Starting statuses move into the workflow's processing status. The target
    // key is read from the workflow itself, so no project-specific guessing.
    let step = bug_write::accept_into_processing(app, &item.workspace_id, &item.bug_id)
        .await
        .map_err(|error| format!("状态流转失败：{error}"))?;
    let transitioned = step.is_some();

    service.set_state(id, NotificationState::Handled)?;

    let _ = app.emit(
        "agent://enqueue",
        json!({
            "workspaceId": item.workspace_id,
            "bugId": item.bug_id,
            "title": item.title,
            "workspaceName": item.workspace_name,
            "source": "notification"
        }),
    );
    let _ = app.emit("data://refresh", ());
    service.refresh_window();

    let status = step
        .as_ref()
        .map(|step| step.to.clone())
        .unwrap_or_else(|| plan.status.clone());

    Ok(json!({
        "ok": true,
        "owner": plan.me,
        "status": status,
        "assigned": plan.assigned,
        "transitioned": transitioned
    }))
}

// ---------------------------------------------------------------------------
// Settings patch handling
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct QuietHoursPatch {
    enabled: Option<bool>,
    start: Option<String>,
    end: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SettingsPatch {
    enabled: Option<bool>,
    scope: Option<NotificationScope>,
    include_new: Option<bool>,
    include_transferred: Option<bool>,
    include_reopened: Option<bool>,
    poll_interval_secs: Option<u64>,
    quiet_hours: Option<QuietHoursPatch>,
    max_visible: Option<u32>,
    ai_enabled: Option<bool>,
}

fn apply_settings_patch(
    service: &NotificationService,
    payload: &Value,
) -> Result<NotificationSettings, String> {
    let patch_value = payload
        .get("settings")
        .cloned()
        .unwrap_or_else(|| payload.clone());
    let patch: SettingsPatch = serde_json::from_value(patch_value)
        .map_err(|error| format!("通知设置格式不正确：{error}"))?;

    let mut settings = service.settings();
    if let Some(enabled) = patch.enabled {
        settings.enabled = enabled;
    }
    if let Some(scope) = patch.scope {
        settings.scope = scope;
    }
    if let Some(value) = patch.include_new {
        settings.include_new = value;
    }
    if let Some(value) = patch.include_transferred {
        settings.include_transferred = value;
    }
    if let Some(value) = patch.include_reopened {
        settings.include_reopened = value;
    }
    if let Some(value) = patch.poll_interval_secs {
        settings.poll_interval_secs = value;
    }
    if let Some(value) = patch.max_visible {
        settings.max_visible = value;
    }
    if let Some(value) = patch.ai_enabled {
        settings.ai_enabled = value;
    }
    if let Some(quiet) = patch.quiet_hours {
        if let Some(enabled) = quiet.enabled {
            settings.quiet_hours.enabled = enabled;
        }
        if let Some(start) = quiet.start {
            if !is_hhmm(&start) {
                return Err("免打扰开始时间格式应为 HH:MM".to_string());
            }
            settings.quiet_hours.start = start;
        }
        if let Some(end) = quiet.end {
            if !is_hhmm(&end) {
                return Err("免打扰结束时间格式应为 HH:MM".to_string());
            }
            settings.quiet_hours.end = end;
        }
    }

    let settings = settings.normalized();
    {
        let mut store = service.store.lock().expect("notification store lock");
        store.settings = settings.clone();
    }
    Ok(settings)
}

fn payload_str(payload: &Value, key: &str) -> Result<String, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("缺少参数 {key}"))
}

// ---------------------------------------------------------------------------
// Tests — pure business rules only (no TAPD calls).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(hour: u32, minute: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, 10)
            .expect("date")
            .and_hms_opt(hour, minute, 0)
            .expect("time")
    }

    fn seen(status: &str, owner: &str, kinds: &[&str]) -> SeenBug {
        SeenBug {
            status: status.to_string(),
            owner: owner.to_string(),
            created: "2026-11-09 09:00:00".to_string(),
            assigned_time: String::new(),
            kinds: kinds.iter().map(|kind| kind.to_string()).collect(),
            last_seen: String::new(),
        }
    }

    #[test]
    fn fresh_created_bug_is_new() {
        let kind = classify_bug(
            "new",
            "何帅",
            "2026-11-10 11:58:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::New));
    }

    #[test]
    fn old_bug_first_seen_for_me_is_transferred() {
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Transferred));
    }

    #[test]
    fn recent_assignment_wins_over_creation_time() {
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "2026-11-10 11:57:00",
            None,
            "何帅",
            at(12, 0),
            false,
        );
        assert_eq!(kind, Some(NotificationKind::Transferred));
    }

    #[test]
    fn project_scope_needs_evidence_for_transfer() {
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            false,
        );
        assert_eq!(kind, None);
    }

    #[test]
    fn owner_change_on_known_bug_is_transferred() {
        let previous = seen("in_progress", "郭俊宏", &["new"]);
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-09 09:00:00",
            "",
            Some(&previous),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Transferred));
    }

    #[test]
    fn comment_only_change_is_not_a_notification() {
        let previous = seen("in_progress", "何帅", &["new"]);
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-09 09:00:00",
            "",
            Some(&previous),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, None);
    }

    #[test]
    fn reopened_status_wins_over_everything() {
        let previous = seen("resolved", "何帅", &["new"]);
        let kind = classify_bug(
            "reopened",
            "何帅",
            "2026-11-01 09:00:00",
            "",
            Some(&previous),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Reopened));
    }

    #[test]
    fn first_sighting_of_reopened_bug_is_reopened() {
        let kind = classify_bug(
            "reopened",
            "郭俊宏",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Reopened));
    }

    #[test]
    fn open_is_classified_like_new() {
        // A fresh `open` bug is a new notification.
        let fresh = classify_bug(
            "open",
            "何帅",
            "2026-11-10 11:58:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(fresh, Some(NotificationKind::New));

        // An old `open` bug that just appeared for me is a transfer.
        let transferred = classify_bug(
            "open",
            "何帅",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(transferred, Some(NotificationKind::Transferred));

        // Someone else's old `open` bug is not mine to notify in mine scope.
        let not_mine = classify_bug(
            "open",
            "郭俊宏",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(not_mine, None);
    }

    #[test]
    fn missing_me_disables_classification() {
        let kind = classify_bug(
            "new",
            "",
            "2026-11-10 11:59:00",
            "",
            None,
            "  ",
            at(12, 0),
            true,
        );
        assert_eq!(kind, None);
    }

    #[test]
    fn scope_filter_matches_owner() {
        assert!(scope_allows(NotificationScope::Mine, "何帅", "何帅"));
        assert!(!scope_allows(NotificationScope::Mine, "郭俊宏", "何帅"));
        assert!(scope_allows(NotificationScope::Project, "郭俊宏", "何帅"));
    }

    #[test]
    fn kinds_dedupe_by_kind() {
        let sent = vec!["new".to_string()];
        assert!(already_notified(&sent, NotificationKind::New));
        assert!(!already_notified(&sent, NotificationKind::Reopened));
        assert_eq!(bug_key(" 45336192 ", " 1 "), "45336192:1");
    }

    #[test]
    fn quiet_hours_cross_midnight() {
        let quiet = QuietHours {
            enabled: true,
            start: "22:00".to_string(),
            end: "09:00".to_string(),
        };
        assert!(quiet_hours_active(
            &quiet,
            NaiveTime::from_hms_opt(23, 0, 0).unwrap()
        ));
        assert!(quiet_hours_active(
            &quiet,
            NaiveTime::from_hms_opt(8, 59, 0).unwrap()
        ));
        assert!(!quiet_hours_active(
            &quiet,
            NaiveTime::from_hms_opt(9, 0, 0).unwrap()
        ));
        assert!(!quiet_hours_active(
            &quiet,
            NaiveTime::from_hms_opt(12, 0, 0).unwrap()
        ));
    }

    #[test]
    fn quiet_hours_within_day_and_disabled() {
        let quiet = QuietHours {
            enabled: true,
            start: "12:00".to_string(),
            end: "13:30".to_string(),
        };
        assert!(quiet_hours_active(
            &quiet,
            NaiveTime::from_hms_opt(13, 0, 0).unwrap()
        ));
        assert!(!quiet_hours_active(
            &quiet,
            NaiveTime::from_hms_opt(13, 30, 0).unwrap()
        ));

        let disabled = QuietHours {
            enabled: false,
            ..quiet
        };
        assert!(!quiet_hours_active(
            &disabled,
            NaiveTime::from_hms_opt(13, 0, 0).unwrap()
        ));
    }

    #[test]
    fn settings_are_clamped() {
        let settings = NotificationSettings {
            poll_interval_secs: 5,
            max_visible: 42,
            ..NotificationSettings::default()
        }
        .normalized();
        assert_eq!(settings.poll_interval_secs, 20);
        assert_eq!(settings.max_visible, 5);

        let settings = NotificationSettings {
            poll_interval_secs: 5000,
            max_visible: 0,
            ..NotificationSettings::default()
        }
        .normalized();
        assert_eq!(settings.poll_interval_secs, 600);
        assert_eq!(settings.max_visible, 1);
    }

    #[test]
    fn default_poll_interval_is_30s() {
        assert_eq!(
            NotificationSettings::default().poll_interval_secs,
            DEFAULT_POLL_INTERVAL_SECS
        );
        assert_eq!(DEFAULT_POLL_INTERVAL_SECS, 30);
    }

    #[test]
    fn the_first_round_of_a_session_is_silent() {
        assert!(round_is_silent(true, false));
        assert!(round_is_silent(false, false));
        assert!(round_is_silent(true, true));
        assert!(!round_is_silent(false, true));
    }

    #[test]
    fn transfer_back_is_detected_from_a_new_assigned_time() {
        let mut previous = seen("in_progress", "何帅", &["new"]);
        previous.assigned_time = "2026-11-01 09:00:00".to_string();

        // "Mine" never saw the bug while it was assigned to someone else, so
        // the new assigned_time is the only transfer evidence.
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "2026-11-10 11:58:00",
            Some(&previous),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Transferred));

        // The same assignment observed again on the next round stays silent.
        let mut observed = previous.clone();
        observed.assigned_time = "2026-11-10 11:58:00".to_string();
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "2026-11-10 11:58:00",
            Some(&observed),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, None);
    }

    #[test]
    fn prune_seen_drops_stale_rows() {
        let now = at(12, 0);
        let mut store = NotificationStore::default();
        store.seen.insert(
            "1:1".to_string(),
            SeenBug {
                last_seen: "2026-11-10 11:00:00".to_string(),
                ..SeenBug::default()
            },
        );
        store.seen.insert(
            "1:2".to_string(),
            SeenBug {
                last_seen: "2025-01-01 00:00:00".to_string(),
                ..SeenBug::default()
            },
        );

        let removed = prune_seen(&mut store, now);
        assert_eq!(removed, vec!["1:2".to_string()]);
        assert!(store.seen.contains_key("1:1"));
    }

    #[test]
    fn extracts_workspace_from_session_url() {
        assert_eq!(
            workspace_from_session_url("https://www.tapd.cn/tapd_fe/45336192/bug/list"),
            Some("45336192".to_string())
        );
        assert_eq!(
            workspace_from_session_url("https://www.tapd.cn/tapd_fe/123/my/work?x=1"),
            Some("123".to_string())
        );
        assert_eq!(
            workspace_from_session_url("https://www.tapd.cn/login"),
            None
        );
        assert_eq!(
            workspace_from_session_url("https://www.tapd.cn/tapd_fe/my/work"),
            None
        );
    }

    #[test]
    fn timestamps_round_trip() {
        let time = at(12, 34);
        assert_eq!(format_tapd_time(time), "2026-11-10 12:34:00");
        assert_eq!(parse_tapd_time("2026-11-10 12:34:00"), Some(time));
        assert_eq!(parse_tapd_time(""), None);
    }
}

#[cfg(test)]
mod ai_notification_tests {
    use super::*;

    #[test]
    fn builds_blocks_from_shorthand() {
        let (title, payload) = ai_payload_from_arguments(
            &json!({
                "title": "  构建完成 ",
                "tone": "success",
                "body": "3 个任务完成",
                "fields": [{"label": "耗时", "value": "42s"}],
                "actions": [{"id": "open", "label": "打开", "style": "primary"}]
            }),
            "Claude Code",
        )
        .expect("payload");

        assert_eq!(title, "构建完成");
        assert_eq!(payload.tone, AiTone::Success);
        assert_eq!(payload.client, "Claude Code");
        assert_eq!(
            payload.blocks[0],
            AiBlock::Text {
                text: "3 个任务完成".to_string()
            }
        );
        assert!(matches!(payload.blocks[1], AiBlock::Fields { .. }));
        assert_eq!(payload.actions[0].id, "open");
        assert_eq!(payload.actions[0].style, "primary");
    }

    #[test]
    fn explicit_blocks_override_shorthand() {
        let (_, payload) = ai_payload_from_arguments(
            &json!({
                "title": "进度",
                "tone": "progress",
                "body": "ignored",
                "blocks": [
                    {"type": "progress", "percent": 120, "label": "安装"},
                    {"type": "divider"},
                    {"type": "code", "text": "cargo build", "language": "sh"}
                ]
            }),
            "Codex",
        )
        .expect("payload");

        assert_eq!(payload.blocks.len(), 3);
        assert_eq!(
            payload.blocks[0],
            AiBlock::Progress {
                percent: Some(100.0),
                label: Some("安装".to_string())
            }
        );
        assert_eq!(payload.blocks[1], AiBlock::Divider);
        assert!(matches!(&payload.blocks[2], AiBlock::Code { text, .. } if text == "cargo build"));
    }

    #[test]
    fn rejects_unknown_types_and_duplicate_actions() {
        let unknown = ai_payload_from_arguments(
            &json!({"title": "x", "blocks": [{"type": "video"}]}),
            "client",
        );
        assert!(unknown.is_err());

        let duplicate = ai_payload_from_arguments(
            &json!({
                "title": "x",
                "actions": [
                    {"id": "a", "label": "A"},
                    {"id": "a", "label": "B"}
                ]
            }),
            "client",
        );
        assert!(duplicate.is_err());

        let bad_style = ai_payload_from_arguments(
            &json!({"title": "x", "actions": [{"id": "a", "label": "A", "style": "loud"}]}),
            "client",
        );
        assert!(bad_style.is_err());
    }

    #[test]
    fn truncates_long_body_and_clamps_wait() {
        let body = "x".repeat(MAX_AI_TEXT_CHARS + 10);
        let (_, payload) =
            ai_payload_from_arguments(&json!({"title": "x", "body": body}), "client")
                .expect("payload");
        match &payload.blocks[0] {
            AiBlock::Text { text } => {
                assert_eq!(text.chars().count(), MAX_AI_TEXT_CHARS);
                assert!(text.ends_with('…'));
            }
            other => panic!("unexpected block: {other:?}"),
        }

        assert_eq!(
            notify_wait_seconds(&json!({"waitSeconds": 999})),
            MAX_NOTIFY_WAIT_SECS
        );
        assert_eq!(notify_wait_seconds(&json!({})), DEFAULT_NOTIFY_WAIT_SECS);
        assert_eq!(notify_wait_seconds(&json!({"waitSeconds": 0})), 0);
    }
}
