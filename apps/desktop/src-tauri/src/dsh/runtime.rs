//! Runtime supervision: system Node, composed profile, stdio pump, approvals.
//!
//! One child process serves every session. Control traffic is newline-delimited
//! JSON-RPC over stdio (documented SDK protocol); token-level streaming arrives
//! separately from our bridge plugin (P2d). Anything unexpected on stdout is
//! logged and ignored — a single bad frame must not take the runtime down.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dsh_host::profile::{PluginRow, ProfileSpec, ProviderConfig, ProviderModel, PROFILE_NAME};
use dsh_host::protocol::{
    ApprovalRequestParams, Capabilities, InitializeParams, InitializeResult, SessionQueryParams,
    UserQuestionRequest,
};
use dsh_host::rpc::{self, Incoming, RpcId};
use dsh_host::transcript::ModelSelection;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::{
    bridge, payload, EVENT_APPROVAL, EVENT_ERROR, EVENT_QUESTION, EVENT_READY, EVENT_STATUS,
};
use crate::agent_settings::{self, AgentConfig, DshModelsConfig, DshProvider, PermissionMode};
use crate::shell_path;
use tapd_i18n::{tr, tr_args};

/// Environment variable each provider's key travels in. The profile references
/// it by name, so the secret never enters a config file. Every enabled route
/// lives in the same profile, so each one gets its own variable.
const API_KEY_ENV_PREFIX: &str = "TAPD_DSH_API_KEY_";

/// Sent when the user leaves the key empty. Hand-declared gateways (local
/// vLLM/Ollama, proxies) usually ignore the header, but the credential seam
/// fails closed on a reference that resolves to nothing.
const NO_AUTH_PLACEHOLDER: &str = "tapd-no-auth";

/// Requests that never answered in time are abandoned; the UI shows an error
/// instead of hanging forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(90);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Stopped,
    Starting,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshStatus {
    pub phase: Phase,
    pub payload_version: Option<String>,
    pub node_version: Option<String>,
    pub node_path: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// Stable machine code (`node_missing`, `model_missing`, `payload_missing`,
    /// `spawn_failed`, `initialize_failed`, `exited`).
    pub error_code: Option<String>,
    pub error: Option<String>,
    /// Startup-only settings were edited since this process booted (permission
    /// mode, model catalog, coworkers). The UI offers one restart.
    pub restart_required: bool,
}

impl Default for DshStatus {
    fn default() -> Self {
        Self {
            phase: Phase::Stopped,
            payload_version: None,
            node_version: None,
            node_path: None,
            provider: None,
            model: None,
            error_code: None,
            error: None,
            restart_required: false,
        }
    }
}

impl DshStatus {
    fn starting(version: String) -> Self {
        Self {
            phase: Phase::Starting,
            payload_version: Some(version),
            ..Self::default()
        }
    }

    fn failed(code: &str, message: impl Into<String>) -> Self {
        Self {
            phase: Phase::Failed,
            error_code: Some(code.to_string()),
            error: Some(message.into()),
            ..Self::default()
        }
    }
}

struct Running {
    stdin: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, rpc::RpcError>>>>>,
    ids: Arc<AtomicU64>,
    child: Child,
    #[allow(dead_code)]
    runtime_dir: PathBuf,
}

/// Managed Tauri state for the built-in agent runtime.
pub struct RuntimeState {
    status: std::sync::Mutex<DshStatus>,
    running: Mutex<Option<Running>>,
    /// Serialises start attempts so two UI actions cannot spawn twice.
    start_lock: Mutex<()>,
    /// Server-initiated requests still waiting for an answer. The runtime owns
    /// their lifecycle: `remember` on arrival, `respond` removes, exit clears.
    pending: std::sync::Mutex<Vec<PendingRequest>>,
    /// Server-owned wire ids, keyed by the numeric alias the UI answers with.
    ///
    /// The SDK transport keys its `approval/request` and `user-question/ask`
    /// frames by `req_<uuid>` strings and only resolves the caller when that
    /// exact id comes back. The documented UI contract (§8.7) answers with a
    /// numeric `rpcId`, so a string id gets a stable alias and `respond` maps it
    /// back before writing the frame.
    server_ids: std::sync::Mutex<HashMap<u64, RpcId>>,
    aliases: AtomicU64,
    /// The model catalog written into the profile of the running process.
    /// Models added after the start are not routable until the next start, so
    /// a session switch validates against this snapshot instead of the file.
    started_models: std::sync::Mutex<Option<DshModelsConfig>>,
    /// Fingerprint of the startup-only settings this process booted with. A
    /// mismatch with the current file is what "restart required" means; the
    /// comparison lives here so the UI never has to duplicate the rule.
    boot_config: std::sync::Mutex<Option<String>>,
    /// Team default the running profile was composed with. The catalog sync
    /// carries a changed one, so the likewise start-only setting needs no
    /// restart either.
    boot_team_default: std::sync::Mutex<Option<bool>>,
    /// Monotonic generation of the child process. A reader from an older
    /// process must never shut down the bridge or reset the status of a newer
    /// one: a restart stops and starts back to back.
    run_id: AtomicU64,
}

/// A question or approval the runtime is blocked on. `request` is the typed
/// payload the UI cards render; `rpc_id` is what the answer goes back on.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub rpc_id: u64,
    pub session_id: String,
    pub kind: PendingKind,
    pub request: Value,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PendingKind {
    Approval,
    Question,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            status: std::sync::Mutex::new(DshStatus::default()),
            running: Mutex::new(None),
            start_lock: Mutex::new(()),
            pending: std::sync::Mutex::new(Vec::new()),
            server_ids: std::sync::Mutex::new(HashMap::new()),
            aliases: AtomicU64::new(0),
            started_models: std::sync::Mutex::new(None),
            boot_config: std::sync::Mutex::new(None),
            boot_team_default: std::sync::Mutex::new(None),
            run_id: AtomicU64::new(0),
        }
    }
}

impl RuntimeState {
    pub fn status(&self) -> DshStatus {
        self.status.lock().expect("dsh status lock").clone()
    }

    /// Requests the runtime is still waiting on, oldest first.
    pub fn pending(&self) -> Vec<PendingRequest> {
        self.pending.lock().expect("dsh pending lock").clone()
    }

    /// Blocking requests one session owns; a canceled turn settles these.
    pub fn pending_for_session(&self, session_id: &str) -> Vec<PendingRequest> {
        self.pending
            .lock()
            .expect("dsh pending lock")
            .iter()
            .filter(|request| request.session_id == session_id)
            .cloned()
            .collect()
    }

    fn remember_pending(&self, request: PendingRequest) {
        let mut pending = self.pending.lock().expect("dsh pending lock");
        pending.retain(|item| item.rpc_id != request.rpc_id);
        pending.push(request);
    }

    pub fn clear_pending(&self) {
        self.pending.lock().expect("dsh pending lock").clear();
        self.server_ids
            .lock()
            .expect("dsh server id lock")
            .clear();
    }

