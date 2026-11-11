//! Shared temp-dir helpers for the import tests.

use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use super::{client_spec, ensure_in_file};
use super::merge::MergeOutcome;

pub(super) fn temp_dir(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "tapd-mcp-import-{name}-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

pub(super) fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

pub(super) fn backup_files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .expect("read temp dir")
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.to_string_lossy().contains(".bak-"))
        .collect()
}

/// Runs the spec's real import path against an explicit file.
pub(super) fn ensure_for(
    client: &str,
    path: &Path,
    command_path: &str,
) -> Result<MergeOutcome, String> {
    ensure_in_file(
        client_spec(client).expect("known client"),
        path,
        command_path,
    )
}
