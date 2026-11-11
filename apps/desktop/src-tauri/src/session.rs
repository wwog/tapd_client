use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::{notification, state::SharedState};

pub const SESSION_LABEL: &str = "tapd-session";

/// While a logout is running, the URL watcher must not resurrect `loggedIn`
/// from the still-loaded TAPD page (navigation happens asynchronously).
static LOGOUT_GUARD_UNTIL: AtomicU64 = AtomicU64::new(0);

/// Throttles navigating a logged-out webview away from TAPD's marketing home.
static LOGIN_BOUNCE_UNTIL: AtomicU64 = AtomicU64::new(0);

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Suppresses session auto-detection for `millis`, so a logout does not flip
/// straight back to "logged in" before TAPD lands on the login page.
pub fn begin_logout_guard(millis: u64) {
    LOGOUT_GUARD_UNTIL.store(now_millis() + millis, Ordering::SeqCst);
}

fn logout_in_progress() -> bool {
    now_millis() < LOGOUT_GUARD_UNTIL.load(Ordering::SeqCst)
}
pub const TAPD_HOME: &str = "https://www.tapd.cn/";
/// Server-rendered login page. TAPD's marketing home does not redirect logged
/// out visitors here, so the hidden webview must open it directly.
pub const TAPD_LOGIN: &str = "https://www.tapd.cn/cloud_logins/login?";

/// True for the marketing home (`tapd.cn/`), which is not a login page.
pub fn is_bare_tapd_home(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    let Some((_, rest)) = lower.split_once("tapd.cn") else {
        return false;
    };
    let path = rest.split(['?', '#']).next().unwrap_or("");
    path.is_empty() || path == "/"
}

/// TAPD redirects into a workspace shell after a successful login.
pub fn is_logged_in_url(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    if !lower.contains("tapd.cn") || looks_like_auth_page(&lower) {
        return false;
    }

    let Some((_, rest)) = lower.split_once("tapd.cn") else {
        return false;
    };
    let path = rest.trim_start_matches('/');
    if path.is_empty() {
        return false;
    }
    let path = path.split(['?', '#']).next().unwrap_or("");

    if path.starts_with("tapd_fe/")
        || path.starts_with("my_work")
        || path.starts_with("company/")
        || path.starts_with("dashboard")
    {
        return true;
    }

    // Workspace-scoped pages start with the numeric workspace id.
    let first = path.split('/').next().unwrap_or("");
    !first.is_empty() && first.chars().all(|c| c.is_ascii_digit())
}

pub fn looks_like_auth_page(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    lower.contains("/login")
        || lower.contains("/signin")
        || lower.contains("cloud_logins")
        || lower.contains("/register")
}

/// The actual TAPD login form (not an OAuth callback). Reaching it means the
/// logout cleanup finished navigating, so the logout guard can be released.
pub fn is_login_form_url(raw: &str) -> bool {
    raw.to_ascii_lowercase().contains("/cloud_logins/login")
}

/// Decides whether the session watcher must re-evaluate a URL.
///
/// An unchanged URL is normally skipped to avoid rewriting the config every
/// tick. Two cases must still be evaluated: while the logout guard is active
/// (a login may finish inside it), the first tick after it expires (that login
/// was suppressed and must not be lost), and a blank page (a failed logout
/// navigation needs to be repaired).
fn should_evaluate(url: &str, last_url: &str, guarded: bool, was_guarded: bool) -> bool {
    let blank = url.is_empty() || url == "about:blank";
    url != last_url || guarded || was_guarded || blank
}

