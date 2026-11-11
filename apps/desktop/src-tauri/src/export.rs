use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tapd_core::{
    export::{
        collect_media, download_url_for, render_markdown, ascii_slug, MediaAsset, MediaKind,
        MediaRef,
    },
    tapd::BugDetail,
};

use crate::{media, session, state::SharedState};

const MAX_TOTAL_BYTES: u64 = 300 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub dir: String,
    pub markdown_path: String,
    pub asset_count: usize,
    pub downloaded_bytes: u64,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn export_bug_md(
    app: AppHandle,
    state: State<'_, SharedState>,
    workspace_id: String,
    bug_id: String,
    workspace_name: Option<String>,
) -> Result<ExportResult, String> {
    run_export(&app, &state.paths, &workspace_id, &bug_id, workspace_name).await
}

pub async fn run_export(
    app: &AppHandle,
    paths: &tapd_core::paths::AppPaths,
    workspace_id: &str,
    bug_id: &str,
    workspace_name: Option<String>,
) -> Result<ExportResult, String> {
    let detail = fetch_detail(app, workspace_id, bug_id).await?;
    let label = workspace_label(workspace_name, &detail, workspace_id);
    let bug_ref = bug_reference(&detail.summary);
    let bug_dir = bug_export_dir(
        paths,
        workspace_id,
        &label,
        &bug_ref,
        &detail.summary.title,
    );

    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| "会话窗口尚未创建".to_string())?;
    let cookie = session::cookie_header(&window)?;

    let assets_dir = bug_dir.join("assets");
    std::fs::create_dir_all(&assets_dir).map_err(|error| error.to_string())?;

    let client = reqwest::Client::builder()
        .user_agent(media::USER_AGENT)
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| error.to_string())?;

    let media = collect_media(&detail);
    let mut assets: Vec<MediaAsset> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut used_names: HashSet<String> = HashSet::new();
    let mut total_bytes: u64 = 0;
    let mut media_index = 0usize;

    for item in media {
        if total_bytes >= MAX_TOTAL_BYTES {
            warnings.push("已达到导出总大小上限，剩余资源未下载".to_string());
            break;
        }

        media_index += 1;
        match download_one(
            &client,
            &cookie,
            &item,
            media_index,
            &assets_dir,
            &mut used_names,
        )
        .await
        {
            Ok(asset) => {
                total_bytes += asset.size;
                assets.push(asset);
            }
            Err(error) => warnings.push(format!("{}：{}", item.filename_hint, error)),
        }
    }

    let markdown = render_markdown(&detail, &assets, &label);
    let markdown_path = bug_dir.join("bug.md");
    std::fs::write(&markdown_path, markdown).map_err(|error| error.to_string())?;

    let json_path = bug_dir.join("bug.json");
    let json = serde_json::to_vec_pretty(&detail).map_err(|error| error.to_string())?;
    std::fs::write(&json_path, json).map_err(|error| error.to_string())?;

    tracing::info!(
        bug_id,
        assets = assets.len(),
        bytes = total_bytes,
        path = %bug_dir.display(),
        "bug exported"
    );

    Ok(ExportResult {
        dir: bug_dir.to_string_lossy().to_string(),
        markdown_path: markdown_path.to_string_lossy().to_string(),
        asset_count: assets.len(),
        downloaded_bytes: total_bytes,
        warnings,
    })
}

fn workspace_label(
    workspace_name: Option<String>,
    detail: &BugDetail,
    workspace_id: &str,
) -> String {
    workspace_name
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            let name = detail.workspace_name.trim().to_string();
            (!name.is_empty()).then_some(name)
        })
        .unwrap_or_else(|| workspace_id.to_string())
}

/// Directory that receives `bug.md`, `bug.json` and `assets/` for one bug.
///
/// Layout: `<exports>/<workspace>-<workspace_id>/<bug_ref>[-<ascii-slug>]`.
/// `bug_ref` is the short id TAPD shows in its UI, and the slug is ASCII-only
/// so the path stays short and portable.
pub(crate) fn bug_export_dir(
    paths: &tapd_core::paths::AppPaths,
    workspace_id: &str,
    workspace_label: &str,
    bug_ref: &str,
    title: &str,
) -> PathBuf {
    let workspace_slug = ascii_slug(workspace_label);
    let workspace_dir = if workspace_slug.is_empty() {
        workspace_id.to_string()
    } else {
        format!("{workspace_slug}-{workspace_id}")
    };
    let title_slug = ascii_slug(title);
    let bug_dir = if title_slug.is_empty() {
        bug_ref.to_string()
    } else {
        format!("{bug_ref}-{title_slug}")
    };
    paths.exports_dir.join(workspace_dir).join(bug_dir)
}

