use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// All local paths used by the client.
///
/// macOS layout:
/// - data:    ~/Library/Application Support/com.tapdclient.desktop
/// - exports: ~/Documents/TAPDClient/exports
///
/// Debug builds (all `pnpm dev` runs) use a sibling `_dev` data directory, so a
/// development login/cache can never make an installed release build believe it
/// is still signed in.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub captures_dir: PathBuf,
    pub exports_dir: PathBuf,
    /// Per-task git worktrees, inside the data directory so a reset removes
    /// them together with the rest of the agent state.
    #[serde(default)]
    pub worktrees_dir: PathBuf,
    pub runtime_file: PathBuf,
    pub config_file: PathBuf,
}

impl AppPaths {
    pub fn resolve() -> std::io::Result<Self> {
        let home = home_dir()?;
        #[cfg(debug_assertions)]
        let app_data_name = "com.tapdclient.desktop_dev";
        #[cfg(not(debug_assertions))]
        let app_data_name = "com.tapdclient.desktop";

        #[cfg(target_os = "macos")]
        let data_dir = home.join("Library/Application Support").join(app_data_name);
        #[cfg(target_os = "windows")]
        let data_dir = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join(app_data_name);
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        let data_dir = home.join(".local/share").join(app_data_name);

        let logs_dir = data_dir.join("logs");
        let captures_dir = data_dir.join("captures");
        let exports_dir = home.join("Documents/TAPDClient/exports");
        let worktrees_dir = data_dir.join("worktrees");
        let runtime_file = data_dir.join("runtime.json");
        let config_file = data_dir.join("config.json");

        let paths = Self {
            data_dir,
            logs_dir,
            captures_dir,
            exports_dir,
            worktrees_dir,
            runtime_file,
            config_file,
        };
        paths.ensure_dirs()?;
        Ok(paths)
    }

    /// Creates the directories this app writes to. Safe to call repeatedly;
    /// used after a reset wipes the data directory.
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        for dir in [
            &self.data_dir,
            &self.logs_dir,
            &self.captures_dir,
            &self.exports_dir,
            &self.worktrees_dir,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}

/// User home directory (`HOME`, falling back to `USERPROFILE` on Windows).
pub fn home_dir() -> std::io::Result<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        return Ok(PathBuf::from(home));
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        return Ok(PathBuf::from(home));
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "cannot determine home directory",
    ))
}

/// Expands a leading `~/` so hand-typed paths behave like the folder picker's.
pub fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => match home_dir() {
            Ok(home) => home.join(rest),
            Err(_) => PathBuf::from(path),
        },
        None => PathBuf::from(path),
    }
}