/// Creates (or reveals) the TAPD webview used both for login and as the data bridge.
pub fn ensure_session_window(
    app: &AppHandle,
    state: &SharedState,
    visible: bool,
) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(SESSION_LABEL) {
        if visible {
            let _ = window.show();
            let _ = window.set_focus();
        } else {
            let _ = window.hide();
        }
        return Ok(window);
    }

    let logged_in = {
        let config = state.config.lock().expect("config lock");
        config.logged_in
    };
    let target = if logged_in { TAPD_HOME } else { TAPD_LOGIN };
    let url = tauri::Url::parse(target).map_err(|e| e.to_string())?;

    let window = WebviewWindowBuilder::new(app, SESSION_LABEL, WebviewUrl::External(url))
        .title("登录 TAPD")
        .inner_size(1120.0, 760.0)
        .min_inner_size(900.0, 600.0)
        .center()
        .visible(visible)
        .devtools(cfg!(debug_assertions))
        .initialization_script_for_all_frames(include_str!("inject.js"))
        .build()
        .map_err(|e| e.to_string())?;

    // Closing the TAPD window should keep the session alive in the background.
    let window_for_event = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_for_event.hide();
        }
    });

    Ok(window)
}

/// Builds a Cookie header for direct asset downloads from `file.tapd.cn`.
pub fn cookie_header(window: &WebviewWindow) -> Result<String, String> {
    let cookies = window.cookies().map_err(|error| error.to_string())?;
    let mut pairs = Vec::new();

    for cookie in cookies {
        let domain = cookie
            .domain()
            .unwrap_or_default()
            .trim_start_matches('.')
            .to_ascii_lowercase();
        if domain == "tapd.cn" || domain.ends_with(".tapd.cn") {
            pairs.push(format!("{}={}", cookie.name(), cookie.value()));
        }
    }

    if pairs.is_empty() {
        Err("没有可用的 TAPD 会话 Cookie".to_string())
    } else {
        Ok(pairs.join("; "))
    }
}

/// Returns a single cookie value (for example the `dsc-token` used by writes).
pub fn cookie_value(window: &WebviewWindow, name: &str) -> Option<String> {
    window
        .cookies()
        .ok()?
        .into_iter()
        .find(|cookie| cookie.name() == name)
        .map(|cookie| cookie.value().to_string())
}

/// Watches the session webview URL and keeps `loggedIn` in sync.
pub fn spawn_session_watcher(app: AppHandle, state: SharedState) {
    tauri::async_runtime::spawn(async move {
        let mut last_url = String::new();
        let mut was_guarded = false;

        loop {
            tokio::time::sleep(Duration::from_millis(1200)).await;

            let Some(window) = app.get_webview_window(SESSION_LABEL) else {
                continue;
            };
            let Ok(url) = window.url() else {
                continue;
            };
            let url_string = url.to_string();
            let guarded = logout_in_progress();
            let blank = url_string.is_empty() || url_string == "about:blank";

            if !should_evaluate(&url_string, &last_url, guarded, was_guarded) {
                continue;
            }
            was_guarded = guarded;
            last_url = url_string.clone();

            let logged_in = is_logged_in_url(&url_string);
            let auth_page = looks_like_auth_page(&url_string);
            let login_form = is_login_form_url(&url_string);

            let mut login_changed = false;
            let mut expired = false;
            let mut open_login = false;
            let mut guard_done = false;
            let persisted = state.update_config(|config| {
                if !blank {
                    config.last_session_url = Some(url_string.clone());
                }

                // A logout just cleared cookies and is still navigating: don't
                // read the old page as a fresh login and flip the state back.
                let suppress_login = guarded && !config.logged_in;

                if !suppress_login && logged_in && !config.logged_in {
                    config.logged_in = true;
                    login_changed = true;
                } else if !logged_in && config.logged_in && auth_page {
                    // The session expired and TAPD bounced us to the login page.
                    // The login screen picks it up from the hidden webview; the
                    // window itself must never pop up on its own.
                    config.logged_in = false;
                    config.me = None;
                    config.me_avatar = None;
                    login_changed = true;
                    expired = true;
                }

                // The real login form is on screen, so the logout navigation
                // has finished: release the guard and let the next scan log in
                // immediately instead of being ignored for the whole window.
                if guarded && !config.logged_in && login_form {
                    guard_done = true;
                }

                // TAPD's marketing home (or a blank document left behind by a
                // failed logout navigation) never turns into the login form on
                // its own, which would leave the hidden webview stuck there.
                if !suppress_login && !config.logged_in && (is_bare_tapd_home(&url_string) || blank)
                {
                    open_login = true;
                }
            });
            if let Err(error) = persisted {
                tracing::warn!(%error, "failed to persist session state");
            }

            if guard_done {
                LOGOUT_GUARD_UNTIL.store(0, Ordering::SeqCst);
            }

            if open_login && now_millis() > LOGIN_BOUNCE_UNTIL.load(Ordering::SeqCst) {
                LOGIN_BOUNCE_UNTIL.store(now_millis() + 5000, Ordering::SeqCst);
                if let Ok(login) = tauri::Url::parse(TAPD_LOGIN) {
                    let _ = window.navigate(login);
                }
            }

            if expired {
                // Cached projects/bugs belong to the session that just ended.
                if let Err(error) = state.cache.clear() {
                    tracing::warn!(%error, "failed to clear offline cache after session expiry");
                }
                notification::reset_session();
            }

            if login_changed {
                if !expired {
                    // A real login starts a fresh notification baseline: only
                    // changes after the first round may notify.
                    notification::reset_session();
                }
                // The background window never pops up on its own: the login
                // screen mirrors the QR code and the successful login hides it.
                let _ = window.hide();
                let _ = app.emit("session://changed", ());
            }
        }
    });
}