/// Stable, filesystem-friendly bug reference: TAPD's short id when present.
pub(crate) fn bug_reference(summary: &tapd_core::tapd::BugSummary) -> String {
    let short = summary.short_id.trim();
    if !short.is_empty() {
        return short.to_string();
    }
    let id = summary.id.trim();
    // The long id is numeric; the last 10 digits keep it distinguishable
    // without a 19-digit directory name.
    id.chars()
        .rev()
        .take(10)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// Reuses an existing export of the same bug. An explicit `workspace_name`
/// changes the parent directory, so every `<slug>-<workspace_id>` folder is
/// scanned; the newest `bug.md` wins.
///
/// Both the short id and the long id are accepted so exports created before
/// the naming change are still reused.
pub(crate) fn find_existing_export(
    paths: &tapd_core::paths::AppPaths,
    workspace_id: &str,
    bug_ref: &str,
    bug_id: &str,
) -> Option<PathBuf> {
    let suffix = format!("-{workspace_id}");
    let refs: Vec<String> = [
        bug_ref.trim().to_string(),
        bug_id.trim().to_string(),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect();
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;

    for workspace_entry in std::fs::read_dir(&paths.exports_dir).ok()?.flatten() {
        if !workspace_entry.path().is_dir() {
            continue;
        }
        if !workspace_entry.file_name().to_string_lossy().ends_with(&suffix) {
            continue;
        }
        let Ok(children) = std::fs::read_dir(workspace_entry.path()) else {
            continue;
        };
        for child in children.flatten() {
            let dir = child.path();
            let name = child.file_name().to_string_lossy().to_string();
            let matches_bug = refs.iter().any(|reference| {
                name == *reference || name.starts_with(&format!("{reference}-"))
            });
            if !dir.is_dir() || !matches_bug || !dir.join("bug.md").is_file() {
                continue;
            }
            let modified = std::fs::metadata(&dir)
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            if best.as_ref().is_none_or(|(latest, _)| modified > *latest) {
                best = Some((modified, dir));
            }
        }
    }

    best.map(|(_, dir)| dir)
}

async fn fetch_detail(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<BugDetail, String> {
    crate::commands::fetch_bug_detail(app, workspace_id, bug_id).await
}

async fn download_one(
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
        return Err("文件超过 300MB，已跳过".to_string());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?;

    if bytes.len() as u64 > media::MAX_FILE_BYTES {
        return Err("文件超过 300MB，已跳过".to_string());
    }

    // TAPD returns a short placeholder instead of the file when the URL or
    // permissions are wrong.
    let body_head = String::from_utf8_lossy(&bytes[..bytes.len().min(64)]).to_lowercase();
    if media::content_type_is_html(&content_type) && body_head.contains("error") {
        return Err(format!("下载被拒绝（{content_type}）"));
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

#[cfg(test)]
mod tests {
    use super::*;
    use tapd_core::paths::AppPaths;
    use tapd_core::tapd::BugSummary;

    fn paths() -> AppPaths {
        AppPaths {
            data_dir: PathBuf::from("/tmp/tapd"),
            logs_dir: PathBuf::from("/tmp/tapd/logs"),
            captures_dir: PathBuf::from("/tmp/tapd/captures"),
            exports_dir: PathBuf::from("/exports"),
            runtime_file: PathBuf::from("/tmp/tapd/runtime.json"),
            config_file: PathBuf::from("/tmp/tapd/config.json"),
        }
    }

    fn summary(id: &str, short_id: &str, title: &str) -> BugSummary {
        BugSummary {
            id: id.to_string(),
            short_id: short_id.to_string(),
            title: title.to_string(),
            ..BugSummary::default()
        }
    }

    #[test]
    fn export_dir_is_short_and_ascii() {
        let summary = summary(
            "1145336192001010643",
            "1010643",
            "rust-设置-通话记录-清空通话",
        );
        let dir = bug_export_dir(
            &paths(),
            "45336192",
            "UU",
            &bug_reference(&summary),
            &summary.title,
        );
        assert_eq!(
            dir.to_string_lossy(),
            "/exports/UU-45336192/1010643-rust"
        );
    }

    #[test]
    fn export_dir_falls_back_to_the_bug_reference() {
        let summary = summary("1145336192001010643", "1010643", "通话记录清空");
        let dir = bug_export_dir(
            &paths(),
            "45336192",
            "项目",
            &bug_reference(&summary),
            &summary.title,
        );
        assert_eq!(dir.to_string_lossy(), "/exports/45336192/1010643");
    }

    #[test]
    fn bug_reference_uses_short_id_or_long_id_tail() {
        assert_eq!(
            bug_reference(&summary("1145336192001010643", "1010643", "")),
            "1010643"
        );
        assert_eq!(
            bug_reference(&summary("1145336192001010643", " ", "")),
            "2001010643"
        );
    }
}
