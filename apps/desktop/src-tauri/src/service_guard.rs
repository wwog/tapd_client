//! Startup guards for the two background services.
//!
//! The companion LAN server and the built-in agent runtime both boot from
//! `setup` in detached tasks. A single failed attempt used to be one log line
//! and a dead service until the next app launch. The guard retries the start a
//! bounded number of times, records the final failure in the daily log, and
//! publishes it so the UI can show one modal with a retry action.
//!
//! Only failures that can plausibly heal on their own are retried. A missing
//! Node.js, an unconfigured model or a missing payload are configuration
//! states: they are logged once and left to the runtime notice, which already
//! names the setting that fixes them.

use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::SharedState;

/// Emitted when every automatic attempt failed. Payload: [`ServiceFailure`].
pub const EVENT_FAILED: &str = "service://failed";
/// Emitted after a manual retry succeeded, so the modal can close itself.
pub const EVENT_READY: &str = "service://ready";

/// Total start attempts, the first try included.
pub const MAX_ATTEMPTS: u32 = 3;

/// Pause before the second and third attempt.
const RETRY_DELAY: Duration = Duration::from_secs(2);

/// The services that boot asynchronously with the app.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Service {
    Companion,
    Agent,
}

impl Service {
    fn as_str(self) -> &'static str {
        match self {
            Service::Companion => "companion",
            Service::Agent => "agent",
        }
    }
}

/// One failed start. `retryable` is only meaningful while the guard is running;
/// it is not part of the event payload.
pub struct StartError {
    pub message: String,
    pub retryable: bool,
}

impl StartError {
    /// A failure the next attempt may survive (port race, spawn or handshake
    /// timeout, transient profile write).
    pub fn transient(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }

    /// A failure retrying cannot fix (missing Node.js, unconfigured model,
    /// missing payload). The runtime notice already explains these.
    pub fn terminal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }
}

/// A service that stayed down after its attempts. Kept in memory for the
/// current run: a new launch runs the guard again, so persisting it would only
/// show a stale error over a service that came up.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceFailure {
    pub service: Service,
    pub attempts: u32,
    pub error: String,
    /// Folder holding `tapd-client.log.*`; also where the failure was written.
    pub log_dir: String,
}

#[derive(Default)]
pub struct GuardState {
    failures: Mutex<Vec<ServiceFailure>>,
}

impl GuardState {
    fn record(&self, failure: ServiceFailure) {
        let mut failures = self.failures.lock().expect("service guard lock");
        match failures
            .iter_mut()
            .find(|item| item.service == failure.service)
        {
            Some(item) => *item = failure,
            None => failures.push(failure),
        }
    }

    fn clear(&self, service: Service) {
        self.failures
            .lock()
            .expect("service guard lock")
            .retain(|item| item.service != service);
    }

    fn list(&self) -> Vec<ServiceFailure> {
        self.failures.lock().expect("service guard lock").clone()
    }
}

/// Runs one service's start attempts, then records and announces the outcome.
///
/// `start` is called again for every attempt, so it must be self-contained:
/// the runtime and companion starters both detect an already running service.
pub async fn run<F, Fut>(app: AppHandle, service: Service, mut start: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<(), StartError>>,
{
    let mut last_error = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        match start().await {
            Ok(()) => {
                if attempt > 1 {
                    tracing::info!(
                        service = service.as_str(),
                        attempt,
                        "background service started after a retry"
                    );
                }
                return;
            }
            Err(error) => {
                last_error = error.message;
                if !error.retryable {
                    tracing::warn!(
                        service = service.as_str(),
                        error = %last_error,
                        "background service cannot start; retrying would not help"
                    );
                    return;
                }
                tracing::warn!(
                    service = service.as_str(),
                    attempt,
                    max = MAX_ATTEMPTS,
                    error = %last_error,
                    "background service failed to start"
                );
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(RETRY_DELAY).await;
                }
            }
        }
    }

    let log_dir = app
        .try_state::<SharedState>()
        .map(|state| state.paths.logs_dir.display().to_string())
        .unwrap_or_default();
    // The daily log file is where "it kept failing" must be visible after the
    // modal is dismissed; the tracing error below is that record.
    tracing::error!(
        service = service.as_str(),
        attempts = MAX_ATTEMPTS,
        error = %last_error,
        logs = %log_dir,
        "background service failed to start after retries"
    );
    let failure = ServiceFailure {
        service,
        attempts: MAX_ATTEMPTS,
        error: last_error,
        log_dir,
    };
    if let Some(state) = app.try_state::<Arc<GuardState>>() {
        state.record(failure.clone());
    }
    let _ = app.emit(EVENT_FAILED, failure);
}

/// A service came up through any path (guard attempt, settings toggle, agent
/// page retry): drop its failure and let every surface close the modal.
pub fn mark_up(app: &AppHandle, service: Service) {
    if let Some(state) = app.try_state::<Arc<GuardState>>() {
        state.clear(service);
    }
    let _ = app.emit(EVENT_READY, serde_json::json!({ "service": service }));
}

