//! Auto-update: GitHub Releases checks, progress reporting and install flow.
//!
//! Tauri's updater plugin reads its endpoint and public key from
//! `tauri.conf.json`. This module owns everything around it:
//!
//! - checks once shortly after launch and then every two hours, persisting the
//!   request time in `config.json`;
//! - keeps a single state machine (`UpdateService`) that the main window and
//!   the island capsule both subscribe to (`update://state`);
//! - while downloading/installing/erroring, hides the main window and blocks
//!   every path that could reopen it, morphing the island into a 3x progress
//!   panel instead;
//! - on failure the capsule offers manual download and cancel; cancel restores
//!   the main window and the update can be retried from Settings.
//!
//! The plugin installs the new bundle on macOS but does not relaunch, so a
//! successful install calls `AppHandle::restart`.

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use chrono::Local;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::{notification, state::SharedState};

const RELEASES_URL: &str = "https://github.com/wwog/tapd_client/releases";
const CHECK_INTERVAL: Duration = Duration::from_secs(2 * 60 * 60);
/// Let the window manager settle before the first background check.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(5);
const STATE_EVENT: &str = "update://state";

static SERVICE: OnceLock<Arc<UpdateService>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    /// No update (or not checked yet).
    #[default]
    Idle,
    Checking,
    /// A newer release is known and ready to install.
    Available,
    Downloading,
    Installing,
    /// Package installed; the process is about to restart.
    Ready,
    /// Install failed. The main window stays hidden until the user cancels.
    Error,
}