    fn forget_pending(&self, rpc_id: u64) {
        self.pending
            .lock()
            .expect("dsh pending lock")
            .retain(|item| item.rpc_id != rpc_id);
    }

    /// One `user-question.cancelled` notification: the runtime withdrew a
    /// question, so its card must go on every surface. Returns the numeric id
    /// the UI knows, when the request was still registered.
    pub fn settle_request(&self, request_id: &str) -> Option<u64> {
        let mut pending = self.pending.lock().expect("dsh pending lock");
        let index = pending.iter().position(|item| {
            item.request.get("requestId").and_then(Value::as_str) == Some(request_id)
        })?;
        let request = pending.remove(index);
        drop(pending);
        self.server_ids
            .lock()
            .expect("dsh server id lock")
            .remove(&request.rpc_id);
        Some(request.rpc_id)
    }

    /// Numeric id the UI answers with. A server-owned `req_<uuid>` id gets a
    /// fresh alias so the documented numeric `rpcId` contract stays intact.
    fn alias_for(&self, id: RpcId) -> u64 {
        match id {
            RpcId::Number(id) => id,
            RpcId::Text(_) => {
                let alias = self.aliases.fetch_add(1, Ordering::SeqCst) + 1;
                self.server_ids
                    .lock()
                    .expect("dsh server id lock")
                    .insert(alias, id);
                alias
            }
        }
    }

    fn set_status(&self, app: &AppHandle, mut status: DshStatus) -> DshStatus {
        status.restart_required = status.phase == Phase::Ready && self.config_drifted(app);
        *self.status.lock().expect("dsh status lock") = status.clone();
        let _ = app.emit(EVENT_STATUS, &status);
        status
    }

    /// The status as the UI should read it right now: the stored phase plus a
    /// freshly computed drift flag, because settings are edited while the
    /// runtime keeps running and no status event fires for that.
    pub fn status_for(&self, app: &AppHandle) -> DshStatus {
        let mut status = self.status();
        status.restart_required = status.phase == Phase::Ready && self.config_drifted(app);
        status
    }

    /// Startup-only settings differ from what this process booted with.
    fn config_drifted(&self, app: &AppHandle) -> bool {
        let booted = self
            .boot_config
            .lock()
            .expect("dsh boot config lock")
            .clone();
        booted.is_some_and(|booted| booted != boot_fingerprint(&agent_settings::config_for(app)))
    }

    fn remember_boot_config(&self, config: &AgentConfig) {
        *self.boot_config.lock().expect("dsh boot config lock") =
            Some(boot_fingerprint(config));
        *self
            .boot_team_default
            .lock()
            .expect("dsh boot team lock") = Some(!config.coworker_ids.is_empty());
    }

    fn clear_boot_config(&self) {
        *self.boot_config.lock().expect("dsh boot config lock") = None;
        *self
            .boot_team_default
            .lock()
            .expect("dsh boot team lock") = None;
    }

    /// Pushes the current catalog (and Team default) into a running runtime.
    ///
    /// Both are otherwise start-only facts. The plugin rewrites the profile
    /// rows through the engine's own config editor, which reconciles the
    /// Loader without a restart, and answers once that settled. A runtime that
    /// is not running needs nothing: its next start renders the same settings.
    pub async fn sync_catalog(
        &self,
        app: &AppHandle,
        config: &AgentConfig,
    ) -> Result<(), String> {
        if self.status().phase != Phase::Ready {
            return Ok(());
        }
        let started = self
            .started_models
            .lock()
            .expect("dsh started models lock")
            .clone();
        let boot_team = *self
            .boot_team_default
            .lock()
            .expect("dsh boot team lock");
        let team_default = !config.coworker_ids.is_empty();
        let models_changed = started
            .as_ref()
            .map(|started| catalog_json(started) != catalog_json(&config.dsh_models))
            .unwrap_or(true);
        // A key edit is a live change too: it travels through the managed
        // credentials, not the rendered profile.
        let keys_changed = started
            .as_ref()
            .map(|started| credential_keys(started) != credential_keys(&config.dsh_models))
            .unwrap_or(true);
        if !models_changed && !keys_changed && boot_team == Some(team_default) {
            return Ok(());
        }
        let Some(bridge) = app.try_state::<Arc<bridge::BridgeState>>() else {
            return Err("agent bridge unavailable".to_string());
        };

        // A route that left the catalog must not keep a stored secret behind.
        let mut drop_keys: Vec<String> = Vec::new();
        if let Some(started) = started.as_ref() {
            for provider in started.providers.iter().filter(|provider| routable(provider)) {
                let still = config
                    .dsh_models
                    .providers
                    .iter()
                    .any(|item| item.id == provider.id);
                if !still {
                    drop_keys.push(api_key_env(&provider.id));
                }
            }
        }

        bridge
            .apply_catalog(
                models_changed.then(|| catalog_json(&config.dsh_models)),
                (boot_team != Some(team_default)).then_some(team_default),
                credential_keys(&config.dsh_models),
                drop_keys,
            )
            .await?;

        // The running profile now serves exactly this catalog, so session
        // switches validate against it and no restart is outstanding.
        *self
            .started_models
            .lock()
            .expect("dsh started models lock") = Some(config.dsh_models.clone());
        self.remember_boot_config(config);
        let mut status = self.status();
        status.restart_required = false;
        self.set_status(app, status);
        Ok(())
    }

    /// Rewrites the engine's managed credentials from settings. A start does
    /// this once initialized: the engine resolves a stored credential before
    /// the environment, so a key it stored in an earlier run would otherwise
    /// outrank the key this process was spawned with. The catalog is left
    /// alone — the profile a start just rendered is current.
    pub async fn refresh_credentials(&self, app: &AppHandle, models: &DshModelsConfig) {
        let Some(bridge) = app.try_state::<Arc<bridge::BridgeState>>() else {
            return;
        };
        if let Err(error) = bridge
            .apply_catalog(None, None, credential_keys(models), Vec::new())
            .await
        {
            tracing::warn!(%error, "managed credentials were not refreshed");
        }
    }

    /// Asks the running engine which models a draft endpoint advertises.
    /// Reusing the engine keeps catalog routes answered from the installed
    /// catalog and everything else from the endpoint's own listing.
    pub async fn discover_models(
        &self,
        app: &AppHandle,
        provider: &str,
        base_url: &str,
        api: &str,
        api_key: Option<&str>,
    ) -> Result<Value, String> {
        if self.status().phase != Phase::Ready {
            return Err(tr("dsh.runtime.notStarted").to_string());
        }
        let Some(bridge) = app.try_state::<Arc<bridge::BridgeState>>() else {
            return Err("agent bridge unavailable".to_string());
        };
        let models = bridge
            .discover_models(provider, base_url, api, api_key)
            .await?;
        Ok(json!({ "models": models }))
    }

