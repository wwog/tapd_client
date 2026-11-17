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
    /// `agentTeams` service and re-publishes the board; the session must exist
    /// in the runtime (a queued frame for an unknown id is ignored).
    pub async fn set_team_mode(&self, session_id: &str, enabled: bool) -> Result<(), String> {
        self.send_control(json!({
            "type": "team",
            "sessionId": session_id,
            "enabled": enabled,
        }))
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
    /// an override picks it up on its next tool call.
    pub fn set_default_mode(&self, mode: PermissionMode) -> Result<(), String> {
        self.send_control(json!({
            "type": "default-mode",
            "mode": mode.as_env(),
        }))
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
        match message.get("type").and_then(Value::as_str) {
            Some("hello") => tracing::info!("agent bridge connected"),
            Some("snapshot") => self.ingest_snapshot(app, message),
            Some("event") => {
                let session_id = message.get("sessionId").and_then(Value::as_str);
                let event = message.get("event");
                match (session_id, event) {
                    (Some(session_id), Some(event)) => self.ingest(app, session_id, event),
                    _ => tracing::warn!("agent bridge: malformed event frame"),
                }
            }
            Some("stream") => self.ingest_stream(app, message),
            Some("stats") => self.ingest_stats(app, message),
            Some("team") => self.ingest_team(app, message),
            Some("notice") => super::policy::notice(message),
            Some(other) => tracing::debug!(kind = other, "agent bridge: unknown frame type"),
            None => tracing::warn!("agent bridge: frame without a type"),
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
