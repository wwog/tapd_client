//! Embedded static assets of the companion SPA.
//!
//! Built by `pnpm -C apps/companion build` into `dist-companion/`; debug
//! builds read the folder at runtime, release builds embed it.

use axum::{
    http::{header, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

/// Static assets of the companion SPA. Built by `pnpm -C apps/companion build`
/// into `dist-companion/`; debug builds read the folder at runtime, release
/// builds embed it.
#[derive(RustEmbed)]
#[folder = "dist-companion"]
struct CompanionAssets;

/// `/` and unknown paths serve `index.html` so the SPA owns routing; a missing
/// build shows an actionable placeholder instead of a 404.
pub(super) async fn static_fallback(uri: Uri) -> Response {
    serve_asset(uri.path().trim_start_matches('/'))
}

fn serve_asset(name: &str) -> Response {
    // `..` segments never resolve: only keys inside the embed folder are served.
    let file = if name.is_empty() || name.split(['/', '\\']).any(|part| part == "..") {
        None
    } else {
        CompanionAssets::get(name)
    };
    match file {
        Some(file) => (
            [(header::CONTENT_TYPE, content_type_for(name))],
            file.data.to_vec(),
        )
            .into_response(),
        None => match CompanionAssets::get("index.html") {
            Some(file) => (
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                file.data.to_vec(),
            )
                .into_response(),
            None => unbuilt_placeholder(),
        },
    }
}

/// Minimal MIME table for the SPA's asset extensions.
fn content_type_for(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Shown while `dist-companion/` has no build output yet.
fn unbuilt_placeholder() -> Response {
    let html = r#"<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TAPD 伴侣</title><!-- i18n-exempt: static fallback page --></head>
<body style="font-family:-apple-system,sans-serif;padding:24px;line-height:1.6">
<h1 style="font-size:18px">伴侣前端未构建</h1><!-- i18n-exempt: static fallback page -->
<p>在仓库根目录运行 <code>pnpm -C apps/companion build</code>，然后刷新本页。</p><!-- i18n-exempt: static fallback page -->
</body>
</html>"#;
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html.as_bytes().to_vec(),
    )
        .into_response()
}
