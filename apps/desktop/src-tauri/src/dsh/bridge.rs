//! Bridge listener: the single owner of the normalized transcript.
//!
//! Two feeds describe the same committed log — the plugin's snapshot/stream
//! socket (token-level live frames + history) and the SDK's `session.event`
//! notifications on stdio. Both call [`BridgeState::ingest`], which hands the
//! event to [`dsh_host::transcript::Transcript`]; the registry is the one
//! source the Tauri commands and the paired phone read.
//!
//! The socket is duplex: the plugin pushes frames in, and the newest connection
//! that presented the token owns the control slot for `assign` / `cancel`
//! frames going out. Tokens cross in both directions; a mismatch closes the
//! connection instead of guessing.
//!
//! Locking: [`BridgeState::transcript`] is held only for the synchronous
//! normalization pass. Every emitter runs after the guard is dropped, so a
//! listener that calls back into `dsh_sessions` cannot deadlock. There is no
//! second lock around registry state.
//!
//! The listener binds `127.0.0.1:0` per runtime start; the URL and token go
//! into the child's environment and never leave the machine.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use dsh_host::transcript::{
    DshDelta, DshEntry, DshSession, DshStream, Ingested, ModelSelection, SessionMeter,
    SessionStatus, Transcript,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};

use super::team::{normalize_team, DshTeam};
use super::{EVENT_ENTRY, EVENT_SESSIONS, EVENT_STREAM};
use crate::agent_settings::PermissionMode;
use tapd_i18n::tr;

/// How long a config apply or a discovery may take. Both run inside the
/// runtime (a profile rewrite plus a Loader reconcile, or one HTTP listing), so
/// a slow answer is normal; an unanswered one must still free the caller.
const REPLY_TIMEOUT: Duration = Duration::from_secs(20);

/// A `task-phase` frame must be acknowledged before a prompt is sent into the
/// phase (otherwise the tools the prompt tells the model to use would not be
/// registered yet). The plugin only touches an in-memory map, so this is short.
const PHASE_TIMEOUT: Duration = Duration::from_secs(10);

/// Inbound frame types that answer a pending request. A reply type missing
/// here is dropped and its caller times out, so every new request frame adds
/// its reply here as well.
const REPLY_TYPES: [&str; 5] = [
    "models-applied",
    "models-discovered",
    "plugins-listed",
    "tools-listed",
    // The plugin acknowledges `task-phase` / `task-phases`; only the former is
    // awaited (the write-back turn cannot start without it).
    "task-phase-applied",
];

/// What the child needs to reach this listener.
#[derive(Clone, Debug)]
pub struct BridgeEndpoint {
    pub url: String,
    pub token: String,
}

/// One plugin connection's outbound queue. `generation` identifies the
/// connection so a late close cannot clear a newer slot.
struct Control {
    generation: u64,
    lines: mpsc::UnboundedSender<String>,
}

#[derive(Default)]
pub struct BridgeState {
    /// Single owner; see the module docs for the lock order.
    transcript: std::sync::Mutex<Transcript>,
    /// The accept loop for the current runtime, if any.
    listener: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// The connection that currently owns Rust → plugin frames.
    control: std::sync::Mutex<Option<Control>>,
    /// This runtime's token, echoed in every outbound frame.
    token: std::sync::Mutex<Option<String>>,
    /// Last team board per session (P5). Owned by inbound `team` frames and
    /// cleared with the runtime, so a restart never shows the old board.
    teams: std::sync::Mutex<HashMap<String, DshTeam>>,
    /// Model choices made in this app run, keyed by session. They survive a
    /// runtime restart (unlike the live agents) and cover sessions that do not
    /// exist yet, so the next prompt can force the route the user picked.
    selections: std::sync::Mutex<HashMap<String, ModelSelection>>,
    /// Permission mode per session for this app run. The durable copy is the
    /// mode table; this map keeps prompts from reading SQLite each time. Like
    /// `selections`, it survives a runtime restart.
    modes: std::sync::Mutex<HashMap<String, PermissionMode>>,
    /// Plan-mode choices that have not reached the engine yet. The engine's
    /// `plan/mode` event clears the entry, so the session log stays the
    /// authority once the agent has acted on it.
    plans: std::sync::Mutex<HashMap<String, bool>>,
    /// The runtime-wide default last written. Replayed on every plugin connect
    /// so a config change that missed the socket is not silently lost.
    default_mode: std::sync::Mutex<Option<PermissionMode>>,
    /// Callers waiting for a reply on the same socket, keyed by request id. The
    /// plugin answers a catalog apply (`models-applied`) or a discovery
    /// (`models-discovered`); closing the runtime drops every sender.
    replies: std::sync::Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>,
    /// Next request id handed out.
    requests: AtomicU64,
    /// Per-connection identity, see [`Control`].
    connections: AtomicU64,
}

