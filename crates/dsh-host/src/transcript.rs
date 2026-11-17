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
    /// Decode speed of the whole session: output tokens over the time the
    /// model spent producing them, read from dsh's own `sessionStats` fold. A
    /// per-message ratio is deliberately not computed here — a short burst
    /// (a few tokens in a few milliseconds) divides into absurd four- or
    /// five-digit rates.
    pub tokens_per_second: u64,
    /// Average wait for the first streamed token, over the requests that
    /// reported one; 0 when no request was timed.
    pub ttft_ms: u64,
    /// Request start → message settle, summed over every timed request.
    pub model_ms: u64,
    /// Prompt-side tokens of the latest request (the context occupancy the
    /// runtime's own meter reports); 0 until it does.
    pub context_used_tokens: u64,
    /// Context composition as dsh priced the latest request surface.
    pub system_tokens: u64,
    pub tools_tokens: u64,
    pub message_tokens: u64,
}

/// One meter snapshot read from the runtime's projections. Every field is
/// optional upstream, so an absent value keeps what the transcript already
/// knows instead of zeroing it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeter {
    pub context_used_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub system_tokens: Option<u64>,
    pub tools_tokens: Option<u64>,
    pub message_tokens: Option<u64>,
    /// dsh `sessionStats.decodeTokens` / `decodeMs`: provider output tokens and
    /// first-token → message-settle wall time, summed over the whole log.
    pub decode_tokens: Option<u64>,
    pub decode_ms: Option<u64>,
    /// dsh `sessionStats.ttftMs` / `ttftSteps`: first-token latency summed over
    /// every step that recorded one (tool-call-only steps included).
    pub ttft_ms: Option<u64>,
    pub ttft_steps: Option<u64>,
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

    /// Context window used by the latest request, in percent. The runtime's
    /// own prompt-side meter wins; the cumulative total is only a fallback for
    /// a session the bridge has not measured yet.
    pub fn context_percent(&self) -> u64 {
        if self.context_window == 0 {
            return 0;
        }
        let used = if self.context_used_tokens > 0 {
            self.context_used_tokens
        } else {
            self.total_tokens
        };
        ((used * 100 + self.context_window / 2) / self.context_window).min(100)
    }
}

impl SessionUsage {
    /// Applies one meter snapshot; absent values keep the current figure.
    fn apply_meter(&mut self, meter: &SessionMeter) -> bool {
        let before = (
            self.context_used_tokens,
            self.context_window,
            self.system_tokens,
            self.tools_tokens,
            self.message_tokens,
            self.tokens_per_second,
            self.ttft_ms,
        );
        if let Some(value) = meter.context_used_tokens {
            self.context_used_tokens = value;
        }
        if let Some(value) = meter.context_window {
            self.context_window = value;
        }
        if let Some(value) = meter.system_tokens {
            self.system_tokens = value;
        }
        if let Some(value) = meter.tools_tokens {
            self.tools_tokens = value;
        }
        if let Some(value) = meter.message_tokens {
            self.message_tokens = value;
        }
        // The engine's own decode fold is the authority: tokens and milliseconds
        // both accumulate over the whole session, so one short message cannot
        // spike the rate.
        if let (Some(tokens), Some(ms)) = (meter.decode_tokens, meter.decode_ms) {
            self.tokens_per_second = if ms > 0 {
                (tokens as f64 * 1000.0 / ms as f64).round() as u64
            } else {
                0
            };
        }
        // The engine's first-token fold covers every step it timed; the local
        // average only counts steps whose message reached the transcript.
        if let (Some(total), Some(steps)) = (meter.ttft_ms, meter.ttft_steps) {
            if steps > 0 {
                self.ttft_ms = (total + steps / 2) / steps;
            }
        }
        before
            != (
                self.context_used_tokens,
                self.context_window,
                self.system_tokens,
                self.tools_tokens,
                self.message_tokens,
                self.tokens_per_second,
                self.ttft_ms,
            )
    }
}

