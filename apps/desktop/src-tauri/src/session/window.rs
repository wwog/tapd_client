//! Creation and cookie access for the TAPD session webview.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::{SESSION_LABEL, TAPD_HOME, TAPD_LOGIN};
use crate::state::SharedState;

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
        .initialization_script_for_all_frames(include_str!("../inject.js"))
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
