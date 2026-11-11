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
//!
//! Module layout:
//! - `model` — serde/wire types, settings defaults and clamping.
//! - `rules` — pure classification, time, quiet-hours and pruning rules.
//! - `ai` — AI/MCP payload parsing, transient AI cards, MCP entry points.
//! - `poll` — identity resolution, paged TAPD fetches and poll rounds.
//! - `actions` — Tauri command dispatch, card actions and the accept flow.

mod actions;
pub(crate) mod ai;
pub(crate) mod model;
mod poll;
pub(crate) mod rules;

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use chrono::Local;
use serde_json::{json, Value};
use tapd_core::tapd::api::{bug_detail_body, bug_detail_url, parse_bug_detail};
use tauri::{AppHandle, Emitter};

use crate::{
    commands::auth::session_request_json,
    notification_db,
    state::SharedState,
};

pub use actions::command;

use model::{
    bug_key, NotificationItem, NotificationSettings, NotificationSource, NotificationState,
    NotificationStore, SeenBug,
};
use rules::{format_tapd_time, quiet_hours_active};

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
/// How long a claim made here can explain an observed transfer. Covers the
/// latest TAPD write becoming visible in the next poll or two; a later genuine
/// transfer must notify again.
const SELF_CLAIM_TTL_SECS: i64 = 600;

/// Default and bounds for the notification poll interval.
const DEFAULT_POLL_INTERVAL_SECS: u64 = 30;
const MIN_POLL_INTERVAL_SECS: u64 = 20;
const MAX_POLL_INTERVAL_SECS: u64 = 600;

/// Error text for a card id that is no longer in either store.
const NOT_FOUND: &str = "通知不存在或已被清理";

static SERVICE: OnceLock<Arc<NotificationService>> = OnceLock::new();
/// Bumped whenever a notification session starts (app launch is implicit, login
/// and logout call `reset_session`). A poll that started under an older session
/// drops its results instead of leaking them into the new account.
static SESSION_SEQ: AtomicU64 = AtomicU64::new(0);

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
    /// Bugs this client claimed itself, with the claim time (unix seconds).
    /// The assignment is our own write, so it must not come back as news.
    self_claims: Mutex<BTreeMap<String, i64>>,
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

    /// Consumes a pending self-claim for `key`, pruning expired entries so a
    /// later genuine transfer still notifies.
    fn take_self_claim(&self, key: &str) -> bool {
        let mut claims = self
            .self_claims
            .lock()
            .expect("notification self claim lock");
        rules::take_claim_entry(&mut claims, key, Local::now().timestamp())
    }

    /// Records a rendered bug-list page as already seen. Never creates cards
    /// and never moves the poll cursor.
    fn observe_bugs(&self, bugs: &[tapd_core::tapd::BugSummary]) {
        let now = format_tapd_time(Local::now().naive_local());
        let updates = {
            let mut store = self.store.lock().expect("notification store lock");
            let mut updates: Vec<(String, SeenBug)> = Vec::with_capacity(bugs.len());
            for bug in bugs {
                if bug.workspace_id.trim().is_empty() || bug.id.trim().is_empty() {
                    continue;
                }
                let key = bug_key(&bug.workspace_id, &bug.id);
                // Keep the lifetime "new" de-dupe: observing is not a send.
                let kinds = store
                    .seen
                    .get(&key)
                    .map(|seen| seen.kinds.clone())
                    .unwrap_or_default();
                let seen = SeenBug {
                    status: bug.status.clone(),
                    owner: bug.owner.clone(),
                    created: bug.created.clone(),
                    assigned_time: bug.assigned_time.clone(),
                    kinds,
                    last_seen: now.clone(),
                };
                store.seen.insert(key.clone(), seen.clone());
                updates.push((key, seen));
            }
            updates
        };
        notification_db::write_seen(&self.state.cache, &updates);
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
            .ok_or_else(|| NOT_FOUND.to_string())
    }

    fn set_state(&self, id: &str, state: NotificationState) -> Result<NotificationItem, String> {
        let item = {
            let mut store = self.store.lock().expect("notification store lock");
            let item = store
                .items
                .iter_mut()
                .rev()
                .find(|item| item.id == id)
                .ok_or_else(|| NOT_FOUND.to_string())?;
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
            model::trim_oldest_items(&mut store.items, MAX_ITEMS);
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
}

/// Fetches one bug detail. Shared by project-scope polling and the accept flow.
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

fn service() -> Result<Arc<NotificationService>, String> {
    SERVICE
        .get()
        .cloned()
        .ok_or_else(|| "通知服务尚未初始化".to_string())
}

/// Records a bug-list page as already seen.
///
/// A list refresh — the manual button or the periodic one, page switches and
/// filter changes included — is an observation like a poll round: whatever the
/// user can already see on screen must not arrive later as a card. Only the
/// seen state is updated; no notification is created and the poll cursor stays
/// put. A real later change (reopen, new assignment) still notifies.
/// No-op when the notification service is not running.
pub fn observe_bug_page(bugs: &[tapd_core::tapd::BugSummary]) {
    let Ok(service) = service() else {
        return;
    };
    service.observe_bugs(bugs);
}

/// Records that this client just claimed a bug. The resulting assignment is
/// our own write, so the next transfer observed for this bug stays silent.
/// No-op when notifications are not running.
pub fn suppress_transfer(workspace_id: &str, bug_id: &str) {
    let Ok(service) = service() else {
        return;
    };
    service
        .self_claims
        .lock()
        .expect("notification self claim lock")
        .insert(bug_key(workspace_id, bug_id), Local::now().timestamp());
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
    let removed = rules::prune_seen(&mut store, now);
    notification_db::delete_seen_and_ignored(&state.cache, &removed);

    let service = Arc::new(NotificationService {
        app: app.clone(),
        state,
        store: Mutex::new(store),
        ai_items: Mutex::new(VecDeque::new()),
        workspace_names: Mutex::new(BTreeMap::new()),
        primed: Mutex::new(BTreeSet::new()),
        self_claims: Mutex::new(BTreeMap::new()),
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