/// Evaluates a synchronous expression and returns its JSON value.
///
/// Uses the native evaluation callback, which does not depend on remote IPC.
pub async fn eval_sync_json(
    window: &WebviewWindow,
    expression: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let mut last_error = String::new();

    for attempt in 0..3 {
        match eval_sync_once(window, expression, timeout).await {
            Ok(value) => return Ok(value),
            Err(error) => {
                let retryable = error.contains("callback dropped")
                    || error.contains("timed out")
                    || error.contains("empty bridge payload");
                last_error = error;
                if !retryable || attempt == 2 {
                    break;
                }
                // The hidden webview may still be navigating after startup/login.
                tokio::time::sleep(Duration::from_millis(350)).await;
            }
        }
    }

    Err(last_error)
}

/// Evaluates a synchronous expression exactly once.
///
/// Polling callers (the login screen) would otherwise stall for the full
/// timeout on every retry while the page is navigating.
pub async fn eval_sync_json_once(
    window: &WebviewWindow,
    expression: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    eval_sync_once(window, expression, timeout).await
}

async fn eval_sync_once(
    window: &WebviewWindow,
    expression: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    let sender = Mutex::new(Some(sender));
    let script = format!("JSON.stringify(({expression}))");

    window
        .eval_with_callback(script, move |raw| {
            if let Some(sender) = sender.lock().expect("callback lock").take() {
                let _ = sender.send(raw);
            }
        })
        .map_err(|e| e.to_string())?;

    let raw = tokio::time::timeout(timeout, receiver)
        .await
        .map_err(|_| format!("webview evaluation timed out after {}s", timeout.as_secs()))?
        .map_err(|_| "webview evaluation callback dropped".to_string())?;

    parse_bridge_payload(&raw)
}