    /// Claims a generation before spawning a reader. Called under `start_lock`.
    fn next_run_id(&self) -> u64 {
        self.run_id.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Whether `run_id` still names the process this state belongs to.
    fn is_current_run(&self, run_id: u64) -> bool {
        self.run_id.load(Ordering::SeqCst) == run_id
    }

    fn fail(&self, app: &AppHandle, code: &str, message: impl Into<String>) -> String {
        // A failed start (or a dead runtime) has no routable catalog any more.
        self.clear_started_models();
        let message = message.into();
        self.set_status(app, DshStatus::failed(code, message.clone()));
        let _ = app.emit(EVENT_ERROR, json!({ "code": code, "message": message }));
        message
    }

    fn clear_started_models(&self) {
        *self
            .started_models
            .lock()
            .expect("dsh started models lock") = None;
    }

    /// Whether the running process can route this provider/model pair. While
    /// the runtime is stopped the profile will be rendered from the current
    /// settings on the next start, so anything configured there is accepted.
    pub fn route_available(&self, selection: &ModelSelection) -> bool {
        let models = self
            .started_models
            .lock()
            .expect("dsh started models lock");
        let Some(models) = models.as_ref() else {
            return true;
        };
        models.providers.iter().any(|provider| {
            provider.id == selection.provider
                && provider.enabled
                && !provider.base_url.trim().is_empty()
                && provider
                    .models
                    .iter()
                    .any(|model| model.id == selection.model && model.enabled)
        })
    }

    /// Points the session at the route it should use before the next prompt.
    ///
    /// The plugin applies the frame immediately for a live Agent and queues it
    /// until `agent/created` otherwise, so this also covers a session the SDK
    /// creates on the prompt that follows. A route the running profile does not
    /// know is skipped (the runtime default stays) instead of failing the send.
    fn apply_session_selection(&self, app: &AppHandle, session_id: &str) {
        let Some(bridge) = app.try_state::<Arc<bridge::BridgeState>>() else {
            return;
        };
        let Some(selection) = session_selection(app, session_id) else {
            return;
        };
        if !self.route_available(&selection) {
            tracing::warn!(
                session = session_id,
                provider = %selection.provider,
                model = %selection.model,
                "session model is not in the running profile; keeping the runtime default"
            );
            return;
        }
        if bridge.recorded_selection(session_id).as_ref() == Some(&selection) {
            return;
        }
        if let Err(error) = bridge.select_model(session_id, &selection) {
            // Best effort: a prompt must not fail because the preference could
            // not be queued; the next prompt retries it.
            tracing::warn!(%error, session = session_id, "model selection was not queued");
        }
    }

    /// Pushes the session's permission mode before the next tool call. The
    /// durable copy is the mode table; the bridge cache avoids a read per
    /// prompt. A session with no row inherits the plugin default and needs no
    /// frame at all.
    async fn apply_session_mode(&self, app: &AppHandle, session_id: &str) {
        let Some(bridge) = app.try_state::<Arc<bridge::BridgeState>>() else {
            return;
        };
        let mode = match bridge.pending_mode(session_id) {
            Some(mode) => Some(mode),
            None => persisted_mode(app, session_id).await,
        };
        let Some(mode) = mode else {
            return;
        };
        if let Err(error) = bridge.set_session_mode(session_id, mode) {
            tracing::debug!(%error, session = session_id, "session mode was not queued");
        }
    }

    /// Replays a plan choice that has not reached the engine yet. The engine's
    /// `plan/mode` event clears it; a resumed session already carries its own
    /// state, so nothing is pushed without a pending choice.
    fn apply_session_plan(&self, app: &AppHandle, session_id: &str) {
        let Some(bridge) = app.try_state::<Arc<bridge::BridgeState>>() else {
            return;
        };
        let Some(active) = bridge.pending_plan(session_id) else {
            return;
        };
        if let Err(error) = bridge.set_plan(session_id, active) {
            tracing::debug!(%error, session = session_id, "plan mode was not queued");
        }
    }

    /// Makes the session live and forces its route **before** the prompt.
    ///
    /// dsh fixes a step's route when the turn starts, so a control frame that
    /// reaches the plugin after `turn/start` would only apply from the second
    /// step. A new session is created with `session/working-directory/get`
    /// (which creates the Agent without a turn), the choice is applied, and the
    /// caller waits until dsh records it. A failed setup degrades to the normal
    /// prompt path instead of blocking the send.
    pub async fn prepare_session(&self, app: &AppHandle, session_id: &str, fresh: bool) {
        // The policy gate reads the mode per tool call, and the bridge queues a
        // plan frame for a session whose Agent does not exist yet: both can be
        // pushed before the creation below.
        self.apply_session_mode(app, session_id).await;
        self.apply_session_plan(app, session_id);
        if fresh {
            if let Err(error) = self
                .call(
                    rpc::METHOD_SESSION_WORKING_DIRECTORY_GET,
                    json!({ "sessionId": session_id }),
                )
                .await
            {
                tracing::warn!(
                    %error,
                    session = session_id,
                    "session could not be created ahead of the prompt"
                );
            }
        }
        let Some(bridge) = app.try_state::<Arc<bridge::BridgeState>>() else {
            return;
        };
        let Some(selection) = session_selection(app, session_id) else {
            return;
        };
        if !self.route_available(&selection) {
            return;
        }
        if bridge.recorded_selection(session_id).as_ref() == Some(&selection) {
            return;
        }
        if let Err(error) = bridge.select_model(session_id, &selection) {
            tracing::warn!(%error, session = session_id, "model selection was not queued");
            return;
        }
        // The event travels plugin → dsh log → SDK notification → this registry.
        // A few milliseconds is normal; the bound only keeps a lost frame from
        // delaying the prompt forever.
        let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
        loop {
            if bridge.recorded_selection(session_id).as_ref() == Some(&selection) {
                return;
            }
            if tokio::time::Instant::now() >= deadline {
                tracing::warn!(
                    session = session_id,
                    "model selection was not recorded before the prompt"
                );
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Ensures the payload is extracted and the runtime is running and
    /// initialized. Safe to call repeatedly; concurrent callers serialise.
    pub async fn ensure_ready(&self, app: &AppHandle) -> Result<DshStatus, String> {
        let _guard = self.start_lock.lock().await;
        self.start_locked(app).await
    }

    /// Restarts the process so startup-only settings take effect. Both halves
    /// run under the same start lock, so no prompt can slip in between a stop
    /// and the next start and find a half-configured runtime.
    pub async fn restart(&self, app: &AppHandle) -> Result<DshStatus, String> {
        let _guard = self.start_lock.lock().await;
        self.stop_runtime(app).await?;
        self.start_locked(app).await
    }

    /// Caller holds `start_lock`.
    async fn start_locked(&self, app: &AppHandle) -> Result<DshStatus, String> {
        if let Some(running) = self.running.lock().await.as_mut() {
            if running.child.try_wait().ok().flatten().is_none() {
                return Ok(self.status_for(app));
            }
        }
        // Reaped (or never started): drop the stale handle. The lock is taken a
        // second time only after the `if let` guard is gone — tokio's Mutex is
        // not reentrant, so re-locking inside the block would deadlock.
        *self.running.lock().await = None;

        let payload = match payload::ensure_payload(app) {
            Ok(payload) => payload,
            Err(error) => return Err(self.fail(app, "payload_missing", error)),
        };
        self.set_status(app, DshStatus::starting(payload.version.clone()));

        let (node_path, node_version) = match resolve_node() {
            Ok(node) => node,
            Err(error) => return Err(self.fail(app, "node_missing", error)),
        };

        let config = agent_settings::config_for(app);
        // The bridge replays this default on every plugin connect, so a config
        // change that raced the socket still reaches the running gate.
        if let Some(bridge) = app.try_state::<Arc<bridge::BridgeState>>() {
            bridge.inner().remember_default_mode(config.permission_mode);
        }
        if !config.dsh_models.is_configured() {
            return Err(self.fail(
                app,
                "model_missing",
                tr("dsh.model.unconfigured"),
            ));
        }
        // `is_configured` already proved this resolves; the ids are what the SDK
        // initialize call names.
        let Some((active_provider, active_model)) = config.dsh_models.active() else {
            return Err(self.fail(app, "model_missing", tr("dsh.model.unconfigured")));
        };
        let provider = active_provider.id.clone();
        let model = active_model.id.clone();

        let layout = match prepare_profile(app, &payload, &config) {
            Ok(layout) => layout,
            Err(error) => return Err(self.fail(app, "profile_failed", error)),
        };

        // One loopback port per runtime start; the plugin reads these from env.
        let endpoint = match bridge::open(app).await {
            Ok(endpoint) => endpoint,
            Err(error) => return Err(self.fail(app, "bridge_failed", error)),
        };

        let mut child = match spawn_runtime(
            &node_path,
            &layout,
            &config.dsh_models,
            &endpoint,
            config.permission_mode.as_env(),
        ) {
            Ok(child) => child,
            Err(error) => {
                bridge::shutdown(app).await;
                return Err(self.fail(app, "spawn_failed", error));
            }
        };

        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill().await;
                bridge::shutdown(app).await;
                return Err(self.fail(app, "spawn_failed", "runtime stdout is unavailable"));
            }
        };
        if let Some(stderr) = child.stderr.take() {
            pump_stderr(stderr).await;
        }

        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill().await;
                bridge::shutdown(app).await;
                return Err(self.fail(app, "spawn_failed", "runtime stdin is unavailable"));
            }
        };
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let mut stdin = stdin;
        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, rpc::RpcError>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let ids = Arc::new(AtomicU64::new(0));
        // Claim the generation before the reader can report anything: a
        // restart's stop path may still have a reader draining.
        let run_id = self.next_run_id();
        spawn_reader(app.clone(), stdout, pending.clone(), run_id);

        *self.running.lock().await = Some(Running {
            stdin: tx,
            pending: pending.clone(),
            ids: ids.clone(),
            child,
            runtime_dir: layout.runtime_dir.clone(),
        });

        let params = InitializeParams {
            cwd: layout.default_cwd.to_string_lossy().to_string(),
            provider: provider.clone(),
            model: model.clone(),
            reasoning_effort: None,
            max_tokens: None,
            approval_requests: true,
            capabilities: Capabilities {
                user_questions: true,
            },
        };

        match self
            .call_with_timeout(
                rpc::METHOD_INITIALIZE,
                serde_json::to_value(params).unwrap_or(Value::Null),
                INITIALIZE_TIMEOUT,
            )
            .await
        {
            Ok(value) => {
                let result: InitializeResult = serde_json::from_value(value)
                    .map_err(|error| self.fail(app, "initialize_failed", error.to_string()))?;
                tracing::info!(server = %result.server_info.name, "built-in agent runtime ready");
            }
            Err(error) => {
                let _ = self.stop(app).await;
                return Err(self.fail(app, "initialize_failed", error));
            }
        }

        let status = DshStatus {
            phase: Phase::Ready,
            payload_version: Some(payload.version),
            node_version: Some(node_version),
            node_path: Some(node_path.to_string_lossy().to_string()),
            provider: Some(provider),
            model: Some(model),
            error_code: None,
            error: None,
            restart_required: false,
        };
        // Remember the catalog this process was actually started with; a later
        // session switch validates against it, not the edited file.
        *self
            .started_models
            .lock()
            .expect("dsh started models lock") = Some(config.dsh_models.clone());
        // Same idea for every startup-only setting: this is the baseline the
        // "restart required" flag compares the file against.
        self.remember_boot_config(&config);
        // A credential the engine stored in an earlier run outranks the
        // environment, so the keys this start was spawned with must be written
        // into the managed document before the first request.
        self.refresh_credentials(app, &config.dsh_models).await;
        let status = self.set_status(app, status);
        let _ = app.emit(EVENT_READY, &status);
        Ok(status)
    }

