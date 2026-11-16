//! Auto-update: GitHub Releases checks, progress reporting and install flow.
//!
//! Tauri's updater plugin reads its endpoint and public key from
//! `tauri.conf.json`. This module owns everything around it:
//!
//! - checks on launch and then every two hours, persisting the request time in
//!   `config.json`;
//! - keeps a single state machine (`UpdateService`) that the main window and
//!   the island capsule both subscribe to (`update://state`);
//! - while downloading/installing/erroring, hides the main window and blocks
//!   every path that could reopen it, morphing the island into a 3x progress
//!   panel instead;
//! - on failure the capsule offers manual download and cancel; cancel restores
//!   the main window and the update can be retried from Settings;
//! - a release whose notes carry `FORCE_UPDATE_MARKER` is mandatory: the
//!   requirement is persisted in `config.json` and the UI shows an
//!   un-dismissable upgrade modal (also on the login screen).
//!
//! The plugin installs the new bundle on macOS but does not relaunch, so a
//! successful install calls `AppHandle::restart`.
//!
//! Layout: [`model`] holds the serialized state, [`notes`] the release-note and
//! version policy, and [`screen`] the window choreography. This file is the
//! state machine plus the Tauri commands.

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    time::{Duration, Instant},
};

use chrono::Local;
use tapd_i18n::tr;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::state::SharedState;

mod model;
mod notes;
mod screen;

use model::{AvailableUpdate, Inner, UpdatePhase, UpdateProgress, UpdateState};
use notes::{parse_notes, recorded_force};

const RELEASES_URL: &str = "https://github.com/wwog/tapd_client/releases";
const CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);
const STATE_EVENT: &str = "update://state";

/// First line of the release notes when the maintainer requires this update.
/// An HTML comment, so GitHub's rendered release page hides it; the client
/// strips it from the notes it displays and turns it into a mandatory upgrade.
pub const FORCE_UPDATE_MARKER: &str = "<!-- force-update -->";

static SERVICE: OnceLock<Arc<UpdateService>> = OnceLock::new();

pub struct UpdateService {
    app: AppHandle,
    state: SharedState,
    current_version: String,
    inner: Mutex<Inner>,
}

impl UpdateService {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().expect("update state lock")
    }

    fn snapshot(&self) -> UpdateState {
        let inner = self.lock();
        self.snapshot_locked(&inner)
    }

    /// Builds the public state from an already-held guard. Callers inside a
    /// `lock()` scope must use this: `snapshot()` would re-lock the same
    /// non-reentrant mutex and deadlock.
    fn snapshot_locked(&self, inner: &Inner) -> UpdateState {
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
            let mut inner = self.lock();
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
                screen::hide_main_and_show_island(&self.app, &self.state);
            } else {
                screen::restore_main_and_island(&self.app, &self.state);
            }
        }
        self.emit();
    }

    fn set_progress(&self, received: u64, total: Option<u64>, force: bool) {
        let should_emit = {
            let mut inner = self.lock();
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
            let mut inner = self.lock();
            inner.checked_at = Some(now.clone());
        }
        if let Err(error) = self
            .state
            .update_config(|config| config.last_update_check_at = Some(now))
        {
            tracing::warn!(%error, "failed to persist update check time");
        }
    }

    /// Persists a mandatory update so it survives restarts and reconnects.
    /// Repeated checks for the same version do not rewrite the config.
    fn record_forced_update(&self, version: &str) {
        let already = self
            .state
            .config_snapshot()
            .forced_update
            .as_ref()
            .is_some_and(|record| record.version == version);
        if already {
            return;
        }

        tracing::warn!(
            %version,
            current = %self.current_version,
            "release requires a forced update"
        );
        let recorded_at = Local::now().to_rfc3339();
        if let Err(error) = self.state.update_config(|config| {
            config.forced_update = Some(tapd_core::config::ForcedUpdate {
                version: version.to_string(),
                recorded_at,
            });
        }) {
            tracing::warn!(%error, "failed to persist the forced update record");
        }
    }
}

