//! Loopback HTTP API consumed by the `tapd-mcp` sidecar and dev tooling.
//!
//! The server binds an ephemeral port on `127.0.0.1` and publishes it (plus a
//! bearer token) through the runtime file. Routes:
//! - `/healthz`, `/mcp/call`, `/media`, `/file` — shipped.
//! - `/dev/*` — debug builds only (`dev` module).

mod auth;
#[cfg(debug_assertions)]
mod dev;
mod proxy;

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tapd_core::runtime::RuntimeInfo;
use tauri::AppHandle;

use crate::fs::FsErrorKind;
use crate::state::SharedState;

use auth::{authorized, unauthorized};
pub(crate) use proxy::{fetch_tapd_media, media_response};

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

    let token = opaque_token();
    let media_token = opaque_token();
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
        .route("/media", get(proxy::media_proxy))
        .route("/file", get(file_proxy));

    // Debug-only escape hatches for mapping TAPD's internal API. They never
    // ship in a release binary.
    #[cfg(debug_assertions)]
    let router = router
        .route("/dev/eval", post(dev::dev_eval))
        .route("/dev/call", post(dev::dev_call))
        .route("/dev/cookies", get(dev::dev_cookies))
        .route("/dev/export", post(dev::dev_export))
        .route("/dev/feature", post(dev::dev_feature))
        .route("/dev/companion", get(dev::dev_companion))
        .route("/dev/companion/pairing", post(dev::dev_companion_pairing));

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
    let arguments = payload.get("arguments").cloned().unwrap_or(Value::Null);
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

/// Two concatenated v4 UUIDs: 64 hex characters of unpredictable token.
pub(crate) fn opaque_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

// ---------------------------------------------------------------------------
// Read-only file streaming
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct FileQuery {
    token: String,
    /// TAPD workspace id (project whose configured folder is the root).
    ws: String,
    /// Path relative to the project root; empty is the root itself.
    path: String,
}

/// `GET /file?token&ws&path` — streams one file from the project folder.
///
/// `<img>` / `<video>` cannot send the bearer token, so this route uses the
/// same independent `media_token` capability as `/media`. The body is buffered
/// (the preview ceiling is 64 MiB) and served with `Accept-Ranges` plus simple
/// single-range `206` support, which is what video elements need to seek.
async fn file_proxy(
    State(ctx): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<FileQuery>,
) -> Response {
    let Some(runtime) = ctx.state.runtime_info() else {
        return file_error(StatusCode::SERVICE_UNAVAILABLE, "runtime not ready");
    };
    if query.token.is_empty() || query.token != runtime.media_token {
        return file_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    let root = match crate::fs::root_for(&ctx.app, &query.ws) {
        Ok(root) => root,
        Err(error) => return fs_error_response(&error),
    };
    let requested = query.path;
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    stream_file_response(root, requested, range).await
}

/// Serves one project file, reading only the requested `Range` span.
///
/// A `206` seek must not read the whole file: the old path buffered it and
/// sliced afterwards, so every video seek cost one full disk read.
pub(crate) async fn stream_file_response(
    root: std::path::PathBuf,
    relative: String,
    range: Option<String>,
) -> Response {
    let opened =
        tokio::task::spawn_blocking(move || crate::fs::open_stream(&root, &relative)).await;
    let file = match opened {
        Ok(Ok(file)) => file,
        Ok(Err(error)) => return fs_error_response(&error),
        Err(error) => {
            return file_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("file open failed: {error}"),
            )
        }
    };

    let total = file.size();
    let content_type = file.content_type().to_string();
    let span = range
        .as_deref()
        .and_then(|header| parse_single_range(header, total));
    let (status, content_range, start, len) = match span {
        Some((start, end)) => (
            StatusCode::PARTIAL_CONTENT,
            Some(format!("bytes {start}-{end}/{total}")),
            start,
            end - start + 1,
        ),
        None => (StatusCode::OK, None, 0, total),
    };

    let read = tokio::task::spawn_blocking(move || file.read(start, len)).await;
    match read {
        Ok(Ok(body)) => file_body_response(status, &content_type, content_range, body),
        Ok(Err(error)) => fs_error_response(&error),
        Err(error) => file_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("file read failed: {error}"),
        ),
    }
}

