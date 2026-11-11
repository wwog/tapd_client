//! Support bundle export.
//!
//! Writes a redacted diagnostic folder (and a zip when `ditto` is available)
//! containing app/system metadata, sanitized settings, recent logs and the MCP
//! audit log. Cookies, the local API token and request bodies are never copied.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::SystemTime,
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::state::SharedState;

const MAX_LOG_BYTES: usize = 1_500_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsResult {
    /// The zip when compression succeeded, otherwise the folder.
    pub path: String,
    pub folder: String,
    pub files: usize,
    pub bytes: u64,
    pub zipped: bool,
}

#[tauri::command]
pub fn export_diagnostics(state: State<'_, SharedState>) -> Result<DiagnosticsResult, String> {
    export_bundle(state.inner())
}

fn export_bundle(state: &SharedState) -> Result<DiagnosticsResult, String> {
    let paths = &state.paths;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let root = paths.data_dir.join("diagnostics");
    let folder = root.join(format!("tapd-client-{stamp}"));
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;

    write_json(&folder.join("meta.json"), &meta(state))?;
    write_json(&folder.join("config.sanitized.json"), &sanitized_config(state))?;
    write_json(
        &folder.join("notifications.settings.json"),
        &crate::notification::settings_for_diagnostics(state),
    )?;
    write_json(
        &folder.join("agent.summary.json"),
        &agent_summary(&paths.data_dir),
    )?;

    // Audit rows live in SQLite now; export a snapshot into the bundle.
    if let Err(error) = state.mcp_audit.export(&folder.join("mcp-audit.json")) {
        tracing::warn!(%error, "failed to export MCP audit for diagnostics");
    }

    let logs_dir = folder.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|error| error.to_string())?;
    copy_recent_logs(&paths.logs_dir, &logs_dir);

    fs::write(
        folder.join("README.txt"),
        "TAPD Client 诊断包\n\
         \n\
         包含：版本/系统信息、脱敏配置、通知设置、Agent 摘要、MCP 审计日志和最近的应用日志。\n\
         不包含：TAPD Cookie、本地 API token、请求/响应正文、评论正文、导出资源。\n\
         日志中可能包含 TAPD 页面 URL、项目 ID 与缺陷 ID；提交前请自行确认。\n",
    )
    .map_err(|error| error.to_string())?;

    let (files, bytes) = folder_stats(&folder)?;
    let zip_path = root.join(format!("tapd-client-{stamp}.zip"));
    let zipped = compress(&folder, &zip_path);
    if zipped {
        let _ = fs::remove_dir_all(&folder);
        Ok(DiagnosticsResult {
            path: zip_path.to_string_lossy().to_string(),
            folder: root.to_string_lossy().to_string(),
            files,
            bytes,
            zipped: true,
        })
    } else {
        Ok(DiagnosticsResult {
            path: folder.to_string_lossy().to_string(),
            folder: folder.to_string_lossy().to_string(),
            files,
            bytes,
            zipped: false,
        })
    }
}