    /// Sends one request and waits for its response.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call_with_timeout(method, params, CALL_TIMEOUT).await
    }

    async fn call_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        let id = {
            let running = self.running.lock().await;
            let Some(running) = running.as_ref() else {
                return Err(tr("dsh.runtime.notStarted").to_string());
            };
            let id = running.ids.fetch_add(1, Ordering::SeqCst) + 1;
            running.pending.lock().await.insert(id, tx);
            running
                .stdin
                .send(rpc::encode_request(&RpcId::Number(id), method, params))
                .map_err(|_| tr("dsh.runtime.exited").to_string())?;
            id
        };

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(error.message),
            Ok(Err(_)) => Err(tr("dsh.runtime.interrupted").to_string()),
            Err(_) => {
                let running = self.running.lock().await;
                if let Some(running) = running.as_ref() {
                    running.pending.lock().await.remove(&id);
                }
                Err(tr_args("dsh.call.timeout", &[&method]))
            }
        }
    }

    /// Answers a server-initiated request by the numeric id the UI was given.
    pub async fn respond(&self, id: u64, result: Value) -> Result<(), String> {
        self.forget_pending(id);
        // A server-owned string id must be echoed back verbatim; the UI only
        // ever sees the alias.
        let wire = self
            .server_ids
            .lock()
            .expect("dsh server id lock")
            .remove(&id)
            .unwrap_or(RpcId::Number(id));
        self.respond_wire(&wire, result).await
    }

    /// Writes one response for the exact wire id.
    async fn respond_wire(&self, id: &RpcId, result: Value) -> Result<(), String> {
        let running = self.running.lock().await;
        let Some(running) = running.as_ref() else {
            return Err(tr("dsh.runtime.notStarted").to_string());
        };
        running
            .stdin
            .send(rpc::encode_success(id, result))
            .map_err(|_| tr("dsh.runtime.exited").to_string())
    }

    /// Re-attaches a session dsh persisted in an earlier run. Idempotent: an
    /// already-open session reports an error we treat as success.
    ///
    /// The SDK re-selects the runtime default while resuming, so the session's
    /// own choice is snapshotted first; the prompt path then restores it.
    pub async fn resume_session(&self, app: &AppHandle, session_id: &str) -> Result<(), String> {
        super::session_log::preserve_selection(app, session_id);
        match self
            .call(
                rpc::METHOD_SESSION_RESUME,
                json!({ "sessionId": session_id }),
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if error.contains("already open") => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// Queues one prompt on a session, creating it on first use. The session's
    /// model route is forced first so a resumed session is not reset to the
    /// runtime default.
    pub async fn query(
        &self,
        app: &AppHandle,
        session_id: &str,
        text: &str,
    ) -> Result<Value, String> {
        // The last host-controlled point before a turn: every prompt path
        // (chat, task, team, dev) goes through here.
        self.apply_session_mode(app, session_id).await;
        self.apply_session_plan(app, session_id);
        self.apply_session_selection(app, session_id);
        let params = SessionQueryParams {
            session_id: session_id.to_string(),
            content_blocks: vec![dsh_host::protocol::ContentBlock::Text {
                text: text.to_string(),
            }],
        };
        self.call(
            rpc::METHOD_SESSION_QUERY,
            serde_json::to_value(params).unwrap_or(Value::Null),
        )
        .await
    }

    pub async fn stop(&self, app: &AppHandle) -> Result<(), String> {
        self.stop_runtime(app).await
    }

    /// The stop path itself takes no start lock: a failed start calls it from
    /// inside [`Self::start_locked`], and `restart` already holds the lock.
    async fn stop_runtime(&self, app: &AppHandle) -> Result<(), String> {
        // Cards must disappear with their requests: the webview and the phone
        // render from the approval/question events and have no other way to
        // learn that a stop cleared the queue.
        for request in self.pending() {
            let _ = app.emit(super::EVENT_SETTLED, json!({ "rpcId": request.rpc_id }));
        }
        self.clear_pending();
        self.clear_started_models();
        self.clear_boot_config();
        let mut guard = self.running.lock().await;
        let Some(mut running) = guard.take() else {
            bridge::shutdown(app).await;
            let status = self.set_status(app, DshStatus::default());
            let _ = status;
            return Ok(());
        };
        let _ = running
            .stdin
            .send(rpc::encode_request(&RpcId::Number(0), rpc::METHOD_SHUTDOWN, Value::Null));
        let deadline = tokio::time::Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            match running.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if tokio::time::Instant::now() >= deadline {
                        let _ = running.child.kill().await;
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(_) => break,
            }
        }
        drop(guard);
        bridge::shutdown(app).await;
        self.set_status(app, DshStatus::default());
        Ok(())
    }
}