impl BridgeState {
    /// Binds a fresh loopback port for one runtime start. A previous listener
    /// (from a failed or stopped runtime) is closed first so only one runtime
    /// can ever feed this registry.
    pub async fn open(self: &Arc<Self>, app: &AppHandle) -> Result<BridgeEndpoint, String> {
        self.close().await;
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("failed to bind the agent bridge: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("failed to read the bridge address: {error}"))?
            .port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        *self.token.lock().expect("dsh bridge token lock") = Some(token.clone());

        let bridge = self.clone();
        let app = app.clone();
        let expected = token.clone();
        let task = tauri::async_runtime::spawn(async move {
            accept_loop(listener, app, bridge, expected).await;
        });
        *self.listener.lock().await = Some(task);

        Ok(BridgeEndpoint {
            url: format!("http://127.0.0.1:{port}"),
            token,
        })
    }

    /// Stops accepting connections. An already-connected plugin notices the
    /// socket close when the child exits.
    pub async fn close(&self) {
        if let Some(task) = self.listener.lock().await.take() {
            task.abort();
        }
        // Frames queued for one runtime must never reach the next one.
        *self.control.lock().expect("dsh bridge control lock") = None;
        *self.token.lock().expect("dsh bridge token lock") = None;
        self.teams.lock().expect("dsh team lock").clear();
        // Waiting callers learn the runtime is gone instead of hanging.
        self.replies.lock().expect("dsh bridge reply lock").clear();
    }

    /// Sends one request and waits for the plugin's matching reply. The reply
    /// carries `requestId`; a non-empty `error` string is returned as the
    /// failure so the caller can show the engine's own diagnostic.
    pub async fn request(
        &self,
        frame: Value,
        timeout: std::time::Duration,
    ) -> Result<Value, String> {
        let id = self.requests.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.replies
            .lock()
            .expect("dsh bridge reply lock")
            .insert(id, tx);
        let mut frame = frame;
        // The timeout message names the request that timed out, not a fixed one.
        let method = frame
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("request")
            .to_string();
        frame["requestId"] = json!(id);
        if let Err(error) = self.send_control(frame) {
            self.replies
                .lock()
                .expect("dsh bridge reply lock")
                .remove(&id);
            return Err(error);
        }
        let reply = tokio::time::timeout(timeout, rx).await;
        let reply = match reply {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => return Err(tr("dsh.runtime.exited").to_string()),
            Err(_) => {
                self.replies
                    .lock()
                    .expect("dsh bridge reply lock")
                    .remove(&id);
                return Err(tapd_i18n::tr_args("dsh.call.timeout", &[&method]));
            }
        };
        if reply.get("ok").and_then(Value::as_bool) == Some(false) {
            let error = reply
                .get("error")
                .and_then(Value::as_str)
                .filter(|error| !error.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| tr("dsh.bridge.rejected").to_string());
            return Err(error);
        }
        match reply.get("error").and_then(Value::as_str) {
            Some(error) if !error.is_empty() => Err(error.to_string()),
            _ => Ok(reply),
        }
    }

    /// Queues one `task-phase` frame for a live session. Fire-and-forget: the
    /// plugin still acks it, but the caller does not wait (the follow-up
    /// snapshot keeps a lost frame from mattering).
    pub fn send_task_phase(&self, session_id: &str, phase: &str, kind: &str) -> Result<(), String> {
        let id = self.requests.fetch_add(1, Ordering::SeqCst) + 1;
        self.send_control(json!({
            "type": "task-phase",
            "requestId": id,
            "sessionId": session_id,
            "phase": phase,
            "kind": kind,
        }))
    }

    /// The acknowledged form, used before a write-back turn: the prompt cannot
    /// run until the plugin's phase map says `writeback`.
    pub async fn request_task_phase(
        &self,
        session_id: &str,
        phase: &str,
        kind: &str,
    ) -> Result<(), String> {
        self.request(
            json!({
                "type": "task-phase",
                "sessionId": session_id,
                "phase": phase,
                "kind": kind,
            }),
            PHASE_TIMEOUT,
        )
        .await
        .map(|_| ())
    }

    /// The whole phase map, sent after `hello` and after any list change.
    pub fn send_task_phases(&self, phases: Value) -> Result<(), String> {
        self.send_control(json!({ "type": "task-phases", "phases": phases }))
    }

    /// A hidden host-authored turn. The plugin creates it with
    /// `source.kind = "host"` so the transcript does not show a user line.
    pub fn send_host_prompt(&self, session_id: &str, text: &str) -> Result<(), String> {
        self.send_control(json!({
            "type": "host-prompt",
            "sessionId": session_id,
            "text": text,
        }))
    }

    /// Answers one plugin call. `requestId` is the plugin's `p-<n>` string.
    pub fn send_host_reply(&self, request_id: &str, result: Result<Value, String>) {
        let frame = match result {
            Ok(data) => json!({
                "type": "host-reply",
                "requestId": request_id,
                "ok": true,
                "data": data,
            }),
            Err(error) => json!({
                "type": "host-reply",
                "requestId": request_id,
                "ok": false,
                "error": error,
            }),
        };
        if let Err(error) = self.send_control(frame) {
            tracing::warn!(%error, request_id, "host reply could not be delivered");
        }
    }

    /// Moves one session to `cwd` (used to point a task at its worktree). The
    /// plugin applies it immediately when the session exists and on
    /// `session/created` otherwise.
    pub async fn assign_session(&self, session_id: &str, cwd: &str) -> Result<(), String> {
        self.send_control(json!({
            "type": "assign",
            "sessionId": session_id,
            "cwd": cwd,
        }))
    }

    /// Stops the current turn of one session without touching the others.
    pub async fn cancel_session(&self, session_id: &str) -> Result<(), String> {
        self.send_control(json!({ "type": "cancel", "sessionId": session_id }))
    }

    /// Toggles Team mode for one session. The plugin applies it through the
    /// `agentTeams` service and re-publishes the board; a session whose Agent
    /// does not exist yet has the toggle queued until `agent/created`.
    pub async fn set_team_mode(&self, session_id: &str, enabled: bool) -> Result<(), String> {
        self.send_control(json!({
            "type": "team",
            "sessionId": session_id,
            "enabled": enabled,
        }))
    }

    /// Replaces the running profile's model catalog (and the Team default)
    /// without a restart. The plugin writes the rows through the engine's own
    /// config editor and answers once the Loader reconciled them, so a caller
    /// that returns here can trust the new routes are live.
    ///
    /// `providers: None` keeps the running catalog untouched and only refreshes
    /// the managed credentials — what a start does, because the profile it just
    /// rendered is current while a credential the engine stored in an earlier
    /// run would otherwise outrank the key this process was spawned with.
    pub async fn apply_catalog(
        &self,
        providers: Option<Value>,
        team_default: Option<bool>,
        keys: Value,
        drop_keys: Vec<String>,
    ) -> Result<(), String> {
        let mut frame = json!({
            "type": "models",
            "keys": keys,
            "dropKeys": drop_keys,
        });
        if let Some(providers) = providers {
            frame["providers"] = providers;
        }
        if let Some(team_default) = team_default {
            frame["teamDefaultEnabled"] = json!(team_default);
        }
        self.request(frame, REPLY_TIMEOUT).await.map(|_| ())
    }

    /// Reads the runtime's composed plugin inventory (the settings panel's
    /// "内置插件"). The plugin answers from its own Loader, so this is what is
    /// actually running, not what the profile file says.
    pub async fn plugin_inventory(&self) -> Result<Value, String> {
        let reply = self
            .request(json!({ "type": "plugins" }), REPLY_TIMEOUT)
            .await?;
        Ok(reply
            .get("entries")
            .cloned()
            .unwrap_or_else(|| json!([])))
    }

    /// Reads the tool registry a session created now inherits (the settings
    /// panel's "集成"). The plugin answers from the engine's own `tools`
    /// service, so conditional rows are reported rather than guessed.
    pub async fn tool_inventory(&self) -> Result<Value, String> {
        let reply = self
            .request(json!({ "type": "tools" }), REPLY_TIMEOUT)
            .await?;
        Ok(reply
            .get("tools")
            .cloned()
            .unwrap_or_else(|| json!([])))
    }

    /// Points one session at a model route and queues the frame for the plugin.
    /// The plugin applies it immediately for a live Agent and queues it until
    /// `agent/created` otherwise, so calling this before the session exists is
    /// safe. The choice is remembered even when the plugin is offline: the next
    /// prompt calls this again once the runtime is up.
    pub fn select_model(&self, session_id: &str, selection: &ModelSelection) -> Result<(), String> {
        self.remember_selection(session_id, selection.clone());
        // `reasoningEffort` must be absent, not null: dsh validates it as a
        // non-empty string when present and an explicit null fails that check.
        let mut frame = json!({
            "type": "select-model",
            "sessionId": session_id,
            "provider": selection.provider,
            "model": selection.model,
        });
        if let Some(effort) = &selection.reasoning_effort {
            frame["reasoningEffort"] = Value::from(effort.clone());
        }
        self.send_control(frame)
    }

    /// Keeps a choice for this app run (also used to preserve a session's own
    /// route across an SDK resume, which re-selects the runtime default).
    pub fn remember_selection(&self, session_id: &str, selection: ModelSelection) {
        self.selections
            .lock()
            .expect("dsh selection lock")
            .insert(session_id.to_string(), selection);
    }

    /// A choice made in this app run, if any.
    pub fn pending_selection(&self, session_id: &str) -> Option<ModelSelection> {
        self.selections
            .lock()
            .expect("dsh selection lock")
            .get(session_id)
            .cloned()
    }

    /// Pushes the runtime-wide default permission mode. Every session without
    /// an override picks it up on its next tool call. The value is remembered
    /// so a reconnect can replay it (the plugin may have missed the first send).
    pub fn set_default_mode(&self, mode: PermissionMode) -> Result<(), String> {
        self.remember_default_mode(mode);
        self.send_control(json!({
            "type": "default-mode",
            "mode": mode.as_env(),
        }))
    }

    pub fn remember_default_mode(&self, mode: PermissionMode) {
        *self
            .default_mode
            .lock()
            .expect("dsh default mode lock") = Some(mode);
    }

    fn current_default_mode(&self) -> Option<PermissionMode> {
        *self.default_mode.lock().expect("dsh default mode lock")
    }

    /// Pushes one session's permission mode and remembers it for the next
    /// prompt. The plugin applies it on the next tool call.
    pub fn set_session_mode(&self, session_id: &str, mode: PermissionMode) -> Result<(), String> {
        self.remember_mode(session_id, mode);
        self.send_control(json!({
            "type": "mode",
            "sessionId": session_id,
            "mode": mode.as_env(),
        }))
    }

    pub fn remember_mode(&self, session_id: &str, mode: PermissionMode) {
        self.modes
            .lock()
            .expect("dsh mode lock")
            .insert(session_id.to_string(), mode);
    }

    /// The mode this app run last pushed for the session, if any.
    pub fn pending_mode(&self, session_id: &str) -> Option<PermissionMode> {
        self.modes
            .lock()
            .expect("dsh mode lock")
            .get(session_id)
            .copied()
    }

    /// Asks the plugin to re-run the session's last turn. The plugin inserts the
    /// engine's own empty `retry` user message, so the prompt is not repeated in
    /// the model's context.
    pub fn retry_session(&self, session_id: &str) -> Result<(), String> {
        self.send_control(json!({
            "type": "retry",
            "sessionId": session_id,
        }))
    }

    /// Requests plan mode for one session. The plugin queues the frame until
    /// the Agent exists; the engine writes `plan/mode` once it is applied.
    pub fn set_plan(&self, session_id: &str, active: bool) -> Result<(), String> {
        self.plans
            .lock()
            .expect("dsh plan lock")
            .insert(session_id.to_string(), active);
        self.send_control(json!({
            "type": "plan",
            "sessionId": session_id,
            "active": active,
        }))
    }

    /// A plan choice that has not been confirmed by the engine yet.
    pub fn pending_plan(&self, session_id: &str) -> Option<bool> {
        self.plans
            .lock()
            .expect("dsh plan lock")
            .get(session_id)
            .copied()
    }

    /// Drops a plan request once the engine's own event confirms that state.
    /// A divergent event (a snapshot from before the request) is ignored so a
    /// reconnect cannot cancel the user's pending choice.
    fn settle_plan_event(&self, session_id: &str, event: &Value) {
        if event.get("type").and_then(Value::as_str) != Some("plan/mode") {
            return;
        }
        let active = event
            .pointer("/data/active")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut plans = self.plans.lock().expect("dsh plan lock");
        if plans.get(session_id).copied() == Some(active) {
            plans.remove(session_id);
        }
    }

    /// The route dsh itself recorded for this session (`model/selection`).
    pub fn recorded_selection(&self, session_id: &str) -> Option<ModelSelection> {
        self.transcript
            .lock()
            .expect("dsh transcript lock")
            .selection(session_id)
    }

    /// The route a prompt should force: this app run's choice, else the route
    /// in the session log, else the configured default.
    pub fn desired_selection(
        &self,
        session_id: &str,
        default: Option<ModelSelection>,
    ) -> Option<ModelSelection> {
        self.pending_selection(session_id)
            .or_else(|| self.recorded_selection(session_id))
            .or(default)
    }

    /// Whether this process has seen the session (live or hydrated from log).
    pub fn knows(&self, session_id: &str) -> bool {
        self.transcript
            .lock()
            .expect("dsh transcript lock")
            .knows(session_id)
    }

    /// The board the plugin last reported for this session. `None` means the
    /// runtime has not published one yet, which the command surfaces as an
    /// empty, disabled team rather than an error.
    pub fn team(&self, session_id: &str) -> Option<DshTeam> {
        self.teams
            .lock()
            .expect("dsh team lock")
            .get(session_id)
            .cloned()
    }

    /// Queues one frame for the connected plugin.
    ///
    /// Fails when no plugin has connected since this runtime started: silently
    /// dropping a worktree assignment would leave the task running in the wrong
    /// directory, so the caller must surface the error.
    fn send_control(&self, mut frame: Value) -> Result<(), String> {
        let token = self
            .token
            .lock()
            .expect("dsh bridge token lock")
            .clone()
            .ok_or_else(|| tr("dsh.bridge.unavailable").to_string())?;
        frame["token"] = Value::from(token);
        let control = self.control.lock().expect("dsh bridge control lock");
        let Some(control) = control.as_ref() else {
            return Err(tr("dsh.policy.bridge.offline").to_string());
        };
        control
            .lines
            .send(frame.to_string())
            .map_err(|_| tr("dsh.policy.bridge.offline").to_string())
    }

    /// The newest connection that presented the token owns outbound frames.
    fn claim_control(&self, generation: u64, lines: mpsc::UnboundedSender<String>) {
        *self.control.lock().expect("dsh bridge control lock") = Some(Control { generation, lines });
    }

    fn release_control(&self, generation: u64) {
        let mut control = self.control.lock().expect("dsh bridge control lock");
        if control
            .as_ref()
            .is_some_and(|current| current.generation == generation)
        {
            *control = None;
        }
    }

    /// The one ingest entry point for committed events from either feed.
    pub fn ingest(&self, app: &AppHandle, session_id: &str, event: &Value) {
        self.settle_plan_event(session_id, event);
        let at = event_at(event);
        let ingested = {
            let mut transcript = self.transcript.lock().expect("dsh transcript lock");
            transcript.ingest(session_id, event, &at)
        };
        self.publish(app, session_id, ingested);
    }

    /// `session.status` notifications; the live authority on `running`.
    pub fn set_status(&self, app: &AppHandle, session_id: &str, status: SessionStatus) {
        let at = now();
        let changed = {
            let mut transcript = self.transcript.lock().expect("dsh transcript lock");
            transcript.set_status(session_id, status, &at)
        };
        if changed {
            self.emit_sessions(app);
        }
    }

    /// After the runtime process exits no turn can still be live.
    pub fn runtime_exited(&self, app: &AppHandle) {
        let changed = {
            let mut transcript = self.transcript.lock().expect("dsh transcript lock");
            transcript.mark_runtime_exited()
        };
        if changed {
            self.emit_sessions(app);
        }
    }

    /// Allocates the registry row for a new session id.
    pub fn create_session(&self, app: &AppHandle, session_id: &str) -> bool {
        let created = {
            let mut transcript = self.transcript.lock().expect("dsh transcript lock");
            transcript.ensure_session(session_id, &now())
        };
        if created {
            self.emit_sessions(app);
        }
        created
    }

    pub fn sessions(&self) -> Vec<DshSession> {
        self.transcript
            .lock()
            .expect("dsh transcript lock")
            .sessions()
    }

    /// Forgets a deleted session so the list and any later read cannot
    /// resurrect it. The caller removes the log and the task row.
    pub fn forget_session(&self, app: &AppHandle, session_id: &str) {
        self.modes
            .lock()
            .expect("dsh mode lock")
            .remove(session_id);
        self.plans
            .lock()
            .expect("dsh plan lock")
            .remove(session_id);
        let removed = self
            .transcript
            .lock()
            .expect("dsh transcript lock")
            .remove_session(session_id);
        if removed {
            self.emit_sessions(app);
        }
    }

    /// Entries past `since_seq` plus the session's current last seq.
    pub fn entries_since(&self, session_id: &str, since_seq: u64) -> Option<(Vec<DshEntry>, u64)> {
        self.transcript
            .lock()
            .expect("dsh transcript lock")
            .entries_since(session_id, since_seq)
    }

    /// Rebuilds one session from dsh's own log, for a session this process has
    /// not seen (the runtime resumes sessions lazily and may be stopped).
    ///
    /// Ingested quietly: the caller returns these rows directly, so publishing
    /// them would only duplicate a burst the UI is about to read anyway.
    /// Returns whether a log existed.
    pub fn hydrate_from_log(&self, sessions_dir: &Path, session_id: &str) -> bool {
        let Some(events) = super::session_log::events(sessions_dir, session_id) else {
            return false;
        };
        {
            let mut transcript = self.transcript.lock().expect("dsh transcript lock");
            // The log's first line is the session header (`type: "session"`),
            // the only place the subagent identity (origin / parentSession /
            // agentPreset) lives once the runtime is gone. It carries no `seq`,
            // so the ingest loop below skips it either way.
            if let Some(header) = events
                .first()
                .filter(|line| line.get("type").and_then(Value::as_str) == Some("session"))
            {
                transcript.set_meta(
                    session_id,
                    header.get("origin").and_then(Value::as_str),
                    header.get("parentSession").and_then(Value::as_str),
                    header.get("agentPreset").and_then(Value::as_str),
                    &header_at(header),
                );
            }
            for event in &events {
                transcript.ingest(session_id, event, &event_at(event));
            }
            // The runtime did not know this session, so it cannot be running a
            // turn: an unclosed `turn/start` in the file is a crash artifact.
            transcript.settle_hydrated(session_id);
        }
        true
    }

    /// Puts the stored context meter back on a hydrated session. The log holds
    /// token totals; only the meter table remembers how a request was split.
    pub fn restore_meter(&self, app: &AppHandle, session_id: &str) {
        let Some(cache) = cache_of(app) else {
            return;
        };
        let Ok(Some(stored)) = super::meter_store::load(&cache, session_id) else {
            return;
        };
        let mut transcript = self.transcript.lock().expect("dsh transcript lock");
        transcript.set_meter(session_id, &stored.meter, &stored.at);
    }

    /// Applies one NDJSON message from the plugin.
    fn dispatch(&self, app: &AppHandle, message: &Value) {
        let frame_type = message.get("type").and_then(Value::as_str);
        // `task-phase` acks carry no `type`, only the numeric request id the
        // host assigned. They are replies to a pending request, like the named
        // reply kinds below.
        if frame_type.is_none() {
            if message.get("requestId").and_then(Value::as_u64).is_some() {
                self.resolve_reply(message);
            } else {
                tracing::warn!("agent bridge: frame without a type");
            }
            return;
        }
        let Some(frame_type) = frame_type else {
            return;
        };
        match frame_type {
            "hello" => {
                tracing::info!("agent bridge connected");
                // The plugin may have connected after a default-mode frame was
                // attempted; replay it so the running gate is never stale.
                if let Some(mode) = self.current_default_mode() {
                    if let Err(error) = self.set_default_mode(mode) {
                        tracing::debug!(%error, "default mode was not replayed on connect");
                    }
                }
                // A reconnect has an empty phase map; the task rows are the
                // source, so push the whole map before the next turn.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    super::tasks::publish_phases(&app).await;
                });
            }
            "host" => {
                // The plugin's conditional tools call back here. The work can
                // hit the network (TAPD), so it must not block the reader.
                let app = app.clone();
                let frame = message.clone();
                tauri::async_runtime::spawn(async move {
                    super::tasks::host_rpc(&app, &frame).await;
                });
            }
            "snapshot" => self.ingest_snapshot(app, message),
            "session-meta" => self.ingest_session_meta(app, message),
            "event" => {
                let session_id = message.get("sessionId").and_then(Value::as_str);
                let event = message.get("event");
                match (session_id, event) {
                    (Some(session_id), Some(event)) => self.ingest(app, session_id, event),
                    _ => tracing::warn!("agent bridge: malformed event frame"),
                }
            }
            "stream" => self.ingest_stream(app, message),
            "stats" => self.ingest_stats(app, message),
            "team" => self.ingest_team(app, message),
            "notice" => super::policy::notice(message),
            kind if REPLY_TYPES.contains(&kind) => self.resolve_reply(message),
            other => tracing::debug!(kind = other, "agent bridge: unknown frame type"),
        }
    }

    /// Hands one plugin reply to the caller waiting on its `requestId`.
    fn resolve_reply(&self, message: &Value) {
        let Some(id) = message.get("requestId").and_then(Value::as_u64) else {
            tracing::warn!("agent bridge: reply frame without a request id");
            return;
        };
        let sender = self
            .replies
            .lock()
            .expect("dsh bridge reply lock")
            .remove(&id);
        // The channel carries one value; a duplicate reply finds no waiter.
        if let Some(sender) = sender {
            let _ = sender.send(message.clone());
        }
    }

    fn ingest_snapshot(&self, app: &AppHandle, message: &Value) {
        let session_id = message.get("sessionId").and_then(Value::as_str);
        let events = message.get("events").and_then(Value::as_array);
        let (Some(session_id), Some(events)) = (session_id, events) else {
            tracing::warn!("agent bridge: malformed snapshot frame");
            return;
        };
        // One lock per snapshot: the normalization pass is pure and short, and
        // each row is published afterwards.
        for event in events {
            self.settle_plan_event(session_id, event);
        }
        let outcomes = {
            let mut transcript = self.transcript.lock().expect("dsh transcript lock");
            events
                .iter()
                .map(|event| transcript.ingest(session_id, event, &event_at(event)))
                .collect::<Vec<_>>()
        };
        // One list update per snapshot, not one per event: a long history is
        // thousands of events.
        let changed = outcomes
            .into_iter()
            .map(|ingested| self.publish_entry(app, session_id, ingested))
            .fold(false, |changed, entry_changed| changed || entry_changed);
        if changed {
            self.emit_sessions(app);
        }
    }

    /// One session's header identity from the plugin (`origin` /
    /// `parentSession` / `agentPreset`). A child agent session is spawned by
    /// the runtime itself, so the transcript learns the relationship from this
    /// frame; the log header covers the hydrated path.
    fn ingest_session_meta(&self, app: &AppHandle, message: &Value) {
        let Some(session_id) = message.get("sessionId").and_then(Value::as_str) else {
            tracing::warn!("agent bridge: session-meta frame without a session");
            return;
        };
        let origin = message.get("origin").and_then(Value::as_str);
        let parent = message.get("parentSession").and_then(Value::as_str);
        let preset = message.get("agentPreset").and_then(Value::as_str);
        let at = now();
        let changed = {
            let mut transcript = self.transcript.lock().expect("dsh transcript lock");
            transcript.set_meta(session_id, origin, parent, preset, &at)
        };
        if changed {
            self.emit_sessions(app);
        }
    }

    fn ingest_stream(&self, app: &AppHandle, message: &Value) {
        let Some(session_id) = message.get("sessionId").and_then(Value::as_str) else {
            tracing::warn!("agent bridge: stream frame without a session");
            return;
        };
        let Some(frame) = message.get("frame") else {
            tracing::warn!("agent bridge: stream frame without a payload");
            return;
        };
        let Some(stream) = normalize_stream(session_id, frame) else {
            // start/end/usage/finish frames carry no delta; committed entries
            // settle the turn, so there is nothing to render here.
            return;
        };
        let _ = app.emit(
            EVENT_STREAM,
            json!({ "sessionId": session_id, "stream": stream }),
        );
    }

    /// The runtime's own meter snapshot: prompt-side context occupancy and the
    /// composition of the request surface. Token totals stay transcript-owned;
    /// this only fills the figures dsh alone can price.
    fn ingest_stats(&self, app: &AppHandle, message: &Value) {
        let Some(session_id) = message.get("sessionId").and_then(Value::as_str) else {
            tracing::warn!("agent bridge: stats frame without a session");
            return;
        };
        let meter = normalize_meter(message);
        tracing::debug!(session = session_id, ?meter, "dsh stats frame");
        let at = now();
        let changed = {
            let mut transcript = self.transcript.lock().expect("dsh transcript lock");
            transcript.set_meter(session_id, &meter, &at)
        };
        // dsh keeps this in memory only: without the row a restarted app knows
        // a session's token totals but not what filled the window.
        persist_meter(app, session_id, &at, &meter);
        if changed {
            self.emit_sessions(app);
        }
    }

    /// Team board for one root session. Every frame replaces the stored board
    /// and reaches the UI; the plugin only sends it when the projection exists
    /// and after a settled burst of board events.
    fn ingest_team(&self, app: &AppHandle, message: &Value) {
        let Some(session_id) = message.get("sessionId").and_then(Value::as_str) else {
            tracing::warn!("agent bridge: team frame without a session");
            return;
        };
        let team = normalize_team(session_id, message);
        self.teams
            .lock()
            .expect("dsh team lock")
            .insert(session_id.to_string(), team.clone());
        let _ = app.emit(
            super::team::EVENT_TEAM,
            json!({ "sessionId": session_id, "team": team }),
        );
    }

    fn publish(&self, app: &AppHandle, session_id: &str, ingested: Ingested) {
        if self.publish_entry(app, session_id, ingested) {
            self.emit_sessions(app);
        }
    }

    /// Emits the entry (if any) and returns whether the session list changed.
    fn publish_entry(&self, app: &AppHandle, session_id: &str, ingested: Ingested) -> bool {
        if let Some(kind) = ingested.unknown {
            tracing::debug!(event_type = %kind, "ignored an unrecognized dsh session event");
        }
        if let Some(entry) = ingested.entry {
            // The task workflow owns `turn/end` transitions; it sees the row
            // before the UI so the list is already correct on the next paint.
            super::tasks::observe(app, session_id, &entry);
            let _ = app.emit(
                EVENT_ENTRY,
                json!({ "sessionId": session_id, "entry": entry }),
            );
        }
        ingested.created || ingested.session_changed
    }

    /// Publishes the current session list. Used after hydrating a session from
    /// disk so the UI gets its usage counters without waiting for the runtime.
    pub fn publish_sessions(&self, app: &AppHandle) {
        self.emit_sessions(app);
    }

    fn emit_sessions(&self, app: &AppHandle) {
        let sessions = self.sessions();
        let _ = app.emit(EVENT_SESSIONS, json!({ "sessions": sessions }));
    }
}

