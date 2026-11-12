use std::sync::{Arc, Mutex};

use tapd_core::{
    config::{AppConfig, ConfigStore},
    paths::AppPaths,
    runtime::RuntimeInfo,
};

use crate::cache::Cache;
use crate::mcp_audit::McpAudit;

/// Shared state for Tauri commands, the local HTTP server and the session watcher.
pub struct AppState {
    pub paths: AppPaths,
    pub config_store: ConfigStore,
    pub config: Mutex<AppConfig>,
    pub runtime: Mutex<Option<RuntimeInfo>>,
    /// Runtime state of the companion LAN server (port, task, one-time code).
    pub companion: Mutex<crate::companion::CompanionRuntime>,
    /// Offline snapshot cache (projects/bugs). Disabled if SQLite failed to open.
    pub cache: Arc<Cache>,
    /// Bounded MCP call audit log.
    pub mcp_audit: McpAudit,
}

impl AppState {
    pub fn new(paths: AppPaths, config_store: ConfigStore, config: AppConfig) -> Self {
        let cache = Arc::new(Cache::open(paths.data_dir.join("cache.sqlite3")));
        let mcp_audit = McpAudit::load(cache.clone());
        Self {
            paths,
            config_store,
            config: Mutex::new(config),
            runtime: Mutex::new(None),
            companion: Mutex::new(crate::companion::CompanionRuntime::default()),
            cache,
            mcp_audit,
        }
    }

    pub fn config_snapshot(&self) -> AppConfig {
        self.config.lock().expect("config lock").clone()
    }

    /// Mutates the config under its lock and persists before releasing it.
    ///
    /// Every writer must go through this helper: cloning under the lock and
    /// saving afterwards lets concurrent writers persist stale snapshots (for
    /// example flipping `loggedIn` back to false mid-login).
    pub fn update_config<T>(
        &self,
        mutate: impl FnOnce(&mut AppConfig) -> T,
    ) -> std::io::Result<T> {
        let mut config = self.config.lock().expect("config lock");
        let output = mutate(&mut config);
        self.config_store.save(&config)?;
        Ok(output)
    }

    pub fn runtime_info(&self) -> Option<RuntimeInfo> {
        self.runtime.lock().expect("runtime lock").clone()
    }
}

pub type SharedState = Arc<AppState>;
