//! Debug-only bridge into the application's own UI window (`main`).
//!
//! `/dev/eval` and `/dev/call` evaluate inside the hidden TAPD session webview,
//! which is the right place for mapping TAPD's internal API but useless for
//! checking the app UI. These routes do the same thing against the `main`
//! window and can also write a PNG of it, so an agent can inspect, click and
//! verify the real interface over loopback HTTP instead of driving macOS
//! through computer use.
//!
//! Only compiled into debug builds.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

use super::{authorized, unauthorized, ApiState};

const MAIN_LABEL: &str = "main";

/// Default screenshot width in CSS-independent pixels. Retina captures are
/// twice that, which costs the reader nothing but a lot of image tokens, so the
/// long edge is scaled down unless the caller asks otherwise.
#[cfg(target_os = "macos")]
const DEFAULT_MAX_WIDTH: u32 = 1280;

/// How many screenshots to keep around in `<data>/screenshots/`.
#[cfg(target_os = "macos")]
const KEEP_SCREENSHOTS: usize = 50;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UiEvalRequest {
    expression: String,
    #[serde(default = "default_eval_timeout")]
    timeout_secs: u64,
    /// Window label, defaults to `main`.
    #[serde(default)]
    label: Option<String>,
    /// Report console output captured since the last `/dev/ui/console` call.
    #[serde(default)]
    with_console: bool,
}

fn default_eval_timeout() -> u64 {
    15
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnapshotRequest {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    max_width: Option<u32>,
    /// Absolute path to write; defaults to `<data>/screenshots/ui-<n>.png`.
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UiQuery {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    max_width: Option<u32>,
}

/// Evaluates a synchronous expression in the app UI and returns its JSON value.
pub(super) async fn dev_ui_eval(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<UiEvalRequest>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let Some(window) = ui_window(&ctx.app, request.label.as_deref()) else {
        return missing_window(request.label.as_deref());
    };
    let _ = ensure_console_hook(&window).await;

    let timeout = Duration::from_secs(request.timeout_secs.clamp(1, 60));
    match crate::session::eval_sync_json(&window, &request.expression, timeout).await {
        Ok(value) => {
            let console = if request.with_console {
                console_entries(&window)
                    .await
                    .unwrap_or(Value::Array(Vec::new()))
            } else {
                Value::Null
            };
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "value": value, "console": console })),
            )
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Same as [`dev_ui_eval`], but awaits promises (`click`, `fetch`, IPC calls).
pub(super) async fn dev_ui_call(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<UiEvalRequest>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let Some(window) = ui_window(&ctx.app, request.label.as_deref()) else {
        return missing_window(request.label.as_deref());
    };
    let _ = ensure_console_hook(&window).await;

    let timeout = Duration::from_secs(request.timeout_secs.clamp(1, 60));
    match crate::session::eval_async_json(&window, &request.expression, timeout).await {
        Ok(value) => {
            let console = if request.with_console {
                console_entries(&window)
                    .await
                    .unwrap_or(Value::Array(Vec::new()))
            } else {
                Value::Null
            };
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "value": value, "console": console })),
            )
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Console output (and uncaught errors) collected since the previous call.
///
/// The frontend is ours, so a debug-only console tap is safe and makes UI
/// failures inspectable without opening devtools.
pub(super) async fn dev_ui_console(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<UiQuery>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let Some(window) = ui_window(&ctx.app, query.label.as_deref()) else {
        return missing_window(query.label.as_deref());
    };
    let _ = ensure_console_hook(&window).await;

    match console_entries(&window).await {
        Ok(entries) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "value": entries })),
        ),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Captures the UI window to a PNG file and returns its path and size.
pub(super) async fn dev_ui_snapshot(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<SnapshotRequest>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let label = request.label.unwrap_or_else(|| MAIN_LABEL.to_string());
    let target = match request.path {
        Some(path) => PathBuf::from(path),
        None => match default_snapshot_path(&ctx, &label) {
            Ok(path) => path,
            Err(error) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "ok": false, "error": error })),
                )
            }
        },
    };

    match capture(&ctx.app, &label, request.max_width, &target).await {
        Ok(info) => (StatusCode::OK, Json(json!({ "ok": true, "data": info }))),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Same capture, returned as image bytes so the caller can also open it in a
/// browser (`GET /dev/ui/snapshot.png?maxWidth=900`).
pub(super) async fn dev_ui_snapshot_png(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<UiQuery>,
) -> Response {
    if !authorized(&ctx.state, &headers) {
        return unauthorized().into_response();
    }
    let label = query.label.unwrap_or_else(|| MAIN_LABEL.to_string());
    let target = match default_snapshot_path(&ctx, &label) {
        Ok(path) => path,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": error })),
            )
                .into_response()
        }
    };

    match capture(&ctx.app, &label, query.max_width, &target).await {
        Ok(_) => match tokio::fs::read(&target).await {
            Ok(bytes) => {
                (StatusCode::OK, [(header::CONTENT_TYPE, "image/png")], bytes).into_response()
            }
            Err(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": error.to_string() })),
            )
                .into_response(),
        },
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

fn ui_window(app: &AppHandle, label: Option<&str>) -> Option<WebviewWindow> {
    app.get_webview_window(label.unwrap_or(MAIN_LABEL))
}

fn missing_window(label: Option<&str>) -> (StatusCode, Json<Value>) {
    let label = label.unwrap_or(MAIN_LABEL);
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "ok": false, "error": format!("window {label} is not open") })),
    )
}

