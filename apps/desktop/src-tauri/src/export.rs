//! Bug export pipeline: fetch the bug, lay out the package directory, download
//! media and write `bug.json` + `assets/`.
//!
//! Directory naming lives in [`paths`], a single asset transfer in
//! [`download`] and the fix prompt in [`prompt`]; this file only sequences them.

use std::{collections::HashSet, time::Duration};

use serde::Serialize;
use tapd_core::{
    export::{collect_media, MediaAsset},
    tapd::BugDetail,
};
use tapd_i18n::{tr, tr_args};
use tauri::{AppHandle, Manager, State};

use crate::{media, session, state::SharedState};

mod download;
pub(crate) mod paths;
pub(crate) mod prompt;

use download::download_one;
use paths::{bug_export_dir, bug_reference, workspace_label};

const MAX_TOTAL_BYTES: u64 = 300 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub dir: String,
    pub bug_json: String,
    pub asset_count: usize,
    pub downloaded_bytes: u64,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn export_bug(
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
    let detail = crate::commands::bugs::fetch_bug_detail(app, workspace_id, bug_id).await?;
    export_detail(app, paths, workspace_id, workspace_name, &detail).await
}

/// Writes the package for an already-fetched bug.
///
/// `tapd_get_bug` needs the same detail for its prompt and would otherwise
/// fetch it twice; it calls this and renders the prompt from `detail`.
pub(crate) async fn export_detail(
    app: &AppHandle,
    paths: &tapd_core::paths::AppPaths,
    workspace_id: &str,
    workspace_name: Option<String>,
    detail: &BugDetail,
) -> Result<ExportResult, String> {
    let label = workspace_label(workspace_name, detail, workspace_id);
    let bug_ref = bug_reference(&detail.summary);
    let bug_dir = bug_export_dir(paths, workspace_id, &label, &bug_ref, &detail.summary.title);

    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| tr("app.session.window").to_string())?;
    let cookie = session::cookie_header(&window)?;

    let assets_dir = bug_dir.join("assets");
    std::fs::create_dir_all(&assets_dir).map_err(|error| error.to_string())?;

    let client = reqwest::Client::builder()
        .user_agent(media::USER_AGENT)
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| error.to_string())?;

    let media = collect_media(detail);
    let mut assets: Vec<MediaAsset> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut used_names: HashSet<String> = HashSet::new();
    let mut total_bytes: u64 = 0;
    let mut media_index = 0usize;

    for item in media {
        if total_bytes >= MAX_TOTAL_BYTES {
            warnings.push(tr("app.export.limit").to_string());
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
            Err(error) => warnings.push(tr_args("app.error.labeled", &[&item.filename_hint, &error])),
        }
    }

    // Written after the downloads so `assets` lists exactly what landed on disk.
    let json_path = bug_dir.join("bug.json");
    let bytes = bug_json_bytes(detail, &assets)?;
    std::fs::write(&json_path, bytes).map_err(|error| error.to_string())?;

    tracing::info!(
        bug_id = %detail.summary.id,
        assets = assets.len(),
        bytes = total_bytes,
        path = %bug_dir.display(),
        "bug exported"
    );

    Ok(ExportResult {
        dir: bug_dir.to_string_lossy().to_string(),
        bug_json: json_path.to_string_lossy().to_string(),
        asset_count: assets.len(),
        downloaded_bytes: total_bytes,
        warnings,
    })
}

/// `bug.json` payload: the detail untouched, plus the assets that were
/// downloaded under a top-level `assets` key.
fn bug_json_bytes(detail: &BugDetail, assets: &[MediaAsset]) -> Result<Vec<u8>, String> {
    let mut json = serde_json::to_value(detail).map_err(|error| error.to_string())?;
    json["assets"] = serde_json::to_value(assets).map_err(|error| error.to_string())?;
    serde_json::to_vec_pretty(&json).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::bug_json_bytes;
    use tapd_core::{
        export::{MediaAsset, MediaKind},
        tapd::BugDetail,
    };

    #[test]
    fn bug_json_is_camel_case_detail_plus_assets() {
        let asset = MediaAsset {
            url: "https://file.tapd.cn/a.png".to_string(),
            relative_path: "assets/a.png".to_string(),
            filename: "a.png".to_string(),
            kind: MediaKind::Image,
            size: 3,
            content_type: "image/png".to_string(),
        };

        let bytes = bug_json_bytes(&BugDetail::default(), &[asset]).expect("serialize");
        let json: serde_json::Value = serde_json::from_slice(&bytes).expect("valid json");

        assert!(
            json.get("descriptionHtml").is_some(),
            "detail keeps its camelCase shape"
        );
        let assets = json["assets"].as_array().expect("assets array");
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0]["relativePath"], "assets/a.png");
        assert_eq!(assets[0]["contentType"], "image/png");
    }

    #[test]
    fn bug_json_keeps_an_empty_assets_array() {
        let bytes = bug_json_bytes(&BugDetail::default(), &[]).expect("serialize");
        let json: serde_json::Value = serde_json::from_slice(&bytes).expect("valid json");
        assert_eq!(json["assets"], serde_json::json!([]));
    }
}
