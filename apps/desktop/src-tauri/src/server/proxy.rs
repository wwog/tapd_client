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

/// Proxies TAPD-hosted images/videos with the session cookies so the main
/// window can render thumbnails and previews (`<img>`/`<video>` cannot send
/// the bearer token, hence the separate `media_token` query capability).
///
/// `Range` is forwarded and `206`/`Content-Range` are passed through, which is
/// what the video element needs to seek.
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
    if !crate::commands::open::is_tapd_media_url(&query.url) {
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
