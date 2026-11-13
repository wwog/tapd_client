//! Downloading one media reference into an export's `assets/` directory,
//! including the naming rules that keep filenames stable and collision-free.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use tapd_core::export::{download_url_for, MediaAsset, MediaKind, MediaRef};
use tapd_i18n::{tr, tr_args};

use crate::media;

pub(super) async fn download_one(
    client: &reqwest::Client,
    cookie: &str,
    item: &MediaRef,
    index: usize,
    assets_dir: &Path,
    used_names: &mut HashSet<String>,
) -> Result<MediaAsset, String> {
    let download_url = download_url_for(&item.url);
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

    let filename = unique_filename(
        &item.filename_hint,
        &content_type,
        item.kind,
        index,
        used_names,
    );
    let path = assets_dir.join(&filename);
    std::fs::write(&path, &bytes).map_err(|error| error.to_string())?;

    Ok(MediaAsset {
        url: item.url.clone(),
        relative_path: format!("assets/{filename}"),
        filename,
        kind: item.kind,
        size: bytes.len() as u64,
        content_type,
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