/// True while an update owns the screen; the main window must stay hidden.
pub fn is_updating() -> bool {
    let Some(service) = SERVICE.get() else {
        return false;
    };
    service.lock().phase.owns_screen()
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
        service.lock().checked_at = Some(checked_at);
    }

    // A mandatory update recorded in an earlier session is shown immediately,
    // even on the login screen and before the network check returns (or when
    // the machine is offline).
    if let Some(forced) = recorded_force(&state, &service.current_version) {
        let mut inner = service.lock();
        if inner.available.is_none() {
            inner.available = Some(forced);
            inner.phase = UpdatePhase::Available;
        }
    }

    let app_for_loop = app.clone();
    let state_for_loop = state.clone();
    tauri::async_runtime::spawn(async move {
        // Check as soon as the app opens: the login page must be able to show
        // a forced-update modal without waiting for the first interval.
        loop {
            let phase = service.lock().phase;
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
        let phase = service.lock().phase;
        if phase.owns_screen() || phase == UpdatePhase::Checking {
            return Ok(service.snapshot());
        }
    }
    {
        let mut inner = service.lock();
        inner.phase = UpdatePhase::Checking;
    }
    service.emit();

    let result = check_inner(app).await;

    // Installing may have started while the request was in flight (the forced
    // modal makes this likely). Never pull the main window back by writing an
    // "available" phase over a download that owns the screen.
    let owns_screen = service.lock().phase.owns_screen();
    if owns_screen {
        return Ok(service.snapshot());
    }

    match result {
        Ok(Some(mut update)) => {
            if update.forced {
                service.record_forced_update(&update.version);
            }
            // An earlier mandatory requirement stays binding when the live
            // release is a later (non-marked) version: installing it fulfils
            // the requirement, so the modal must not disappear.
            if recorded_force(state, &service.current_version).is_some() {
                update.forced = true;
            }
            {
                let mut inner = service.lock();
                inner.available = Some(update);
                inner.error = None;
            }
            service.record_check_time();
            service.transition(UpdatePhase::Available);
        }
        Ok(None) => {
            // A withdrawn release must not clear a recorded mandatory update:
            // the requirement sticks until the running app is new enough.
            let forced = recorded_force(state, &service.current_version);
            let still_forced = forced.is_some();
            {
                let mut inner = service.lock();
                inner.available = forced;
                inner.error = None;
            }
            service.record_check_time();
            service.transition(UpdatePhase::settled(still_forced));
        }
        Err(error) => {
            tracing::warn!(%error, manual, "update check failed");
            service.record_check_time();
            {
                let mut inner = service.lock();
                inner.error = Some(error.clone());
            }
            // A failed background check is not worth a modal; the recorded
            // mandatory update (if any) keeps its modal, everything else
            // stays idle and Settings shows the message.
            let still_forced = recorded_force(state, &service.current_version).is_some();
            service.transition(UpdatePhase::settled(still_forced));
            if manual {
                return Err(error);
            }
        }
    }

    Ok(service.snapshot())
}

async fn check_inner(app: &AppHandle) -> Result<Option<AvailableUpdate>, String> {
    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    Ok(update.map(|update| {
        let (notes, forced) = parse_notes(update.body.as_deref().unwrap_or("").trim());
        AvailableUpdate {
            version: update.version,
            notes,
            date: update.date.map(|date| date.to_string()),
            forced,
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
        let inner = service.lock();
        if inner.phase.owns_screen() {
            return Ok(service.snapshot_locked(&inner));
        }
        if inner.available.is_none() {
            return Err(tr("app.update.none").to_string());
        }
    }

    service.transition(UpdatePhase::Downloading);
    {
        let mut inner = service.lock();
        inner.error = None;
        inner.progress = Some(UpdateProgress::default());
    }
    service.emit();

    let service_for_task = service.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = install(&service_for_task).await {
            tracing::error!(%error, "update install failed");
            {
                let mut inner = service_for_task.lock();
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
        .ok_or_else(|| tr("app.update.none").to_string())?;

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
        let inner = service.lock();
        if inner.phase != UpdatePhase::Error {
            return Ok(service.snapshot_locked(&inner));
        }
    }

    {
        let mut inner = service.lock();
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
