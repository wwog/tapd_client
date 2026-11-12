use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Revision of the first-run guide. Bump it whenever the guide changes so every
/// client sees the new flow once after upgrading.
pub const ONBOARDING_VERSION: u32 = 2;

/// Persistent user configuration. Secrets are never stored here.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// Whether the embedded TAPD session has been verified.
    pub logged_in: bool,
    /// TAPD nickname of the signed-in user, when known.
    pub me: Option<String>,
    /// Cached avatar URL (from the WeCom scan panel) for the local user.
    pub me_avatar: Option<String>,
    /// Last selected workspace, restored on launch.
    pub last_workspace_id: Option<String>,
    /// Last known TAPD page URL (used for diagnostics only).
    pub last_session_url: Option<String>,
    /// Request capture used during the API discovery phase.
    pub capture_enabled: bool,
    /// Onboarding revision the user last completed; `0` = never. The guide is
    /// shown again whenever this differs from [`ONBOARDING_VERSION`].
    pub onboarded_version: u32,
    /// Name shown in the UI; purely cosmetic.
    pub device_name: Option<String>,
    /// Chosen "open with" target per resource kind (`image` / `video` / `file`);
    /// missing means the system default app.
    pub open_with: BTreeMap<String, String>,
    /// Where the user dragged the status capsule: physical pixels of the
    /// island's (centre x, top y). `None` = top-centre default.
    pub island_anchor: Option<(i32, i32)>,
    /// Last main-window geometry, restored on the next launch.
    pub main_window: Option<WindowGeometry>,
    /// TAPD workspaces hidden from the left project list (local preference).
    pub hidden_workspace_ids: Vec<String>,
    /// Capability boundary enforced for every MCP tool call.
    pub mcp_policy: McpPolicy,
    /// RFC 3339 time of the last successful update check (GitHub Releases).
    pub last_update_check_at: Option<String>,
    /// Mandatory update the client has been told about (the release notes
    /// carried the force marker). Persisted so the upgrade modal survives a
    /// restart and stays visible while offline.
    pub forced_update: Option<ForcedUpdate>,
    /// Frontend-owned UI preferences (theme, bug list columns/filters/sort).
    ///
    /// Kept here instead of the WebView's localStorage because logging out
    /// clears all WebView browsing data. The schema belongs to the frontend;
    /// the backend only stores the blob.
    pub ui_prefs: serde_json::Value,
}

/// A release the client must install before it can keep being used.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ForcedUpdate {
    /// Target version, e.g. `1.1.2`.
    pub version: String,
    /// RFC 3339 time when this client first recorded the requirement.
    pub recorded_at: String,
}

/// Main-window size (logical points) and position (physical pixels).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowGeometry {
    pub width: f64,
    pub height: f64,
    pub x: i32,
    pub y: i32,
}

/// Policy for the MCP sidecar bridge. Filters can only narrow access; TAPD's
/// own permissions always apply on top.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpPolicy {
    /// Allow comment / status write-back tools. Read tools stay available.
    pub writes_enabled: bool,
    /// Record every tool call in the local audit log.
    pub audit_enabled: bool,
    /// Workspace ids the MCP tools may touch. Empty = every project.
    pub allowed_workspace_ids: Vec<String>,
    /// Status keys/labels allowed for `tapd_update_bug_status`.
    /// Empty = TAPD's workflow decides.
    pub allowed_statuses: Vec<String>,
}

impl Default for McpPolicy {
    fn default() -> Self {
        Self {
            writes_enabled: true,
            audit_enabled: true,
            allowed_workspace_ids: Vec::new(),
            allowed_statuses: Vec::new(),
        }
    }
}

impl McpPolicy {
    /// Normalizes user-entered ids/labels (trim, drop empties/duplicates).
    pub fn normalized(mut self) -> Self {
        self.allowed_workspace_ids = normalize_list(self.allowed_workspace_ids);
        self.allowed_statuses = normalize_list(self.allowed_statuses);
        self
    }

