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

/// One provider's token accounting. dsh reports it per assistant message, so
/// any counter built from it can only move when a message settles.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryUsage {
    /// Input tokens that missed the provider's cache.
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_write_tokens: u64,
    pub total_tokens: u64,
}

/// Running totals for one session, as the status line shows them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    /// Turns started in this session.
    pub turns: u64,
    /// Steps started in this session (one step = one model request).
    pub steps: u64,
    /// Sum over every assistant message.
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub total_tokens: u64,
    /// Provider and model of the most recent request.
    pub provider: String,
    pub model: String,
    /// Context window of the most recent request; 0 when the session never
    /// stated one.
    pub context_window: u64,
    /// Output tokens per second over the last message's generation.
    pub tokens_per_second: u64,
}

impl SessionUsage {
    /// Share of input tokens that came from the provider's cache, in percent.
    pub fn cache_hit_percent(&self) -> u64 {
        let input = self.input_tokens + self.cache_read_tokens;
        if input == 0 {
            return 0;
        }
        (self.cache_read_tokens * 100 + input / 2) / input
    }

    /// Context window used by the latest request, in percent.
    pub fn context_percent(&self) -> u64 {
        if self.context_window == 0 {
            return 0;
        }
        ((self.total_tokens * 100 + self.context_window / 2) / self.context_window).min(100)
    }
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
    /// Token accounting and turn/step counters for the status line.
    #[serde(default)]
    pub usage: SessionUsage,
}

