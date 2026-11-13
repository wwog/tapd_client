//! Downloading one media reference into an export's `assets/` directory,
//! including the naming rules that keep filenames stable and collision-free.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use tapd_core::export::{download_url_for, MediaAsset, MediaKind, MediaRef};
use tapd_i18n::{tr, tr_args};

use crate::{media, media_cache};

pub(super) async fn download_one(
    client: &reqwest::Client,
    cookie: &str,
    item: &MediaRef,
    index: usize,
    assets_dir: &Path,
    cache_dir: &Path,
    used_names: &mut HashSet<String>,
) -> Result<MediaAsset, String> {
    let download_url = download_url_for(&item.url);

    // A previous export of this bug, or a media-proxy hit, already fetched the
    // same resource. Reuse it instead of downloading it again.
    if let Some(cached) = media_cache::get(cache_dir, &download_url) {
        if let Ok(bytes) = std::fs::read(&cached.path) {
            return save_asset(
                item,
                index,
                assets_dir,
                used_names,
                &bytes,
                &cached.content_type,
            );
        }
    }

    let response = client
        .get(&download_url)
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::REFERER, media::REFERER)
        .header(reqwest::header::ACCEPT, "*/*")
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    let length = response.content_length().unwrap_or(0);
    if length > media::MAX_FILE_BYTES {
        return Err(tr("app.file.large").to_string());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?;

    if bytes.len() as u64 > media::MAX_FILE_BYTES {
        return Err(tr("app.file.large").to_string());
    }

    // TAPD returns a short placeholder instead of the file when the URL or
    // permissions are wrong.
    let body_head = String::from_utf8_lossy(&bytes[..bytes.len().min(64)]).to_lowercase();
    if media::content_type_is_html(&content_type) && body_head.contains("error") {
        return Err(tr_args("app.download.rejected", &[&content_type]));
    }

    media_cache::put(cache_dir, &download_url, &content_type, &bytes);
    save_asset(item, index, assets_dir, used_names, &bytes, &content_type)
}

/// Writes downloaded bytes into `assets/` and describes the resulting file.
fn save_asset(
    item: &MediaRef,
    index: usize,
    assets_dir: &Path,
    used_names: &mut HashSet<String>,
    bytes: &[u8],
    content_type: &str,
) -> Result<MediaAsset, String> {
    let filename = unique_filename(
        &item.filename_hint,
        content_type,
        item.kind,
        index,
        used_names,
    );
    let path = assets_dir.join(&filename);
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;

    Ok(MediaAsset {
        url: item.url.clone(),
        relative_path: format!("assets/{filename}"),
        filename,
        kind: item.kind,
        size: bytes.len() as u64,
        content_type: content_type.to_string(),
    })
}

fn unique_filename(
    hint: &str,
    content_type: &str,
    kind: MediaKind,
    index: usize,
    used: &mut HashSet<String>,
) -> String {
    let base = media::sanitize_filename(hint);
    let base = if base.is_empty() || base == "asset" || base == "poster" {
        format!(
            "media-{index}-{}",
            if base.is_empty() { "asset" } else { base.as_str() }
        )
    } else {
        base
    };
    let base = media::with_extension(&base, content_type, kind);

    let mut candidate = base.clone();
    let mut counter = 2usize;
    while used.contains(&candidate) {
        let path = PathBuf::from(&base);
        let stem = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("asset");
        let extension = path.extension().and_then(|extension| extension.to_str()).unwrap_or("");
        candidate = if extension.is_empty() {
            format!("{stem}-{counter}")
        } else {
            format!("{stem}-{counter}.{extension}")
        };
        counter += 1;
    }

    used.insert(candidate.clone());
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use axum::{http::header, routing::get, Router};

    /// The second export of the same resource must reuse the first download.
    #[tokio::test]
    async fn a_cached_url_is_only_downloaded_once() {
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("local addr");
        let server = Router::new().route(
            "/a.png",
            get(move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    ([(header::CONTENT_TYPE, "image/png")], "png-bytes")
                }
            }),
        );
        let handle = tokio::spawn(async move { axum::serve(listener, server).await });

        let root = std::env::temp_dir().join(format!(
            "tapd-export-cache-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let assets = root.join("assets");
        std::fs::create_dir_all(&assets).expect("assets dir");
        let cache = root.join("cache");
        let item = MediaRef {
            url: format!("http://{address}/a.png"),
            kind: MediaKind::Image,
            filename_hint: "shot.png".to_string(),
        };
        let client = reqwest::Client::new();

        let first = download_one(&client, "", &item, 1, &assets, &cache, &mut HashSet::new())
            .await
            .expect("first download");
        let second = download_one(&client, "", &item, 1, &assets, &cache, &mut HashSet::new())
            .await
            .expect("cached export");

        assert_eq!(hits.load(Ordering::SeqCst), 1, "only one HTTP request");
        assert_eq!(first.content_type, "image/png");
        assert_eq!(second.content_type, "image/png");
        assert_eq!(second.size, b"png-bytes".len() as u64);
        assert_eq!(
            std::fs::read(assets.join(&second.filename)).expect("asset on disk"),
            b"png-bytes"
        );

        handle.abort();
        let _ = std::fs::remove_dir_all(&root);
    }
}
