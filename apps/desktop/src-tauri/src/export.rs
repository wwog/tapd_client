//! Bug export pipeline: fetch the bug, lay out the package directory, download
//! media and write `bug.md` / `bug.json`.
//!
//! Directory naming lives in [`paths`] and a single asset transfer in
//! [`download`]; this file only sequences them.

use std::{collections::HashSet, time::Duration};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tapd_core::{
    export::{collect_media, render_markdown, MediaAsset},
    tapd::BugDetail,
};

use crate::{media, session, state::SharedState};

mod download;
pub(crate) mod paths;

use download::download_one;
use paths::{bug_export_dir, bug_reference, workspace_label};


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

async fn fetch_detail(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<BugDetail, String> {
    crate::commands::bugs::fetch_bug_detail(app, workspace_id, bug_id).await
}
