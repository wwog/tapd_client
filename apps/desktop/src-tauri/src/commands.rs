use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Value};
use tapd_core::{
    bridge::{BridgeHttpResult, CapturedRequest},
    config::McpPolicy,
    export::MediaKind,
    tapd::{
        api::{
            bug_detail_body, bug_detail_url, bug_list_url, parse_bug_detail, parse_bug_list,
            parse_workspace_members, parse_workspaces, user_chooser_all_body, user_chooser_url,
            user_workspace_url, workspace_members_url, BugQuery,
        },
        changes_list_url, parse_changes_html, BugDetail, BugListPage, ChangeHistory, Workspace,
        WorkspaceMember,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    bug_write::{self, normalize_user_value, EDITABLE_USER_FIELDS},
    mcp_audit::McpAuditEntry,
    media, notification, open_with, session,
    state::SharedState,
};

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
        onboarded: config.onboarded,
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
    let logged_in = {
        let config = state.config.lock().expect("config lock");
        config.logged_in
    };

    if logged_in {
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
    let logged_in = {
        let config = state.config.lock().expect("config lock");
        config.logged_in
    };
    if logged_in {
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

/// Clears the TAPD session in config, cache, cookies and the hidden webview.
///
/// Shared by the explicit "退出登录" action and automatic expiry detection, so
/// both paths leave the app on the login screen with no stale identity left.
pub(crate) async fn logout_session(app: &AppHandle, state: &SharedState, reason: &str) {
    if let Err(error) = state.update_config(|config| {
        config.logged_in = false;
        config.me = None;
        config.me_avatar = None;
        config.last_session_url = None;
    }) {
        tracing::warn!(%error, reason, "failed to clear session config");
    }

    // Drop cached user/project/bug data: it belongs to the session being ended.
    // Best effort — a broken cache must never block logging out.
    if let Err(error) = state.cache.clear() {
        tracing::warn!(%error, "failed to clear offline cache on logout");
    }
    // Cards and de-duplication state belong to the account being ended.
    notification::reset_session();

    // Keep the URL watcher from resurrecting the old session while TAPD boots.
    // The login page takes a few seconds to settle, so cover the whole window.
    session::begin_logout_guard(30_000);
    let _ = app.emit("session://changed", ());

    if let Some(window) = app.get_webview_window(session::SESSION_LABEL) {
        let app_for_emit = app.clone();
        let reason = reason.to_string();
        tauri::async_runtime::spawn(async move {
            reset_session_and_open_login(&window).await;

            // Stay hidden: the login screen shows the new QR code in place.
            let _ = app_for_emit.emit("session://changed", ());
            tracing::info!(reason, "session cleared");
        });
    }
}

/// Clears the TAPD session in the hidden webview and opens a clean login form.
///
/// Order matters: page storage is cleared while the document is still on the
/// TAPD origin, then the page is parked on `about:blank` so the old SPA cannot
/// re-issue request cookies while the jar is being emptied. The login page is
/// only opened after the cookies are actually gone; otherwise TAPD redirects
/// straight back into the workspace and the hidden window has no QR to publish
/// (the login screen then looks stuck at "正在接入").
async fn reset_session_and_open_login(window: &tauri::WebviewWindow) {
    let _ = session::eval_sync_json(
        window,
        "try { localStorage.clear(); sessionStorage.clear(); } catch (error) {}; true",
        Duration::from_secs(2),
    )
    .await;

    if let Ok(blank) = tauri::Url::parse("about:blank") {
        let _ = window.navigate(blank);
    }
    for _ in 0..12 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if window
            .url()
            .map(|url| url.as_str() == "about:blank")
            .unwrap_or(false)
        {
            break;
        }
    }

    // Deleting cookies explicitly is more reliable than the bulk clear on
    // macOS, where the removal is asynchronous.
    let _ = clear_tapd_cookies(window);
    let _ = window.clear_all_browsing_data();

    // Give WKWebsiteDataStore the same grace period the manual "refresh QR"
    // path uses, then keep polling until the jar is empty. The completion time
    // varies with the number of TAPD cookies.
    tokio::time::sleep(Duration::from_millis(700)).await;
    for _ in 0..15 {
        let _ = clear_tapd_cookies(window);
        if tapd_cookie_count(window) == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let remaining = tapd_cookie_count(window);
    if remaining > 0 {
        // Proceed anyway, but leave a trail: a surviving session cookie makes
        // the login page bounce straight back into the workspace.
        tracing::warn!(remaining, "TAPD cookies survived session cleanup");
    }

    if let Ok(login) = tauri::Url::parse(session::TAPD_LOGIN) {
        let _ = window.navigate(login);
    }
    let _ = window.hide();
}

/// A TAPD response proves the session is gone: an explicit 401, a redirect
/// that landed on the login page, or the login shell returned in place of an
/// API body. Transient network errors never match.
fn session_expired(http: &BridgeHttpResult) -> bool {
    if http.status == 401 || session::looks_like_auth_page(&http.url) {
        return true;
    }

    let content_type = http
        .content_type
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.contains("text/html") {
        return false;
    }

    let head = http
        .body
        .chars()
        .take(2400)
        .collect::<String>()
        .to_ascii_lowercase();
    head.contains("wwlogin") || head.contains("<title>登录") || head.contains("<title>企业微信")
}

/// Guards against several in-flight requests all clearing the session at once.
static EXPIRING: AtomicBool = AtomicBool::new(false);

/// Signs out once when an authenticated TAPD call reports an expired session.
pub(crate) async fn expire_session(app: &AppHandle) {
    let Some(state) = app.try_state::<SharedState>() else {
        return;
    };
    let logged_in = state.config.lock().expect("config lock").logged_in;
    if !logged_in || EXPIRING.swap(true, Ordering::SeqCst) {
        return;
    }

    tracing::warn!("TAPD session expired; signing out");
    logout_session(app, state.inner(), "expired").await;
    EXPIRING.store(false, Ordering::SeqCst);
}

/// Removes every TAPD cookie from a webview and returns how many were deleted.
fn clear_tapd_cookies(window: &tauri::WebviewWindow) -> usize {
    let Ok(cookies) = window.cookies() else {
        return 0;
    };

    let mut removed = 0usize;
    for cookie in cookies {
        if is_tapd_cookie_domain(cookie.domain().unwrap_or_default())
            && window.delete_cookie(cookie).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

/// How many TAPD cookies are still in the jar.
fn tapd_cookie_count(window: &tauri::WebviewWindow) -> usize {
    window
        .cookies()
        .map(|cookies| {
            cookies
                .iter()
                .filter(|cookie| is_tapd_cookie_domain(cookie.domain().unwrap_or_default()))
                .count()
        })
        .unwrap_or(0)
}

fn is_tapd_cookie_domain(domain: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    domain == "tapd.cn" || domain.ends_with(".tapd.cn")
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

#[tauri::command]
pub async fn bug_list(
    app: AppHandle,
    state: State<'_, SharedState>,
    query: BugQuery,
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

async fn fetch_workspace_members(
    app: &AppHandle,
    url: String,
) -> Result<Vec<WorkspaceMember>, String> {
    let root = session_request_json(app, "GET", &url, None, Duration::from_secs(30)).await?;
    Ok(parse_workspace_members(&root))
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
#[tauri::command]
pub async fn bug_update_field(
    app: AppHandle,
    workspace_id: String,
    bug_id: String,
    field: String,
    value: String,
) -> Result<(), String> {
    let field = field.trim();
    if !EDITABLE_USER_FIELDS.contains(&field) {
        return Err("只支持修改处理人与开发人员".to_string());
    }
    let value = normalize_user_value(&value);
    if value.is_empty() {
        return Err("请选择人员".to_string());
    }

    bug_write::update_field(&app, workspace_id.trim(), bug_id.trim(), field, &value).await
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
) -> Result<BugTransitionResult, String> {
    let outcome = bug_write::perform_transition(
        &app,
        workspace_id.trim(),
        bug_id.trim(),
        status.trim(),
        &json!([]),
    )
    .await?;

    Ok(BugTransitionResult {
        from: outcome.original_status,
        status: outcome.status,
        label: outcome.label,
        changed: !outcome.steps.is_empty(),
    })
}

/// Loads a bug together with its change history.
///
/// The history lives in a legacy HTML page, so a failure there only degrades
/// that section instead of failing the whole detail.
pub(crate) async fn fetch_bug_detail(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<BugDetail, String> {
    let body = bug_detail_body(workspace_id, bug_id);
    let url = bug_detail_url();
    let detail_future =
        session_request_json(app, "POST", &url, Some(body), Duration::from_secs(45));
    let changes_future = fetch_change_history(app, workspace_id, bug_id);

    let (root, changes) = tokio::join!(detail_future, changes_future);
    let mut detail = parse_bug_detail(&root?)?;
    detail.changes = changes.unwrap_or_else(|error| ChangeHistory {
        error: Some(error),
        ..ChangeHistory::default()
    });

    Ok(detail)
}

/// The legacy page returns at most one page of changes per request.
const MAX_CHANGE_PAGES: u32 = 10;

pub(crate) async fn fetch_change_history(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<ChangeHistory, String> {
    let mut history = ChangeHistory::default();
    let mut previous_first_seq: Option<u32> = None;

    for page in 1..=MAX_CHANGE_PAGES {
        let http = session_request_text(
            app,
            "GET",
            &changes_list_url(workspace_id, bug_id, page),
            None,
            Duration::from_secs(30),
        )
        .await?;
        let parsed = parse_changes_html(&http.body)?;

        if page == 1 {
            history.total = parsed.total;
        }
        let Some(first_seq) = parsed.changes.first().map(|change| change.seq) else {
            break;
        };
        // Guard against the server ignoring `page` and repeating the first page.
        if page > 1 && previous_first_seq == Some(first_seq) {
            break;
        }
        previous_first_seq = Some(first_seq);

        for change in parsed.changes {
            if history
                .changes
                .iter()
                .any(|existing| existing.seq == change.seq)
            {
                continue;
            }
            history.changes.push(change);
        }

        if history.changes.len() as u32 >= history.total {
            break;
        }
    }

    if history.total < history.changes.len() as u32 {
        history.total = history.changes.len() as u32;
    }

    Ok(history)
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
        .update_config(|config| config.onboarded = false)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn complete_onboarding(state: State<'_, SharedState>) -> Result<(), String> {
    state
        .update_config(|config| config.onboarded = true)
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

pub(crate) async fn session_request_json(
    app: &AppHandle,
    method: &str,
    url: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let http = session_request_text(app, method, url, body, timeout).await?;

    serde_json::from_str(&http.body).map_err(|error| format!("invalid TAPD JSON response: {error}"))
}

/// Same as [`session_request_json`] but returns the raw body, for the legacy
/// pages TAPD renders as HTML.
pub(crate) async fn session_request_text(
    app: &AppHandle,
    method: &str,
    url: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<BridgeHttpResult, String> {
    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| "会话窗口尚未创建，请稍后重试".to_string())?;

    let payload = serde_json::json!({
        "method": method,
        "url": url,
        "body": body.map(|body| body.to_string()),
    });
    let expression = format!("window.__TAPDCB__.request({payload})");
    let value = session::eval_async_json(&window, &expression, timeout).await?;
    let http: BridgeHttpResult = serde_json::from_value(value)
        .map_err(|error| format!("unexpected bridge payload: {error}"))?;

    // An expired TAPD session usually surfaces as a 401 or a redirect to the
    // login page. Detect it on every authenticated call so cached data never
    // makes the app look signed in after the cookie has gone stale.
    if session_expired(&http) {
        expire_session(app).await;
        return Err("TAPD 登录状态已失效，请重新扫码登录".to_string());
    }

    if !http.ok {
        let preview: String = http.body.chars().take(240).collect();
        return Err(format!(
            "TAPD 请求失败（HTTP {}）：{}",
            http.status, preview
        ));
    }

    Ok(http)
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Reads the avatar URL from a TAPD user object.
///
/// `img_src` is what the web app uses, but older/other endpoints answer with
/// `avatar`/`head`, and a relative path is common. Anything that is not an
/// absolute http(s) URL after resolving against `www.tapd.cn` is ignored.
fn current_user_avatar(user: &Value) -> Option<String> {
    [
        "img_src",
        "imgsrc",
        "avatar",
        "avatar_url",
        "head",
        "user_avatar",
    ]
    .iter()
    .find_map(|key| user.get(*key).and_then(Value::as_str))
    .and_then(normalize_avatar_url)
}

fn normalize_avatar_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    let url = if let Some(rest) = raw.strip_prefix("//") {
        format!("https://{rest}")
    } else if raw.starts_with("https://") || raw.starts_with("http://") {
        raw.to_string()
    } else if raw.starts_with('/') {
        format!("https://www.tapd.cn{raw}")
    } else {
        return None;
    };

    Some(url)
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
) -> Result<String, String> {
    let captures = snapshot_captures(&app).await?;
    let names = format!(
        "capture-{}-{}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        captures.len()
    );
    let path = state.paths.captures_dir.join(names);
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

    let selected = match target {
        Some(target) if !target.trim().is_empty() => target,
        _ => {
            let open_with = state.config.lock().expect("config lock").open_with.clone();
            open_with::selected_target("directory", &open_with)
        }
    };

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
            let selected = match target {
                Some(target) if !target.trim().is_empty() => target,
                _ => {
                    let open_with = state.config.lock().expect("config lock").open_with.clone();
                    open_with::selected_target(kind, &open_with)
                }
            };

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

/// Opens a downloaded file with the selected target app (or the system default).
fn open_local(path: &std::path::Path, target: &str) -> Result<(), String> {
    let path = path.to_string_lossy().to_string();
    if target == open_with::SYSTEM_TARGET {
        return run_open(&[path.as_str()]);
    }

    let app =
        open_with::app_path_for(target).ok_or_else(|| format!("找不到要使用的应用：{target}"))?;
    run_open(&["-a", &app.to_string_lossy(), path.as_str()])
}

/// Runs `open` and waits for it, so a bad app path surfaces as an error instead
/// of silently doing nothing.
fn run_open(args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .args(args)
        .status()
        .map_err(|error| format!("启动打开命令失败：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("打开失败（open 退出码 {status}）"))
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

/// Downloads into `media-cache`, reusing a previous download for the same URL.
async fn download_media(
    app: &AppHandle,
    paths: &tapd_core::paths::AppPaths,
    url: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = paths.data_dir.join("media-cache");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let name = format!(
        "{:016x}-{}",
        media::fnv1a(url.as_bytes()),
        media_filename(url)
    );
    let path = dir.join(&name);
    if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 0) {
        return Ok(path);
    }

    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| "会话窗口尚未创建".to_string())?;
    let cookie = session::cookie_header(&window)?;

    let response = reqwest::Client::builder()
        .user_agent(media::USER_AGENT)
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| error.to_string())?
        .get(url)
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::REFERER, media::REFERER)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载失败（HTTP {status}）"));
    }
    if response.content_length().unwrap_or(0) > media::MAX_FILE_BYTES {
        return Err("文件超过 300MB，已跳过".to_string());
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() as u64 > media::MAX_FILE_BYTES {
        return Err("文件超过 300MB，已跳过".to_string());
    }
    if media::content_type_is_html(&content_type) && !bytes.starts_with(b"\x89PNG") {
        return Err(format!("下载被拒绝（{content_type}）"));
    }

    // `MediaKind::File` keeps the old cache-name behavior: an unknown content
    // type does not invent an extension.
    let name = media::with_extension(&name, &content_type, MediaKind::File);
    let path = dir.join(name);
    std::fs::write(&path, &bytes).map_err(|error| error.to_string())?;
    Ok(path)
}

fn media_filename(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let raw = path.rsplit('/').next().unwrap_or_default();
    let cleaned: String = raw
        .chars()
        .filter(|character| character.is_alphanumeric() || matches!(character, '.' | '-' | '_'))
        .take(90)
        .collect();
    let cleaned = cleaned.trim_matches(['.', '-', '_']).to_string();
    if cleaned.is_empty() {
        "media".to_string()
    } else {
        cleaned
    }
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

/// Accepts any `tapd.cn` host, so avatars served from `viper.tapd.cn` are
/// proxied with the session cookie just like captures and attachments.
pub(crate) fn is_tapd_media_url(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    else {
        return false;
    };

    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default()
        .trim_start_matches('.')
        .to_ascii_lowercase();

    host == "tapd.cn" || host.ends_with(".tapd.cn")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allows_tapd_media_urls() {
        assert!(is_tapd_media_url(
            "https://www.tapd.cn/tfl/captures/2026-11/a.png"
        ));
        assert!(is_tapd_media_url(
            "https://file.tapd.cn/1/attachments/download/2/a.png"
        ));
        assert!(is_tapd_media_url("https://viper.tapd.cn/user_logo/123.jpg"));
        assert!(is_tapd_media_url("http://tapd.cn/a.png"));
        assert!(!is_tapd_media_url("https://evil.example.com/a.png"));
        assert!(!is_tapd_media_url("https://tapd.cn.evil.example/a.png"));
        assert!(!is_tapd_media_url("file:///etc/passwd"));
    }

    #[test]
    fn resolves_current_user_avatar_urls() {
        let user = serde_json::json!({
            "img_src": "/users/avatar/2015551610/abc.png",
        });
        assert_eq!(
            current_user_avatar(&user).as_deref(),
            Some("https://www.tapd.cn/users/avatar/2015551610/abc.png")
        );

        let user = serde_json::json!({
            "img_src": "//viper.tapd.cn/user_logo/2015551610.jpg",
        });
        assert_eq!(
            current_user_avatar(&user).as_deref(),
            Some("https://viper.tapd.cn/user_logo/2015551610.jpg")
        );

        let user = serde_json::json!({ "imgsrc": "https://wework.qpic.cn/a.png" });
        assert_eq!(
            current_user_avatar(&user).as_deref(),
            Some("https://wework.qpic.cn/a.png")
        );

        assert!(current_user_avatar(&serde_json::json!({})).is_none());
        assert!(current_user_avatar(&serde_json::json!({ "img_src": "" })).is_none());
    }

    #[test]
    fn builds_stable_cache_names() {
        assert_eq!(media::fnv1a(b"abc"), media::fnv1a(b"abc"));
        assert_ne!(media::fnv1a(b"abc"), media::fnv1a(b"abd"));
        assert_eq!(
            media_filename("https://file.tapd.cn/1/attachments/download/2/log.ips?x=1"),
            "log.ips"
        );
        assert_eq!(media_filename("https://www.tapd.cn/"), "media");
        assert_eq!(media_filename("https://www.tapd.cn/a/../b"), "b");
    }
}