/// Accepts plugin connections (initial and reconnects) until the runtime stops.
async fn accept_loop(
    listener: TcpListener,
    app: AppHandle,
    bridge: Arc<BridgeState>,
    token: String,
) {
    loop {
        let Ok((socket, peer)) = listener.accept().await else {
            tracing::warn!("agent bridge stopped accepting connections");
            break;
        };
        if !peer.ip().is_loopback() {
            tracing::warn!(%peer, "rejected a non-loopback agent bridge connection");
            continue;
        }
        let bridge = bridge.clone();
        let app = app.clone();
        let token = token.clone();
        let generation = bridge.connections.fetch_add(1, Ordering::SeqCst) + 1;
        tokio::spawn(async move {
            serve_connection(socket, peer, app, bridge, token, generation).await;
        });
    }
}

/// One plugin connection: NDJSON in, queued NDJSON lines out.
async fn serve_connection(
    socket: TcpStream,
    peer: SocketAddr,
    app: AppHandle,
    bridge: Arc<BridgeState>,
    token: String,
    generation: u64,
) {
    let (read, write) = socket.into_split();
    let (lines_tx, lines_rx) = mpsc::unbounded_channel::<String>();
    // The writer owns the half; it ends when the read loop drops the last
    // sender, which also closes the socket.
    tauri::async_runtime::spawn(pump_writes(write, lines_rx));

    let mut lines = BufReader::new(read).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(message) => {
                        let presented = message.get("token").and_then(Value::as_str);
                        if presented != Some(token.as_str()) {
                            tracing::warn!(%peer, "agent bridge token mismatch; closing");
                            break;
                        }
                        if message.get("type").and_then(Value::as_str) == Some("hello") {
                            bridge.claim_control(generation, lines_tx.clone());
                        }
                        bridge.dispatch(&app, &message);
                    }
                    Err(error) => {
                        // One bad frame must not lose the rest of the stream.
                        tracing::warn!(%peer, %error, "agent bridge: malformed line");
                    }
                }
            }
            Ok(None) => break,
            Err(error) => {
                tracing::debug!(%peer, %error, "agent bridge read failed");
                break;
            }
        }
    }
    bridge.release_control(generation);
}