/// One session's current model route, as dsh records it on `model/selection`.
/// The UI shows it as the session's model; an absent effort means the adapter
/// default.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
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
    /// The route the session will use next; absent until the first selection or
    /// request records one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<ModelSelection>,
    /// The engine's plan mode for this session (`plan/mode` events). Plan mode
    /// is prompt-enforced upstream; the session row is where the UI reads it.
    #[serde(default)]
    pub plan_active: bool,
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
            selection: None,
            plan_active: false,
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
///
/// `turn`/`step` are dsh's own 1-based counters (a step is one model request),
/// so the trajectory view groups rows without re-deriving them. The timing
/// fields are epoch milliseconds taken from the session events: a reply's step
/// start, first streamed token and settle time; a tool's call and result time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum DshEntry {
    User {
        seq: u64,
        at: String,
        /// Defaulted so a row serialized before the trajectory existed still
        /// deserializes (0 = unknown).
        #[serde(default)]
        turn: u64,
        #[serde(default)]
        step: u64,
        text: String,
    },
    Assistant {
        seq: u64,
        at: String,
        #[serde(default)]
        turn: u64,
        #[serde(default)]
        step: u64,
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
        /// `step/start` of the request this reply answered.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at_ms: Option<u64>,
        /// First streamed chunk; absent when the log carried no stream timing.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        first_token_at_ms: Option<u64>,
        /// The `assistant/message` event time (the reply settled).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        completed_at_ms: Option<u64>,
    },
    Tool {
        seq: u64,
        at: String,
        #[serde(default)]
        turn: u64,
        #[serde(default)]
        step: u64,
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
        /// The `tool/call` event time.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at_ms: Option<u64>,
        /// The `tool/result` event time; absent while the call is running.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ended_at_ms: Option<u64>,
    },
    Turn {
        seq: u64,
        at: String,
        #[serde(default)]
        turn: u64,
        state: TurnState,
        /// `TurnEndReason.kind` (`completed`, `error`, `aborted`, …).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        /// The provider/runtime message behind a failed turn. The reason alone
        /// says *that* it failed; this says why.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
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

    /// The event's own timestamp. Replaying a log must use this instead of the
    /// wall clock, so history does not read as "just now".
    pub fn at(&self) -> &str {
        match self {
            Self::User { at, .. }
            | Self::Assistant { at, .. }
            | Self::Tool { at, .. }
            | Self::Turn { at, .. } => at,
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
    /// Row seq → the event seq that last touched it. A tool row keeps its
    /// call's seq while the result lands much later, so incremental readers
    /// page on this instead of the row's own seq.
    last_update: HashMap<u64, u64>,
    /// Results whose `tool/call` has not arrived yet, keyed by call id.
    orphans: HashMap<String, OrphanResult>,
    first_user_seen: bool,
    /// dsh's current 1-based turn and step. Assistant/tool events carry both;
    /// `user/message` does not, so it takes the counters as they stand.
    turn: u64,
    step: u64,
    /// Highest turn/step boundary seq applied, so a snapshot replayed after
    /// newer live events cannot roll the counters back.
    last_boundary: u64,
    /// `(turn, step)` → that step's `step/start` time. A reply's own step is
    /// the only honest generation start, so the map is keyed, not "last seen".
    step_starts: HashMap<(u64, u64), u64>,
    /// `step/start` time of the current step, used as the generation start
    /// when a message carries no stream timing.
    last_step_ms: Option<u64>,
    /// Sum and count behind [`SessionUsage::ttft_ms`].
    ttft_total_ms: u64,
    ttft_samples: u64,
}

/// A `tool/result` that arrived before its `tool/call`.
struct OrphanResult {
    /// The result event's seq, so an incremental read still sees the row once
    /// the call lands (instead of losing the update forever).
    seq: u64,
    text: String,
    failed: bool,
    ended_at_ms: Option<u64>,
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
                last_update: HashMap::new(),
                orphans: HashMap::new(),
                first_user_seen: false,
                turn: 0,
                step: 0,
                last_boundary: 0,
                step_starts: HashMap::new(),
                last_step_ms: None,
                ttft_total_ms: 0,
                ttft_samples: 0,
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
                | "model/selection"
                | "plan/mode"
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
                // A snapshot replayed after newer live events must not roll the
                // counters back; only an event at the boundary frontier may
                // move them.
                if seq >= record.last_boundary {
                    record.last_boundary = seq;
                    // dsh states the turn; the counter is only a fallback for a
                    // log whose turn marker lost its payload.
                    record.turn = event
                        .pointer("/data/turn")
                        .and_then(Value::as_u64)
                        .unwrap_or(record.turn + 1);
                    record.step = 0;
                    record.last_step_ms = None;
                }
                let turn = record.turn;
                Some(record.push_turn(seq, at, turn, TurnState::Start, None, None))
            }
            "turn/end" => {
                let reason = event
                    .pointer("/data/reason/kind")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let error = event
                    .pointer("/data/reason/error/message")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|message| !message.is_empty())
                    .map(str::to_string);
                if seq >= record.last_boundary {
                    record.last_boundary = seq;
                    record.meta.status = match reason.as_deref() {
                        Some("error") | Some("blocked") => SessionStatus::Failed,
                        _ => SessionStatus::Idle,
                    };
                    // A log that starts mid-turn still labels its rows: the
                    // event states the turn it closes.
                    if let Some(turn) = event.pointer("/data/turn").and_then(Value::as_u64) {
                        record.turn = turn;
                    }
                }
                let turn = record.turn;
                Some(record.push_turn(seq, at, turn, TurnState::End, reason, error))
            }
            "step/start" => {
                record.meta.usage.steps += 1;
                if seq >= record.last_boundary {
                    record.last_boundary = seq;
                    if let Some(turn) = event.pointer("/data/turn").and_then(Value::as_u64) {
                        record.turn = turn;
                    }
                    record.step = event
                        .pointer("/data/step")
                        .and_then(Value::as_u64)
                        .unwrap_or(record.step + 1);
                    let started = event.get("time").and_then(Value::as_u64);
                    record.last_step_ms = started;
                    if let Some(started) = started {
                        record.step_starts.insert((record.turn, record.step), started);
                    }
                }
                None
            }
            "request/context" => {
                record.record_route(event);
                None
            }
            "model/selection" => {
                record.record_selection(event);
                None
            }
            "plan/mode" => {
                record.meta.plan_active = event
                    .pointer("/data/active")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
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

    /// Applies the runtime's own meter snapshot (token usage, context
    /// occupancy and composition). Returns whether the session row changed.
    ///
    /// A meter read is not activity: it must not move `updated_at`, or every
    /// reconnect would reorder the session list.
    pub fn set_meter(&mut self, session_id: &str, meter: &SessionMeter, at: &str) -> bool {
        let created = self.ensure_session(session_id, at);
        let record = self.sessions.get_mut(session_id).expect("session ensured above");
        created || record.meta.usage.apply_meter(meter)
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

    /// A session hydrated from its log cannot be running: the runtime is what
    /// runs turns, and it did not know this session yet. An unclosed
    /// `turn/start` in the file is a crash artifact, not live work — leaving it
    /// `running` would show a timer that never stops.
    pub fn settle_hydrated(&mut self, session_id: &str) -> bool {
        let Some(record) = self.sessions.get_mut(session_id) else {
            return false;
        };
        if record.meta.status != SessionStatus::Running {
            return false;
        }
        record.meta.status = SessionStatus::Idle;
        true
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

    /// Drops one session's normalized state (a deleted chat). Returns whether
    /// the registry held it.
    pub fn remove_session(&mut self, session_id: &str) -> bool {
        self.sessions.remove(session_id).is_some()
    }

    /// The route dsh last recorded for this session, if any.
    pub fn selection(&self, session_id: &str) -> Option<ModelSelection> {
        self.sessions
            .get(session_id)
            .and_then(|record| record.meta.selection.clone())
    }

    /// Whether this process has seen the session (live or hydrated from its log).
    pub fn knows(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    pub fn entries(&self, session_id: &str) -> Option<Vec<DshEntry>> {
        self.sessions
            .get(session_id)
            .map(|record| record.entries.clone())
    }

    /// Entries updated past `since_seq` plus the session's current cursor. The
    /// phone polls with the previous `last_seq`, so a long transcript is not
    /// shipped whole every few seconds.
    ///
    /// A tool row keeps its call's seq while the result lands later, so the
    /// filter reads the row's last update, not its identity: otherwise a
    /// result that arrives after the cursor would never reach the phone.
    pub fn entries_since(&self, session_id: &str, since_seq: u64) -> Option<(Vec<DshEntry>, u64)> {
        let record = self.sessions.get(session_id)?;
        let last_seq = record.seen.iter().next_back().copied().unwrap_or(0);
        let entries = record
            .entries
            .iter()
            .filter(|entry| {
                record
                    .last_update
                    .get(&entry.seq())
                    .copied()
                    .unwrap_or(entry.seq())
                    > since_seq
            })
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
            turn: self.turn,
            step: self.step,
            text,
        };
        self.entries.push(entry.clone());
        self.last_update.insert(seq, seq);
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
            // Generation-only speed: the stream's first chunk beats
            // `step/start`, which also covers request setup and queueing.
            let end = event.get("time").and_then(Value::as_u64);
            let generation_start = event.pointer("/data/stream/0/time").and_then(Value::as_u64);
            let request_start = self.last_step_ms;
            if let (Some(start), Some(end)) = (request_start, end) {
                if end > start {
                    totals.model_ms += end - start;
                    // Only a real stream timestamp can time the first token;
                    // the step clock would report the whole request instead.
                    if let Some(first) = generation_start {
                        if first > start && first <= end {
                            self.ttft_total_ms += first - start;
                            self.ttft_samples += 1;
                            totals.ttft_ms = self.ttft_total_ms / self.ttft_samples;
                        }
                    }
                }
            }
        }

        let entry = DshEntry::Assistant {
            seq,
            at: at.to_string(),
            turn: self.event_turn(event),
            step: self.event_step(event),
            text,
            reasoning,
            usage,
            provider,
            model,
            // The reply's own step start; `last_step_ms` would attach a stale
            // step when events arrive out of order.
            started_at_ms: self
                .step_starts
                .get(&(self.event_turn(event), self.event_step(event)))
                .copied(),
            first_token_at_ms: first_token_ms(event),
            completed_at_ms: event.get("time").and_then(Value::as_u64),
        };
        self.entries.push(entry.clone());
        self.last_update.insert(seq, seq);
        Some(entry)
    }

    /// dsh stamps `turn`/`step` on assistant and tool events; the tracked
    /// counters cover a log that lost them.
    fn event_turn(&self, event: &Value) -> u64 {
        event
            .pointer("/data/turn")
            .and_then(Value::as_u64)
            .unwrap_or(self.turn)
    }

    fn event_step(&self, event: &Value) -> u64 {
        event
            .pointer("/data/step")
            .and_then(Value::as_u64)
            .unwrap_or(self.step)
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

    /// `model/selection` is dsh's durable record of the route a session will
    /// use from now on. It is the session's choice, not a request that already
    /// ran, so it does not touch the usage counters.
    fn record_selection(&mut self, event: &Value) {
        let provider = event.pointer("/data/provider").and_then(Value::as_str);
        let model = event.pointer("/data/model").and_then(Value::as_str);
        let (Some(provider), Some(model)) = (provider, model) else {
            return;
        };
        self.meta.selection = Some(ModelSelection {
            provider: provider.to_string(),
            model: model.to_string(),
            reasoning_effort: event
                .pointer("/data/reasoningEffort")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
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
            turn: self.event_turn(event),
            step: self.event_step(event),
            call_id,
            name,
            args,
            status: ToolStatus::Running,
            result: None,
            started_at_ms: event.get("time").and_then(Value::as_u64),
            ended_at_ms: None,
        };
        let mut entry = entry;
        if let DshEntry::Tool { call_id, .. } = &entry {
            self.calls.insert(call_id.clone(), self.entries.len());
            // A result that outran its call is applied now; the row is
            // published already settled, so no reader ever sees a ghost.
            if let Some(orphan) = self.orphans.remove(call_id) {
                if let DshEntry::Tool {
                    status,
                    result,
                    ended_at_ms,
                    ..
                } = &mut entry
                {
                    *status = if orphan.failed { ToolStatus::Error } else { ToolStatus::Ok };
                    *result = Some(orphan.text);
                    *ended_at_ms = orphan.ended_at_ms;
                }
                self.last_update.insert(seq, orphan.seq);
            }
        }
        self.entries.push(entry.clone());
        self.last_update.insert(seq, seq);
        Some(entry)
    }

    /// Applies a `tool/result` to its call row and re-publishes that row with
    /// the call's seq. A result that arrives before its call is buffered and
    /// applied when the call lands; dropping it would leave the row running
    /// forever and cost the panel its duration.
    fn merge_tool_result(&mut self, seq: u64, event: &Value) -> Option<DshEntry> {
        let call_id = event
            .pointer("/data/message/toolCallId")
            .or_else(|| event.pointer("/data/message/source/callId"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let message = event.pointer("/data/message");
        let text = join_text_blocks(message.and_then(|value| value.get("content")));
        let failed = message
            .and_then(|value| value.get("isError"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let ended_at_ms = event.get("time").and_then(Value::as_u64);
        let Some(index) = self.calls.get(&call_id).copied() else {
            if !call_id.is_empty() {
                self.orphans.insert(
                    call_id,
                    OrphanResult { seq, text, failed, ended_at_ms },
                );
            }
            return None;
        };
        let entry = match self.entries.get_mut(index) {
            Some(DshEntry::Tool {
                status,
                result,
                ended_at_ms: ended,
                ..
            }) => {
                *status = if failed { ToolStatus::Error } else { ToolStatus::Ok };
                *result = Some(text);
                *ended = ended_at_ms;
                self.entries[index].clone()
            }
            // The call row was replaced (new revision); keep the log honest.
            _ => return None,
        };
        self.last_update.insert(entry.seq(), seq);
        Some(entry)
    }

    fn push_turn(
        &mut self,
        seq: u64,
        at: &str,
        turn: u64,
        state: TurnState,
        reason: Option<String>,
        error: Option<String>,
    ) -> DshEntry {
        let entry = DshEntry::Turn {
            seq,
            at: at.to_string(),
            turn,
            state,
            reason,
            error,
        };
        self.entries.push(entry.clone());
        self.last_update.insert(seq, seq);
        entry
    }
}

/// Time of the first streamed chunk. dsh writes either loose chunks (`time`)
/// or a packed run (`time0` + deltas), and only the first record matters.
fn first_token_ms(event: &Value) -> Option<u64> {
    let first = event.pointer("/data/stream/0")?;
    first
        .get("time")
        .and_then(Value::as_u64)
        .or_else(|| first.get("time0").and_then(Value::as_u64))
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
            turn: 1,
            step: 1,
            text: "hello".into(),
        })
        .unwrap();
        assert_eq!(
            user,
            json!({
                "kind": "user", "seq": 3, "at": "2026-11-16T00:00:00.000Z",
                "turn": 1, "step": 1, "text": "hello"
            })
        );

        let tool = serde_json::to_value(DshEntry::Tool {
            seq: 5,
            at: "2026-11-16T00:00:00.000Z".into(),
            turn: 1,
            step: 1,
            call_id: "c1".into(),
            name: "bash".into(),
            args: r#"{"cmd":"ls"}"#.into(),
            status: ToolStatus::Running,
            result: None,
            started_at_ms: Some(1_700_000_000_000),
            ended_at_ms: None,
        })
        .unwrap();
        assert_eq!(tool["kind"], "tool");
        assert_eq!(tool["callId"], "c1");
        assert_eq!(tool["args"], r#"{"cmd":"ls"}"#);
        assert_eq!(tool["status"], "running");
        assert_eq!(tool["startedAtMs"], 1_700_000_000_000u64);
        assert!(tool.get("result").is_none());
        assert!(tool.get("endedAtMs").is_none());

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
    fn rows_carry_turn_step_and_operation_timing() {
        let mut transcript = Transcript::default();
        let mut start = event("turn/start", 0);
        start["data"] = json!({ "turn": 1 });
        transcript.ingest("s1", &start, "2026-11-16T00:00:00.000Z");
        let mut step = event("step/start", 1);
        step["data"] = json!({ "turn": 1, "step": 1 });
        step["time"] = json!(1_700_000_000_000u64);
        transcript.ingest("s1", &step, "2026-11-16T00:00:00.000Z");

        // `user/message` carries no counters; it inherits the current step.
        let asked = transcript
            .ingest("s1", &user(2, "hi"), "2026-11-16T00:00:01.000Z")
            .entry
            .unwrap();
        match asked {
            DshEntry::User { turn, step, .. } => {
                assert_eq!((turn, step), (1, 1));
            }
            other => panic!("unexpected entry: {other:?}"),
        }

        let mut reply = assistant(3, "done", "");
        reply["data"]["stream"] = json!([{ "type": "chunk", "time": 1_700_000_000_250u64 }]);
        reply["time"] = json!(1_700_000_000_900u64);
        let entry = transcript
            .ingest("s1", &reply, "2026-11-16T00:00:00.900Z")
            .entry
            .unwrap();
        match entry {
            DshEntry::Assistant {
                turn,
                step,
                started_at_ms,
                first_token_at_ms,
                completed_at_ms,
                ..
            } => {
                assert_eq!((turn, step), (1, 1));
                assert_eq!(started_at_ms, Some(1_700_000_000_000));
                assert_eq!(first_token_at_ms, Some(1_700_000_000_250));
                assert_eq!(completed_at_ms, Some(1_700_000_000_900));
            }
            other => panic!("unexpected entry: {other:?}"),
        }

        let mut call = event("tool/call", 4);
        call["time"] = json!(1_700_000_001_000u64);
        call["data"] = json!({
            "turn": 1, "step": 2, "callId": "c1", "name": "bash",
            "arguments": "{\"cmd\":\"ls\"}"
        });
        transcript.ingest("s1", &call, "2026-11-16T00:00:01.000Z");
        let mut result = event("tool/result", 6);
        result["time"] = json!(1_700_000_001_026u64);
        result["data"] = json!({
            "turn": 1, "step": 2,
            "message": {
                "id": "t1", "role": "tool", "toolCallId": "c1", "isError": false,
                "content": [{ "type": "text", "text": "file.txt" }],
                "source": { "kind": "tool", "callId": "c1" }
            }
        });
        let entry = transcript
            .ingest("s1", &result, "2026-11-16T00:00:01.026Z")
            .entry
            .unwrap();
        match entry {
            DshEntry::Tool {
                turn,
                step,
                started_at_ms,
                ended_at_ms,
                ..
            } => {
                assert_eq!((turn, step), (1, 2));
                assert_eq!(started_at_ms, Some(1_700_000_001_000));
                assert_eq!(ended_at_ms, Some(1_700_000_001_026));
            }
            other => panic!("unexpected entry: {other:?}"),
        }
    }

    #[test]
    fn incremental_reads_return_in_place_tool_updates() {
        let mut transcript = Transcript::default();
        let mut call = event("tool/call", 4);
        call["data"] = json!({
            "turn": 1, "step": 1, "callId": "c1", "name": "bash",
            "arguments": "{\"cmd\":\"ls\"}"
        });
        transcript.ingest("s1", &call, "2026-11-16T00:00:04.000Z");
        let (rows, cursor) = transcript.entries_since("s1", 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(cursor, 4);

        // The result keeps the call's seq but arrives at a later event seq.
        let mut result = event("tool/result", 11);
        result["data"] = json!({
            "turn": 1, "step": 1,
            "message": {
                "id": "t1", "role": "tool", "toolCallId": "c1", "isError": false,
                "content": [{ "type": "text", "text": "file.txt" }],
                "source": { "kind": "tool", "callId": "c1" }
            }
        });
        transcript.ingest("s1", &result, "2026-11-16T00:00:11.000Z");

        let (rows, cursor) = transcript.entries_since("s1", cursor).unwrap();
        assert_eq!(rows.len(), 1, "the settled row must reach an incremental reader");
        match &rows[0] {
            DshEntry::Tool {
                status, result, ended_at_ms, ..
            } => {
                assert_eq!(*status, ToolStatus::Ok);
                assert_eq!(result.as_deref(), Some("file.txt"));
                assert_eq!(*ended_at_ms, Some(1_700_000_000_000));
            }
            other => panic!("unexpected entry: {other:?}"),
        }
        assert_eq!(cursor, 11);
    }

    #[test]
    fn a_result_that_outruns_its_call_is_applied_when_the_call_lands() {
        let mut transcript = Transcript::default();
        let mut result = event("tool/result", 3);
        result["data"] = json!({
            "turn": 1, "step": 1,
            "message": {
                "id": "t1", "role": "tool", "toolCallId": "c1", "isError": true,
                "content": [{ "type": "text", "text": "boom" }],
                "source": { "kind": "tool", "callId": "c1" }
            }
        });
        assert!(transcript
            .ingest("s1", &result, "2026-11-16T00:00:03.000Z")
            .entry
            .is_none());

        let mut call = event("tool/call", 5);
        call["data"] = json!({
            "turn": 1, "step": 1, "callId": "c1", "name": "bash",
            "arguments": "{\"cmd\":\"ls\"}"
        });
        let published = transcript
            .ingest("s1", &call, "2026-11-16T00:00:05.000Z")
            .entry
            .expect("the call row is published");
        match published {
            DshEntry::Tool {
                status, result, ended_at_ms, ..
            } => {
                assert_eq!(status, ToolStatus::Error, "the buffered failure is applied");
                assert_eq!(result.as_deref(), Some("boom"));
                assert_eq!(ended_at_ms, Some(1_700_000_000_000));
            }
            other => panic!("unexpected entry: {other:?}"),
        }
        let (rows, cursor) = transcript.entries_since("s1", 3).unwrap();
        assert_eq!(rows.len(), 1, "an incremental reader still sees the row");
        assert_eq!(cursor, 5);
    }

    #[test]
    fn a_log_that_starts_mid_turn_still_labels_its_rows() {
        let mut transcript = Transcript::default();
        let mut step = event("step/start", 0);
        step["data"] = json!({ "turn": 7, "step": 3 });
        transcript.ingest("s1", &step, "2026-11-16T00:00:00.000Z");

        let asked = transcript
            .ingest("s1", &user(1, "hi"), "2026-11-16T00:00:01.000Z")
            .entry
            .unwrap();
        match asked {
            DshEntry::User { turn, step, .. } => assert_eq!((turn, step), (7, 3)),
            other => panic!("unexpected entry: {other:?}"),
        }

        let mut end = event("turn/end", 2);
        end["data"] = json!({ "turn": 7, "reason": { "kind": "completed" } });
        let closed = transcript
            .ingest("s1", &end, "2026-11-16T00:00:02.000Z")
            .entry
            .unwrap();
        match closed {
            DshEntry::Turn { turn, .. } => assert_eq!(turn, 7, "turn/end states its turn"),
            other => panic!("unexpected entry: {other:?}"),
        }
    }

    #[test]
    fn packed_stream_records_still_time_the_first_token() {
        let mut transcript = Transcript::default();
        let mut step = event("step/start", 0);
        step["data"] = json!({ "turn": 1, "step": 1 });
        step["time"] = json!(1_700_000_000_000u64);
        transcript.ingest("s1", &step, "2026-11-16T00:00:00.000Z");

        // A packed run carries `time0` (first token) instead of a loose chunk.
        let mut reply = assistant(1, "done", "");
        reply["data"]["stream"] = json!([
            { "type": "text-chunks", "time0": 1_700_000_000_400u64, "dt": [10, 12], "texts": ["a", "b"] }
        ]);
        reply["time"] = json!(1_700_000_001_000u64);
        let entry = transcript
            .ingest("s1", &reply, "2026-11-16T00:00:01.000Z")
            .entry
            .unwrap();
        match entry {
            DshEntry::Assistant {
                started_at_ms,
                first_token_at_ms,
                ..
            } => {
                assert_eq!(started_at_ms, Some(1_700_000_000_000));
                assert_eq!(first_token_at_ms, Some(1_700_000_000_400));
            }
            other => panic!("unexpected entry: {other:?}"),
        }
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
            DshEntry::Turn {
                state, reason, error, ..
            } => {
                assert_eq!(state, TurnState::End);
                assert_eq!(reason.as_deref(), Some("error"));
                assert_eq!(error.as_deref(), Some("boom"));
            }
            other => panic!("unexpected entry: {other:?}"),
        }
        assert_eq!(transcript.session("s1").unwrap().status, SessionStatus::Failed);
    }

    #[test]
    fn a_hydrated_unclosed_turn_is_not_live() {
        let mut transcript = Transcript::default();
        transcript.ingest("s1", &event("turn/start", 0), "2026-11-16T00:00:00.000Z");
        assert!(transcript.settle_hydrated("s1"));
        assert_eq!(
            transcript.session("s1").unwrap().status,
            SessionStatus::Idle,
            "a crash artifact must not keep a turn running forever"
        );
        assert!(!transcript.settle_hydrated("missing"));
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
    fn usage_totals_come_from_the_message_and_speed_from_the_meter() {
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
        assert_eq!(session.usage.cache_hit_percent(), 98);
        // A message never states a rate: only the engine's decode fold does.
        assert_eq!(session.usage.tokens_per_second, 0);

        // dsh's sessionStats fold: 189 output tokens over 1.75s of decoding.
        let meter = SessionMeter {
            decode_tokens: Some(189),
            decode_ms: Some(1_750),
            ..Default::default()
        };
        transcript.set_meter("s1", &meter, "2026-11-16T00:00:03.000Z");
        assert_eq!(
            transcript.session("s1").unwrap().usage.tokens_per_second,
            108
        );

        // The entry carries the token numbers so the popover needs no lookup.
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
    fn model_selection_updates_the_session_choice() {
        let mut transcript = Transcript::default();
        let ingested = transcript.ingest(
            "s1",
            &json!({
                "type": "model/selection",
                "seq": 0,
                "data": {
                    "provider": "opencode-go",
                    "model": "deepseek-v4.1-flash",
                    "reasoningEffort": "high",
                },
            }),
            "2026-11-16T00:00:00.000Z",
        );
        // A selection is state, not a transcript row.
        assert!(ingested.entry.is_none());
        assert!(ingested.session_changed);

        let session = transcript.session("s1").unwrap();
        let selection = session.selection.expect("selection recorded");
        assert_eq!(selection.provider, "opencode-go");
        assert_eq!(selection.model, "deepseek-v4.1-flash");
        assert_eq!(selection.reasoning_effort.as_deref(), Some("high"));
        // The choice is not a request, so the usage route stays untouched.
        assert!(session.usage.model.is_empty());

        // A repeated seq is deduped, just like every other event.
        transcript.ingest(
            "s1",
            &json!({
                "type": "model/selection",
                "seq": 0,
                "data": { "provider": "gone", "model": "gone" },
            }),
            "2026-11-16T00:00:01.000Z",
        );
        assert_eq!(
            transcript.selection("s1").unwrap().provider,
            "opencode-go"
        );

        // Switching again replaces the choice and drops an absent effort.
        transcript.ingest(
            "s1",
            &json!({
                "type": "model/selection",
                "seq": 1,
                "data": { "provider": "acme", "model": "fast" },
            }),
            "2026-11-16T00:00:02.000Z",
        );
        let selection = transcript.selection("s1").unwrap();
        assert_eq!(selection.model, "fast");
        assert!(selection.reasoning_effort.is_none());
    }

    #[test]
    fn plan_mode_is_part_of_the_session_row() {
        let mut transcript = Transcript::default();
        let entered = transcript.ingest(
            "s1",
            &json!({ "type": "plan/mode", "seq": 0, "data": { "active": true } }),
            "2026-11-16T00:00:00.000Z",
        );
        // Plan state is a session flag, not a transcript row.
        assert!(entered.entry.is_none());
        assert!(entered.session_changed);
        assert!(transcript.session("s1").unwrap().plan_active);

        transcript.ingest(
            "s1",
            &json!({ "type": "plan/mode", "seq": 1, "data": { "active": false } }),
            "2026-11-16T00:00:01.000Z",
        );
        assert!(!transcript.session("s1").unwrap().plan_active);
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

        transcript.ingest("s1", &assistant_with_usage(1, 2_000_000), "2026-11-16T00:00:02.000Z");
        // 8306 / 1,000,000 rounds to nothing at integer percent.
        assert_eq!(transcript.session("s1").unwrap().usage.context_percent(), 1);
    }

    #[test]
    fn timings_start_at_the_step_and_separate_first_token_wait() {
        let mut transcript = Transcript::default();
        let mut step = event("step/start", 1);
        step["time"] = json!(1_700_000_000_000u64);
        transcript.ingest("s1", &step, "2026-11-16T00:00:00.000Z");
        let mut message = assistant_with_usage(2, 1_700_000_005_500);
        message["data"]["stream"] = json!([{ "type": "chunk", "time": 1_700_000_002_500u64 }]);
        transcript.ingest("s1", &message, "2026-11-16T00:00:05.500Z");

        let usage = &transcript.session("s1").unwrap().usage;
        assert_eq!(usage.ttft_ms, 2_500);
        assert_eq!(usage.model_ms, 5_500);
        // A message's stream window never becomes a rate: one short burst would
        // divide into an impossible number. The meter owns the figure.
        assert_eq!(usage.tokens_per_second, 0);

        // The engine's first-token fold wins once it has a sample; it also
        // counts steps whose message never reached the transcript.
        let meter = SessionMeter {
            ttft_ms: Some(9_000),
            ttft_steps: Some(3),
            ..Default::default()
        };
        transcript.set_meter("s1", &meter, "2026-11-16T00:00:06.000Z");
        assert_eq!(transcript.session("s1").unwrap().usage.ttft_ms, 3_000);
    }

    #[test]
    fn a_one_token_burst_cannot_spike_the_decode_rate() {
        let mut transcript = Transcript::default();
        transcript.ingest("s1", &event("step/start", 1), "2026-11-16T00:00:00.000Z");
        // 40 tokens in 4ms is exactly the shape that read as 10,000 tok/s.
        let mut message = assistant_with_usage(2, 1_700_000_000_004);
        message["data"]["stream"] = json!([{ "type": "chunk", "time": 1_700_000_000_000u64 }]);
        message["data"]["usage"]["outputTokens"] = json!(40u64);
        transcript.ingest("s1", &message, "2026-11-16T00:00:00.004Z");
        assert_eq!(
            transcript.session("s1").unwrap().usage.tokens_per_second,
            0
        );

        // The whole-session fold amortizes the burst instead of amplifying it.
        let meter = SessionMeter {
            decode_tokens: Some(1_040),
            decode_ms: Some(20_000),
            ..Default::default()
        };
        transcript.set_meter("s1", &meter, "2026-11-16T00:00:20.000Z");
        assert_eq!(
            transcript.session("s1").unwrap().usage.tokens_per_second,
            52
        );
    }

    #[test]
    fn the_meter_supplies_context_occupancy_and_composition() {
        let mut transcript = Transcript::default();
        transcript.ingest(
            "s1",
            &json!({
                "type": "request/context",
                "seq": 0,
                "data": { "contextWindow": 1_000_000 },
            }),
            "2026-11-16T00:00:00.000Z",
        );
        let meter = SessionMeter {
            context_used_tokens: Some(12_060),
            context_window: Some(1_000_000),
            system_tokens: Some(1_800),
            tools_tokens: Some(8_800),
            message_tokens: Some(1_460),
            ..Default::default()
        };
        assert!(transcript.set_meter("s1", &meter, "2026-11-16T00:00:01.000Z"));
        let usage = &transcript.session("s1").unwrap().usage;
        assert_eq!(usage.context_used_tokens, 12_060);
        assert_eq!(usage.system_tokens, 1_800);
        assert_eq!(usage.tools_tokens, 8_800);
        assert_eq!(usage.message_tokens, 1_460);
        assert_eq!(usage.context_percent(), 1);

        // An unchanged snapshot is not a change; omissions keep the old values.
        assert!(!transcript.set_meter("s1", &meter, "2026-11-16T00:00:02.000Z"));
        let sparse = SessionMeter {
            context_used_tokens: Some(20_000),
            ..SessionMeter::default()
        };
        assert!(transcript.set_meter("s1", &sparse, "2026-11-16T00:00:03.000Z"));
        let usage = &transcript.session("s1").unwrap().usage;
        assert_eq!(usage.context_used_tokens, 20_000);
        assert_eq!(usage.tools_tokens, 8_800);
        assert_eq!(usage.context_percent(), 2);
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
