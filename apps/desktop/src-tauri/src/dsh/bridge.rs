//! Bridge listener: the single owner of the normalized transcript.
//!
//! Two feeds describe the same committed log — the plugin's snapshot/stream
//! socket (token-level live frames + history) and the SDK's `session.event`
//! notifications on stdio. Both call [`BridgeState::ingest`], which hands the
//! event to [`dsh_host::transcript::Transcript`]; the registry is the one
//! source the Tauri commands and the paired phone read.
//!
//! Locking: [`BridgeState::transcript`] is held only for the synchronous
//! normalization pass. Every emitter runs after the guard is dropped, so a
//! listener that calls back into `dsh_sessions` cannot deadlock. There is no
//! second lock around registry state.
//!
//! The listener binds `127.0.0.1:0` per runtime start; the URL and token go
//! into the child's environment and never leave the machine.

use std::net::SocketAddr;
use std::sync::Arc;

use chrono::{SecondsFormat, Utc};
use dsh_host::transcript::{
    DshDelta, DshEntry, DshSession, DshStream, Ingested, SessionStatus, Transcript,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use super::{EVENT_ENTRY, EVENT_SESSIONS, EVENT_STREAM};
use tapd_i18n::tr;

/// What the child needs to reach this listener.
#[derive(Clone, Debug)]
pub struct BridgeEndpoint {
    pub url: String,
    pub token: String,
}

#[derive(Default)]
pub struct BridgeState {
    /// Single owner; see the module docs for the lock order.
    transcript: std::sync::Mutex<Transcript>,
    /// The accept loop for the current runtime, if any.
    listener: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
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
    }

    /// The one ingest entry point for committed events from either feed.
    pub fn ingest(&self, app: &AppHandle, session_id: &str, event: &Value) {
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

    pub fn entries(&self, session_id: &str) -> Option<Vec<DshEntry>> {
        self.transcript
            .lock()
            .expect("dsh transcript lock")
            .entries(session_id)
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
            let _ = app.emit(
                EVENT_ENTRY,
                json!({ "sessionId": session_id, "entry": entry }),
            );
        }
        ingested.created || ingested.session_changed
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
        tokio::spawn(async move {
            serve_connection(socket, peer, app, bridge, token).await;
        });
    }
}

/// One plugin connection: newline-delimited JSON in, nothing back.
async fn serve_connection(
    socket: TcpStream,
    peer: SocketAddr,
    app: AppHandle,
    bridge: Arc<BridgeState>,
    token: String,
) {
    let mut lines = BufReader::new(socket).lines();
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
                            return;
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
    fn turn_state_is_part_of_the_contract() {
        let entry = DshEntry::Turn {
            seq: 1,
            at: "2026-11-16T00:00:00.000Z".into(),
            state: TurnState::Start,
            reason: None,
        };
        let value = serde_json::to_value(entry).unwrap();
        assert_eq!(value["kind"], "turn");
        assert_eq!(value["state"], "start");
        assert!(value.get("reason").is_none());
    }
}
