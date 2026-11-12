//! Debug-only escape hatches for mapping TAPD's internal API. This module is
//! only compiled into debug builds and never ships in a release binary.

use std::time::Duration;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;

use super::{authorized, unauthorized, ApiState};
use crate::session;

#[derive(Deserialize)]
pub(super) struct FeatureRequest {
    name: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Deserialize)]
pub(super) struct ExportRequest {
    workspace_id: String,
    bug_id: String,
    #[serde(default)]
    workspace_name: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct EvalRequest {
    expression: String,
    #[serde(default = "default_eval_timeout")]
    timeout_secs: u64,
}

fn default_eval_timeout() -> u64 {
    15
}

/// Token-protected entry point for testing feature commands without the UI.
pub(super) async fn dev_feature(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<FeatureRequest>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }

    match crate::feature_router::dispatch(&ctx.app, &ctx.state, &request.name, request.payload).await
    {
        Ok(value) => (StatusCode::OK, Json(json!({ "ok": true, "data": value }))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Runs the same export pipeline used by the desktop UI.
pub(super) async fn dev_export(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<ExportRequest>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }

    let paths = ctx.state.paths.clone();
    match crate::export::run_export(
        &ctx.app,
        &paths,
        &request.workspace_id,
        &request.bug_id,
        request.workspace_name,
        Some(crate::export::PromptOptions::default()),
    )
    .await
    {
        Ok(result) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "result": result })),
        ),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Returns the webview's cookie jar (including HttpOnly) for diagnostics.
/// Values are only exposed over the token-protected loopback endpoint.
pub(super) async fn dev_cookies(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let Some(window) = ctx.app.get_webview_window(session::SESSION_LABEL) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "session_window_missing" })),
        );
    };

    match window.cookies() {
        Ok(cookies) => {
            let list: Vec<Value> = cookies
                .iter()
                .map(|cookie| {
                    json!({
                        "name": cookie.name(),
                        "value": cookie.value(),
                        "domain": cookie.domain(),
                        "path": cookie.path(),
                        "secure": cookie.secure(),
                        "httpOnly": cookie.http_only(),
                    })
                })
                .collect();
            (StatusCode::OK, Json(json!({ "ok": true, "cookies": list })))
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error.to_string() })),
        ),
    }
}

/// Token-protected escape hatch used while mapping TAPD's internal API.
pub(super) async fn dev_eval(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<EvalRequest>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let Some(window) = ctx.app.get_webview_window(session::SESSION_LABEL) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "session_window_missing" })),
        );
    };

    let timeout = Duration::from_secs(request.timeout_secs.clamp(1, 60));
    match session::eval_sync_json(&window, &request.expression, timeout).await {
        Ok(value) => (StatusCode::OK, Json(json!({ "ok": true, "value": value }))),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Same as `/dev/eval`, but resolves through the injected IPC callback.
pub(super) async fn dev_call(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<EvalRequest>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let Some(window) = ctx.app.get_webview_window(session::SESSION_LABEL) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "session_window_missing" })),
        );
    };

    let timeout = Duration::from_secs(request.timeout_secs.clamp(1, 60));
    match session::eval_async_json(&window, &request.expression, timeout).await {
        Ok(value) => (StatusCode::OK, Json(json!({ "ok": true, "value": value }))),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Companion runtime snapshot for dev tooling: server port, LAN IP and the
/// current one-time pairing code, so tests can drive the companion without
/// clicking the settings card.
pub(super) async fn dev_companion(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    let runtime = ctx.state.companion.lock().expect("companion lock");
    let pairing = runtime.pairing.as_ref().map(|pairing| {
        json!({ "code": pairing.code, "expiresAt": pairing.expires_at.to_rfc3339() })
    });
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "data": {
                "enabled": ctx.state.config_snapshot().companion.enabled,
                "running": runtime.task.is_some(),
                "port": runtime.port,
                "lanIp": crate::companion::lan_ipv4().map(|ip| ip.to_string()),
                "pairing": pairing,
            }
        })),
    )
}

/// Generates a fresh one-time pairing code (same path as the settings card).
pub(super) async fn dev_companion_pairing(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }
    match crate::companion::pairing_code(&ctx.state) {
        Ok(info) => (StatusCode::OK, Json(json!({ "ok": true, "data": info }))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}