impl UpdatePhase {
    /// Phases that own the screen: main hidden, island expanded.
    fn owns_screen(self) -> bool {
        matches!(
            self,
            Self::Downloading | Self::Installing | Self::Ready | Self::Error
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub notes: String,
    pub date: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub received: u64,
    pub total: Option<u64>,
    pub percent: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: UpdatePhase,
    pub current_version: String,
    pub checked_at: Option<String>,
    pub available: Option<AvailableUpdate>,
    pub progress: Option<UpdateProgress>,
    pub error: Option<String>,
    /// Release page for the manual-download fallback.
    pub manual_url: String,
}

#[derive(Default)]
struct Inner {
    phase: UpdatePhase,
    checked_at: Option<String>,
    available: Option<AvailableUpdate>,
    progress: Option<UpdateProgress>,
    error: Option<String>,
    /// Last progress event time, used to throttle high-frequency chunks.
    last_emit: Option<Instant>,
}

pub struct UpdateService {
    app: AppHandle,
    state: SharedState,
    current_version: String,
    inner: Mutex<Inner>,
}

impl UpdateService {
    fn snapshot(&self) -> UpdateState {
        let inner = self.inner.lock().expect("update state lock");
        UpdateState {
            phase: inner.phase,
            current_version: self.current_version.clone(),
            checked_at: inner.checked_at.clone(),
            available: inner.available.clone(),
            progress: inner.progress.clone(),
            error: inner.error.clone(),
            manual_url: inner
                .available
                .as_ref()
                .map(|update| format!("{RELEASES_URL}/tag/v{}", update.version))
                .unwrap_or_else(|| format!("{RELEASES_URL}/latest")),
        }
    }

    fn emit(&self) {
        let _ = self.app.emit(STATE_EVENT, self.snapshot());
    }

    /// Applies a phase change and keeps the window choreography in sync.
    fn transition(&self, phase: UpdatePhase) {
        let previous = {
            let mut inner = self.inner.lock().expect("update state lock");
            let previous = inner.phase;
            inner.phase = phase;
            if !phase.owns_screen() {
                inner.progress = None;
                if phase != UpdatePhase::Error {
                    inner.error = None;
                }
            }
            previous
        };

        if previous.owns_screen() != phase.owns_screen() {
            if phase.owns_screen() {
                self.hide_main_and_show_island();
            } else {
                self.restore_main_and_island();
            }
        }
        self.emit();
    }

    fn hide_main_and_show_island(&self) {
        if let Some(main) = self.app.get_webview_window("main") {
            let _ = main.hide();
        }
        notification::set_update_mode(true);
        notification::refresh_island_layout(&self.app, &self.state);
    }

    fn restore_main_and_island(&self) {
        notification::set_update_mode(false);
        notification::refresh_island_layout(&self.app, &self.state);
        if let Some(main) = self.app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.unminimize();
            let _ = main.set_focus();
        }
    }

    fn set_progress(&self, received: u64, total: Option<u64>, force: bool) {
        let should_emit = {
            let mut inner = self.inner.lock().expect("update state lock");
            let now = Instant::now();
            let should_emit = force
                || inner
                    .last_emit
                    .map(|last| now.duration_since(last) >= Duration::from_millis(120))
                    .unwrap_or(true);
            if should_emit {
                inner.last_emit = Some(now);
            }
            let percent = total
                .filter(|total| *total > 0)
                .map(|total| ((received as f64 / total as f64) * 100.0).clamp(0.0, 100.0));
            inner.progress = Some(UpdateProgress {
                received,
                total,
                percent,
            });
            should_emit
        };
        if should_emit {
            self.emit();
        }
    }

    fn record_check_time(&self) {
        let now = Local::now().to_rfc3339();
        {
            let mut inner = self.inner.lock().expect("update state lock");
            inner.checked_at = Some(now.clone());
        }
        if let Err(error) = self
            .state
            .update_config(|config| config.last_update_check_at = Some(now))
        {
            tracing::warn!(%error, "failed to persist update check time");
        }
    }
}

/// True while an update owns the screen; the main window must stay hidden.
pub fn is_updating() -> bool {
    let Some(service) = SERVICE.get() else {
        return false;
    };
    let phase = service.inner.lock().expect("update state lock").phase;
    phase.owns_screen()
}

pub fn init(app: &AppHandle, state: SharedState) {
    let service = match SERVICE.get() {
        Some(service) => service.clone(),
        None => {
            let service = Arc::new(UpdateService {
                app: app.clone(),
                state: state.clone(),
                current_version: app.package_info().version.to_string(),
                inner: Mutex::new(Inner::default()),
            });
            let _ = SERVICE.set(service.clone());
            service
        }
    };

    // Restore the persisted check time so the UI can show it before the first
    // request completes.
    if let Some(checked_at) = state.config_snapshot().last_update_check_at {
        service.inner.lock().expect("update state lock").checked_at = Some(checked_at);
    }

    let app_for_loop = app.clone();
    let state_for_loop = state.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let phase = service.inner.lock().expect("update state lock").phase;
            if !phase.owns_screen() && phase != UpdatePhase::Checking {
                let _ = check(&app_for_loop, &state_for_loop, false).await;
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

async fn check(app: &AppHandle, state: &SharedState, manual: bool) -> Result<UpdateState, String> {
    let service = SERVICE
        .get()
        .ok_or_else(|| "update service not initialized".to_string())?;

    {
        let phase = service.inner.lock().expect("update state lock").phase;
        if phase.owns_screen() || phase == UpdatePhase::Checking {
            return Ok(service.snapshot());
        }
        service.inner.lock().expect("update state lock").phase = UpdatePhase::Checking;
    }
    service.emit();

    let result = check_inner(app).await;

    match result {
        Ok(Some(update)) => {
            {
                let mut inner = service.inner.lock().expect("update state lock");
                inner.available = Some(update);
                inner.error = None;
            }
            service.record_check_time();
            service.transition(UpdatePhase::Available);
        }
        Ok(None) => {
            {
                let mut inner = service.inner.lock().expect("update state lock");
                inner.available = None;
                inner.error = None;
            }
            service.record_check_time();
            service.transition(UpdatePhase::Idle);
        }
        Err(error) => {
            tracing::warn!(%error, manual, "update check failed");
            service.record_check_time();
            {
                let mut inner = service.inner.lock().expect("update state lock");
                inner.error = Some(error.clone());
            }
            // A failed background check is not worth a modal; stay idle and
            // let Settings show the message. Manual checks deserve the same
            // quiet treatment because the toast is rendered from this state.
            service.transition(UpdatePhase::Idle);
            if manual {
                return Err(error);
            }
        }
    }

    let _ = state;
    Ok(service.snapshot())
}

async fn check_inner(app: &AppHandle) -> Result<Option<AvailableUpdate>, String> {
    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    Ok(update.map(|update| {
        let notes = update
            .body
            .as_ref()
            .map(|body| body.trim().to_string())
            .filter(|body| !body.is_empty())
            .unwrap_or_else(|| "该版本没有提供更新说明。".to_string());
        AvailableUpdate {
            version: update.version,
            notes,
            date: update.date.map(|date| date.to_string()),
        }
    }))
}

#[tauri::command]
pub fn update_state() -> Result<UpdateState, String> {
    SERVICE
        .get()
        .map(|service| service.snapshot())
        .ok_or_else(|| "update service not initialized".to_string())
}

#[tauri::command]
pub async fn update_check() -> Result<UpdateState, String> {
    let service = SERVICE
        .get()
        .ok_or_else(|| "update service not initialized".to_string())?;
    check(&service.app, &service.state, true).await
}

/// Starts downloading/installing the known update. Returns immediately; the
/// UI follows `update://state`.
#[tauri::command]
pub fn update_install() -> Result<UpdateState, String> {
    let service = SERVICE
        .get()
        .ok_or_else(|| "update service not initialized".to_string())?
        .clone();

    {
        let inner = service.inner.lock().expect("update state lock");
        if inner.phase.owns_screen() {
            return Ok(service.snapshot());
        }
        if inner.available.is_none() {
            return Err("当前没有可用的更新".to_string());
        }
    }

    service.transition(UpdatePhase::Downloading);
    {
        let mut inner = service.inner.lock().expect("update state lock");
        inner.error = None;
        inner.progress = Some(UpdateProgress::default());
    }
    service.emit();

    let service_for_task = service.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = install(&service_for_task).await {
            tracing::error!(%error, "update install failed");
            {
                let mut inner = service_for_task.inner.lock().expect("update state lock");
                inner.error = Some(error);
            }
            service_for_task.transition(UpdatePhase::Error);
        }
    });

    Ok(service.snapshot())
}

async fn install(service: &Arc<UpdateService>) -> Result<(), String> {
    let app = &service.app;

    // Re-check so a stale "available" banner cannot install a release that was
    // withdrawn, and to obtain a fresh Update handle.
    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "当前没有可用的更新".to_string())?;

