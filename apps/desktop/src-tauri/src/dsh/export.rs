//! `/export` for one session: the raw dsh session log, packed as a ZIP.
//!
//! dsh desktop's `/export` downloads `<session>.zip` from a host route this app
//! does not consume, so the equivalent is built here: stage the log file the
//! runtime already wrote, archive the folder with `ditto` (the same helper the
//! diagnostic bundle uses), and hand back the path for Finder reveal.
//!
//! A machine without `ditto` keeps the staging folder and reports it, exactly
//! like the diagnostic bundle does — a readable log beats a failed export.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use tauri::AppHandle;
use tapd_i18n::{tr, tr_args};

/// Writes `<dir>/dsh-session-<short>-<stamp>.zip` (or the staging folder when
/// `ditto` is unavailable). Nothing outside `dir` is created or removed.
pub fn export(app: &AppHandle, session_id: &str, dir: &Path) -> Result<Value, String> {
    let sessions_dir = super::session_log::dir(app)
        .ok_or_else(|| tr("dsh.export.noRuntime").to_string())?;
    let log = super::session_log::path(&sessions_dir, session_id)
        .ok_or_else(|| tr("dsh.export.noLog").to_string())?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;

    let short: String = session_id.chars().take(8).collect();
    let stamp = stamp();
    let folder = dir.join(format!("dsh-session-{short}-{stamp}"));
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let name = log
        .file_name()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("session.v4.jsonl.zstd"));
    let copied = folder.join(&name);
    if let Err(error) = fs::copy(&log, &copied) {
        let _ = fs::remove_dir_all(&folder);
        return Err(tr_args(
            "dsh.export.copyFailed",
            &[&error.to_string()],
        ));
    }
    let bytes = fs::metadata(&copied).map(|meta| meta.len()).unwrap_or(0);

    let zip = dir.join(format!("dsh-session-{short}-{stamp}.zip"));
    let zipped = compress(&folder, &zip);
    if zipped {
        let _ = fs::remove_dir_all(&folder);
    }
    Ok(json!({
        "sessionId": session_id,
        "path": if zipped { zip.to_string_lossy().to_string() } else { folder.to_string_lossy().to_string() },
        "bytes": bytes,
        "zipped": zipped,
    }))
}

/// Uses the macOS `ditto` archive tool; returns false if it is unavailable.
fn compress(folder: &Path, zip: &Path) -> bool {
    Command::new("ditto")
        .args(["-c", "-k", "--sequesterRsrc", "--keepParent"])
        .arg(folder)
        .arg(zip)
        .status()
        .map(|status| status.success() && zip.exists())
        .unwrap_or(false)
}

/// `YYYYMMDD-HHMMSS` in UTC: fixed width, so folder names sort chronologically.
fn stamp() -> String {
    chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string()
}