fn meta(state: &SharedState) -> Value {
    let runtime = state.runtime_info();
    let cache = state.paths.data_dir.join("cache.sqlite3");
    json!({
        "generatedAt": chrono::Local::now().to_rfc3339(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "pid": std::process::id(),
        "runtime": runtime.map(|info| json!({
            "port": info.port,
            "startedAt": info.started_at,
        })),
        "cache": file_meta(&cache),
        "dataDir": state.paths.data_dir,
        "logsDir": state.paths.logs_dir,
    })
}

fn sanitized_config(state: &SharedState) -> Value {
    let config = state.config_snapshot();
    json!({
        "loggedIn": config.logged_in,
        "me": config.me,
        "onboarded": config.onboarded,
        "lastWorkspaceId": config.last_workspace_id,
        "deviceName": config.device_name,
        "openWith": config.open_with,
        "islandAnchor": config.island_anchor,
        "hiddenWorkspaceIds": config.hidden_workspace_ids,
        "mcpPolicy": config.mcp_policy,
    })
}

fn agent_summary(data_dir: &Path) -> Value {
    let raw = fs::read_to_string(data_dir.join("agent.json")).ok();
    let Some(value) = raw.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else {
        return Value::Null;
    };

    let projects = value
        .get("projects")
        .and_then(Value::as_object)
        .map(|projects| {
            projects
                .iter()
                .map(|(workspace, entry)| {
                    json!({
                        "workspaceId": workspace,
                        "repoPath": entry.get("repoPath"),
                        "hasRule": entry
                            .get("rule")
                            .and_then(Value::as_str)
                            .map(|rule| !rule.trim().is_empty())
                            .unwrap_or(false),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    json!({
        "binaryPath": value.get("binaryPath"),
        "readyQuietMs": value.get("readyQuietMs"),
        "readyTimeoutMs": value.get("readyTimeoutMs"),
        "projects": projects,
        "queueConcurrency": 1,
    })
}

fn copy_recent_logs(source: &Path, target: &Path) {
    let Ok(entries) = fs::read_dir(source) else {
        return;
    };

    let mut logs: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().to_string();
            if !name.starts_with("tapd-client.log") {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect();
    logs.sort_by(|a, b| b.0.cmp(&a.0));

    for (_, path) in logs.into_iter().take(2) {
        let Some(name) = path.file_name() else {
            continue;
        };
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let tail = if text.len() > MAX_LOG_BYTES {
            let start = text.len().saturating_sub(MAX_LOG_BYTES);
            let start = text
                .char_indices()
                .find(|(index, _)| *index >= start)
                .map(|(index, _)| index)
                .unwrap_or(0);
            format!("[truncated to last {MAX_LOG_BYTES} bytes]\n{}", &text[start..])
        } else {
            text
        };
        let _ = fs::write(target.join(name), tail);
    }
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())
}

fn file_meta(path: &Path) -> Value {
    fs::metadata(path)
        .ok()
        .map(|meta| {
            json!({
                "path": path,
                "bytes": meta.len(),
                "modified": meta.modified().ok().map(|time| {
                    chrono::DateTime::<chrono::Local>::from(time).to_rfc3339()
                }),
            })
        })
        .unwrap_or(Value::Null)
}

fn folder_stats(root: &Path) -> Result<(usize, u64), String> {
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|error| error.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(meta) = entry.metadata() {
                files += 1;
                bytes += meta.len();
            }
        }
    }

    Ok((files, bytes))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tapd_core::{
        config::{AppConfig, ConfigStore},
        paths::AppPaths,
    };

    use crate::state::AppState;

    #[test]
    fn bundle_is_written_and_never_copies_runtime_token() {
        let root = std::env::temp_dir().join(format!(
            "tapd-diag-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let data = root.join("data");
        let logs = data.join("logs");
        let exports = root.join("exports");
        fs::create_dir_all(&logs).unwrap();
        fs::create_dir_all(&exports).unwrap();

        fs::write(logs.join("tapd-client.log.2026-01-01"), "hello log\n").unwrap();
        fs::write(
            data.join("agent.json"),
            r#"{"binaryPath":"opencode","projects":{"1":{"repoPath":"/tmp","rule":""}}}"#,
        )
        .unwrap();
        fs::write(data.join("runtime.json"), r#"{"token":"super-secret"}"#).unwrap();

        let paths = AppPaths {
            data_dir: data.clone(),
            logs_dir: logs,
            captures_dir: data.join("captures"),
            exports_dir: exports,
            runtime_file: data.join("runtime.json"),
            config_file: data.join("config.json"),
        };
        let store = ConfigStore::new(paths.config_file.clone());
        let state: SharedState = Arc::new(AppState::new(paths, store, AppConfig::default()));
        state
            .mcp_audit
            .record(crate::mcp_audit::McpAuditEntry {
                id: "audit-1".to_string(),
                ts: "2026-01-01T00:00:00Z".to_string(),
                tool: "tapd_whoami".to_string(),
                client: "zcode".to_string(),
                decision: "allowed".to_string(),
                ok: true,
                duration_ms: 1,
                workspace_id: None,
                bug_id: None,
                error: None,
                summary: serde_json::json!({}),
            })
            .expect("record audit");

        let result = export_bundle(&state).unwrap();
        assert!(result.files >= 5, "expected meta/settings/log files");
        assert!(Path::new(&result.path).exists());

        if result.zipped {
            let listing = Command::new("unzip")
                .args(["-Z1", &result.path])
                .output()
                .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
                .unwrap_or_default();
            assert!(listing.contains("meta.json"));
            assert!(listing.contains("mcp-audit.json"));
            assert!(
                !listing.contains("runtime.json"),
                "runtime token must never be copied"
            );
        } else {
            let folder = fs::read_dir(&result.folder)
                .expect("diagnostics root")
                .flatten()
                .map(|entry| entry.path())
                .find(|path| path.is_dir())
                .expect("bundle folder");
            assert!(folder.join("mcp-audit.json").exists());
            assert!(!folder.join("runtime.json").exists());
        }

        let _ = fs::remove_dir_all(&root);
    }
}
