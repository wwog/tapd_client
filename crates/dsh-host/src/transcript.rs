//! Normalized session view shared by every frontend (desktop and paired phone).
//!
//! The bridge plugin and the SDK notification stream both describe the same
//! committed log, in two different shapes. This module owns the one conversion
//! into [`DshEntry`] plus the per-session registry ([`Transcript`]), so the
//! frontends read a single, stable contract instead of dsh internals.
//!
//! The module is deliberately clock- and IO-free: callers pass the RFC3339
//! timestamp for each event, which keeps the normalization deterministic and
//! unit-testable. Shapes are documented in `docs/DSH.md` §8.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Longest session title derived from the first user message.
const TITLE_MAX_CHARS: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Idle,
    Running,
    Failed,
}

/// One session as the session list shows it. `title` is empty until a first
/// user message arrives — the UI renders its own empty state rather than a
/// fabricated title.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshSession {
    pub id: String,
    pub title: String,
    /// RFC3339 with milliseconds, UTC. Fixed width, so lexicographic order is
    /// chronological and the list can sort without parsing.
    pub updated_at: String,
    pub status: SessionStatus,
    /// Committed user + assistant entries (tool calls and turn markers excluded).
    pub message_count: u64,
}

impl DshSession {
    fn new(id: &str, at: &str) -> Self {
        Self {
            id: id.to_string(),
            title: String::new(),
            updated_at: at.to_string(),
            status: SessionStatus::Idle,
            message_count: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolStatus {
    Running,
    Ok,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnState {
    Start,
    End,
}

/// One normalized, committed row. `seq` is the session-log position it came
/// from, so a UI keys rows by `seq` and a repeated snapshot replaces instead of
/// duplicating. A tool row keeps the `tool/call` seq; its `tool/result` update
/// arrives as another `dsh://entry` with the same `seq`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum DshEntry {
    User {
        seq: u64,
        at: String,
        text: String,
    },
    Assistant {
        seq: u64,
        at: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning: Option<String>,
    },
    Tool {
        seq: u64,
        at: String,
        call_id: String,
        name: String,
        /// Raw JSON string exactly as the model produced it; the consumer
        /// parses it (never a re-serialized approximation).
        args: String,
        status: ToolStatus,
        /// Model-facing text of the result (text blocks only). The consumer
        /// shows it verbatim; richer previews are a later concern.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<String>,
    },
    Turn {
        seq: u64,
        at: String,
        state: TurnState,
        /// `TurnEndReason.kind` (`completed`, `error`, `aborted`, …).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

/// One live token-level delta. Not durable: the committed `assistant/message`
/// entry replaces it. The consumer keys live text by `(attemptId, revision)`;
/// a higher `revision` means the previous attempt was replaced, not appended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshStream {
    pub session_id: String,
    pub attempt_id: String,
    pub revision: u64,
    pub index: u64,
    pub delta: DshDelta,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum DshDelta {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
    },
    ToolCall {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        arguments: Option<String>,
    },
}

/// What one ingest changed. The bridge emits Tauri events from this and holds
/// no state of its own.
#[derive(Debug, Default)]
pub struct Ingested {
    pub created: bool,
    /// Session metadata (title, status, count, timestamp) changed.
    pub session_changed: bool,
    /// A committed row to publish (new, or a tool row updated by its result).
    pub entry: Option<DshEntry>,
    /// Unrecognized event type, reported the first time only.
    pub unknown: Option<String>,
}

struct SessionRecord {
    meta: DshSession,
    entries: Vec<DshEntry>,
    /// Event seqs already applied. Snapshot and live feeds overlap freely.
    seen: BTreeSet<u64>,
    /// `callId` → index in `entries`, for merging `tool/result` into its call.
    calls: HashMap<String, usize>,
    first_user_seen: bool,
}

/// The one owner of normalized session state.
#[derive(Default)]
pub struct Transcript {
    sessions: BTreeMap<String, SessionRecord>,
    reported_unknown: HashSet<String>,
}

impl Transcript {
    /// Creates an empty session (idempotent) — used by `dsh_new_session` so a
    /// freshly allocated id is listed before the runtime sees its first prompt.
    pub fn ensure_session(&mut self, session_id: &str, at: &str) -> bool {
        if self.sessions.contains_key(session_id) {
            return false;
        }
        self.sessions.insert(
            session_id.to_string(),
            SessionRecord {
                meta: DshSession::new(session_id, at),
                entries: Vec::new(),
                seen: BTreeSet::new(),
                calls: HashMap::new(),
                first_user_seen: false,
            },
        );
        true
    }

    /// Applies one committed session event, in either source's shape. `at` is
    /// the event's own timestamp; callers convert `event.time` (epoch ms).
    pub fn ingest(&mut self, session_id: &str, event: &Value, at: &str) -> Ingested {
        let created = self.ensure_session(session_id, at);
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            return Ingested { created, ..Ingested::default() };
        };
        let Some(seq) = event.get("seq").and_then(Value::as_u64) else {
            return Ingested { created, ..Ingested::default() };
        };

        let record = self.sessions.get_mut(session_id).expect("session ensured above");
        let known = matches!(
            kind,
            "user/message"
                | "assistant/message"
                | "tool/call"
                | "tool/result"
                | "turn/start"
                | "turn/end"
        );
        if !known {
            let first = self.reported_unknown.insert(kind.to_string());
            return Ingested {
                created,
                unknown: first.then(|| kind.to_string()),
                ..Ingested::default()
            };
        }
        if !record.seen.insert(seq) {
            return Ingested { created, ..Ingested::default() };
        }

        let entry = match kind {
            "user/message" => record.push_user(seq, at, event),
            "assistant/message" => record.push_assistant(seq, at, event),
            "tool/call" => record.push_tool(seq, at, event),
            "tool/result" => record.merge_tool_result(seq, event),
            "turn/start" => {
                record.meta.status = SessionStatus::Running;
                Some(record.push_turn(seq, at, TurnState::Start, None))
            }
            "turn/end" => {
                let reason = event
                    .pointer("/data/reason/kind")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                record.meta.status = match reason.as_deref() {
                    Some("error") | Some("blocked") => SessionStatus::Failed,
                    _ => SessionStatus::Idle,
                };
                Some(record.push_turn(seq, at, TurnState::End, reason))
            }
            _ => None,
        };

        record.touch(at);
        Ingested {
            created,
            session_changed: true,
            entry,
            unknown: None,
        }
    }

    /// `session.status` notifications are the live authority on `running`.
    pub fn set_status(&mut self, session_id: &str, status: SessionStatus, at: &str) -> bool {
        let created = self.ensure_session(session_id, at);
        let record = self.sessions.get_mut(session_id).expect("session ensured above");
        if !created && record.meta.status == status {
            return false;
        }
        record.meta.status = status;
        record.touch(at);
        true
    }

    /// Marks every running session as failed after the runtime process exits —
    /// a live turn cannot survive it.
    pub fn mark_runtime_exited(&mut self) -> bool {
        let mut changed = false;
        for record in self.sessions.values_mut() {
            if record.meta.status == SessionStatus::Running {
                record.meta.status = SessionStatus::Failed;
                changed = true;
            }
        }
        changed
    }

    /// Sessions sorted newest first.
    pub fn sessions(&self) -> Vec<DshSession> {
        let mut sessions: Vec<DshSession> =
            self.sessions.values().map(|record| record.meta.clone()).collect();
        sessions.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        sessions
    }

    pub fn session(&self, session_id: &str) -> Option<DshSession> {
        self.sessions
            .get(session_id)
            .map(|record| record.meta.clone())
    }

    pub fn entries(&self, session_id: &str) -> Option<Vec<DshEntry>> {
        self.sessions
            .get(session_id)
            .map(|record| record.entries.clone())
    }
}

impl SessionRecord {
    fn touch(&mut self, at: &str) {
        // Snapshots can arrive after live events; never move the clock back.
        if at > self.meta.updated_at.as_str() {
            self.meta.updated_at = at.to_string();
        }
    }

    fn push_user(&mut self, seq: u64, at: &str, event: &Value) -> Option<DshEntry> {
        // Injected context (workspace instructions, time samples, agent.inject)
        // is also a `user/message`, but a chat bubble would misrepresent it as
        // typed text. Only `source.kind == 'user'` (or an absent source, for
        // older logs) is a human prompt.
        let source_kind = event.pointer("/data/source/kind").and_then(Value::as_str);
        if matches!(source_kind, Some(kind) if kind != "user") {
            return None;
        }
        let text = join_text_blocks(event.pointer("/data/content"));
        if !self.first_user_seen {
            self.first_user_seen = true;
            self.meta.title = title_from(&text);
        }
        self.meta.message_count += 1;
        let entry = DshEntry::User {
            seq,
            at: at.to_string(),
            text,
        };
        self.entries.push(entry.clone());
        Some(entry)
    }

    fn push_assistant(&mut self, seq: u64, at: &str, event: &Value) -> Option<DshEntry> {
        let content = event.pointer("/data/message/content");
        let text = join_text_blocks(content);
        let reasoning = join_reasoning_blocks(content);
        // A message that carried only tool calls is represented by its
        // `tool/call` rows; an empty bubble would be fake state.
        if text.is_empty() && reasoning.is_none() {
            return None;
        }
        self.meta.message_count += 1;
        let entry = DshEntry::Assistant {
            seq,
            at: at.to_string(),
            text,
            reasoning,
        };
        self.entries.push(entry.clone());
        Some(entry)
    }

    fn push_tool(&mut self, seq: u64, at: &str, event: &Value) -> Option<DshEntry> {
        let call_id = event
            .pointer("/data/callId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let name = event
            .pointer("/data/name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let args = event
            .pointer("/data/arguments")
            .and_then(Value::as_str)
            .unwrap_or("{}")
            .to_string();
        let entry = DshEntry::Tool {
            seq,
            at: at.to_string(),
            call_id,
            name,
            args,
            status: ToolStatus::Running,
            result: None,
        };
        if let DshEntry::Tool { call_id, .. } = &entry {
            self.calls.insert(call_id.clone(), self.entries.len());
        }
        self.entries.push(entry.clone());
        Some(entry)
    }

    /// Merges a result into its call row and re-publishes that row with the
    /// call's seq. A result whose call was never seen is dropped loudly; with a
    /// snapshot starting at seq 0 this only happens on a malformed feed.
    fn merge_tool_result(&mut self, _seq: u64, event: &Value) -> Option<DshEntry> {
        let call_id = event
            .pointer("/data/message/toolCallId")
            .or_else(|| event.pointer("/data/message/source/callId"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let index = *self.calls.get(&call_id)?;
        let message = event.pointer("/data/message");
        let text = join_text_blocks(message.and_then(|value| value.get("content")));
        let failed = message
            .and_then(|value| value.get("isError"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let entry = match self.entries.get_mut(index) {
            Some(DshEntry::Tool {
                status, result, ..
            }) => {
                *status = if failed { ToolStatus::Error } else { ToolStatus::Ok };
                *result = Some(text);
                self.entries[index].clone()
            }
            // The call row was replaced (new revision); keep the log honest.
            _ => return None,
        };
        Some(entry)
    }

    fn push_turn(&mut self, seq: u64, at: &str, state: TurnState, reason: Option<String>) -> DshEntry {
        let entry = DshEntry::Turn {
            seq,
            at: at.to_string(),
            state,
            reason,
        };
        self.entries.push(entry.clone());
        entry
    }
}

/// Concatenates `text` blocks of a dsh content array. Other block types are
/// not rendered by this view yet (images/files are still visible in TAPD).
fn join_text_blocks(content: Option<&Value>) -> String {
    let Some(blocks) = content.and_then(Value::as_array) else {
        return String::new();
    };
    blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect()
}

fn join_reasoning_blocks(content: Option<&Value>) -> Option<String> {
    let blocks = content.and_then(Value::as_array)?;
    let joined: String = blocks
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("reasoning"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect();
    (!joined.is_empty()).then_some(joined)
}

/// First line of the first user message, bounded to [`TITLE_MAX_CHARS`] chars.
fn title_from(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or("").trim();
    let mut title: String = first_line.chars().take(TITLE_MAX_CHARS).collect();
    if first_line.chars().count() > TITLE_MAX_CHARS {
        title.pop();
        title.push('…');
    }
    title
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str, seq: u64) -> Value {
        json!({ "type": kind, "seq": seq, "time": 1_700_000_000_000u64 })
    }

    fn user(seq: u64, text: &str) -> Value {
        let mut value = event("user/message", seq);
        value["data"] = json!({
            "id": format!("m{seq}"),
            "role": "user",
            "content": [{ "type": "text", "text": text }],
            "source": { "kind": "user" }
        });
        value
    }

    fn assistant(seq: u64, text: &str, reasoning: &str) -> Value {
        let mut value = event("assistant/message", seq);
        value["data"] = json!({
            "turn": 1,
            "step": 1,
            "message": {
                "id": format!("a{seq}"),
                "role": "assistant",
                "content": [
                    { "type": "reasoning", "text": reasoning },
                    { "type": "text", "text": text }
                ],
                "source": { "kind": "model", "provider": "p", "model": "m" }
            },
            "stream": []
        });
        value
    }

    #[test]
    fn entry_shapes_match_the_documented_contract() {
        let user = serde_json::to_value(DshEntry::User {
            seq: 3,
            at: "2026-11-16T00:00:00.000Z".into(),
            text: "hello".into(),
        })
        .unwrap();
        assert_eq!(
            user,
            json!({ "kind": "user", "seq": 3, "at": "2026-11-16T00:00:00.000Z", "text": "hello" })
        );

        let tool = serde_json::to_value(DshEntry::Tool {
            seq: 5,
            at: "2026-11-16T00:00:00.000Z".into(),
            call_id: "c1".into(),
            name: "bash".into(),
            args: r#"{"cmd":"ls"}"#.into(),
            status: ToolStatus::Running,
            result: None,
        })
        .unwrap();
        assert_eq!(tool["kind"], "tool");
        assert_eq!(tool["callId"], "c1");
        assert_eq!(tool["args"], r#"{"cmd":"ls"}"#);
        assert_eq!(tool["status"], "running");
        assert!(tool.get("result").is_none());

        let stream = serde_json::to_value(DshStream {
            session_id: "s1".into(),
            attempt_id: "a1".into(),
            revision: 1,
            index: 2,
            delta: DshDelta::ToolCall {
                call_id: Some("c1".into()),
                name: Some("bash".into()),
                arguments: Some("{\"cmd\":".into()),
            },
        })
        .unwrap();
        assert_eq!(stream["delta"]["type"], "tool-call");
        assert_eq!(stream["sessionId"], "s1");
        assert_eq!(stream["attemptId"], "a1");
    }

    #[test]
    fn first_user_message_titles_the_session_and_is_truncated() {
        let mut transcript = Transcript::default();
        let long = format!("{}  \nsecond line", "字".repeat(80));
        transcript.ingest("s1", &user(0, &long), "2026-11-16T00:00:00.000Z");
        transcript.ingest("s1", &user(2, "later"), "2026-11-16T00:00:02.000Z");
        let session = transcript.session("s1").unwrap();
        assert_eq!(session.title.chars().count(), TITLE_MAX_CHARS);
        assert!(session.title.ends_with('…'));
        assert_eq!(session.message_count, 2);
    }

    #[test]
    fn injected_context_is_not_a_user_bubble() {
        let mut transcript = Transcript::default();
        let mut injected = user(0, "workspace instructions");
        injected["data"]["source"] = json!({ "kind": "agent-instructions", "form": "instructions" });
        assert!(transcript
            .ingest("s1", &injected, "2026-11-16T00:00:00.000Z")
            .entry
            .is_none());
        assert!(transcript.session("s1").unwrap().title.is_empty());

        transcript.ingest("s1", &user(1, "real question"), "2026-11-16T00:00:01.000Z");
        let session = transcript.session("s1").unwrap();
        assert_eq!(session.title, "real question");
        assert_eq!(session.message_count, 1);
    }

    #[test]
    fn duplicate_seqs_are_applied_once() {
        let mut transcript = Transcript::default();
        let first = transcript.ingest("s1", &user(0, "hi"), "2026-11-16T00:00:00.000Z");
        let again = transcript.ingest("s1", &user(0, "hi"), "2026-11-16T00:00:00.000Z");
        assert!(first.entry.is_some());
        assert!(again.entry.is_none());
        assert_eq!(transcript.entries("s1").unwrap().len(), 1);
    }

    #[test]
    fn tool_result_updates_the_call_row_in_place() {
        let mut transcript = Transcript::default();
        let mut call = event("tool/call", 4);
        call["data"] = json!({
            "turn": 1, "step": 1, "callId": "c1", "name": "bash",
            "arguments": "{\"cmd\":\"ls\"}"
        });
        transcript.ingest("s1", &call, "2026-11-16T00:00:04.000Z");

        let mut result = event("tool/result", 6);
        result["data"] = json!({
            "turn": 1, "step": 1,
            "message": {
                "id": "t1", "role": "tool", "toolCallId": "c1", "isError": false,
                "content": [{ "type": "text", "text": "file.txt" }],
                "source": { "kind": "tool", "callId": "c1" }
            }
        });
        let updated = transcript
            .ingest("s1", &result, "2026-11-16T00:00:06.000Z")
            .entry
            .expect("result updates the call row");

        match updated {
            DshEntry::Tool { seq, status, result, .. } => {
                assert_eq!(seq, 4, "the row keeps the call's seq");
                assert_eq!(status, ToolStatus::Ok);
                assert_eq!(result, Some("file.txt".to_string()));
            }
            other => panic!("unexpected entry: {other:?}"),
        }
        assert_eq!(transcript.entries("s1").unwrap().len(), 1);
    }

    #[test]
    fn turn_boundaries_drive_status_and_reason() {
        let mut transcript = Transcript::default();
        transcript.ingest("s1", &event("turn/start", 0), "2026-11-16T00:00:00.000Z");
        assert_eq!(
            transcript.session("s1").unwrap().status,
            SessionStatus::Running
        );

        let mut end = event("turn/end", 9);
        end["data"] = json!({ "turn": 1, "reason": { "kind": "error",
            "error": { "message": "boom", "code": "HTTP_500" } } });
        let ingested = transcript.ingest("s1", &end, "2026-11-16T00:00:09.000Z");
        match ingested.entry.unwrap() {
            DshEntry::Turn { state, reason, .. } => {
                assert_eq!(state, TurnState::End);
                assert_eq!(reason.as_deref(), Some("error"));
            }
            other => panic!("unexpected entry: {other:?}"),
        }
        assert_eq!(transcript.session("s1").unwrap().status, SessionStatus::Failed);
    }

    #[test]
    fn assistant_rows_carry_reasoning_and_skip_tool_only_messages() {
        let mut transcript = Transcript::default();
        transcript.ingest("s1", &assistant(0, "answer", "thinking"), "2026-11-16T00:00:00.000Z");
        let entries = transcript.entries("s1").unwrap();
        match &entries[0] {
            DshEntry::Assistant { text, reasoning, .. } => {
                assert_eq!(text, "answer");
                assert_eq!(reasoning.as_deref(), Some("thinking"));
            }
            other => panic!("unexpected entry: {other:?}"),
        }

        let mut tool_only = assistant(1, "", "");
        tool_only["data"]["message"]["content"] =
            json!([{ "type": "tool-call", "id": "c1", "name": "bash", "arguments": "{}" }]);
        assert!(transcript
            .ingest("s1", &tool_only, "2026-11-16T00:00:01.000Z")
            .entry
            .is_none());
    }

    #[test]
    fn sessions_are_sorted_newest_first() {
        let mut transcript = Transcript::default();
        transcript.ensure_session("old", "2026-11-16T00:00:00.000Z");
        transcript.ensure_session("new", "2026-11-16T00:00:05.000Z");
        let ids: Vec<String> = transcript
            .sessions()
            .into_iter()
            .map(|session| session.id)
            .collect();
        assert_eq!(ids, ["new", "old"]);
    }

    #[test]
    fn unknown_event_types_are_reported_once() {
        let mut transcript = Transcript::default();
        let first = transcript.ingest("s1", &event("step/start", 0), "2026-11-16T00:00:00.000Z");
        let second = transcript.ingest("s1", &event("step/start", 1), "2026-11-16T00:00:01.000Z");
        assert_eq!(first.unknown.as_deref(), Some("step/start"));
        assert!(second.unknown.is_none());
        assert!(transcript.entries("s1").unwrap().is_empty());
    }

    #[test]
    fn runtime_exit_marks_running_sessions_failed() {
        let mut transcript = Transcript::default();
        transcript.ingest("s1", &event("turn/start", 0), "2026-11-16T00:00:00.000Z");
        assert!(transcript.mark_runtime_exited());
        assert_eq!(transcript.session("s1").unwrap().status, SessionStatus::Failed);
        assert!(!transcript.mark_runtime_exited());
    }
}
