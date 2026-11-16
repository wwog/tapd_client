//! TAPD session plumbing for the command layer: authenticated requests through
//! the hidden webview, the login/logout lifecycle, and the signed-in identity.

use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use serde_json::Value;
use tapd_core::bridge::BridgeHttpResult;
use tapd_i18n::{tr, tr_args};
use tauri::{AppHandle, Emitter, Manager};

use crate::{notification, session, state::SharedState};

pub(super) fn is_logged_in(state: &SharedState) -> bool {
    state.config.lock().expect("config lock").logged_in
}

/// Clears the TAPD session in config, cache, cookies and the hidden webview.
///
/// Shared by the explicit "退出登录" action and automatic expiry detection, so
/// both paths leave the app on the login screen with no stale identity left.
pub(super) async fn logout_session(app: &AppHandle, state: &SharedState, reason: &str) {
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
pub(super) async fn reset_session_and_open_login(window: &tauri::WebviewWindow) {
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
    head.contains("wwlogin") || head.contains("<title>登录") || head.contains("<title>企业微信") // i18n-exempt: HTML parse token
}

/// Guards against several in-flight requests all clearing the session at once.
static EXPIRING: AtomicBool = AtomicBool::new(false);

/// Signs out once when an authenticated TAPD call reports an expired session.
async fn expire_session(app: &AppHandle) {
    let Some(state) = app.try_state::<SharedState>() else {
        return;
    };
    if !is_logged_in(state.inner()) || EXPIRING.swap(true, Ordering::SeqCst) {
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
pub(super) async fn session_request_text(
    app: &AppHandle,
    method: &str,
    url: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<BridgeHttpResult, String> {
    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| tr("app.session.retry").to_string())?;

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
        return Err(tr("app.session.expired").to_string());
    }

    if !http.ok {
        let preview: String = http.body.chars().take(240).collect();
        return Err(tr_args("app.request.failed",
            &[&http.status, &preview],
        ));
    }

    Ok(http)
}

pub(super) fn string_field(value: &Value, key: &str) -> String {
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
pub(super) fn current_user_avatar(user: &Value) -> Option<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