/// The route a prompt should force: this app run's pick, else the session
/// log's recorded choice, else the configured default.
fn session_selection(app: &AppHandle, session_id: &str) -> Option<ModelSelection> {
    let bridge = app.try_state::<Arc<bridge::BridgeState>>()?;
    let models = agent_settings::config_for(app).dsh_models;
    // The configured default carries the level that model last used, so a new
    // session starts exactly where the picker says it will.
    let configured = models.active().map(|(provider, model)| ModelSelection {
        provider: provider.id.clone(),
        model: model.id.clone(),
        reasoning_effort: Some(models.effort_for(&provider.id, &model.id)),
    });
    bridge.desired_selection(session_id, configured)
}

/// The mode persisted for one session; `None` means "inherit the default".
async fn persisted_mode(app: &AppHandle, session_id: &str) -> Option<PermissionMode> {
    let state = app.try_state::<Arc<crate::state::AppState>>()?;
    let cache = state.inner().cache.clone();
    let id = session_id.to_string();
    tauri::async_runtime::spawn_blocking(move || super::mode_store::load(&cache, &id))
        .await
        .ok()
        .and_then(Result::ok)
        .flatten()
}

/// Composed paths for one runtime.
struct RuntimeLayout {
    runtime_dir: PathBuf,
    entry: PathBuf,
    home: PathBuf,
    default_cwd: PathBuf,
}

fn prepare_profile(
    app: &AppHandle,
    payload: &payload::PayloadStatus,
    config: &agent_settings::AgentConfig,
) -> Result<RuntimeLayout, String> {
    let models = &config.dsh_models;
    let state = app
        .try_state::<Arc<crate::state::AppState>>()
        .ok_or_else(|| "app state unavailable".to_string())?;
    let data_dir = state.paths.data_dir.join("dsh");
    let home = data_dir.join("home");
    let profile_dir = home.join("profiles").join(PROFILE_NAME);
    let runtime_dir = payload.runtime_dir.clone();
    let entry = runtime_dir.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
    if !entry.exists() {
        return Err(format!("payload launcher missing at {}", entry.display()));
    }

    let mut plugins = plugin_rows(&runtime_dir);
    // dsh's whole-log stats unit is not part of the base/SDK bundles, yet it is
    // the only authoritative source for decode speed (tokens ÷ decode time) and
    // the other wall-time figures. Mounting it lets the bridge read
    // `sessionStats` instead of guessing a rate per message.
    let stats_entry = runtime_dir.join("node_modules/@deepseek-ai/dsh-session-stats/lib/index.js");
    if stats_entry.exists() {
        plugins.push(PluginRow {
            // App-owned row id, so a future bundle that mounts the unit under
            // its own id cannot collide with this insert.
            id: "tapd-session-stats".to_string(),
            entry: stats_entry.to_string_lossy().into_owned(),
        });
    }
    let spec = ProfileSpec {
        plugins,
        providers: models
            .providers
            .iter()
            .filter(|provider| routable(provider))
            .map(provider_config)
            .collect(),
        // The 同事 switch is the agent team: coworkers join the board, and no
        // coworkers means a single agent.
        team_default_enabled: Some(!config.coworker_ids.is_empty()),
    };
    spec.write(&profile_dir)
        .map_err(|error| format!("failed to write profile: {error}"))?;

    Ok(RuntimeLayout {
        runtime_dir,
        entry,
        home,
        default_cwd: default_cwd(app),
    })
}

/// Only a route that can actually serve a request is worth writing: it needs an
/// address and at least one enabled model.
fn routable(provider: &DshProvider) -> bool {
    provider.enabled
        && !provider.base_url.trim().is_empty()
        && provider.models.iter().any(|model| model.enabled)
}

fn provider_config(provider: &DshProvider) -> ProviderConfig {
    ProviderConfig {
        id: provider.id.clone(),
        display_name: if provider.name.is_empty() {
            provider.id.clone()
        } else {
            provider.name.clone()
        },
        api: provider.protocol.clone(),
        base_url: provider.base_url.clone(),
        api_key_env: Some(api_key_env(&provider.id)),
        models: provider
            .models
            .iter()
            .filter(|model| model.enabled)
            .map(|model| ProviderModel {
                id: model.id.clone(),
                name: model.id.clone(),
                context_window: model.context_window,
                max_tokens: model.max_tokens,
                input: model.input.clone(),
                reasoning: model
                    .reasoning
                    .iter()
                    .map(|effort| (effort.level.clone(), effort.wire.clone()))
                    .collect(),
            })
            .collect(),
    }
}

/// Credential ref for one route: a POSIX shell identifier derived from the
/// provider key, so two routes never share a secret.
fn api_key_env(provider_id: &str) -> String {
    let suffix: String = provider_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("{API_KEY_ENV_PREFIX}{suffix}")
}