/// Drains queued control frames onto the socket in order.
async fn pump_writes(mut write: OwnedWriteHalf, mut lines: mpsc::UnboundedReceiver<String>) {
    while let Some(line) = lines.recv().await {
        if write.write_all(line.as_bytes()).await.is_err()
            || write.write_all(b"\n").await.is_err()
            || write.flush().await.is_err()
        {
            break;
        }
    }
}

/// Maps one `AssistantStreamFrame` chunk onto the durable UI delta contract.
fn normalize_stream(session_id: &str, frame: &Value) -> Option<DshStream> {
    if frame.get("type").and_then(Value::as_str) != Some("chunk") {
        return None;
    }
    let attempt_id = frame.get("attemptId")?.as_str()?.to_string();
    let revision = frame.get("revision")?.as_u64()?;
    let index = frame.get("index")?.as_u64()?;
    let chunk = frame.get("chunk")?;
    let delta = match chunk.get("type").and_then(Value::as_str)? {
        "text-delta" => DshDelta::Text {
            text: chunk.get("text").and_then(Value::as_str)?.to_string(),
        },
        "reasoning-delta" => DshDelta::Reasoning {
            text: chunk.get("text").and_then(Value::as_str)?.to_string(),
        },
        "tool-call-delta" => DshDelta::ToolCall {
            call_id: text_field(chunk, "id"),
            name: text_field(chunk, "name"),
            arguments: text_field(chunk, "argumentsDelta"),
        },
        _ => return None,
    };
    Some(DshStream {
        session_id: session_id.to_string(),
        attempt_id,
        revision,
        index,
        delta,
    })
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// The offline cache handle, when the app is in a state that has one.
fn cache_of(app: &AppHandle) -> Option<std::sync::Arc<crate::cache::Cache>> {
    app.try_state::<std::sync::Arc<crate::state::AppState>>()
        .map(|state| state.cache.clone())
}

/// Writes the meter in the background: a frame must never wait on SQLite.
fn persist_meter(app: &AppHandle, session_id: &str, at: &str, meter: &SessionMeter) {
    let Some(cache) = cache_of(app) else {
        return;
    };
    let session_id = session_id.to_string();
    let at = at.to_string();
    let meter = meter.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            super::meter_store::save(&cache, &session_id, &at, &meter)
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(%error, "failed to persist a context meter"),
            Err(error) => tracing::warn!(%error, "context meter write panicked"),
        }
    });
}