/// Evaluates an async expression.
///
/// Remote pages are not granted access to application IPC commands, and
/// `eval_with_callback` does not await promises, so the expression runs in an
/// async IIFE that stores its result in a global bucket. Rust polls that bucket
/// through the native evaluation channel (no ACL involved).
pub async fn eval_async_json(
    window: &WebviewWindow,
    expression: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let start_script = format!(
        r#"
(function () {{
  var bucket = window.__TAPDCB_RESULTS__ || (window.__TAPDCB_RESULTS__ = {{}});
  var key = "{token}";
  bucket[key] = {{ state: "pending", at: Date.now() }};
  (async function () {{
    try {{
      var value = await ({expression});
      bucket[key] = {{ state: "ok", value: value === undefined ? null : value, at: Date.now() }};
    }} catch (error) {{
      bucket[key] = {{ state: "error", message: String((error && error.stack) || error), at: Date.now() }};
    }}
  }})();
  return {{ started: true }};
}})()
"#
    );

    let _ = eval_sync_json(window, &start_script, Duration::from_secs(5)).await?;

    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if tokio::time::Instant::now() >= deadline {
            cleanup_result(window, &token).await;
            return Err(format!(
                "webview async evaluation timed out after {}s",
                timeout.as_secs()
            ));
        }

        tokio::time::sleep(Duration::from_millis(120)).await;

        let read_script = format!(
            r#"(function () {{
  try {{
    var bucket = window.__TAPDCB_RESULTS__;
    return bucket ? bucket["{token}"] : null;
  }} catch (error) {{
    return {{ state: "error", message: String(error) }};
  }}
}})()"#
        );

        match eval_sync_json(window, &read_script, Duration::from_secs(3)).await {
            Ok(serde_json::Value::Null) => continue,
            Ok(value) => {
                let state = value.get("state").and_then(|state| state.as_str()).unwrap_or("");
                if state == "ok" {
                    let result = value.get("value").cloned().unwrap_or(serde_json::Value::Null);
                    cleanup_result(window, &token).await;
                    return Ok(result);
                }
                if state == "error" {
                    let message = value
                        .get("message")
                        .and_then(|message| message.as_str())
                        .unwrap_or("unknown async bridge error")
                        .to_string();
                    cleanup_result(window, &token).await;
                    return Err(message);
                }
            }
            Err(error) => return Err(error),
        }
    }
}

async fn cleanup_result(window: &WebviewWindow, token: &str) {
    let script = format!(
        r#"(function () {{
  try {{ delete window.__TAPDCB_RESULTS__["{token}"]; }} catch (error) {{}}
  return true;
}})()"#
    );
    let _ = eval_sync_json(window, &script, Duration::from_secs(2)).await;
}

fn parse_bridge_payload(raw: &str) -> Result<serde_json::Value, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty bridge payload (webview evaluation failed)".to_string());
    }

    let value: serde_json::Value = serde_json::from_str(trimmed).map_err(|error| {
        let preview: String = trimmed.chars().take(180).collect();
        format!("invalid bridge payload: {error}; raw={preview}")
    })?;

    // `eval_with_callback` may JSON-encode the returned string a second time.
    if let serde_json::Value::String(inner) = &value {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(inner) {
            return Ok(parsed);
        }
    }

    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::{is_login_form_url, should_evaluate};

    #[test]
    fn reevaluates_once_after_the_logout_guard_expires() {
        let url = "https://www.tapd.cn/tapd_fe/my/work";
        // Same URL, no guard: skipped on purpose.
        assert!(!should_evaluate(url, url, false, false));
        // Same URL right after the guard ended: the suppressed login must be
        // picked up instead of staying logged out forever.
        assert!(should_evaluate(url, url, false, true));
        // While the guard is active the URL is re-checked every tick.
        assert!(should_evaluate(url, url, true, true));
    }

    #[test]
    fn reevaluates_changed_and_blank_urls() {
        let login = "https://www.tapd.cn/cloud_logins/login?";
        assert!(should_evaluate(login, "about:blank", false, false));
        assert!(should_evaluate("about:blank", "about:blank", false, false));
        assert!(should_evaluate("", "", false, false));
    }

    #[test]
    fn detects_the_real_login_form_only() {
        assert!(is_login_form_url("https://www.tapd.cn/cloud_logins/login?"));
        assert!(is_login_form_url(
            "https://www.tapd.cn/cloud_logins/login?redirect_url=https%3A%2F%2Fwww.tapd.cn%2F"
        ));
        // OAuth callbacks are part of an in-flight login, not the form.
        assert!(!is_login_form_url("https://www.tapd.cn/tapd_fe/my/work"));
        assert!(!is_login_form_url(
            "https://www.tapd.cn/cloud_logins/wework_callback"
        ));
    }
}