/// Each enabled route's key under its own reference. A keyless route still
/// states the placeholder, so the managed store never falls back to a key this
/// app no longer uses.
fn credential_keys(models: &DshModelsConfig) -> Value {
    let mut keys = serde_json::Map::new();
    for provider in models.providers.iter().filter(|provider| routable(provider)) {
        let key = if provider.api_key.is_empty() {
            NO_AUTH_PLACEHOLDER
        } else {
            provider.api_key.as_str()
        };
        keys.insert(api_key_env(&provider.id), Value::from(key));
    }
    Value::Object(keys)
}

/// Every `@tapd/*` package in the payload becomes a mounted plugin row.
fn plugin_rows(runtime_dir: &Path) -> Vec<PluginRow> {
    let scope = runtime_dir.join("node_modules/@tapd");
    let Ok(entries) = std::fs::read_dir(&scope) else {
        return Vec::new();
    };
    let mut rows: Vec<PluginRow> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let entry_path = entry.path().join("index.js");
            if !entry_path.exists() {
                return None;
            }
            let dir_name = entry.file_name().to_string_lossy().to_string();
            Some(PluginRow {
                id: dir_name.clone(),
                entry: entry_path.to_string_lossy().to_string(),
            })
        })
        .collect();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    rows
}

/// Sessions inherit this directory unless the task later moves them. It is a
/// neutral scratch area, not a user repository: a free chat that never chose a
/// project must not read or write one.
fn default_cwd(app: &AppHandle) -> PathBuf {
    let data_dir = app
        .try_state::<Arc<crate::state::AppState>>()
        .map(|state| state.paths.data_dir.clone());
    let Some(data_dir) = data_dir else {
        return std::env::temp_dir();
    };
    let workspace = data_dir.join("dsh").join("workspace");
    let _ = std::fs::create_dir_all(&workspace);
    workspace
}

/// Fingerprint of everything a running process freezes at start: the model
/// catalog and the coworker roster (which decides team mode). Permission mode
/// is pushed per session and can change live, so it is not part of the
/// baseline; prompts and per-task settings are read live too.
fn boot_fingerprint(config: &AgentConfig) -> String {
    // Only the rendered catalog is start-only now: the Team default travels
    // with a catalog sync, and a permission mode is already a live frame. The
    // active pointer and remembered levels are not profile content, so editing
    // them must not claim a restart is outstanding.
    catalog_json(&config.dsh_models).to_string()
}

/// The provider catalog in the wire shape `llm-pi-ai` accepts: a dict keyed by
/// route, camelCase fields, and a level → wire map where a valueless `off` is
/// null. This is the same catalog `prepare_profile` renders into YAML, sent
/// over the bridge so a running engine can adopt it without a restart.
fn catalog_json(models: &DshModelsConfig) -> Value {
    let mut providers = serde_json::Map::new();
    for provider in models.providers.iter().filter(|provider| routable(provider)) {
        let mut entry = serde_json::Map::new();
        entry.insert(
            "displayName".into(),
            Value::from(if provider.name.is_empty() {
                provider.id.clone()
            } else {
                provider.name.clone()
            }),
        );
        entry.insert("api".into(), Value::from(provider.protocol.clone()));
        entry.insert("baseURL".into(), Value::from(provider.base_url.clone()));
        entry.insert(
            "apiKeyEnv".into(),
            Value::from(api_key_env(&provider.id)),
        );
        let list: Vec<Value> = provider
            .models
            .iter()
            .filter(|model| model.enabled)
            .map(|model| {
                let mut row = serde_json::Map::new();
                row.insert("id".into(), Value::from(model.id.clone()));
                row.insert("name".into(), Value::from(model.id.clone()));
                row.insert("contextWindow".into(), Value::from(model.context_window));
                if let Some(max_tokens) = model.max_tokens {
                    row.insert("maxTokens".into(), Value::from(max_tokens));
                }
                if !model.input.is_empty() {
                    row.insert("input".into(), json!(model.input));
                }
                if !model.reasoning.is_empty() {
                    let mut efforts = serde_json::Map::new();
                    for effort in &model.reasoning {
                        efforts.insert(
                            effort.level.clone(),
                            if effort.wire.is_empty() {
                                Value::Null
                            } else {
                                Value::from(effort.wire.clone())
                            },
                        );
                    }
                    row.insert("reasoningEfforts".into(), Value::Object(efforts));
                }
                Value::Object(row)
            })
            .collect();
        entry.insert("models".into(), Value::Array(list));
        providers.insert(provider.id.clone(), Value::Object(entry));
    }
    Value::Object(providers)
}

fn spawn_runtime(
    node: &Path,
    layout: &RuntimeLayout,
    models: &DshModelsConfig,
    bridge: &bridge::BridgeEndpoint,
    permission_mode: &str,
) -> Result<Child, String> {
    let mut command = Command::new(node);
    command
        .arg(&layout.entry)
        .arg("--profile")
        .arg(PROFILE_NAME)
        .current_dir(&layout.default_cwd)
        .env("DSH_HOME", &layout.home)
        .env("TAPD_DSH_BRIDGE_URL", &bridge.url)
        .env("TAPD_DSH_BRIDGE_TOKEN", &bridge.token)
        // Read by the policy plugin; a change needs a runtime restart.
        .env("TAPD_DSH_PERMISSION_MODE", permission_mode)
        // Finder-launched apps inherit a minimal PATH; the runtime shells out.
        .env("PATH", shell_path::user_path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for provider in models.providers.iter().filter(|provider| routable(provider)) {
        // The credential seam fails closed on a reference that resolves to
        // nothing, so a keyless route still carries a placeholder.
        let key = if provider.api_key.is_empty() {
            NO_AUTH_PLACEHOLDER
        } else {
            provider.api_key.as_str()
        };
        command.env(api_key_env(&provider.id), key);
    }
    command.spawn().map_err(|error| {
        format!(
            "failed to start {} {}: {error}",
            node.display(),
            layout.entry.display()
        )
    })
}

/// Reads stdout line by line and dispatches frames. `run_id` ties this reader
/// to one child process: once a newer process owns the state, the old reader
/// must not dispatch frames, shut the bridge down or overwrite the status.
fn spawn_reader(
    app: AppHandle,
    stdout: tokio::process::ChildStdout,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, rpc::RpcError>>>>>,
    run_id: u64,
) {
    tauri::async_runtime::spawn(async move {
        let current = || {
            app.try_state::<Arc<RuntimeState>>()
                .is_some_and(|state| state.is_current_run(run_id))
        };
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if !current() {
                        break;
                    }
                    match rpc::decode(&line) {
                        Ok(Some(Incoming::Response { id, result })) => {
                            // Responses echo our own numeric request ids.
                            let slot = match id.number() {
                                Some(id) => pending.lock().await.remove(&id),
                                None => None,
                            };
                            if let Some(sender) = slot {
                                let _ = sender.send(result);
                            }
                        }
                        Ok(Some(Incoming::Request { id, method, params })) => {
                            forward_request(&app, id, &method, params);
                        }
                        Ok(Some(Incoming::Notification { method, params })) => {
                            forward_notification(&app, &method, params);
                        }
                        Ok(None) => {}
                        Err(error) => {
                            tracing::warn!(%error, "ignored a malformed dsh frame");
                        }
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::warn!(%error, "dsh stdout closed");
                    break;
                }
            }
        }

        // The process ended: fail every request still waiting for an answer.
        pending.lock().await.clear();
        let Some(state) = app.try_state::<Arc<RuntimeState>>().map(|state| state.inner().clone())
        else {
            return;
        };
        // A newer child already owns the bridge and the status; this reader
        // belongs to a process that was replaced (restart, fast respawn).
        if !state.is_current_run(run_id) {
            return;
        }
        // No live turn can outlive its process.
        bridge::shutdown(&app).await;
        // Stale cards must not outlive the runtime that asked the question.
        for request in state.pending() {
            let _ = app.emit(super::EVENT_SETTLED, json!({ "rpcId": request.rpc_id }));
        }
        state.clear_pending();
        state.clear_started_models();
        let status = state.status();
        if status.phase != Phase::Stopped {
            state.set_status(&app, DshStatus::failed("exited", tr("dsh.runtime.exited")));
        }
    });
}

