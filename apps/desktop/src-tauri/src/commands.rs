//! Tauri command surface.
//!
//! Every `#[tauri::command]` stays in this module because `lib.rs` registers it
//! as `commands::<name>` and the handler macro resolves the generated wrapper
//! through the same path. The plumbing behind the commands lives in the
//! submodules below, grouped by responsibility.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tapd_core::{
    bridge::CapturedRequest,
    config::{McpPolicy, ONBOARDING_VERSION},
    tapd::{
        api::{
            bug_list_url, parse_bug_list, parse_workspace_members, parse_workspaces,
            user_chooser_all_body, user_chooser_url, user_workspace_url, workspace_members_url,
            BugQuery,
        },
        BugDetail, BugListPage, BugSummary, Workspace, WorkspaceMember,
    },
};
use tauri::{AppHandle, Manager, State};

use crate::{
    bug_write::{self, normalize_user_value, EDITABLE_USER_FIELDS},
    mcp_audit::McpAuditEntry,
    open_with, session,
    state::SharedState,
};

use auth::{
    current_user_avatar, is_logged_in, logout_session, reset_session_and_open_login,
    session_request_json, string_field,
};
use bugs::{fetch_bug_detail, fetch_bug_summary, fetch_workspace_members, main_window_focused};
use open::{download_media, is_tapd_media_url, open_local, run_open, selected_open_target};

pub(crate) mod auth;
pub(crate) mod bugs;
pub(crate) mod open;


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    nick: String,
    user_id: String,
    company: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContext {
    user: UserProfile,
    workspaces: Vec<Workspace>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    paths: tapd_core::paths::AppPaths,
    logged_in: bool,
    me: Option<String>,
    me_avatar: Option<String>,
    last_workspace_id: Option<String>,
    runtime_port: Option<u16>,
    /// Port and capability of the media proxy used by `<img>`/`<video>`.
    media_port: Option<u16>,
    media_token: Option<String>,
    session_url: Option<String>,
    hidden_workspace_ids: Vec<String>,
    /// True when the stored guide revision matches [`ONBOARDING_VERSION`].
    onboarded: bool,
}

/// What the hidden TAPD webview is currently showing on its login page.
///
/// The login screen mirrors this state directly, so the QR code and the
/// WeCom "scanned" confirmation are rendered in-app without a second window.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoginQrState {
    /// `loading` | `qr` | `scanned` | `expired` | `error` | `logged_in`.
    phase: String,
    qr_url: Option<String>,
    name: Option<String>,
    avatar_url: Option<String>,
    corp: Option<String>,
    message: Option<String>,
}

impl LoginQrState {
    fn loading(message: &str) -> Self {
        Self {
            phase: "loading".to_string(),
            qr_url: None,
            name: None,
            avatar_url: None,
            corp: None,
            message: Some(message.to_string()),
        }
    }

    fn from_bridge(value: Value) -> Self {
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
        };

        let mut phase = text("phase").unwrap_or_else(|| "loading".to_string());
        if phase == "idle" || phase == "connecting" {
            phase = "loading".to_string();
        }

        Self {
            phase,
            qr_url: text("qrUrl"),
            name: text("name"),
            avatar_url: text("avatarUrl"),
            corp: text("corp"),
            message: text("message"),
        }
    }
}

#[tauri::command]
pub fn app_info(state: State<'_, SharedState>) -> AppInfo {
    let config = state.config_snapshot();
    let runtime = state.runtime_info();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        paths: state.paths.clone(),
        logged_in: config.logged_in,
        me: config.me,
        me_avatar: config.me_avatar,
        last_workspace_id: config.last_workspace_id,
        runtime_port: runtime.as_ref().map(|runtime| runtime.port),
        media_port: runtime.as_ref().map(|runtime| runtime.port),
        media_token: runtime.map(|runtime| runtime.media_token),
        session_url: config.last_session_url,
        hidden_workspace_ids: config.hidden_workspace_ids,
        onboarded: config.onboarded_version == ONBOARDING_VERSION,
    }
}