/// Converts a failed fs operation into the status the streaming route uses:
/// traversal / malformed requests are forbidden, unknown paths are 404, large
/// bodies are 413.
pub(crate) fn fs_error_status(kind: FsErrorKind) -> StatusCode {
    match kind {
        FsErrorKind::NoFolder | FsErrorKind::NotFound => StatusCode::NOT_FOUND,
        FsErrorKind::InvalidRequest | FsErrorKind::OutsideRoot => StatusCode::FORBIDDEN,
        FsErrorKind::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        FsErrorKind::Conflict => StatusCode::CONFLICT,
        FsErrorKind::Io => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

pub(crate) fn fs_error_response(error: &crate::fs::FsError) -> Response {
    file_error(fs_error_status(error.kind), &error.message())
}

/// Builds the response for an already-sliced file body.
pub(crate) fn file_body_response(
    status: StatusCode,
    content_type: &str,
    content_range: Option<String>,
    body: Vec<u8>,
) -> Response {
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, body.len())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, max-age=0");
    if let Some(content_range) = content_range {
        response = response.header(header::CONTENT_RANGE, content_range);
    }
    response
        .body(axum::body::Body::from(body))
        .unwrap_or_else(|error| file_error(StatusCode::INTERNAL_SERVER_ERROR, &error.to_string()))
}

/// Builds a `200`/`206` response from an in-memory body, slicing it to `range`.
/// Only tests use this now; the routes read their span from disk.
#[cfg(test)]
pub(crate) fn file_stream_response(
    bytes: Vec<u8>,
    content_type: &str,
    range: Option<&str>,
) -> Response {
    let total = bytes.len() as u64;
    match range.and_then(|header| parse_single_range(header, total)) {
        Some((start, end)) => file_body_response(
            StatusCode::PARTIAL_CONTENT,
            content_type,
            Some(format!("bytes {start}-{end}/{total}")),
            bytes[start as usize..=end as usize].to_vec(),
        ),
        None => file_body_response(StatusCode::OK, content_type, None, bytes),
    }
}

/// Parses one `bytes=` range against a known length. Multi-range and malformed
/// headers return `None` (full body).
fn parse_single_range(header: &str, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;

    if start.trim().is_empty() {
        let suffix: u64 = end.trim().parse().ok()?;
        if suffix == 0 {
            return None;
        }
        return Some((total.saturating_sub(suffix), total - 1));
    }

    let start: u64 = start.trim().parse().ok()?;
    if start >= total {
        return None;
    }
    let end = match end.trim() {
        "" => total - 1,
        value => value.parse::<u64>().ok()?.min(total - 1),
    };
    (end >= start).then_some((start, end))
}

fn file_error(status: StatusCode, message: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(axum::body::Body::from(message.to_string()))
        .unwrap_or_else(|_| status.into_response())
}

#[cfg(test)]
mod tests {
    use super::{file_stream_response, parse_single_range};
    use axum::http::{header, StatusCode};

    #[test]
    fn parses_the_single_ranges_media_elements_send() {
        assert_eq!(parse_single_range("bytes=0-3", 10), Some((0, 3)));
        assert_eq!(parse_single_range("bytes=4-", 10), Some((4, 9)));
        assert_eq!(parse_single_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(parse_single_range("bytes=9-99", 10), Some((9, 9)));
        assert_eq!(parse_single_range("bytes=0-", 10), Some((0, 9)));
    }

    #[test]
    fn rejects_ranges_the_file_route_cannot_serve() {
        assert_eq!(parse_single_range("bytes=0-1", 0), None);
        assert_eq!(parse_single_range("bytes=10-", 10), None);
        assert_eq!(parse_single_range("bytes=0-1,4-5", 10), None);
        assert_eq!(parse_single_range("items=0-1", 10), None);
        assert_eq!(parse_single_range("bytes=a-b", 10), None);
        assert_eq!(parse_single_range("bytes=-0", 10), None);
    }

    #[test]
    fn file_responses_slice_and_advertise_ranges() {
        let full = file_stream_response(b"0123456789".to_vec(), "text/plain", None);
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.headers().get(header::ACCEPT_RANGES).unwrap(), "bytes");
        assert_eq!(full.headers().get(header::CONTENT_LENGTH).unwrap(), "10");

        let partial = file_stream_response(b"0123456789".to_vec(), "video/mp4", Some("bytes=2-4"));
        assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            partial.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 2-4/10"
        );
        assert_eq!(partial.headers().get(header::CONTENT_LENGTH).unwrap(), "3");
    }
}