/// Server → client requests become UI events; the answer travels back by RPC id.
///
/// The id in the event is the numeric one the UI answers with (`remember`
/// allocates an alias for string ids); the wire id is kept only in the state.
fn forward_request(app: &AppHandle, id: RpcId, method: &str, params: Value) {
    match method {
        rpc::METHOD_APPROVAL_REQUEST => match serde_json::from_value::<ApprovalRequestParams>(params) {
            Ok(params) => {
                let rpc_id = remember(app, id, PendingKind::Approval, &params.session_id, &params);
                let _ = app.emit(EVENT_APPROVAL, json!({ "rpcId": rpc_id, "request": params }));
            }
            Err(error) => {
                tracing::warn!(%error, "invalid approval/request payload");
                answer_now(app, id, &json!({ "outcome": "cancelled" }));
            }
        },
        rpc::METHOD_USER_QUESTION => match serde_json::from_value::<UserQuestionRequest>(params) {
            Ok(params) => {
                let rpc_id = remember(app, id, PendingKind::Question, &params.session_id, &params);
                let _ = app.emit(EVENT_QUESTION, json!({ "rpcId": rpc_id, "request": params }));
            }
            Err(error) => {
                tracing::warn!(%error, "invalid user-question payload");
                answer_now(app, id, &json!({ "cancelled": true }));
            }
        },
        other => {
            tracing::warn!(method = other, "unhandled dsh request");
            let _ = app.emit(EVENT_ERROR, json!({ "code": "unhandled_request", "message": other }));
        }
    }
}

/// Records a blocking request so a page opened after the event still sees it.
/// The typed payload is serialized once; the UI receives the same shape.
/// Returns the numeric id the UI answers with.
fn remember(
    app: &AppHandle,
    id: RpcId,
    kind: PendingKind,
    session_id: &str,
    request: &impl serde::Serialize,
) -> u64 {
    let Some(state) = app.try_state::<Arc<RuntimeState>>() else {
        return 0;
    };
    let rpc_id = state.inner().alias_for(id);
    let request = serde_json::to_value(request).unwrap_or(Value::Null);
    state.inner().remember_pending(PendingRequest {
        rpc_id,
        session_id: session_id.to_string(),
        kind,
        request,
    });
    rpc_id
}

fn answer_now(app: &AppHandle, id: RpcId, result: &Value) {
    if let Some(state) = app.try_state::<Arc<RuntimeState>>() {
        let state = state.inner().clone();
        let result = result.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = state.respond_wire(&id, result).await {
                tracing::warn!(%error, "agent request could not be answered");
            }
        });
    }
}

fn forward_notification(app: &AppHandle, method: &str, params: Value) {
    match method {
        rpc::METHOD_SESSION_EVENT => {
            ingest_session_event(app, &params);
            let _ = app.emit(super::EVENT_SESSION_EVENT, params);
        }
        rpc::METHOD_SESSION_STATUS => {
            apply_session_status(app, &params);
            // Unchanged generic shape: existing listeners keep working.
            let _ = app.emit(
                "dsh://notification",
                json!({ "method": method, "params": params }),
            );
        }
        rpc::METHOD_SESSION_QUERY_COMPLETED => {
            let _ = app.emit("dsh://query-completed", params);
        }
        rpc::METHOD_USER_QUESTION_CANCELLED => {
            settle_cancelled(app, &params);
            let _ = app.emit(
                "dsh://notification",
                json!({ "method": method, "params": params }),
            );
        }
        other => {
            // subagent.*: forwarded verbatim so the UI can pick up anything the
            // runtime adds.
            let _ = app.emit(
                "dsh://notification",
                json!({ "method": other, "params": params }),
            );
        }
    }
}

/// A withdrawn question (`user-question.cancelled`) leaves the runtime's own
/// queue, so every surface must drop that card — the capsule has its own
/// listener, but the webview and the phone only read `dsh://request-settled`.
fn settle_cancelled(app: &AppHandle, params: &Value) {
    let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
        return;
    };
    let Some(state) = app.try_state::<Arc<RuntimeState>>() else {
        return;
    };
    if let Some(rpc_id) = state.inner().settle_request(request_id) {
        let _ = app.emit(super::EVENT_SETTLED, json!({ "rpcId": rpc_id }));
    }
}

/// The committed event feed also reaches the normalized registry, so a UI that
/// never subscribes to the bridge still sees history it missed.
fn ingest_session_event(app: &AppHandle, params: &Value) {
    let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
        tracing::warn!("session.event without a sessionId");
        return;
    };
    let Some(event) = params.get("event") else {
        tracing::warn!(%session_id, "session.event without an event");
        return;
    };
    if let Some(state) = app.try_state::<Arc<bridge::BridgeState>>() {
        state.ingest(app, session_id, event);
    }
}

fn apply_session_status(app: &AppHandle, params: &Value) {
    let status = match params.get("status").and_then(Value::as_str) {
        Some("running") => dsh_host::transcript::SessionStatus::Running,
        Some("idle") => dsh_host::transcript::SessionStatus::Idle,
        other => {
            tracing::debug!(?other, "session.status with an unknown state");
            return;
        }
    };
    let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
        tracing::warn!("session.status without a sessionId");
        return;
    };
    if let Some(state) = app.try_state::<Arc<bridge::BridgeState>>() {
        state.set_status(app, session_id, status);
    }
}

/// Continues reading stderr into the app log so a failed boot is diagnosable.
async fn pump_stderr(stderr: tokio::process::ChildStderr) {
    let lines = BufReader::new(stderr);
    tauri::async_runtime::spawn(async move {
        let mut lines = lines.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::info!(target: "dsh", "{line}");
        }
    });
}