impl DshSession {
    fn new(id: &str, at: &str) -> Self {
        Self {
            id: id.to_string(),
            title: String::new(),
            updated_at: at.to_string(),
            status: SessionStatus::Idle,
            message_count: 0,
            usage: SessionUsage::default(),
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
        /// What this one reply cost, straight from the provider.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<EntryUsage>,
        /// Route the reply came from, for the usage popover.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
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

impl DshEntry {
    /// Commit position shared by every row kind; incremental readers page on it.
    pub fn seq(&self) -> u64 {
        match self {
            Self::User { seq, .. }
            | Self::Assistant { seq, .. }
            | Self::Tool { seq, .. }
            | Self::Turn { seq, .. } => *seq,
        }
    }
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
    /// `step/start` time of the current step, used as the generation start
    /// when a message carries no stream timing.
    last_step_ms: Option<u64>,
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
                last_step_ms: None,
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
                | "step/start"
                | "request/context"
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
                record.meta.usage.turns += 1;
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
            "step/start" => {
                record.meta.usage.steps += 1;
                record.last_step_ms = event.get("time").and_then(Value::as_u64);
                None
            }
            "request/context" => {
                record.record_route(event);
                None
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

    /// Entries past `since_seq` plus the session's current last seq. The phone
    /// polls with the previous `last_seq`, so a long transcript is not shipped
    /// whole every few seconds.
    pub fn entries_since(&self, session_id: &str, since_seq: u64) -> Option<(Vec<DshEntry>, u64)> {
        let record = self.sessions.get(session_id)?;
        let last_seq = record.entries.last().map(|entry| entry.seq()).unwrap_or(0);
        let entries = record
            .entries
            .iter()
            .filter(|entry| entry.seq() > since_seq)
            .cloned()
            .collect();
        Some((entries, last_seq))
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

        let usage = read_usage(event);
        let provider = event
            .pointer("/data/message/source/provider")
            .and_then(Value::as_str)
            .map(str::to_string);
        let model = event
            .pointer("/data/message/source/model")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let (Some(provider), Some(model)) = (&provider, &model) {
            self.meta.usage.provider = provider.clone();
            self.meta.usage.model = model.clone();
        }
        if let Some(usage) = usage {
            let totals = &mut self.meta.usage;
            totals.input_tokens += usage.input_tokens;
            totals.output_tokens += usage.output_tokens;
            totals.cache_read_tokens += usage.cache_read_tokens;
            totals.total_tokens += usage.total_tokens;
            if usage.output_tokens > 0 {
                // Generation-only speed: the stream's first chunk beats
                // `step/start`, which also covers request setup and queueing.
                let start = event
                    .pointer("/data/stream/0/time")
                    .and_then(Value::as_u64)
                    .or(self.last_step_ms);
                if let (Some(start), Some(end)) =
                    (start, event.get("time").and_then(Value::as_u64))
                {
                    if end > start {
                        let elapsed = (end - start) as f64 / 1000.0;
                        totals.tokens_per_second =
                            (usage.output_tokens as f64 / elapsed).round() as u64;
                    }
                }
            }
        }

        let entry = DshEntry::Assistant {
            seq,
            at: at.to_string(),
            text,
            reasoning,
            usage,
            provider,
            model,
        };
        self.entries.push(entry.clone());
        Some(entry)
    }

    /// `request/context` states the route and window a request was built for.
    fn record_route(&mut self, event: &Value) {
        let usage = &mut self.meta.usage;
        if let Some(provider) = event.pointer("/data/provider").and_then(Value::as_str) {
            usage.provider = provider.to_string();
        }
        if let Some(model) = event.pointer("/data/model").and_then(Value::as_str) {
            usage.model = model.to_string();
        }
        if let Some(window) = event.pointer("/data/contextWindow").and_then(Value::as_u64) {
            usage.context_window = window;
        }
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

/// Token accounting for one assistant message. Logs written before the route
/// reported usage simply have no `usage`, and a zero total is not a fact worth
/// showing.
fn read_usage(event: &Value) -> Option<EntryUsage> {
    let usage = event.pointer("/data/usage")?;
    let number = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let total_tokens = number("totalTokens");
    if total_tokens == 0 {
        return None;
    }
    Some(EntryUsage {
        input_tokens: number("inputTokens"),
        output_tokens: number("outputTokens"),
        cache_read_tokens: number("cacheReadTokens"),
        cache_write_tokens: number("cacheWriteTokens"),
        total_tokens,
    })
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
        let first = transcript.ingest("s1", &event("system/message", 0), "2026-11-16T00:00:00.000Z");
        let second = transcript.ingest("s1", &event("system/message", 1), "2026-11-16T00:00:01.000Z");
        assert_eq!(first.unknown.as_deref(), Some("system/message"));
        assert!(second.unknown.is_none());
        assert!(transcript.entries("s1").unwrap().is_empty());
    }

    fn assistant_with_usage(seq: u64, time: u64) -> Value {
        json!({
            "type": "assistant/message",
            "seq": seq,
            "time": time,
            "data": {
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "hi" }],
                    "source": { "kind": "model", "provider": "opencode-go", "model": "deepseek-v4.1-flash" },
                },
                "usage": {
                    "inputTokens": 181,
                    "outputTokens": 189,
                    "totalTokens": 8306,
                    "cacheReadTokens": 7936,
                },
                "stream": [{ "type": "chunk", "time": 1_000 }],
            },
        })
    }

    #[test]
    fn usage_totals_and_speed_come_from_the_message() {
        let mut transcript = Transcript::default();
        transcript.ingest("s1", &event("turn/start", 0), "2026-11-16T00:00:00.000Z");
        transcript.ingest("s1", &event("step/start", 1), "2026-11-16T00:00:00.000Z");
        transcript.ingest("s1", &assistant_with_usage(2, 2_753), "2026-11-16T00:00:02.753Z");

        let session = transcript.session("s1").unwrap();
        assert_eq!(session.usage.turns, 1);
        assert_eq!(session.usage.steps, 1);
        assert_eq!(session.usage.total_tokens, 8_306);
        assert_eq!(session.usage.cache_read_tokens, 7_936);
        assert_eq!(session.usage.provider, "opencode-go");
        assert_eq!(session.usage.model, "deepseek-v4.1-flash");
        // 189 output tokens over 1.753s of streaming.
        assert_eq!(session.usage.tokens_per_second, 108);
        assert_eq!(session.usage.cache_hit_percent(), 98);

        // The entry carries the same numbers so the popover needs no lookup.
        let entries = transcript.entries("s1").expect("session exists");
        let entry = entries
            .iter()
            .find(|entry| matches!(entry, DshEntry::Assistant { .. }))
            .expect("assistant row");
        let json = serde_json::to_value(entry).unwrap();
        assert_eq!(json["usage"]["totalTokens"], 8_306);
        assert_eq!(json["provider"], "opencode-go");
    }

    #[test]
    fn route_context_sets_the_context_window() {
        let mut transcript = Transcript::default();
        transcript.ingest(
            "s1",
            &json!({
                "type": "request/context",
                "seq": 0,
                "data": { "provider": "opencode-go", "model": "deepseek-v4.1-flash", "contextWindow": 1_000_000 },
            }),
            "2026-11-16T00:00:00.000Z",
        );
        let session = transcript.session("s1").unwrap();
        assert_eq!(session.usage.context_window, 1_000_000);
        assert_eq!(session.usage.context_percent(), 0);

        transcript.ingest("s1", &assistant_with_usage(1, 2_000), "2026-11-16T00:00:02.000Z");
        // 8306 / 1,000,000 rounds to nothing at integer percent.
        assert_eq!(transcript.session("s1").unwrap().usage.context_percent(), 1);
    }

    #[test]
    fn a_repeated_snapshot_does_not_double_count() {
        let mut transcript = Transcript::default();
        let turn = event("turn/start", 0);
        let step = event("step/start", 1);
        let message = assistant_with_usage(2, 2_000);
        for _ in 0..2 {
            transcript.ingest("s1", &turn, "2026-11-16T00:00:00.000Z");
            transcript.ingest("s1", &step, "2026-11-16T00:00:00.000Z");
            transcript.ingest("s1", &message, "2026-11-16T00:00:02.000Z");
        }
        let usage = &transcript.session("s1").unwrap().usage;
        assert_eq!(usage.turns, 1);
        assert_eq!(usage.steps, 1);
        assert_eq!(usage.total_tokens, 8_306);
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