/// Reads one `stats` frame. `projectedTokens` is the runtime's forward-looking
/// occupancy (the last sample plus surface movement); `pressureTokens` is the
/// last request's own prompt size, used when the projection is unavailable.
fn normalize_meter(message: &Value) -> SessionMeter {
    let number = |pointer: &str| message.pointer(pointer).and_then(Value::as_u64);
    SessionMeter {
        context_used_tokens: number("/pressure/projectedTokens")
            .or_else(|| number("/pressure/pressureTokens")),
        context_window: number("/pressure/contextWindow"),
        system_tokens: number("/breakdown/systemTokens"),
        tools_tokens: number("/breakdown/toolsTokens"),
        message_tokens: number("/breakdown/messageTokens"),
        // dsh's own whole-log fold; the rate is derived in the transcript.
        decode_tokens: number("/stats/decodeTokens"),
        decode_ms: number("/stats/decodeMs"),
        ttft_ms: number("/stats/ttftMs"),
        ttft_steps: number("/stats/ttftSteps"),
    }
}

/// The event's own timestamp (`time`, epoch ms), so a replayed snapshot keeps
/// its original ordering. Falls back to now for a malformed event.
fn event_at(event: &Value) -> String {
    event
        .get("time")
        .and_then(Value::as_u64)
        .and_then(|millis| chrono::DateTime::<Utc>::from_timestamp_millis(millis as i64))
        .map(format_time)
        .unwrap_or_else(now)
}

