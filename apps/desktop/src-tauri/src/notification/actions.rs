//! Notification command handlers and card actions.
//!
//! The Tauri feature-command surface (`notification_*`), the "处理" (accept)
//! flow, the settings patch and the debug/simulate paths. Polling lives in
//! `poll.rs`; nothing here runs inside the poll loop.

use chrono::Local;
use serde::Deserialize;
use serde_json::{json, Value};
use tapd_core::tapd::api::user_workspace_url;
use tapd_i18n::{tr, tr_args};
use tauri::{AppHandle, Emitter, Manager};

use crate::{bug_write, commands::auth::session_request_json, notification_db, state::SharedState};

use super::{
    ai::ai_payload_from_arguments,
    fetch_bug,
    model::{
        bug_key, NotificationItem, NotificationKind, NotificationScope, NotificationSettings,
        NotificationSource, NotificationState,
    },
    rules::{current_user_nick, format_tapd_time, is_hhmm},
    service, suppress_transfer, NotificationService, MAX_HISTORY,
};

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
            let count = items.len();
            let expanded = expanded && count > 0;
            crate::island_window::apply_island(app, state, expanded, count, true);
            Ok(json!({ "ok": true, "expanded": expanded, "count": count }))
        }
        "notification_island_peek" => {
            // Hovering the collapsed capsule reveals which task the Agent is
            // working on. Expanded cards keep their own layout.
            let active = payload
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            crate::island_window::set_peek(active);
            super::refresh_island_layout(app, state);
            Ok(json!({ "ok": true, "active": active }))
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
        "notification_open_bug" => {
            // Same path as the card's 查看缺陷: focus the main window and let
            // the workspace hook switch project + load the detail pane.
            let workspace_id = payload_str(&payload, "workspaceId")?;
            let bug_id = payload_str(&payload, "bugId")?;
            focus_main_window(app);
            let _ = app.emit(
                "notification://open-bug",
                json!({ "workspaceId": workspace_id, "bugId": bug_id }),
            );
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
                .unwrap_or(tr("notify.debug.client"));
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
    if !is_simulated(&item) {
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
        tr("notify.simulated.workspace").to_string()
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
        .unwrap_or(tr("notify.simulated.title"))
        .to_string();

    let item = NotificationItem {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id,
        workspace_name,
        bug_id,
        title,
        kind,
        owner: config.me.unwrap_or_else(|| tr("notify.simulated.me").to_string()),
        creator: tr("notify.simulated.creator").to_string(),
        severity: "严重".to_string(), // i18n-exempt: mock TAPD field value
        priority: "高".to_string(), // i18n-exempt: mock TAPD field value
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

/// Cards created by `notification_simulate` have no real bug behind them.
fn is_simulated(item: &NotificationItem) -> bool {
    item.workspace_id == "simulated" || item.bug_id.starts_with("simulated-")
}

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
        return Err(tr("notify.user.unknown").to_string());
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
        std::time::Duration::from_secs(30),
    )
    .await?;
    let nick = current_user_nick(&root);
    if nick.is_empty() {
        return Ok(nick);
    }

    state
        .update_config(|config| config.me = Some(nick.clone()))
        .map_err(|error| error.to_string())?;
    Ok(nick)
}

async fn handle_notification(
    app: &AppHandle,
    state: &SharedState,
    service: &NotificationService,
    id: &str,
) -> Result<Value, String> {
    let item = service.find_item(id)?;
    if item.state == NotificationState::Handled {
        return Err(tr("notify.already.handled").to_string());
    }
    if is_simulated(&item) {
        return Err(tr("notify.simulated.handle").to_string());
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
        .map_err(|error| tr_args("notify.claim.failed", &[&error]))?;
        // The card's own "处理" just assigned the bug to us: the next poll
        // must not surface that as a transfer notification.
        suppress_transfer(&item.workspace_id, &item.bug_id);
    }

    // Starting statuses move into the workflow's processing status. The target
    // key is read from the workflow itself, so no project-specific guessing.
    let step = bug_write::accept_into_processing(app, &item.workspace_id, &item.bug_id)
        .await
        .map_err(|error| tr_args("notify.transition.failed", &[&error]))?;
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
        .map_err(|error| tr_args("notify.settings.invalid", &[&error]))?;

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
                return Err(tr("notify.quiet.start").to_string());
            }
            settings.quiet_hours.start = start;
        }
        if let Some(end) = quiet.end {
            if !is_hhmm(&end) {
                return Err(tr("notify.quiet.end").to_string());
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
        .ok_or_else(|| tr_args("notify.param.missing", &[&key]))
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