    pub fn allows_workspace(&self, workspace_id: &str) -> bool {
        self.allowed_workspace_ids.is_empty()
            || self
                .allowed_workspace_ids
                .iter()
                .any(|allowed| allowed == workspace_id.trim())
    }

    pub fn allows_status(&self, status: &str) -> bool {
        if self.allowed_statuses.is_empty() {
            return true;
        }
        let target = status.trim();
        self.allowed_statuses
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(target) || allowed == target)
    }
}

fn normalize_list(values: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() || out.iter().any(|item| item == trimmed) {
            continue;
        }
        out.push(trimmed.to_string());
    }
    out
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            logged_in: false,
            me: None,
            me_avatar: None,
            last_workspace_id: None,
            last_session_url: None,
            capture_enabled: true,
            onboarded_version: 0,
            device_name: None,
            open_with: BTreeMap::new(),
            island_anchor: None,
            main_window: None,
            hidden_workspace_ids: Vec::new(),
            mcp_policy: McpPolicy::default(),
            last_update_check_at: None,
            forced_update: None,
            ui_prefs: serde_json::Value::Null,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> AppConfig {
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => {
                let mut config: AppConfig = serde_json::from_str(&raw).unwrap_or_default();
                // Configs written before revision tracking used `onboarded: true`
                // for the first guide. Keep that as revision 1 so an upgrade to
                // revision 2 still shows the new flow exactly once.
                if config.onboarded_version == 0 && legacy_onboarded(&raw) {
                    config.onboarded_version = 1;
                }
                config
            }
            Err(_) => AppConfig::default(),
        }
    }

    pub fn save(&self, config: &AppConfig) -> io::Result<()> {
        let raw = serde_json::to_vec_pretty(config)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(&raw)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// Reads the pre-revision `onboarded` flag out of a raw config document.
fn legacy_onboarded(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.get("onboarded").and_then(|flag| flag.as_bool()))
        .unwrap_or(false)
}

#[cfg(test)]
mod policy_tests {
    use super::McpPolicy;

    #[test]
    fn policy_narrows_workspaces_and_statuses() {
        let policy = McpPolicy {
            allowed_workspace_ids: vec![" 45336192 ".into(), "45336192".into(), "".into()],
            allowed_statuses: vec!["resolved".into(), " 已解决 ".into()],
            ..McpPolicy::default()
        }
        .normalized();

        assert_eq!(policy.allowed_workspace_ids, vec!["45336192"]);
        assert!(policy.allows_workspace("45336192"));
        assert!(!policy.allows_workspace("999"));
        assert!(policy.allows_status("resolved"));
        assert!(policy.allows_status("已解决"));
        assert!(!policy.allows_status("closed"));
    }

    #[test]
    fn empty_filters_mean_no_restriction() {
        let policy = McpPolicy::default();
        assert!(policy.allows_workspace("anything"));
        assert!(policy.allows_status("anything"));
        assert!(policy.writes_enabled);
    }
}

#[cfg(test)]
mod onboarding_tests {
    use super::*;

    fn temp_store(name: &str) -> ConfigStore {
        let path = std::env::temp_dir().join(format!(
            "tapd-config-test-{name}-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ));
        ConfigStore::new(path)
    }

    #[test]
    fn legacy_flag_migrates_to_first_revision() {
        let store = temp_store("legacy");
        std::fs::write(store.path(), r#"{"onboarded": true}"#).expect("write config");
        assert_eq!(store.load().onboarded_version, 1);
        let _ = std::fs::remove_file(store.path());
    }

    #[test]
    fn missing_version_means_never_onboarded() {
        let store = temp_store("fresh");
        std::fs::write(store.path(), r#"{"onboarded": false}"#).expect("write config");
        assert_eq!(store.load().onboarded_version, 0);
        let _ = std::fs::remove_file(store.path());
    }

    #[test]
    fn stored_version_wins_over_legacy_flag() {
        let store = temp_store("versioned");
        std::fs::write(
            store.path(),
            r#"{"onboarded": true, "onboardedVersion": 2}"#,
        )
        .expect("write config");
        assert_eq!(store.load().onboarded_version, 2);
        let _ = std::fs::remove_file(store.path());
    }
}
