use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tapd_core::runtime::RuntimeInfo;

use crate::{media, session, state::SharedState};

#[cfg(debug_assertions)]
#[derive(Deserialize)]
struct FeatureRequest {
    name: String,
    #[serde(default)]
    payload: Value,
}

#[cfg(debug_assertions)]
#[derive(Deserialize)]
struct ExportRequest {
    workspace_id: String,
    bug_id: String,
    #[serde(default)]
    workspace_name: Option<String>,
}

#[cfg(debug_assertions)]
#[derive(Deserialize)]
struct EvalRequest {
    expression: String,
    #[serde(default = "default_eval_timeout")]
    timeout_secs: u64,
}

#[cfg(debug_assertions)]
fn default_eval_timeout() -> u64 {
    15
}

#[derive(Clone)]
struct ApiState {
    app: AppHandle,
    state: SharedState,
}

/// Starts the loopback API consumed by the `tapd-mcp` sidecar and dev tooling.
pub async fn run(app: AppHandle, state: SharedState) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;

    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let media_token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let runtime = RuntimeInfo {
        app: "tapd-client".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
        port: address.port(),
        token,
        media_token,
        started_at: chrono::Utc::now().to_rfc3339(),
    };
    runtime
        .write(&state.paths.runtime_file)
        .map_err(|error| error.to_string())?;
    *state.runtime.lock().expect("runtime lock") = Some(runtime);

    tracing::info!(port = address.port(), "local API listening");

    let api_state = ApiState {
        app,
        state: state.clone(),
    };

    let router = Router::new()
        .route("/healthz", get(healthz))
        .route("/mcp/call", post(mcp_call))
        .route("/media", get(media_proxy));

    // Debug-only escape hatches for mapping TAPD's internal API. They never
    // ship in a release binary.
    #[cfg(debug_assertions)]
    let router = router
        .route("/dev/eval", post(dev_eval))
        .route("/dev/call", post(dev_call))
        .route("/dev/cookies", get(dev_cookies))
        .route("/dev/export", post(dev_export))
        .route("/dev/feature", post(dev_feature));

    let router = router.with_state(api_state);

    axum::serve(listener, router)
        .await
        .map_err(|error| error.to_string())
}

async fn healthz(State(state): State<ApiState>) -> impl IntoResponse {
    let logged_in = state.state.config.lock().expect("config lock").logged_in;
    let port = state.state.runtime_info().map(|runtime| runtime.port);

    Json(json!({
        "ok": true,
        "app": "tapd-client",
        "version": env!("CARGO_PKG_VERSION"),
        "pid": std::process::id(),
        "port": port,
        "loggedIn": logged_in,
    }))
}

