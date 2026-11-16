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
    match fetch_tapd_media(&ctx.app, &ctx.state.paths, &query.url, range).await {
        Ok(fetch) => media_response(fetch),
        Err((status, message)) => media_error(status, &message),
    }
}

/// Fetches a TAPD media URL with the hidden webview session's cookies. Shared
/// by the loopback media proxy and the companion server; the callers own their
/// auth and their response envelope.
///
/// A cached full body is served without any network request; the requested
/// `Range` is sliced locally, which is what keeps a bug's screenshots and
/// videos from being downloaded again on every UI render or phone reload.
/// Full-body fetches are stored in the cache; a forwarded `Range` response is
/// partial and is not.
///
/// `Range` is forwarded and `206`/`Content-Range` are passed through, which is
/// what the video element needs to seek.
pub(crate) async fn fetch_tapd_media(
    app: &tauri::AppHandle,
    paths: &tapd_core::paths::AppPaths,
    url: &str,
    range: Option<String>,
) -> Result<MediaFetch, (StatusCode, String)> {
    let absolute = absolute_media_url(url);
    if !crate::commands::open::is_tapd_media_url(&absolute) {
        return Err((StatusCode::BAD_REQUEST, "unsupported media url".to_string()));
    }

    let cache_dir = crate::media_cache::dir(paths);
    if let Some(cached) = crate::media_cache::get(&cache_dir, &absolute) {
        // The proxy buffers bodies in memory, so it keeps its own ceiling even
        // for entries an export cached under the larger limit.
        if cached.size <= media::MAX_PROXY_BYTES {
            // Cache reads can reach 200 MB: never run them on a tokio worker.
            let path = cached.path.clone();
            if let Ok(Ok(bytes)) =
                tokio::task::spawn_blocking(move || std::fs::read(path)).await
            {
                return Ok(cached_fetch(cached.content_type, bytes, range.as_deref()));
            }
        }
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

    // Every hop is re-approved: the request carries the TAPD session cookie,
    // so following a redirect to a non-TAPD host would hand it to that host.
    let client = reqwest::Client::builder()
        .user_agent(media::USER_AGENT)
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5
                || !crate::commands::open::is_tapd_media_url(attempt.url().as_str())
            {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let mut request = client
        .get(&absolute)
        .header(header::COOKIE, cookie)
        .header(header::REFERER, media::REFERER)
        .header(header::ACCEPT, "*/*");
    // A forwarded range yields a partial body, which must not enter the cache.
    let ranged = range.is_some();
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

    // Read with a running cap: `bytes()` would buffer a 1–2 GB attachment in
    // full before the size check ever runs.
    let mut upstream = upstream;
    let mut bytes = Vec::new();
    while let Some(chunk) = upstream
        .chunk()
        .await
        .map_err(|error| (StatusCode::BAD_GATEWAY, error.to_string()))?
    {
        if bytes.len() as u64 + chunk.len() as u64 > media::MAX_PROXY_BYTES {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                "media file is too large".to_string(),
            ));
        }
        bytes.extend_from_slice(&chunk);
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

    if !ranged {
        // Writing up to 200 MB plus the cache trim (`read_dir` + `metadata`
        // over every entry) blocks; keep it off the async workers.
        let put_dir = cache_dir.clone();
        let put_url = absolute.clone();
        let put_type = content_type.clone();
        let put_bytes = bytes.clone();
        let _ = tokio::task::spawn_blocking(move || {
            crate::media_cache::put(&put_dir, &put_url, &put_type, &put_bytes)
        })
        .await;
    }

    Ok(MediaFetch {
        status: if status == reqwest::StatusCode::PARTIAL_CONTENT {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        },
        content_type,
        content_range,
        bytes: bytes.into(),
    })
}

/// Serves a cached body, slicing it locally when the caller asked for a range.
/// An unparseable or unsatisfiable range falls back to the whole body, which
/// every media element can play.
fn cached_fetch(content_type: String, bytes: Vec<u8>, range: Option<&str>) -> MediaFetch {
    let total = bytes.len() as u64;
    if let Some((start, end)) = range.and_then(|header| parse_range(header, total)) {
        return MediaFetch {
            status: StatusCode::PARTIAL_CONTENT,
            content_type,
            content_range: Some(format!("bytes {start}-{end}/{total}")),
            bytes: bytes[start as usize..=end as usize].to_vec().into(),
        };
    }

    MediaFetch {
        status: StatusCode::OK,
        content_type,
        content_range: None,
        bytes: bytes.into(),
    }
}

/// Parses one `bytes=` range against a known body length. Multi-range requests
/// and malformed headers return `None`.
fn parse_range(header: &str, total: u64) -> Option<(u64, u64)> {
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

/// Builds the proxy response for a fetched media body: `Range`/`206` headers
/// pass through so video elements can seek.
pub(crate) fn media_response(fetch: MediaFetch) -> Response {    let mut response = Response::builder()
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

/// TAPD rich text embeds site-relative image paths (`/tfl/captures/...`);
/// resolve them against the main site so the host allowlist sees one form.
fn absolute_media_url(url: &str) -> String {
    if let Some(rest) = url.strip_prefix('/') {
        format!("{}{rest}", session::TAPD_HOME)
    } else {
        url.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{absolute_media_url, cached_fetch, parse_range};
    use axum::http::StatusCode;

    #[test]
    fn resolves_site_relative_paths_against_tapd_home() {
        assert_eq!(
            absolute_media_url("/tfl/captures/2026-11/a.png"),
            "https://www.tapd.cn/tfl/captures/2026-11/a.png"
        );
    }

    #[test]
    fn keeps_absolute_urls_untouched() {
        assert_eq!(
            absolute_media_url("https://file.tapd.cn/a/b.png"),
            "https://file.tapd.cn/a/b.png"
        );
        assert_eq!(absolute_media_url("file:///etc/passwd"), "file:///etc/passwd");
    }

    #[test]
    fn parses_the_ranges_video_elements_send() {
        assert_eq!(parse_range("bytes=0-3", 10), Some((0, 3)));
        assert_eq!(parse_range("bytes=4-", 10), Some((4, 9)));
        assert_eq!(parse_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(parse_range("bytes=9-99", 10), Some((9, 9)));
        assert_eq!(parse_range("bytes=0-", 10), Some((0, 9)));
    }

    #[test]
    fn rejects_ranges_it_cannot_serve() {
        assert_eq!(parse_range("bytes=0-1", 0), None);
        assert_eq!(parse_range("bytes=10-", 10), None);
        assert_eq!(parse_range("bytes=0-1,4-5", 10), None);
        assert_eq!(parse_range("items=0-1", 10), None);
        assert_eq!(parse_range("bytes=a-b", 10), None);
        assert_eq!(parse_range("bytes=-0", 10), None);
    }

    #[test]
    fn cached_fetch_slices_without_a_network_request() {
        let full = cached_fetch("image/png".to_string(), (0..10).collect(), None);
        assert_eq!(full.status, StatusCode::OK);
        assert_eq!(full.content_range, None);
        assert_eq!(full.bytes.len(), 10);

        let partial = cached_fetch(
            "video/mp4".to_string(),
            (0..10).collect(),
            Some("bytes=2-4"),
        );
        assert_eq!(partial.status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(partial.content_range.as_deref(), Some("bytes 2-4/10"));
        assert_eq!(&partial.bytes[..], &[2, 3, 4]);
    }
}
