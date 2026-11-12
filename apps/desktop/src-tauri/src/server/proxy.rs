//! Media proxy: TAPD-hosted images/videos fetched with the session cookies.

use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use tauri::Manager;

use super::ApiState;
use crate::{media, session};

#[derive(Deserialize)]
pub(super) struct MediaQuery {
    token: String,
    url: String,
}

/// One fetched media body plus the upstream headers the proxies forward.
pub(crate) struct MediaFetch {
    /// `206` when the upstream honored a forwarded `Range`, else `200`.
    pub status: StatusCode,
    pub content_type: String,
    pub content_range: Option<String>,
    pub bytes: axum::body::Bytes,
}

/// Proxies TAPD-hosted images/videos with the session cookies so the main
/// window can render thumbnails and previews (`<img>`/`<video>` cannot send
/// the bearer token, hence the separate `media_token` query capability).
pub(super) async fn media_proxy(
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

    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    match fetch_tapd_media(&ctx.app, &query.url, range).await {
        Ok(fetch) => media_response(fetch),
        Err((status, message)) => media_error(status, &message),
    }
}

/// Fetches a TAPD media URL with the hidden webview session's cookies. Shared
/// by the loopback media proxy and the companion server; the callers own their
/// auth and their response envelope.
///
/// `Range` is forwarded and `206`/`Content-Range` are passed through, which is
/// what the video element needs to seek.
pub(crate) async fn fetch_tapd_media(
    app: &tauri::AppHandle,
    url: &str,
    range: Option<String>,
) -> Result<MediaFetch, (StatusCode, String)> {
    if !crate::commands::open::is_tapd_media_url(url) {
        return Err((StatusCode::BAD_REQUEST, "unsupported media url".to_string()));
    }

    let Some(window) = app.get_webview_window(session::SESSION_LABEL) else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "session window missing".to_string(),
        ));
    };
    let Ok(cookie) = session::cookie_header(&window) else {
        return Err((StatusCode::UNAUTHORIZED, "no session cookie".to_string()));
    };

    let client = reqwest::Client::builder()
        .user_agent(media::USER_AGENT)
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let mut request = client
        .get(url)
        .header(header::COOKIE, cookie)
        .header(header::REFERER, media::REFERER)
        .header(header::ACCEPT, "*/*");
    if let Some(range) = range {
        request = request.header(header::RANGE, range);
    }

    let upstream = request
        .send()
        .await
        .map_err(|error| (StatusCode::BAD_GATEWAY, error.to_string()))?;

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

    let bytes = upstream
        .bytes()
        .await
        .map_err(|error| (StatusCode::BAD_GATEWAY, error.to_string()))?;
    if bytes.len() as u64 > media::MAX_PROXY_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "media file is too large".to_string(),
        ));
    }
    if !status.is_success() {
        let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(160)]).to_string();
        tracing::warn!(url = %url, status = %status, "media proxy failed");
        return Err((StatusCode::BAD_GATEWAY, preview));
    }

    // TAPD answers with a bare `image` (no subtype) for editor captures.
    let content_type = if content_type.contains('/') {
        content_type
    } else {
        sniff_media_type(&bytes, &content_type)
    };

    Ok(MediaFetch {
        status: if status == reqwest::StatusCode::PARTIAL_CONTENT {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        },
        content_type,
        content_range,
        bytes,
    })
}

/// Builds the proxy response for a fetched media body: `Range`/`206` headers
/// pass through so video elements can seek.
pub(crate) fn media_response(fetch: MediaFetch) -> Response {
    let mut response = Response::builder()
        .status(fetch.status)
        .header(header::CONTENT_TYPE, fetch.content_type)
        .header(header::CONTENT_LENGTH, fetch.bytes.len())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, max-age=300");

    if let Some(content_range) = fetch.content_range {
        response = response.header(header::CONTENT_RANGE, content_range);
    }

    response
        .body(axum::body::Body::from(fetch.bytes))
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