fn default_snapshot_path(ctx: &ApiState, label: &str) -> Result<PathBuf, String> {
    let dir = ctx.state.paths.data_dir.join("screenshots");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f");
    let safe_label: String = label
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    Ok(dir.join(format!("{safe_label}-{stamp}.png")))
}

/// Captures `label` into `target`, scaling the long edge down to `max_width`.
async fn capture(
    app: &AppHandle,
    label: &str,
    max_width: Option<u32>,
    target: &Path,
) -> Result<Value, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, label, max_width, target);
        Err("screenshots are only implemented on macOS".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        let number = window_number(app, label).await?;
        let target = target.to_path_buf();
        let max_width = max_width.unwrap_or(DEFAULT_MAX_WIDTH);
        let path = target.clone();

        // `screencapture` and `sips` are blocking; keep them off the async
        // runtime.
        let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
            screencapture(number, &path)?;
            if max_width > 0 {
                downscale(&path, max_width)?;
            }
            std::fs::read(&path).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())??;

        prune_screenshots(target.parent());
        let (width, height) = png_size(&bytes).unwrap_or((0, 0));
        Ok(json!({
            "path": target.to_string_lossy(),
            "width": width,
            "height": height,
            "bytes": bytes.len(),
        }))
    }
}

/// Reads the window number AppKit uses, which is what `screencapture -l` wants.
///
/// AppKit window access is main-thread only, so the lookup is hopped onto the
/// main thread and the (short) capture runs on the blocking pool afterwards.
#[cfg(target_os = "macos")]
async fn window_number(app: &AppHandle, label: &str) -> Result<i64, String> {
    use objc2_app_kit::NSWindow;

    let Some(window) = app.get_webview_window(label) else {
        return Err(format!("window {label} is not open"));
    };
    if !window.is_visible().unwrap_or(false) {
        return Err(format!(
            "window {label} is not visible (minimized or hidden), nothing to capture"
        ));
    }

    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<i64, String>>();
    app.run_on_main_thread(move || {
        let result = (|| {
            let pointer = window.ns_window().map_err(|error| error.to_string())?;
            // SAFETY: `ns_window` hands out the live AppKit window for a window
            // that is still alive; only an integer is read from it.
            let ns_window = unsafe { &*(pointer as *const NSWindow) };
            let number = ns_window.windowNumber();
            if number <= 0 {
                return Err("window has no backing window number".to_string());
            }
            Ok(number as i64)
        })();
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;

    receiver.await.map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
fn screencapture(number: i64, target: &Path) -> Result<(), String> {
    let output = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-x") // no shutter sound
        .arg("-o") // no window shadow
        .arg("-t")
        .arg("png")
        .arg("-l")
        .arg(number.to_string())
        .arg(target)
        .output()
        .map_err(|error| format!("screencapture failed to start: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("screencapture failed: {stderr}"));
    }
    if !target.exists() {
        return Err("screencapture produced no file (screen recording permission?)".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn downscale(target: &Path, max_width: u32) -> Result<(), String> {
    let output = std::process::Command::new("/usr/bin/sips")
        .arg("-Z")
        .arg(max_width.to_string())
        .arg(target)
        .output()
        .map_err(|error| format!("sips failed to start: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("sips failed: {stderr}"));
    }
    Ok(())
}

/// Keeps `<data>/screenshots/` bounded; old captures are worthless.
#[cfg(target_os = "macos")]
fn prune_screenshots(dir: Option<&Path>) {
    let Some(dir) = dir else { return };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("png") {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect();
    if files.len() <= KEEP_SCREENSHOTS {
        return;
    }
    files.sort_by_key(|(modified, _)| *modified);
    for (_, path) in files.iter().take(files.len() - KEEP_SCREENSHOTS) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(target_os = "macos")]
fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[0..8] != SIGNATURE {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

/// Installs a console/error tap once per page load.
async fn ensure_console_hook(window: &WebviewWindow) -> Result<(), String> {
    let expression = r#"(function () {
  if (window.__TAPDC_DEV_CONSOLE__) return { installed: false };
  var buffer = (window.__TAPDC_DEV_CONSOLE__ = []);
  var limit = 200;
  function push(level, args) {
    try {
      var text = Array.prototype.map.call(args, function (item) {
        if (item instanceof Error) return String(item.stack || item);
        if (typeof item === 'string') return item;
        try { return JSON.stringify(item); } catch (error) { return String(item); }
      }).join(' ');
      buffer.push({ level: level, text: text, at: Date.now() });
      if (buffer.length > limit) buffer.shift();
    } catch (error) {}
  }
  ['log', 'info', 'warn', 'error'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      push(level, arguments);
      return original.apply(console, arguments);
    };
  });
  window.addEventListener('error', function (event) {
    push('uncaught', [String(event.message), (event.filename || '') + ':' + (event.lineno || 0)]);
  });
  window.addEventListener('unhandledrejection', function (event) {
    push('unhandled', [String((event.reason && event.reason.stack) || event.reason)]);
  });
  return { installed: true };
})()"#;
    crate::session::eval_sync_json(window, expression, Duration::from_secs(5))
        .await
        .map(|_| ())
}

/// Drains the console buffer so repeated calls only report new output.
async fn console_entries(window: &WebviewWindow) -> Result<Value, String> {
    let expression = r#"(function () {
  var buffer = window.__TAPDC_DEV_CONSOLE__ || [];
  window.__TAPDC_DEV_CONSOLE__ = [];
  return buffer;
})()"#;
    crate::session::eval_sync_json(window, expression, Duration::from_secs(5)).await
}