async fn mcp_call(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }

    let tool = payload
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let arguments = payload
        .get("arguments")
        .cloned()
        .unwrap_or(Value::Null);
    let client = payload
        .get("client")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    match crate::mcp::handle(&ctx.app, &ctx.state, tool, &arguments, client).await {
        Ok(data) => (StatusCode::OK, Json(json!({ "ok": true, "data": data }))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Token-protected entry point for testing feature commands without the UI.
#[cfg(debug_assertions)]
async fn dev_feature(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Json(request): Json<FeatureRequest>,
) -> (StatusCode, Json<Value>) {
    if !authorized(&ctx.state, &headers) {
        return unauthorized();
    }

    match crate::feature_router::dispatch(
        &ctx.app,
        &ctx.state,
        &request.name,
        request.payload,
    )
    .await
    {
        Ok(value) => (StatusCode::OK, Json(json!({ "ok": true, "data": value }))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": error })),
        ),
    }
}

/// Runs the same export pipeline used by the desktop UI.
#[cfg(debug_assertions)]
async fn dev_export(
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
#[cfg(debug_assertions)]
async fn dev_cookies(
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
#[cfg(debug_assertions)]
async fn dev_eval(    State(ctx): State<ApiState>,
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
#[cfg(debug_assertions)]
async fn dev_call(
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

#[derive(Deserialize)]
struct MediaQuery {
    token: String,
    url: String,
}

/// Proxies TAPD-hosted images/videos with the session cookies so the main
/// window can render thumbnails and previews (`<img>`/`<video>` cannot send
/// the bearer token, hence the separate `media_token` query capability).
///
/// `Range` is forwarded and `206`/`Content-Range` are passed through, which is
/// what the video element needs to seek.
async fn media_proxy(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<MediaQuery>,
) -> Response {
    let Some(runtime) = ctx.state.runtime_info() else {
        return media_error(StatusCode::SERVICE_UNAVAILABLE, "runtime not ready");
    };
    if query.token.is_empty() || query.token != runtime.media_token {
        return media_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    if !crate::commands::is_tapd_media_url(&query.url) {
        return media_error(StatusCode::BAD_REQUEST, "unsupported media url");
    }

    let Some(window) = ctx.app.get_webview_window(session::SESSION_LABEL) else {
        return media_error(StatusCode::SERVICE_UNAVAILABLE, "session window missing");
    };
    let Ok(cookie) = session::cookie_header(&window) else {
        return media_error(StatusCode::UNAUTHORIZED, "no session cookie");
    };

    let client = match reqwest::Client::builder()
        .user_agent(media::USER_AGENT)
        .timeout(Duration::from_secs(180))
        .build()
    {
        Ok(client) => client,
        Err(error) => return media_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()),
    };

    let mut request = client
        .get(&query.url)
        .header(header::COOKIE, cookie)
        .header(header::REFERER, media::REFERER)
        .header(header::ACCEPT, "*/*");
    if let Some(range) = headers.get(header::RANGE).and_then(|value| value.to_str().ok()) {
        request = request.header(header::RANGE, range);
    }

    let upstream = match request.send().await {
        Ok(response) => response,
        Err(error) => return media_error(StatusCode::BAD_GATEWAY, &error.to_string()),
    };

    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let content_range = upstream
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => return media_error(StatusCode::BAD_GATEWAY, &error.to_string()),
    };
    if bytes.len() as u64 > media::MAX_PROXY_BYTES {
        return media_error(StatusCode::PAYLOAD_TOO_LARGE, "media file is too large");
    }
    if !status.is_success() {
        let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(160)]).to_string();
        tracing::warn!(url = %query.url, status = %status, "media proxy failed");
        return media_error(StatusCode::BAD_GATEWAY, &preview);
    }

    // TAPD answers with a bare `image` (no subtype) for editor captures.
    let content_type = if content_type.contains('/') {
        content_type
    } else {
        sniff_media_type(&bytes, &content_type)
    };

    let mut response = Response::builder()
        .status(if status == reqwest::StatusCode::PARTIAL_CONTENT {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, max-age=300");

    if let Some(content_range) = content_range {
        response = response.header(header::CONTENT_RANGE, content_range);
    }

    response
        .body(axum::body::Body::from(bytes))
        .unwrap_or_else(|error| media_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()))
}

fn sniff_media_type(bytes: &[u8], declared: &str) -> String {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return "image/png".to_string();
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg".to_string();
    }
    if bytes.starts_with(b"GIF8") {
        return "image/gif".to_string();
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp".to_string();
    }
    if declared.eq_ignore_ascii_case("video") {
        return "video/mp4".to_string();
    }
    "application/octet-stream".to_string()
}

fn media_error(status: StatusCode, message: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(axum::body::Body::from(message.to_string()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn unauthorized() -> (StatusCode, Json<Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "ok": false, "error": "unauthorized" })),
    )
}

fn authorized(state: &SharedState, headers: &HeaderMap) -> bool {
    let Some(runtime) = state.runtime_info() else {
        return false;
    };
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };

    value == format!("Bearer {}", runtime.token)
}