#[tauri::command]
pub fn session_show(app: AppHandle, state: State<'_, SharedState>) -> Result<(), String> {
    let window = session::ensure_session_window(&app, state.inner(), true)?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// Reads the login page state that the injected bridge publishes.
#[tauri::command]
pub async fn session_login_state(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<LoginQrState, String> {
    if is_logged_in(state.inner()) {
        return Ok(LoginQrState {
            phase: "logged_in".to_string(),
            qr_url: None,
            name: None,
            avatar_url: None,
            corp: None,
            message: None,
        });
    }

    let Some(window) = app.get_webview_window(session::SESSION_LABEL) else {
        return Ok(LoginQrState::loading("正在启动隐藏会话窗口"));
    };

    let expression = "(window.__TAPDCB__ && typeof window.__TAPDCB__.loginState === 'function') ? window.__TAPDCB__.loginState() : null";
    let state = match session::eval_sync_json_once(&window, expression, Duration::from_millis(1500))
        .await
    {
        Ok(Value::Null) => LoginQrState::loading("正在连接 TAPD 登录页"),
        Ok(value) => LoginQrState::from_bridge(value),
        Err(_) => LoginQrState::loading("正在等待登录页响应"),
    };
    Ok(state)
}

/// Clears any half-finished/expired TAPD session and opens a clean login page.
///
/// The login screen calls this on mount and from its refresh action: a stale
/// `tapdsession` cookie otherwise makes TAPD skip the form and render an
/// unrelated 404 shell, which looks like an endless spinner.
#[tauri::command]
pub async fn session_reload_login(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    if is_logged_in(state.inner()) {
        return Ok(());
    }

    let window = session::ensure_session_window(&app, state.inner(), false)?;
    reset_session_and_open_login(&window).await;
    Ok(())
}

#[tauri::command]
pub fn session_cache_avatar(
    state: State<'_, SharedState>,
    avatar_url: Option<String>,
) -> Result<(), String> {
    let Some(url) = avatar_url
        .map(|value| value.trim().to_string())
        .filter(|value| value.starts_with("https://") || value.starts_with("http://"))
    else {
        return Ok(());
    };

    state
        .update_config(|config| {
            if config.me_avatar.as_deref() != Some(url.as_str()) {
                config.me_avatar = Some(url);
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn session_logout(app: AppHandle, state: State<'_, SharedState>) -> Result<(), String> {
    logout_session(&app, state.inner(), "logout").await;
    Ok(())
}

#[tauri::command]
pub async fn workspace_context(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<WorkspaceContext, String> {
    let root = session_request_json(
        &app,
        "GET",
        &user_workspace_url("0"),
        None,
        Duration::from_secs(30),
    )
    .await?;

    let user_data = root
        .pointer("/data/get_current_user_ret/data")
        .ok_or_else(|| "unexpected identity response".to_string())?;

    // The same payload carries the signed-in user's avatar (`img_src`, which
    // the TAPD front-end maps to `currentUser.imgsrc`). Caching it here keeps
    // the account view and sidebar fresh on every launch and page entry; the
    // WeCom scan panel is only one of several login paths and often has none.
    if let Some(avatar) = current_user_avatar(user_data) {
        let changed = state
            .config
            .lock()
            .expect("config lock")
            .me_avatar
            .as_deref()
            != Some(avatar.as_str());
        if changed {
            if let Err(error) = state.update_config(|config| config.me_avatar = Some(avatar)) {
                tracing::warn!(%error, "failed to cache current user avatar");
            }
        }
    }

    let user = UserProfile {
        nick: string_field(user_data, "user_nick"),
        user_id: string_field(user_data, "user_id"),
        company: string_field(user_data, "company"),
    };
    let workspaces = parse_workspaces(&root)?;
    let context = WorkspaceContext { user, workspaces };

    // Write-through: the UI renders exactly this payload from cache next time.
    state.cache.put_workspace_context(&context);

    Ok(context)
}

/// Fetches one bug-list page.
///
/// `observe` means the caller has the bug list on screen. The backend still
/// requires the main window to be focused right now, so a background
/// auto-refresh while the user is in another app never silences notifications.
#[tauri::command]
pub async fn bug_list(
    app: AppHandle,
    state: State<'_, SharedState>,
    query: BugQuery,
    observe: Option<bool>,
) -> Result<BugListPage, String> {
    let body = query.body();
    let root = session_request_json(
        &app,
        "POST",
        &bug_list_url(),
        Some(body),
        Duration::from_secs(45),
    )
    .await?;

    let page = parse_bug_list(&root)?;
    state.cache.put_bug_list(&query, &page);
    state.cache.put_bug_records(&query.workspace_id, &page.bugs);
    // A focused list refresh (manual or the periodic one) is an observation
    // round: the user already sees these rows, so a later poll must not turn
    // them into notifications.
    if observe.unwrap_or(false) && main_window_focused(&app) {
        crate::notification::observe_bug_page(&page.bugs);
    }

    Ok(page)
}

#[tauri::command]
pub async fn bug_detail(
    app: AppHandle,
    state: State<'_, SharedState>,
    workspace_id: String,
    bug_id: String,
) -> Result<BugDetail, String> {
    // Cached here (not in `fetch_bug_detail`) so MCP/export callers, which need
    // the freshest detail for their own output, don't pay for cache writes.
    let detail = fetch_bug_detail(&app, &workspace_id, &bug_id).await?;
    state.cache.put_bug_detail(&workspace_id, &bug_id, &detail);

    Ok(detail)
}

/// One bug's list-row fields, without the change-history pages.
///
/// The 处理中 view only knows bug ids from live agent state, so it needs the
/// summary fields per row. Deliberately not cached: a summary has no history or
/// description, and writing it would degrade the detail pane's cache-first paint.
#[tauri::command]
pub async fn bug_summary(
    app: AppHandle,
    workspace_id: String,
    bug_id: String,
) -> Result<BugSummary, String> {
    fetch_bug_summary(&app, &workspace_id, &bug_id).await
}

/// Lists the people who can be assigned as owner / developer in a workspace.
///
/// `get_workspace_members` is the primary source; older workspaces may answer
/// with an empty list, in which case the user chooser's full directory is used.
#[tauri::command]
pub async fn workspace_members(
    app: AppHandle,
    state: State<'_, SharedState>,
    workspace_id: String,
) -> Result<Vec<WorkspaceMember>, String> {
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Err("缺少项目 id".to_string());
    }

    // Primary source; a 404/older project simply falls through to the chooser.
    let primary = fetch_workspace_members(&app, workspace_members_url(workspace_id)).await;
    let mut members = primary
        .as_ref()
        .map(|items| items.clone())
        .unwrap_or_default();
    if members.is_empty() {
        let root = session_request_json(
            &app,
            "POST",
            &user_chooser_url(),
            Some(user_chooser_all_body(workspace_id)),
            Duration::from_secs(30),
        )
        .await?;
        members = parse_workspace_members(&root);
    }
    if !members.is_empty() {
        state.cache.put_workspace_members(workspace_id, &members);
    }

    Ok(members)
}

/// Appends a plain-text comment to a bug.
#[tauri::command]
pub async fn bug_add_comment(
    app: AppHandle,
    workspace_id: String,
    bug_id: String,
    comment: String,
) -> Result<(), String> {
    let text = comment.trim();
    if text.is_empty() {
        return Err("评论不能为空".to_string());
    }
    bug_write::add_comment(&app, workspace_id.trim(), bug_id.trim(), text).await?;
    Ok(())
}

/// Changes the owner (`current_owner`) or developer (`de`) of a bug.
///
/// Setting ourselves as owner ("认领" or picking our own name) is our own
/// write: the next poll must not report it back as a transfer notification.
/// `claim` marks the explicit claim button even when the local nickname is
/// unavailable.
#[tauri::command]
pub async fn bug_update_field(
    app: AppHandle,
    state: State<'_, SharedState>,
    workspace_id: String,
    bug_id: String,
    field: String,
    value: String,
    claim: Option<bool>,
) -> Result<(), String> {
    let field = field.trim();
    if !EDITABLE_USER_FIELDS.contains(&field) {
        return Err("只支持修改处理人与开发人员".to_string());
    }
    let value = normalize_user_value(&value);
    if value.is_empty() {
        return Err("请选择人员".to_string());
    }

    bug_write::update_field(&app, workspace_id.trim(), bug_id.trim(), field, &value).await?;

    if field == "current_owner" {
        let mine = state
            .config_snapshot()
            .me
            .map(|me| normalize_user_value(&me) == value)
            .unwrap_or(false);
        if claim.unwrap_or(false) || mine {
            crate::notification::suppress_transfer(workspace_id.trim(), bug_id.trim());
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BugTransitionChoice {
    key: String,
    label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BugTransitionInfo {
    current_status: String,
    current_label: String,
    transitions: Vec<BugTransitionChoice>,
}

/// Lists the workflow transitions available from a bug's current status.
#[tauri::command]
pub async fn bug_transitions(
    app: AppHandle,
    workspace_id: String,
    bug_id: String,
) -> Result<BugTransitionInfo, String> {
    let info = bug_write::load_transition_info(&app, workspace_id.trim(), bug_id.trim()).await?;
    let current_label = info
        .status_alias
        .get(&info.current_status)
        .cloned()
        .unwrap_or_else(|| info.current_status.clone());
    let transitions = info
        .transitions
        .into_iter()
        .map(|(key, label)| BugTransitionChoice { key, label })
        .collect();

    Ok(BugTransitionInfo {
        current_status: info.current_status,
        current_label,
        transitions,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BugTransitionForm {
    from: String,
    status: String,
    label: String,
    fields: Vec<bug_write::TransitionField>,
}

/// Returns the fields TAPD shows before a workflow transition.
#[tauri::command]
pub async fn bug_transition_form(
    app: AppHandle,
    workspace_id: String,
    bug_id: String,
    status: String,
) -> Result<BugTransitionForm, String> {
    let (from, status, label, fields) =
        bug_write::load_transition_form(&app, workspace_id.trim(), bug_id.trim(), status.trim())
            .await?;
    Ok(BugTransitionForm {
        from,
        status,
        label,
        fields,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BugTransitionResult {
    from: String,
    status: String,
    label: String,
    changed: bool,
}

/// Moves a bug to another workflow status.
#[tauri::command]
pub async fn bug_transition(
    app: AppHandle,
    workspace_id: String,
    bug_id: String,
    status: String,
    fields: Option<Value>,
) -> Result<BugTransitionResult, String> {
    let overrides = fields.unwrap_or_else(|| json!({}));
    let outcome = bug_write::perform_transition(
        &app,
        workspace_id.trim(),
        bug_id.trim(),
        status.trim(),
        &overrides,
    )
    .await?;

    Ok(BugTransitionResult {
        from: outcome.original_status,
        status: outcome.status,
        label: outcome.label,
        changed: !outcome.steps.is_empty(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientInfo {
    id: String,
    /// User-scope config file, when it can be located.
    path: Option<String>,
    /// Whether that file already registers `tapd-mcp`.
    imported: bool,
}

/// One tool as shown in the in-app API docs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    name: &'static str,
    description: &'static str,
    /// `inputSchema` JSON text; the UI parses it into a parameter list.
    schema: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigInfo {
    command_path: String,
    snippet: String,
    transport: String,
    read_only: bool,
    tools: Vec<McpToolInfo>,
    port: Option<u16>,
    /// One-click import status for every supported client.
    clients: Vec<McpClientInfo>,
}

/// Path to the bundled `tapd-mcp` sidecar (falls back to PATH lookup in dev).
pub(crate) fn sidecar_command_path() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("tapd-mcp")))
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| "tapd-mcp".to_string())
}

#[tauri::command]
pub fn reset_onboarding(state: State<'_, SharedState>) -> Result<(), String> {
    state
        .update_config(|config| config.onboarded_version = 0)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn complete_onboarding(state: State<'_, SharedState>) -> Result<(), String> {
    state
        .update_config(|config| config.onboarded_version = ONBOARDING_VERSION)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mcp_policy_get(state: State<'_, SharedState>) -> McpPolicy {
    state.config_snapshot().mcp_policy
}

#[tauri::command]
pub fn mcp_policy_set(
    state: State<'_, SharedState>,
    policy: McpPolicy,
) -> Result<McpPolicy, String> {
    let policy = policy.normalized();
    state
        .update_config(|config| config.mcp_policy = policy.clone())
        .map_err(|error| error.to_string())?;
    Ok(policy)
}

#[tauri::command]
pub fn mcp_audit_list(state: State<'_, SharedState>, limit: Option<usize>) -> Vec<McpAuditEntry> {
    state.mcp_audit.list(limit.unwrap_or(200))
}

#[tauri::command]
pub fn mcp_audit_clear(state: State<'_, SharedState>) -> Result<(), String> {
    state.mcp_audit.clear().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mcp_audit_export(state: State<'_, SharedState>) -> Result<String, String> {
    std::fs::create_dir_all(&state.paths.exports_dir).map_err(|error| error.to_string())?;
    let path = state.paths.exports_dir.join(format!(
        "mcp-audit-{}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    state
        .mcp_audit
        .export(&path)
        .map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn mcp_config(state: State<'_, SharedState>) -> Result<McpConfigInfo, String> {
    let command_path = sidecar_command_path();

    // Discovering client configs shells out to `opencode debug paths` (up to
    // 3s); keep the whole probe off the UI thread.
    let status_command = command_path.clone();
    let clients = tokio::task::spawn_blocking(move || {
        crate::mcp_import::CLIENTS
            .iter()
            .map(|client| {
                let path = crate::mcp_import::client_config_path(client);
                let imported = path.as_deref().is_some_and(|path| {
                    crate::mcp_import::imported_in_path(client, path, &status_command)
                });
                McpClientInfo {
                    id: (*client).to_string(),
                    path: path.map(|path| path.to_string_lossy().to_string()),
                    imported,
                }
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();

    let snippet = serde_json::to_string_pretty(&serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "mcp": {
            "tapd": {
                "type": "local",
                "command": [command_path.clone()]
            }
        }
    }))
    .unwrap_or_default();

    Ok(McpConfigInfo {
        command_path: command_path.clone(),
        snippet,
        transport: "stdio".to_string(),
        read_only: !state.config_snapshot().mcp_policy.writes_enabled,
        // The sidecar's manifest is the single source of truth for names,
        // descriptions and input schemas.
        tools: tapd_core::mcp::TOOLS
            .iter()
            .map(|tool| McpToolInfo {
                name: tool.name,
                description: tool.description,
                schema: tool.schema,
            })
            .collect(),
        port: state.runtime_info().map(|runtime| runtime.port),
        clients,
    })
}

#[tauri::command]
pub fn ensure_window_width(app: AppHandle, min_width: f64) -> Result<f64, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口尚未创建".to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let current_width = size.width as f64 / scale;
    let height = size.height as f64 / scale;

    if !min_width.is_finite() || min_width <= current_width + 1.0 {
        return Ok(current_width);
    }

    let mut target_width = min_width;
    let mut min_x = 0.0f64;
    if let Ok(Some(monitor)) = window.current_monitor() {
        target_width = target_width.min(monitor.size().width as f64 / monitor.scale_factor());
        min_x = monitor.position().x as f64 / monitor.scale_factor();
    }

    // Growing for the detail panel is not a user resize: keep the saved
    // window geometry unchanged.
    crate::window_state::suppress_for(1_500);

    // Grow leftwards so the window's right edge (and the new detail panel)
    // stays where the user put it.
    if let Ok(position) = window.outer_position() {
        let x = position.x as f64 / scale;
        let y = position.y as f64 / scale;
        let next_x = (x - (target_width - current_width)).max(min_x);
        let _ = window.set_position(tauri::LogicalPosition::new(next_x, y));
    }

    window
        .set_size(tauri::LogicalSize::new(target_width, height))
        .map_err(|error| error.to_string())?;
    Ok(target_width)
}

#[tauri::command]
pub fn set_current_user(state: State<'_, SharedState>, nick: String) -> Result<(), String> {
    state
        .update_config(|config| {
            let trimmed = nick.trim();
            if !trimmed.is_empty() {
                config.me = Some(trimmed.to_string());
            }
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_hidden_workspaces(
    state: State<'_, SharedState>,
    ids: Vec<String>,
) -> Result<(), String> {
    let mut normalized: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim().to_string();
        if !id.is_empty() && !normalized.contains(&id) {
            normalized.push(id);
        }
    }
    state
        .update_config(|config| config.hidden_workspace_ids = normalized)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_last_workspace(
    state: State<'_, SharedState>,
    workspace_id: String,
) -> Result<(), String> {
    state
        .update_config(|config| config.last_workspace_id = Some(workspace_id))
        .map_err(|error| error.to_string())
}

/// Frontend-owned preference blob (theme, bug list layout). `Null` on a fresh
/// install, or when the stored config predates the field.
#[tauri::command]
pub fn ui_prefs_get(state: State<'_, SharedState>) -> Value {
    state.config_snapshot().ui_prefs
}

/// Replaces the whole preference blob; the frontend owns its schema.
#[tauri::command]
pub fn ui_prefs_set(state: State<'_, SharedState>, prefs: Value) -> Result<(), String> {
    state
        .update_config(|config| config.ui_prefs = prefs)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn capture_snapshot(app: AppHandle) -> Result<Vec<CapturedRequest>, String> {
    snapshot_captures(&app).await
}

#[tauri::command]
pub async fn capture_clear(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(session::SESSION_LABEL) else {
        return Ok(());
    };
    session::eval_sync_json(&window, "window.__TAPDCB__.clear()", Duration::from_secs(8))
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn capture_export(
    app: AppHandle,
    state: State<'_, SharedState>,
    target_dir: Option<String>,
) -> Result<String, String> {
    let captures = snapshot_captures(&app).await?;
    let names = format!(
        "capture-{}-{}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        captures.len()
    );
    // The native picker supplies the destination; captures_dir stays the
    // fallback for callers that do not pass one.
    let dir = target_dir
        .as_deref()
        .map(std::path::Path::new)
        .filter(|path| !path.as_os_str().is_empty())
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| state.paths.captures_dir.clone());
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(names);
    let raw = serde_json::to_vec_pretty(&captures).map_err(|error| error.to_string())?;
    std::fs::write(&path, raw).map_err(|error| error.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    let display_path = path.to_string_lossy().to_string();
    tracing::info!(path = %display_path, count = captures.len(), "capture exported");
    Ok(display_path)
}

async fn snapshot_captures(app: &AppHandle) -> Result<Vec<CapturedRequest>, String> {
    let Some(window) = app.get_webview_window(session::SESSION_LABEL) else {
        return Ok(Vec::new());
    };

    let value = session::eval_sync_json(
        &window,
        "window.__TAPDCB__.snapshot()",
        Duration::from_secs(15),
    )
    .await?;

    serde_json::from_value(value).map_err(|error| format!("unexpected capture payload: {error}"))
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Opens a bound project folder in the saved editor (or `target` overrides it).
///
/// The target set for `directory` is limited to code editors, so a TAPD project
/// folder never lands in a browser or an image viewer.
#[tauri::command]
pub async fn open_directory(
    state: State<'_, SharedState>,
    path: String,
    target: Option<String>,
) -> Result<(), String> {
    let dir = tapd_core::paths::expand_home(path.trim());
    if dir.as_os_str().is_empty() {
        return Err("还没有绑定项目目录".to_string());
    }
    if !dir.is_dir() {
        return Err(format!("项目目录不存在：{}", dir.display()));
    }

    let selected = selected_open_target(state.inner(), target, "directory");

    open_local(&dir, &selected)
}

/// Opens a TAPD resource locally.
///
/// `mode`:
/// - `file`    download to the media cache, then open with the chosen app
/// - `browser` open the TAPD URL in the default browser
/// - `reveal`  download, then reveal it in Finder
/// - `path`    download only, returning the local path
///
/// For `file`, `target` overrides the saved "open with" choice; `kind`
/// (`image` / `video` / `file`) selects which saved choice applies.
#[tauri::command]
pub async fn open_media(
    app: AppHandle,
    state: State<'_, SharedState>,
    url: String,
    mode: String,
    kind: Option<String>,
    target: Option<String>,
) -> Result<String, String> {
    if !is_tapd_media_url(&url) {
        return Err("只支持 TAPD 站内资源地址".to_string());
    }

    match mode.as_str() {
        "browser" => {
            run_open(&[url.as_str()])?;
            Ok(String::new())
        }
        "file" => {
            let kind = open_with::normalize_kind(kind.as_deref().unwrap_or("file"));
            let selected = selected_open_target(state.inner(), target, kind);

            if selected == open_with::BROWSER_TARGET {
                run_open(&[url.as_str()])?;
                return Ok(String::new());
            }

            let path = download_media(&app, &state.paths, &url).await?;
            open_local(&path, &selected)?;
            Ok(path.to_string_lossy().to_string())
        }
        "reveal" => {
            let path = download_media(&app, &state.paths, &url).await?;
            run_open(&["-R", &path.to_string_lossy()])?;
            Ok(path.to_string_lossy().to_string())
        }
        "path" => {
            let path = download_media(&app, &state.paths, &url).await?;
            Ok(path.to_string_lossy().to_string())
        }
        other => Err(format!("不支持的打开方式：{other}")),
    }
}

/// Port and capability of the media proxy, so the UI can (re)build the URL even
/// when `app_info` was read before the local server was ready.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    name: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// Resolved directory (a dropped file resolves to its parent folder).
    path: String,
    parent: Option<String>,
    entries: Vec<DirEntryInfo>,
}

/// Lists sub-directories for the folder picker. Accepts a file path (drag &
/// drop) and resolves it to the containing folder.
#[tauri::command]
pub fn list_dirs(path: Option<String>) -> Result<DirListing, String> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    let requested = path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or(home);

    let mut base = if requested.is_file() {
        requested
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or(requested)
    } else {
        requested
    };
    base = base.canonicalize().unwrap_or(base);
    if !base.is_dir() {
        return Err(format!("目录不存在：{}", base.display()));
    }

    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let read = std::fs::read_dir(&base).map_err(|error| error.to_string())?;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        entries.push(DirEntryInfo {
            path: entry.path().to_string_lossy().to_string(),
            name,
        });
    }
    entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    Ok(DirListing {
        path: base.to_string_lossy().to_string(),
        parent: base
            .parent()
            .map(|parent| parent.to_string_lossy().to_string()),
        entries,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEndpoint {
    port: u16,
    token: String,
}

#[tauri::command]
pub fn media_endpoint(state: State<'_, SharedState>) -> Result<MediaEndpoint, String> {
    let runtime = state
        .runtime_info()
        .ok_or_else(|| "本地服务尚未就绪".to_string())?;
    Ok(MediaEndpoint {
        port: runtime.port,
        token: runtime.media_token,
    })
}

/// Lists the "打开方式" options for a resource kind, plus the saved choice.
#[tauri::command]
pub async fn open_targets(
    state: State<'_, SharedState>,
    kind: String,
) -> Result<open_with::OpenTargetSet, String> {
    let cache_dir = state.paths.data_dir.join("app-icons");
    let open_with = state.config.lock().expect("config lock").open_with.clone();

    tokio::task::spawn_blocking(move || open_with::target_set(&kind, &cache_dir, &open_with))
        .await
        .map_err(|error| error.to_string())
}

/// Remembers the chosen app for a resource kind.
#[tauri::command]
pub fn set_open_target(
    state: State<'_, SharedState>,
    kind: String,
    id: String,
) -> Result<(), String> {
    let kind = open_with::normalize_kind(&kind).to_string();
    state
        .update_config(|config| {
            config.open_with.insert(kind, id);
        })
        .map_err(|error| error.to_string())
}

/// Deletes every entry under the app data directory and restarts the app.
///
/// The wipe runs on the next launch, before logging or SQLite opens anything,
/// because the current process holds those files open (and Windows would
/// refuse to delete them). The caller gets its result before the restart.
#[tauri::command]
pub fn clear_app_data(app: AppHandle, state: State<'_, SharedState>) -> Result<(), String> {
    crate::reset::request(&state.paths).map_err(|error| error.to_string())?;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        app.restart();
    });
    Ok(())
}