    // 0 means "unknown" for the total; the manifest usually sends a length.
    let received = Arc::new(AtomicU64::new(0));
    let reported_total = Arc::new(AtomicU64::new(0));
    let service_for_chunk = service.clone();
    let service_for_finish = service.clone();
    let received_for_chunk = received.clone();
    let total_for_chunk = reported_total.clone();

    update
        .download_and_install(
            move |chunk_length, content_length| {
                let downloaded = received_for_chunk
                    .fetch_add(chunk_length as u64, Ordering::SeqCst)
                    + chunk_length as u64;
                if let Some(total) = content_length {
                    total_for_chunk.store(total, Ordering::SeqCst);
                }
                let total = match total_for_chunk.load(Ordering::SeqCst) {
                    0 => None,
                    total => Some(total),
                };
                service_for_chunk.set_progress(downloaded, total, false);
            },
            move || {
                let total = match reported_total.load(Ordering::SeqCst) {
                    0 => None,
                    total => Some(total),
                };
                service_for_finish.set_progress(received.load(Ordering::SeqCst), total, true);
                service_for_finish.transition(UpdatePhase::Installing);
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    service.transition(UpdatePhase::Ready);
    // Give the capsule a moment to show 100% before the process exits.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    service.app.restart();
}

/// Dismisses a failed install: restores the main window and keeps the update
/// available for a retry.
#[tauri::command]
pub fn update_cancel() -> Result<UpdateState, String> {
    let service = SERVICE
        .get()
        .ok_or_else(|| "update service not initialized".to_string())?;

    {
        let inner = service.inner.lock().expect("update state lock");
        if inner.phase != UpdatePhase::Error {
            return Ok(service.snapshot());
        }
    }

    {
        let mut inner = service.inner.lock().expect("update state lock");
        inner.error = None;
        inner.progress = None;
    }
    service.transition(UpdatePhase::Available);
    Ok(service.snapshot())
}

/// Opens the manual-download page in the default browser.
#[tauri::command]
pub fn update_open_manual() -> Result<(), String> {
    let url = SERVICE
        .get()
        .map(|service| service.snapshot().manual_url)
        .unwrap_or_else(|| format!("{RELEASES_URL}/latest"));
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}