/// Failures the UI should show right now. A service that has come up since the
/// last attempt (manual retry from the agent page, companion toggled in
/// settings) drops its record instead of showing a stale modal.
#[tauri::command]
pub fn service_failures(app: AppHandle) -> Vec<ServiceFailure> {
    let Some(state) = app.try_state::<Arc<GuardState>>() else {
        return Vec::new();
    };
    let failures = state.list();
    if failures.is_empty() {
        return failures;
    }
    let mut live = Vec::with_capacity(failures.len());
    for failure in failures {
        let resolved = match failure.service {
            // The user turned the companion off after the failure: there is
            // nothing to restart and the modal would be a dead end.
            Service::Companion => {
                !companion_enabled(&app) || service_is_up(&app, Service::Companion)
            }
            Service::Agent => service_is_up(&app, Service::Agent),
        };
        if resolved {
            state.clear(failure.service);
        } else {
            live.push(failure);
        }
    }
    live
}

/// Manual retry from the failure modal. One attempt, no automatic loop: the
/// modal is already the place where the user decided to try again.
#[tauri::command]
pub async fn service_retry(app: AppHandle, service: Service) -> Result<(), String> {
    let state = app
        .try_state::<Arc<GuardState>>()
        .map(|state| state.inner().clone());
    let result = match service {
        Service::Agent => crate::dsh::feature::start(&app).await.map(|_| ()),
        Service::Companion => match app.try_state::<SharedState>() {
            // Turned off after the failure: nothing to restart.
            Some(shared) if !shared.config_snapshot().companion.enabled => {
                mark_up(&app, service);
                return Ok(());
            }
            Some(shared) => crate::companion::start(app.clone(), shared.inner().clone()).await,
            None => Err("app state unavailable".to_string()),
        },
    };

    match result {
        Ok(()) => {
            mark_up(&app, service);
            Ok(())
        }
        Err(error) => {
            // Keep the modal honest: show the new reason and the attempt count
            // the guard reported, not the one from the first run.
            if let Some(state) = state {
                if let Some(mut failure) = state
                    .list()
                    .into_iter()
                    .find(|item| item.service == service)
                {
                    failure.error = error.clone();
                    state.record(failure);
                }
            }
            let _ = app.emit(
                EVENT_FAILED,
                ServiceFailure {
                    service,
                    attempts: MAX_ATTEMPTS,
                    error: error.clone(),
                    log_dir: app
                        .try_state::<SharedState>()
                        .map(|state| state.paths.logs_dir.display().to_string())
                        .unwrap_or_default(),
                },
            );
            Err(error)
        }
    }
}

/// Relaunches the app. The startup guards run from scratch, which is the other
/// way out of a service that stayed down (and the one users expect from a
/// "restart" button).
#[tauri::command]
pub fn service_restart_app(app: AppHandle) -> Result<(), String> {
    // A sync command runs on the main thread, where `restart` deliberately
    // skips `RunEvent::Exit` — the event that stops the agent runtime, the
    // terminal shells and the companion tunnel. Restart from a worker thread
    // so the exit cleanup runs before the process is replaced (same shape as
    // `clear_app_data`).
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        app.restart();
    });
    Ok(())
}

/// Whether the user still wants the companion served this run.
fn companion_enabled(app: &AppHandle) -> bool {
    app.try_state::<SharedState>()
        .map(|state| state.config_snapshot().companion.enabled)
        .unwrap_or(false)
}

/// Whether the service is serving right now, without launching anything.
fn service_is_up(app: &AppHandle, service: Service) -> bool {
    match service {
        Service::Agent => crate::dsh::feature::status(app)
            .map(|status| status.phase == crate::dsh::runtime::Phase::Ready)
            .unwrap_or(false),
        Service::Companion => app
            .try_state::<SharedState>()
            .map(|state| {
                state
                    .companion
                    .lock()
                    .expect("companion lock")
                    .task
                    .is_some()
            })
            .unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(service: Service) -> ServiceFailure {
        ServiceFailure {
            service,
            attempts: MAX_ATTEMPTS,
            error: "bind failed".into(),
            log_dir: "/tmp/logs".into(),
        }
    }

    #[test]
    fn recording_replaces_the_previous_failure_of_one_service() {
        let state = GuardState::default();
        state.record(failure(Service::Agent));
        let mut next = failure(Service::Agent);
        next.error = "spawn failed".into();
        state.record(next);
        state.record(failure(Service::Companion));

        let failures = state.list();
        assert_eq!(failures.len(), 2);
        assert_eq!(
            failures
                .iter()
                .find(|item| item.service == Service::Agent)
                .map(|item| item.error.as_str()),
            Some("spawn failed")
        );
    }

    #[test]
    fn clearing_one_service_keeps_the_other() {
        let state = GuardState::default();
        state.record(failure(Service::Agent));
        state.record(failure(Service::Companion));
        state.clear(Service::Agent);

        let failures = state.list();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].service, Service::Companion);
    }

    #[test]
    fn service_keys_match_the_event_payload() {
        assert_eq!(serde_json::to_value(Service::Agent).unwrap(), "agent");
        assert_eq!(
            serde_json::to_value(Service::Companion).unwrap(),
            "companion"
        );
        assert_eq!(
            serde_json::to_value(failure(Service::Companion)).unwrap(),
            serde_json::json!({
                "service": "companion",
                "attempts": MAX_ATTEMPTS,
                "error": "bind failed",
                "logDir": "/tmp/logs",
            })
        );
    }
}