/// Finds `node` on the user's shell PATH and applies the engine gate.
fn resolve_node() -> Result<(PathBuf, String), String> {
    let path = shell_path::user_path().to_string_lossy().to_string();
    let mut candidates: Vec<PathBuf> = Vec::new();
    for dir in path.split(':') {
        if dir.is_empty() {
            continue;
        }
        #[cfg(unix)]
        let candidate = Path::new(dir).join("node");
        #[cfg(windows)]
        let candidate = Path::new(dir).join("node.exe");
        if is_executable(&candidate) {
            candidates.push(candidate);
        }
    }
    // Finder-launched bundles sometimes miss Homebrew in their PATH.
    for extra in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        let candidate = PathBuf::from(extra);
        if is_executable(&candidate) {
            candidates.push(candidate);
        }
    }

    let mut last_error = String::new();
    for candidate in candidates {
        match node_version(&candidate) {
            Ok(version) => match dsh_host::node::evaluate(Some(&version)) {
                Ok(_) => return Ok((candidate, version)),
                // An old node earlier on PATH must not hide a newer one that
                // comes later (the Homebrew fallbacks are appended below it).
                Err(error) => last_error = error.to_string(),
            },
            Err(error) => last_error = error,
        }
    }
    if last_error.is_empty() {
        Err(tr("dsh.node.missing").to_string())
    } else {
        Err(tr_args("dsh.node.tooOld", &[&last_error]))
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn node_version(node: &Path) -> Result<String, String> {
    let output = std::process::Command::new(node)
        .arg("--version")
        .output()
        .map_err(|error| format!("failed to run {}: {error}", node.display()))?;
    if !output.status.success() {
        return Err(format!("{} --version failed", node.display()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_settings::{DshModelEntry, ReasoningEffort};

    fn entry(id: &str) -> DshModelEntry {
        DshModelEntry {
            id: id.into(),
            context_window: 1_000_000,
            max_tokens: Some(64_000),
            input: vec!["text".into(), "image".into()],
            reasoning: vec![
                ReasoningEffort {
                    level: "low".into(),
                    wire: "low".into(),
                },
                ReasoningEffort {
                    level: "high".into(),
                    wire: "high".into(),
                },
            ],
            enabled: true,
        }
    }

    fn config() -> DshModelsConfig {
        DshModelsConfig {
            providers: vec![
                DshProvider {
                    id: "opencode-go".into(),
                    name: "OpenCode Go".into(),
                    base_url: "https://opencode.ai/zen/go/v1".into(),
                    protocol: "openai-completions".into(),
                    api_key: "secret".into(),
                    enabled: true,
                    models: vec![entry("deepseek-v4.1-flash")],
                },
                // Disabled routes never reach the profile, whatever they carry.
                DshProvider {
                    id: "off".into(),
                    name: "Off".into(),
                    base_url: "https://off.example".into(),
                    protocol: "anthropic-messages".into(),
                    api_key: String::new(),
                    enabled: false,
                    models: vec![entry("claude")],
                },
                // An address-less route has nothing to call.
                DshProvider {
                    id: "empty".into(),
                    name: "Empty".into(),
                    base_url: String::new(),
                    protocol: "google-generative-ai".into(),
                    api_key: String::new(),
                    enabled: true,
                    models: vec![entry("gemini")],
                },
                // A route with no enabled model cannot serve a request.
                DshProvider {
                    id: "idle".into(),
                    name: "Idle".into(),
                    base_url: "https://idle.example".into(),
                    protocol: "openai-responses".into(),
                    api_key: String::new(),
                    enabled: true,
                    models: vec![DshModelEntry {
                        enabled: false,
                        ..entry("gpt")
                    }],
                },
            ],
            active_provider_id: "opencode-go".into(),
            active_model_id: "deepseek-v4.1-flash".into(),
            ..Default::default()
        }
    }

    #[test]
    fn only_routable_providers_reach_the_profile() {
        let models = config();
        let providers: Vec<ProviderConfig> = models
            .providers
            .iter()
            .filter(|provider| routable(provider))
            .map(provider_config)
            .collect();

        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "opencode-go");
        assert_eq!(
            providers[0].api_key_env.as_deref(),
            Some("TAPD_DSH_API_KEY_OPENCODE_GO")
        );
        // Only the enabled model is written.
        assert_eq!(providers[0].models.len(), 1);
        let model = &providers[0].models[0];
        assert_eq!(model.name, model.id);
        assert_eq!(model.max_tokens, Some(64_000));
        assert_eq!(model.input, vec!["text", "image"]);
        assert_eq!(
            model.reasoning,
            vec![
                ("low".to_string(), "low".to_string()),
                ("high".to_string(), "high".to_string())
            ]
        );
    }

    #[test]
    fn the_rendered_profile_uses_the_protocols_dsh_accepts() {
        let models = config();
        let yaml = ProfileSpec {
            plugins: Vec::new(),
            providers: models
                .providers
                .iter()
                .filter(|provider| routable(provider))
                .map(provider_config)
                .collect(),
            team_default_enabled: Some(false),
        }
        .patch_yaml();

        assert!(yaml.contains("        api: 'openai-completions'"));
        assert!(yaml.contains("        baseURL: 'https://opencode.ai/zen/go/v1'"));
        assert!(yaml.contains("        apiKeyEnv: 'TAPD_DSH_API_KEY_OPENCODE_GO'"));
        assert!(yaml.contains("            maxTokens: 64000"));
        assert!(yaml.contains("            reasoningEfforts:\n              low: 'low'\n              high: 'high'\n"));
        // Nothing from the routes that cannot serve a request leaks in.
        assert!(!yaml.contains("'off'"));
        assert!(!yaml.contains("gemini"));
        assert!(!yaml.contains("secret"));
    }

    #[test]
    fn provider_keys_never_collide_across_routes() {
        assert_eq!(api_key_env("a"), "TAPD_DSH_API_KEY_A");
        assert_eq!(api_key_env("my-gateway"), "TAPD_DSH_API_KEY_MY_GATEWAY");
        // `-` is the only character mapped to `_`, so the mapping stays injective.
        assert_ne!(api_key_env("a-b"), api_key_env("ab"));
    }

    #[test]
    fn the_boot_fingerprint_only_covers_startup_settings() {
        let mut agent = AgentConfig::default();
        let booted = boot_fingerprint(&agent);

        // Prompt, per-task settings, the permission mode and the coworker
        // roster are live: changing them must not ask for a restart.
        agent.prompt_template.push_str("\nmore");
        agent.worktree_enabled = true;
        agent.permission_mode = PermissionMode::Full;
        agent.coworker_ids.push("author".into());
        assert_eq!(booted, boot_fingerprint(&agent));

        // The rendered catalog is the one start-only fact.
        agent.dsh_models = config();
        assert_ne!(booted, boot_fingerprint(&agent));

        // The active pointer and remembered levels are not profile content.
        let mut eff = agent.clone();
        eff.dsh_models
            .model_efforts
            .insert("opencode-go/deepseek-v4.1-flash".into(), "high".into());
        assert_eq!(boot_fingerprint(&agent), boot_fingerprint(&eff));
    }
}