/// The session header's own `createdAt` (epoch ms), like `event_at` for
/// events. A hydrated session's identity lands at the time the session was
/// created, never at "just now".
fn header_at(header: &Value) -> String {
    header
        .get("createdAt")
        .and_then(Value::as_u64)
        .and_then(|millis| chrono::DateTime::<Utc>::from_timestamp_millis(millis as i64))
        .map(format_time)
        .unwrap_or_else(now)
}

fn now() -> String {
    format_time(Utc::now())
}

/// Fixed-width RFC3339 so lexicographic order is chronological.
fn format_time(time: chrono::DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Convenience for the runtime: binds this start's loopback endpoint.
pub async fn open(app: &AppHandle) -> Result<BridgeEndpoint, String> {
    let state = app
        .try_state::<Arc<BridgeState>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| tr("dsh.bridge.unavailable").to_string())?;
    state.open(app).await
}

/// Convenience for the runtime: the process is gone, so close the listener and
/// fail any session that was still streaming.
pub async fn shutdown(app: &AppHandle) {
    if let Some(bridge) = app.try_state::<Arc<BridgeState>>() {
        bridge.close().await;
        bridge.runtime_exited(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dsh_host::transcript::{DshEntry, TurnState};

    #[test]
    fn text_and_reasoning_chunks_become_deltas() {
        let frame = json!({
            "type": "chunk", "attemptId": "a1", "revision": 2, "index": 7,
            "time": 1,
            "chunk": { "type": "text-delta", "index": 7, "text": "hi" }
        });
        let stream = normalize_stream("s1", &frame).expect("delta");
        assert_eq!(stream.session_id, "s1");
        assert_eq!(stream.revision, 2);
        assert_eq!(stream.index, 7);
        assert_eq!(stream.delta, DshDelta::Text { text: "hi".into() });
    }

    #[test]
    fn tool_call_chunks_keep_partial_arguments() {
        let frame = json!({
            "type": "chunk", "attemptId": "a1", "revision": 1, "index": 2,
            "chunk": {
                "type": "tool-call-delta", "index": 2, "id": "c1",
                "name": "bash", "argumentsDelta": "{\"cmd\":"
            }
        });
        let stream = normalize_stream("s1", &frame).expect("delta");
        assert_eq!(
            stream.delta,
            DshDelta::ToolCall {
                call_id: Some("c1".into()),
                name: Some("bash".into()),
                arguments: Some("{\"cmd\":".into()),
            }
        );
    }

    #[test]
    fn lifecycle_and_usage_frames_emit_no_delta() {
        for frame in [
            json!({ "type": "start", "attemptId": "a", "revision": 1, "turn": 1, "step": 1 }),
            json!({ "type": "end", "attemptId": "a", "revision": 1, "index": 3,
                    "outcome": { "kind": "abandoned" } }),
            json!({ "type": "chunk", "attemptId": "a", "revision": 1, "index": 1,
                    "chunk": { "type": "usage", "usage": {} } }),
        ] {
            assert!(normalize_stream("s1", &frame).is_none());
        }
    }

    #[test]
    fn event_time_is_rfc3339_with_millis() {
        let event = json!({ "time": 1_700_000_000_123u64 });
        assert_eq!(event_at(&event), "2023-11-14T22:13:20.123Z");
        // Sorted lexicographically, i.e. chronologically.
        let later = json!({ "time": 1_700_000_001_000u64 });
        assert!(event_at(&later) > event_at(&event));
    }

    #[test]
    fn a_stats_frame_fills_context_and_composition() {
        let frame = json!({
            "type": "stats",
            "sessionId": "s1",
            "pressure": { "contextWindow": 1_000_000, "pressureTokens": 12_000,
                          "projectedTokens": 12_060 },
            "breakdown": { "systemTokens": 1_800, "toolsTokens": 8_800,
                           "messageTokens": 1_460 },
        });
        let meter = normalize_meter(&frame);
        assert_eq!(meter.context_used_tokens, Some(12_060));
        assert_eq!(meter.context_window, Some(1_000_000));
        assert_eq!(meter.system_tokens, Some(1_800));
        assert_eq!(meter.tools_tokens, Some(8_800));
        assert_eq!(meter.message_tokens, Some(1_460));

        // A projection that has not caught up yet still reports its sample.
        let fallback = json!({ "pressure": { "pressureTokens": 9_000 } });
        assert_eq!(normalize_meter(&fallback).context_used_tokens, Some(9_000));
        assert_eq!(normalize_meter(&json!({})), SessionMeter::default());
    }

    #[test]
    fn turn_state_is_part_of_the_contract() {
        let entry = DshEntry::Turn {
            seq: 1,
            at: "2026-11-16T00:00:00.000Z".into(),
            turn: 1,
            state: TurnState::Start,
            reason: None,
            error: None,
        };
        let value = serde_json::to_value(entry).unwrap();
        assert_eq!(value["kind"], "turn");
        assert_eq!(value["state"], "start");
        assert!(value.get("reason").is_none());
        assert!(value.get("error").is_none());
    }

    #[test]
    fn a_hydrated_log_header_marks_child_sessions() {
        let dir = std::env::temp_dir().join(format!(
            "tapd-bridge-hydrate-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let session_dir = dir.join("--Users-me--").join("child-9");
        std::fs::create_dir_all(&session_dir).unwrap();
        // First line is dsh's own session header; the events follow it.
        let log = session_dir.join("session.v4.jsonl");
        std::fs::write(
            &log,
            concat!(
                "{\"type\":\"session\",\"version\":4,\"id\":\"child-9\",\"createdAt\":1700000000000,",
                "\"isSeeded\":false,\"delegationDepth\":1,\"origin\":\"subagent\",",
                "\"parentSession\":\"root-1\",\"agentPreset\":\"author\"}\n",
                "{\"type\":\"user/message\",\"seq\":0,\"time\":1700000000000,\"data\":{\"role\":\"user\",",
                "\"content\":[{\"type\":\"text\",\"text\":\"hi\"}],\"source\":{\"kind\":\"user\"}}}\n",
                "{\"type\":\"todo/write\",\"seq\":1,\"time\":1700000001000,",
                "\"data\":{\"todos\":[{\"content\":\"step\",\"status\":\"pending\"}]}}\n",
            ),
        )
        .unwrap();

        let bridge = BridgeState::default();
        assert!(bridge.hydrate_from_log(&dir, "child-9"));
        let session = bridge.sessions().into_iter().next().unwrap();
        assert_eq!(session.parent_session.as_deref(), Some("root-1"));
        assert_eq!(session.agent_preset.as_deref(), Some("author"));
        assert_eq!(session.todos.len(), 1);
        assert_eq!(session.todos[0].content, "step");
        // The runtime never knew this session, so it must not be running.
        assert_eq!(session.status, SessionStatus::Idle);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn control_frames_require_a_connected_plugin() {
        let bridge = BridgeState::default();
        // No runtime token yet: nothing may be queued.
        assert!(bridge.assign_session("s1", "/repo").await.is_err());

        *bridge.token.lock().unwrap() = Some("t".into());
        // Token present but no plugin connection: a clear error, not a silent
        // assignment that never happens.
        let error = bridge
            .assign_session("s1", "/repo")
            .await
            .expect_err("offline");
        assert_eq!(error, tr("dsh.policy.bridge.offline"));
    }

    #[tokio::test]
    async fn assign_and_cancel_frames_carry_the_token() {
        let bridge = BridgeState::default();
        *bridge.token.lock().unwrap() = Some("t".into());
        let (tx, mut rx) = mpsc::unbounded_channel();
        bridge.claim_control(1, tx);

        bridge.assign_session("s1", "/repo").await.unwrap();
        let line = rx.recv().await.expect("assign frame");
        let frame: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(frame["type"], "assign");
        assert_eq!(frame["token"], "t");
        assert_eq!(frame["sessionId"], "s1");
        assert_eq!(frame["cwd"], "/repo");

        bridge.cancel_session("s1").await.unwrap();
        let line = rx.recv().await.expect("cancel frame");
        let frame: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(frame["type"], "cancel");
        assert_eq!(frame["token"], "t");
        assert_eq!(frame["sessionId"], "s1");
    }

    #[tokio::test]
    async fn mode_and_plan_frames_are_remembered_and_carry_the_token() {
        let bridge = BridgeState::default();
        // Offline: the frame cannot be queued, but the choice must survive for
        // the next prompt.
        assert!(bridge.set_session_mode("s1", PermissionMode::Full).is_err());
        assert_eq!(bridge.pending_mode("s1"), Some(PermissionMode::Full));
        assert!(bridge.set_plan("s1", true).is_err());
        assert_eq!(bridge.pending_plan("s1"), Some(true));

        *bridge.token.lock().unwrap() = Some("t".into());
        let (tx, mut rx) = mpsc::unbounded_channel();
        bridge.claim_control(1, tx);

        bridge.set_default_mode(PermissionMode::Notify).unwrap();
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["type"], "default-mode");
        assert_eq!(frame["token"], "t");
        assert_eq!(frame["mode"], "notify");

        bridge.set_session_mode("s1", PermissionMode::Auto).unwrap();
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["type"], "mode");
        assert_eq!(frame["token"], "t");
        assert_eq!(frame["sessionId"], "s1");
        assert_eq!(frame["mode"], "auto");

        bridge.set_plan("s1", false).unwrap();
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["type"], "plan");
        assert_eq!(frame["token"], "t");
        assert_eq!(frame["active"], false);
    }

    #[test]
    fn only_a_matching_plan_event_clears_the_pending_choice() {
        let bridge = BridgeState::default();
        bridge.set_plan("s1", true).expect_err("offline");

        // A snapshot from before the request reports `false`; it must not cancel
        // the choice the user just made.
        bridge.settle_plan_event(
            "s1",
            &json!({ "type": "plan/mode", "data": { "active": false } }),
        );
        assert_eq!(bridge.pending_plan("s1"), Some(true));

        bridge.settle_plan_event(
            "s1",
            &json!({ "type": "plan/mode", "data": { "active": true } }),
        );
        assert_eq!(bridge.pending_plan("s1"), None);
    }

    #[tokio::test]
    async fn a_stale_connection_cannot_clear_a_newer_control_slot() {
        let bridge = BridgeState::default();
        *bridge.token.lock().unwrap() = Some("t".into());
        let (old_tx, _old_rx) = mpsc::unbounded_channel();
        let (new_tx, mut new_rx) = mpsc::unbounded_channel();
        bridge.claim_control(1, old_tx);
        bridge.claim_control(2, new_tx);

        // Connection 1 closing after connection 2 took over must not detach it.
        bridge.release_control(1);
        bridge.assign_session("s1", "/repo").await.expect("queued");

        let frame: Value = serde_json::from_str(&new_rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["type"], "assign");
    }

    #[tokio::test]
    async fn model_selection_is_queued_and_remembered() {
        let bridge = BridgeState::default();
        let selection = ModelSelection {
            provider: "opencode-go".into(),
            model: "deepseek-v4.1-flash".into(),
            reasoning_effort: Some("high".into()),
        };
        // No plugin yet: the choice is remembered for the next prompt instead
        // of failing the picker.
        assert!(bridge.select_model("s1", &selection).is_err());
        assert_eq!(bridge.pending_selection("s1"), Some(selection.clone()));
        assert_eq!(bridge.recorded_selection("s1"), None);

        *bridge.token.lock().unwrap() = Some("t".into());
        let (tx, mut rx) = mpsc::unbounded_channel();
        bridge.claim_control(1, tx);

        bridge.select_model("s1", &selection).expect("queued");
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["type"], "select-model");
        assert_eq!(frame["token"], "t");
        assert_eq!(frame["sessionId"], "s1");
        assert_eq!(frame["provider"], "opencode-go");
        assert_eq!(frame["model"], "deepseek-v4.1-flash");
        assert_eq!(frame["reasoningEffort"], "high");

        // An absent effort omits the key entirely; an explicit null would fail
        // dsh's non-empty-string validation.
        let plain = ModelSelection {
            provider: "acme".into(),
            model: "fast".into(),
            reasoning_effort: None,
        };
        bridge.select_model("s1", &plain).expect("queued");
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert!(frame.get("reasoningEffort").is_none());
        assert_eq!(bridge.desired_selection("s1", None), Some(plain));
    }

    #[tokio::test]
    async fn task_phase_frames_and_snapshots_carry_the_token() {
        let bridge = BridgeState::default();
        *bridge.token.lock().unwrap() = Some("t".into());
        let (tx, mut rx) = mpsc::unbounded_channel();
        bridge.claim_control(1, tx);

        bridge
            .send_task_phase("s1", "execute", "bug")
            .expect("queued");
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["type"], "task-phase");
        assert_eq!(frame["token"], "t");
        assert_eq!(frame["sessionId"], "s1");
        assert_eq!(frame["phase"], "execute");
        assert_eq!(frame["kind"], "bug");
        assert!(frame["requestId"].as_u64().is_some());

        bridge
            .send_task_phases(json!([{ "sessionId": "s1", "phase": "none", "kind": "bug" }]))
            .expect("queued");
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["type"], "task-phases");
        assert_eq!(frame["phases"][0]["phase"], "none");

        bridge
            .send_host_prompt("s1", "finish it")
            .expect("queued");
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["type"], "host-prompt");
        assert_eq!(frame["sessionId"], "s1");
        assert_eq!(frame["text"], "finish it");
    }

    #[tokio::test]
    async fn host_replies_use_the_plugin_request_id() {
        let bridge = BridgeState::default();
        *bridge.token.lock().unwrap() = Some("t".into());
        let (tx, mut rx) = mpsc::unbounded_channel();
        bridge.claim_control(1, tx);

        bridge.send_host_reply("p-7", Ok(json!({ "outcome": "review" })));
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["type"], "host-reply");
        assert_eq!(frame["requestId"], "p-7");
        assert_eq!(frame["ok"], true);
        assert_eq!(frame["data"]["outcome"], "review");

        bridge.send_host_reply("p-8", Err("nope".into()));
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["requestId"], "p-8");
        assert_eq!(frame["ok"], false);
        assert_eq!(frame["error"], "nope");
    }

    #[tokio::test]
    async fn an_ack_resolves_the_waiting_task_phase_request() {
        let bridge = std::sync::Arc::new(BridgeState::default());
        *bridge.token.lock().unwrap() = Some("t".into());
        let (tx, mut rx) = mpsc::unbounded_channel();
        bridge.claim_control(1, tx);

        let waiting = {
            let bridge = bridge.clone();
            tokio::spawn(async move {
                bridge
                    .request_task_phase("s1", "writeback", "bug")
                    .await
            })
        };
        // The frame the plugin receives; its `requestId` is the one it acks.
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        let request_id = frame["requestId"].as_u64().expect("numeric id");
        bridge.resolve_reply(&json!({ "requestId": request_id, "ok": true }));
        assert!(waiting.await.expect("join").is_ok());

        // An explicit rejection surfaces the plugin's error.
        let waiting = {
            let bridge = bridge.clone();
            tokio::spawn(async move {
                bridge
                    .request_task_phase("s1", "writeback", "bug")
                    .await
            })
        };
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        let request_id = frame["requestId"].as_u64().expect("numeric id");
        bridge.resolve_reply(&json!({
            "requestId": request_id,
            "ok": false,
            "error": "no map",
        }));
        assert_eq!(waiting.await.expect("join").unwrap_err(), "no map");
    }

    #[tokio::test]
    async fn team_mode_is_queued_as_one_token_carrying_frame() {
        let bridge = BridgeState::default();
        assert!(
            bridge.team("s1").is_none(),
            "no board before the runtime reports one"
        );
        // No plugin yet: the toggle must fail instead of pretending it applied.
        assert!(bridge.set_team_mode("s1", true).await.is_err());

        *bridge.token.lock().unwrap() = Some("t".into());
        let (tx, mut rx) = mpsc::unbounded_channel();
        bridge.claim_control(1, tx);

        bridge.set_team_mode("s1", true).await.expect("queued");
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["type"], "team");
        assert_eq!(frame["token"], "t");
        assert_eq!(frame["sessionId"], "s1");
        assert_eq!(frame["enabled"], true);

        bridge.set_team_mode("s1", false).await.expect("queued");
        let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(frame["enabled"], false);
    }
}
