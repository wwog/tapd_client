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

/// One entry of the session's todo list (`todo/write`, whole-list
/// replacement). Deliberately minimal — no id, no priority: every write
/// replaces the list, so entries have no stable identity. `status` stays the
/// raw dsh string (`pending` / `in_progress` / `completed`) and the UI renders
/// it verbatim.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshTodo {
    pub content: String,
    pub status: String,
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
    /// The session's current todo list (`todo/write` snapshots). Log-only UI
    /// state, not transcript rows: the latest write wins.
    #[serde(default)]
    pub todos: Vec<DshTodo>,
    /// The parent session of a child agent session (dsh header
    /// `origin === "subagent"`). Roots never carry it, so its presence is the
    /// child marker the UI reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session: Option<String>,
    /// The agent preset a child was started with; absent on root sessions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_preset: Option<String>,
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
            todos: Vec::new(),
            parent_session: None,
            agent_preset: None,
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
        /// Child session behind a `subagent`/`subagent_fork` call. The runtime
        /// publishes it as `subagent/catalog` right after the call, which lets
        /// the view show the running child before any settle notice arrives.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        child_session_id: Option<String>,
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
    /// The runtime's account of a child agent settling (a `subagent-settled`
    /// `user/message` in the parent's log). Transcript content — an incremental
    /// reader must see it — but never a human bubble: no title, no message
    /// count.
    Notice {
        seq: u64,
        at: String,
        #[serde(default)]
        turn: u64,
        #[serde(default)]
        step: u64,
        /// The notice's own text blocks, joined like a user row's.
        text: String,
        /// One-line account of how the child ended (`source.summary`).
        summary: String,
        /// Exact execution stop reason; absent on historical notices.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
        /// The child session id, linking this row to the child's transcript.
        sender_session_id: String,
    },
    /// The rendered system prompt of one request (`system/message`). The
    /// conversation view skips it — a prompt is request context, not a chat
    /// bubble — but the trajectory lists it so the exact instructions of a
    /// step are inspectable. A dormant (empty) node produces no row.
    System {
        seq: u64,
        at: String,
        #[serde(default)]
        turn: u64,
        #[serde(default)]
        step: u64,
        text: String,
        /// The event replaced an earlier prompt (`surfaceOp` is not `append`):
        /// an in-history series or a normalization rewrite, not the first one.
        #[serde(default, skip_serializing_if = "is_false")]
        update: bool,
    },
    /// Injected request context: a `user/message` whose source is not a human
    /// (working-directory notices, time samples, agent instructions, the
    /// host's hidden prompts, …) or a `developer/message` session change. The
    /// conversation view skips it; the trajectory shows what else the step
    /// saw. `producer` is a display label (dsh's `contextProducer`: changed
    /// paths, skill name, or the durable source kind).
    Context {
        seq: u64,
        at: String,
        #[serde(default)]
        turn: u64,
        #[serde(default)]
        step: u64,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        producer: Option<String>,
        /// `source.form` when the log carried one (instructions/notice/…).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        form: Option<String>,
    },
    /// The full request header (`request/header`): the route and capacity the
    /// next request was built with, plus the tool names (schemas stay in the
    /// log — a row carries names only).
    Request {
        seq: u64,
        at: String,
        #[serde(default)]
        turn: u64,
        #[serde(default)]
        step: u64,
        /// `RequestHeaderReason`: initial / resume / change / series.
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_tokens: Option<u64>,
        tools: Vec<String>,
    },
    /// One provider-routed retry wait (`llm/retry`). The failure text is the
    /// substance; `llm/retry-started` only marks the wait ending and prices
    /// nothing, so it produces no row.
    Retry {
        seq: u64,
        at: String,
        #[serde(default)]
        turn: u64,
        #[serde(default)]
        step: u64,
        provider: String,
        retry: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_retries: Option<u64>,
        delay_ms: u64,
        message: String,
        code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<u64>,
    },
    /// A request attempt that committed no surface message
    /// (`assistant/attempt`): failed, retried or cancelled mid-stream. The
    /// embedded stream's first/last chunk is all the timing there is.
    Attempt {
        seq: u64,
        at: String,
        #[serde(default)]
        turn: u64,
        #[serde(default)]
        step: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ended_at_ms: Option<u64>,
    },
    /// One compaction cycle (`compaction/start` → `summary` → `end`), merged
    /// in place like a tool row: the row opens running and settles with the
    /// summary text and, on failure, the error.
    Compaction {
        seq: u64,
        at: String,
        #[serde(default)]
        turn: u64,
        #[serde(default)]
        step: u64,
        status: ToolStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        /// Heuristic token price of the shadowed range.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shadowed_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// One PTC sub-call (`tool/ptc-dispatch-start` + `tool/ptc-dispatch`),
    /// nested inside a parent tool call and never re-entering model context.
    /// Same lifecycle as a tool row: opens running, settles in place.
    Subcall {
        seq: u64,
        at: String,
        #[serde(default)]
        turn: u64,
        #[serde(default)]
        step: u64,
        /// The sub-call's own id (`<parent>:ptc:<n>`).
        call_id: String,
        /// The `run_code` call this dispatch happened inside.
        parent_call_id: String,
        name: String,
        /// The dispatched value; already JSON text when the log carried a
        /// string, otherwise re-serialized compactly.
        args: String,
        status: ToolStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ended_at_ms: Option<u64>,
    },
    /// The inherited-history boundary (`session/end-seed`): log from before
    /// this session owned the work (fork prefix / restored cut).
    Seed {
        seq: u64,
        at: String,
        #[serde(default, skip_serializing_if = "is_false")]
        inherited: bool,
    },
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl DshEntry {
    /// Commit position shared by every row kind; incremental readers page on it.
    pub fn seq(&self) -> u64 {
        match self {
            Self::User { seq, .. }
            | Self::Assistant { seq, .. }
            | Self::Tool { seq, .. }
            | Self::Turn { seq, .. }
            | Self::Notice { seq, .. }
            | Self::System { seq, .. }
            | Self::Context { seq, .. }
            | Self::Request { seq, .. }
            | Self::Retry { seq, .. }
            | Self::Attempt { seq, .. }
            | Self::Compaction { seq, .. }
            | Self::Subcall { seq, .. }
            | Self::Seed { seq, .. } => *seq,
        }
    }

    /// The event's own timestamp. Replaying a log must use this instead of the
    /// wall clock, so history does not read as "just now".
    pub fn at(&self) -> &str {
        match self {
            Self::User { at, .. }
            | Self::Assistant { at, .. }
            | Self::Tool { at, .. }
            | Self::Turn { at, .. }
            | Self::Notice { at, .. }
            | Self::System { at, .. }
            | Self::Context { at, .. }
            | Self::Request { at, .. }
            | Self::Retry { at, .. }
            | Self::Attempt { at, .. }
            | Self::Compaction { at, .. }
            | Self::Subcall { at, .. }
            | Self::Seed { at, .. } => at,
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
    /// `subCallId` → index in `entries`, for merging `tool/ptc-dispatch`.
    subcalls: HashMap<String, usize>,
    /// `compactionId` → index in `entries`, for merging a compaction cycle.
    compactions: HashMap<String, usize>,
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
                subcalls: HashMap::new(),
                compactions: HashMap::new(),
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
                | "subagent/catalog"
                | "turn/start"
                | "turn/end"
                | "step/start"
                | "request/context"
                | "model/selection"
                | "plan/mode"
                | "todo/write"
                | "system/message"
                | "developer/message"
                | "request/header"
                | "assistant/attempt"
                | "llm/retry"
                | "llm/retry-started"
                | "compaction/start"
                | "compaction/summary"
                | "compaction/end"
                | "compaction/prune"
                | "tool/ptc-dispatch-start"
                | "tool/ptc-dispatch"
                | "session/end-seed"
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
            "system/message" => record.push_system(seq, at, event),
            "developer/message" => record.push_context(seq, at, event),
            "request/header" => record.push_request(seq, at, event),
            "assistant/attempt" => record.push_attempt(seq, at, event),
            "llm/retry" => record.push_retry(seq, at, event),
            // Timing-only companions: the wait ending and the prune's shadow
            // price change no row the panel shows.
            "llm/retry-started" | "compaction/prune" => None,
            "compaction/start" => record.push_compaction(seq, at, event),
            "compaction/summary" => record.merge_compaction(seq, at, event, false),
            "compaction/end" => record.merge_compaction(seq, at, event, true),
            "tool/ptc-dispatch-start" => record.push_subcall(seq, at, event),
            "tool/ptc-dispatch" => record.merge_subcall(seq, event),
            "session/end-seed" => record.push_seed(seq, at, event),
            "assistant/message" => record.push_assistant(seq, at, event),
            "tool/call" => record.push_tool(seq, at, event),
            "tool/result" => record.merge_tool_result(seq, event),
            "subagent/catalog" => record.merge_subagent_catalog(seq, event),
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
                    // dsh's own `todos` projection folds the standing checklist
                    // away when a later turn begins; `turn/end` keeps the
                    // finished list visible. Mirror that fold here so the card
                    // always reads as the current turn's plan, replayed or live.
                    record.meta.todos.clear();
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
            "todo/write" => {
                // The payload is the complete replacement list (last write
                // wins on replay); it is session state, not a transcript row.
                record.meta.todos = event
                    .pointer("/data/todos")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| DshTodo {
                                content: item
                                    .get("content")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                status: item
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
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

    /// Applies a session header's identity facts (dsh `origin` /
    /// `parentSession` / `agentPreset`). The bridge's `session-meta` frame and
    /// the log's own header line both land here.
    ///
    /// The header is immutable upstream, so only a previously-absent value is
    /// new information; repeated frames are no-ops. `origin` itself is not
    /// stored — `parentSession` presence is the child marker — but a frame that
    /// claims `subagent` without a parent has nothing to record.
    pub fn set_meta(
        &mut self,
        session_id: &str,
        origin: Option<&str>,
        parent_session: Option<&str>,
        agent_preset: Option<&str>,
        at: &str,
    ) -> bool {
        let created = self.ensure_session(session_id, at);
        let record = self.sessions.get_mut(session_id).expect("session ensured above");
        let parent = if origin == Some("subagent") || parent_session.is_some() {
            parent_session
        } else {
            None
        };
        let mut changed = created;
        if parent.is_some() && record.meta.parent_session.is_none() {
            record.meta.parent_session = parent.map(str::to_string);
            changed = true;
        }
        if let Some(preset) = agent_preset {
            if record.meta.agent_preset.is_none() {
                record.meta.agent_preset = Some(preset.to_string());
                changed = true;
            }
        }
        if changed {
            record.touch(at);
        }
        changed
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
        if source_kind == Some("subagent-settled") {
            // The parent log's own account of a child agent settling: real
            // transcript content, but not a human turn (see `push_notice`).
            return Some(self.push_notice(seq, at, event));
        }
        if matches!(source_kind, Some(kind) if kind != "user") {
            // Injected context (workspace instructions, time samples,
            // agent.inject, the host's hidden prompts) is transcript content
            // for the trajectory, but never a human turn: no title, no count.
            let text = join_text_blocks(event.pointer("/data/content"));
            if text.trim().is_empty() {
                return None;
            }
            let entry = DshEntry::Context {
                seq,
                at: at.to_string(),
                turn: self.turn,
                step: self.step,
                text,
                producer: producer_label(event.pointer("/data/source")),
                form: form_of(event.pointer("/data/source")),
            };
            return Some(self.commit(entry, seq));
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

    /// A child agent's settlement notice (`subagent-settled` user/message in
    /// the parent's log). It is transcript content — a dropped notice would
    /// hide "the child finished" entirely — but it is not a human turn: the
    /// title and `message_count` stay untouched, and the `summary` /
    /// `stopReason` / `senderSessionId` attribution comes from the source.
    fn push_notice(&mut self, seq: u64, at: &str, event: &Value) -> DshEntry {
        let text = join_text_blocks(event.pointer("/data/content"));
        let summary = event
            .pointer("/data/source/summary")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let stop_reason = event
            .pointer("/data/source/stopReason")
            .and_then(Value::as_str)
            .map(str::to_string);
        let sender_session_id = event
            .pointer("/data/source/senderSessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let entry = DshEntry::Notice {
            seq,
            at: at.to_string(),
            turn: self.turn,
            step: self.step,
            text,
            summary,
            stop_reason,
            sender_session_id,
        };
        self.entries.push(entry.clone());
        self.last_update.insert(seq, seq);
        entry
    }

    /// The rendered system prompt of one request (`system/message`).
    ///
    /// dsh writes the effective prompt as a surface node and later rewrites it
    /// through a replacing `system/message` (a phase change, or normalization
    /// that empties the old node). New text keeps the event's own turn/step so
    /// the trajectory places it at its request; an empty node is dormant and
    /// projects to no row. Not transcript content: `message_count` and the
    /// title stay untouched.
    fn push_system(&mut self, seq: u64, at: &str, event: &Value) -> Option<DshEntry> {
        let text = join_text_blocks(event.pointer("/data/message/content"));
        if text.trim().is_empty() {
            return None;
        }
        let turn = event
            .pointer("/data/turn")
            .and_then(Value::as_u64)
            .unwrap_or(self.turn);
        let step = event
            .pointer("/data/step")
            .and_then(Value::as_u64)
            .unwrap_or(self.step);
        let update = event
            .get("surfaceOp")
            .map(|op| op.as_str() != Some("append"))
            .unwrap_or(false);
        let entry = DshEntry::System {
            seq,
            at: at.to_string(),
            turn,
            step,
            text,
            update,
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
            child_session_id: None,
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

    /// Binds the child session the runtime just announced to the fork call that
    /// started it, and re-publishes that call row. `subagent/catalog` carries no
    /// call id, so it belongs to the most recent subagent call still unbound;
    /// the catalog lands immediately after its `tool/call` in the log.
    fn merge_subagent_catalog(&mut self, seq: u64, event: &Value) -> Option<DshEntry> {
        let child_id = event
            .pointer("/data/childId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if child_id.is_empty() {
            return None;
        }
        let index = self.entries.iter().rposition(|entry| {
            matches!(
                entry,
                DshEntry::Tool {
                    name,
                    child_session_id: None,
                    ..
                } if name == "subagent" || name == "subagent_fork"
            )
        })?;
        let DshEntry::Tool {
            child_session_id, ..
        } = &mut self.entries[index]
        else {
            return None;
        };
        *child_session_id = Some(child_id);
        let entry = self.entries[index].clone();
        self.last_update.insert(entry.seq(), seq);
        Some(entry)
    }

    /// Appends a row and records its seq as the last update. Every new-row
    /// path funnels here so the incremental-read contract stays uniform.
    fn commit(&mut self, entry: DshEntry, seq: u64) -> DshEntry {
        self.entries.push(entry.clone());
        self.last_update.insert(seq, seq);
        entry
    }

    /// Injected request context. `developer/message` carries the same message
    /// shape (`content` + `source`) the injected `user/message` rows use; both
    /// render through one [`DshEntry::Context`] row.
    fn push_context(&mut self, seq: u64, at: &str, event: &Value) -> Option<DshEntry> {
        let message = event.pointer("/data/message");
        let text = join_text_blocks(message.and_then(|value| value.get("content")));
        if text.trim().is_empty() {
            return None;
        }
        let entry = DshEntry::Context {
            seq,
            at: at.to_string(),
            turn: self.event_turn(event),
            step: self.event_step(event),
            text,
            producer: producer_label(message.and_then(|value| value.get("source"))),
            form: form_of(message.and_then(|value| value.get("source"))),
        };
        Some(self.commit(entry, seq))
    }

    /// The full request header. Tool schemas stay in the log; a row carries
    /// the names only, which is what "what could this step call" needs.
    fn push_request(&mut self, seq: u64, at: &str, event: &Value) -> Option<DshEntry> {
        let header = event.pointer("/data/header");
        let config = header.and_then(|value| value.get("config"));
        let string_in = |key: &str| {
            config
                .and_then(|value| value.get(key))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let number_in = |key: &str| {
            config
                .and_then(|value| value.get(key))
                .and_then(Value::as_u64)
        };
        let tools = header
            .and_then(|value| value.get("tools"))
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let entry = DshEntry::Request {
            seq,
            at: at.to_string(),
            turn: self.turn,
            step: self.step,
            reason: event
                .pointer("/data/reason")
                .and_then(Value::as_str)
                .unwrap_or("initial")
                .to_string(),
            provider: string_in("provider"),
            model: string_in("model"),
            effort: string_in("reasoningEffort"),
            max_tokens: number_in("maxTokens"),
            tools,
        };
        Some(self.commit(entry, seq))
    }

    /// A request attempt that produced no committed message. The stream's
    /// first and last chunk bracket whatever reached the wire.
    fn push_attempt(&mut self, seq: u64, at: &str, event: &Value) -> Option<DshEntry> {
        let stream = event.pointer("/data/stream").and_then(Value::as_array);
        let started_at_ms = stream
            .and_then(|chunks| chunks.first())
            .and_then(|chunk| chunk.get("time"))
            .and_then(Value::as_u64);
        let ended_at_ms = stream
            .and_then(|chunks| chunks.last())
            .and_then(|chunk| chunk.get("time"))
            .and_then(Value::as_u64);
        let entry = DshEntry::Attempt {
            seq,
            at: at.to_string(),
            turn: self.event_turn(event),
            step: self.event_step(event),
            started_at_ms,
            ended_at_ms,
        };
        Some(self.commit(entry, seq))
    }

    /// One provider-routed retry wait; the failure text is the substance.
    fn push_retry(&mut self, seq: u64, at: &str, event: &Value) -> Option<DshEntry> {
        let failure = event.pointer("/data/failure");
        let entry = DshEntry::Retry {
            seq,
            at: at.to_string(),
            turn: self.event_turn(event),
            step: self.event_step(event),
            provider: event
                .pointer("/data/provider")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            retry: event
                .pointer("/data/retry")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            max_retries: event
                .pointer("/data/maxRetries")
                .and_then(Value::as_u64),
            delay_ms: event
                .pointer("/data/delayMs")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            message: failure
                .and_then(|value| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            code: failure
                .and_then(|value| value.get("code"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            status: failure.and_then(|value| value.get("status")).and_then(Value::as_u64),
        };
        Some(self.commit(entry, seq))
    }

    /// Opens one compaction cycle's row; `summary` and `end` merge into it.
    fn push_compaction(&mut self, seq: u64, at: &str, event: &Value) -> Option<DshEntry> {
        let id = compaction_id(event);
        let entry = DshEntry::Compaction {
            seq,
            at: at.to_string(),
            turn: event
                .pointer("/data/turn")
                .and_then(Value::as_u64)
                .unwrap_or(self.turn),
            step: self.step,
            status: ToolStatus::Running,
            summary: None,
            shadowed_tokens: None,
            error: None,
        };
        if !id.is_empty() {
            self.compactions.insert(id, self.entries.len());
        }
        Some(self.commit(entry, seq))
    }

    /// Applies `compaction/summary` or `compaction/end` to the cycle's row. A
    /// cycle whose `start` is missing (older log) still opens a row here, so
    /// the summary text is never lost.
    fn merge_compaction(
        &mut self,
        seq: u64,
        at: &str,
        event: &Value,
        ended: bool,
    ) -> Option<DshEntry> {
        let id = compaction_id(event);
        if self.compactions.get(&id).is_none() {
            self.push_compaction(seq, at, event)?;
        }
        let index = *self.compactions.get(&id)?;
        let summary = join_text_blocks(event.pointer("/data/summary"));
        let shadowed_tokens = event
            .pointer("/data/shadowedTokenCount")
            .and_then(Value::as_u64);
        let error = if ended {
            event
                .pointer("/data/error")
                .and_then(Value::as_str)
                .map(str::to_string)
        } else {
            None
        };
        let entry = match self.entries.get_mut(index) {
            Some(DshEntry::Compaction {
                summary: row_summary,
                shadowed_tokens: row_shadowed,
                error: row_error,
                status,
                ..
            }) => {
                if !summary.is_empty() {
                    *row_summary = Some(summary);
                }
                if shadowed_tokens.is_some() {
                    *row_shadowed = shadowed_tokens;
                }
                if ended {
                    *row_error = error;
                    *status = if row_error.is_some() {
                        ToolStatus::Error
                    } else {
                        ToolStatus::Ok
                    };
                }
                self.entries[index].clone()
            }
            _ => return None,
        };
        self.last_update.insert(entry.seq(), seq);
        Some(entry)
    }

    /// Opens one PTC sub-call row, nested under its parent tool call.
    fn push_subcall(&mut self, seq: u64, at: &str, event: &Value) -> Option<DshEntry> {
        let call_id = event
            .pointer("/data/subCallId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let entry = DshEntry::Subcall {
            seq,
            at: at.to_string(),
            turn: self.turn,
            step: self.step,
            call_id: call_id.clone(),
            parent_call_id: event
                .pointer("/data/parentCallId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            name: event
                .pointer("/data/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            args: args_text(event.pointer("/data/arguments")),
            status: ToolStatus::Running,
            result: None,
            started_at_ms: event.get("time").and_then(Value::as_u64),
            ended_at_ms: None,
        };
        if !call_id.is_empty() {
            self.subcalls.insert(call_id, self.entries.len());
        }
        Some(self.commit(entry, seq))
    }

    /// Applies `tool/ptc-dispatch` to its sub-call row. A start strictly
    /// precedes its dispatch (both append inside the parent's execution), so
    /// no orphan buffering is needed here.
    fn merge_subcall(&mut self, seq: u64, event: &Value) -> Option<DshEntry> {
        let call_id = event
            .pointer("/data/subCallId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let index = *self.subcalls.get(call_id)?;
        let text = join_text_blocks(event.pointer("/data/content"));
        let failed = event
            .pointer("/data/isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let entry = match self.entries.get_mut(index) {
            Some(DshEntry::Subcall {
                status,
                result,
                ended_at_ms: ended,
                ..
            }) => {
                *status = if failed { ToolStatus::Error } else { ToolStatus::Ok };
                *result = Some(text);
                *ended = event.get("time").and_then(Value::as_u64);
                self.entries[index].clone()
            }
            _ => return None,
        };
        self.last_update.insert(entry.seq(), seq);
        Some(entry)
    }

    /// The inherited-history boundary. Nothing before it belongs to this
    /// session's own lifecycle.
    fn push_seed(&mut self, seq: u64, at: &str, event: &Value) -> Option<DshEntry> {
        let entry = DshEntry::Seed {
            seq,
            at: at.to_string(),
            inherited: event
                .pointer("/data/inherited")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        Some(self.commit(entry, seq))
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

/// dsh's `contextProducer`: a readable label for an injected message's
/// source — the changed paths for agent instructions, the skill name, the
/// referenced labels, else the durable source kind itself.
fn producer_label(source: Option<&Value>) -> Option<String> {
    let source = source?;
    let kind = source.get("kind").and_then(Value::as_str)?;
    let specific = match kind {
        "session-reference" => joined_field(source, "references", "label"),
        "agent-instructions" => joined_field(source, "changes", "path"),
        "skill-invocation" => source
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => None,
    };
    Some(
        specific
            .filter(|label| !label.trim().is_empty())
            .unwrap_or_else(|| kind.to_string()),
    )
}

/// dsh's `contextForm`: the source's own presentation form, verbatim.
fn form_of(source: Option<&Value>) -> Option<String> {
    source?
        .get("form")
        .and_then(Value::as_str)
        .filter(|form| !form.is_empty())
        .map(str::to_string)
}

/// Joins `source[key][*][field]` with ", " — the shape `references[].label`
/// and `changes[].path` share.
fn joined_field(source: &Value, key: &str, field: &str) -> Option<String> {
    let joined = source
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get(field).and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    (!joined.is_empty()).then_some(joined)
}

/// A compaction cycle's durable identity, shared by start/summary/end.
fn compaction_id(event: &Value) -> String {
    event
        .pointer("/data/compactionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// PTC dispatch arguments are logged as their normalized value: a string
/// stays verbatim, anything else is re-serialized compactly.
fn args_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(value) => value.to_string(),
        None => "{}".to_string(),
    }
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
            child_session_id: None,
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
        // It is a context row now (trajectory-only), never a human turn.
        assert!(matches!(
            transcript
                .ingest("s1", &injected, "2026-11-16T00:00:00.000Z")
                .entry,
            Some(DshEntry::Context { .. })
        ));
        assert!(transcript.session("s1").unwrap().title.is_empty());

        transcript.ingest("s1", &user(1, "real question"), "2026-11-16T00:00:01.000Z");
        let session = transcript.session("s1").unwrap();
        assert_eq!(session.title, "real question");
        assert_eq!(session.message_count, 1);
    }

    /// A `system/message` as dsh writes it: the rendered prompt plus its
    /// surface placement (`"append"` or a `replace` range).
    fn system_prompt(seq: u64, text: &str, turn: u64, step: u64, surface_op: Value) -> Value {
        let mut value = event("system/message", seq);
        value["surfaceOp"] = surface_op;
        value["data"] = json!({
            "turn": turn,
            "step": step,
            "message": {
                "role": "system",
                "content": [{ "type": "text", "text": text }],
                "source": { "kind": "system-prompt" }
            }
        });
        value
    }

    #[test]
    fn system_prompt_rows_are_trajectory_only() {
        let mut transcript = Transcript::default();
        let appended = transcript.ingest(
            "s1",
            &system_prompt(1, "you are an agent", 1, 1, json!("append")),
            "2026-11-16T00:00:01.000Z",
        );
        let prompt = appended.entry.expect("the prompt is a row");
        assert!(matches!(
            &prompt,
            DshEntry::System { seq: 1, turn: 1, step: 1, text, update: false, .. }
                if text == "you are an agent"
        ));
        // Neither a bubble nor a title: the conversation view never sees it.
        let session = transcript.session("s1").unwrap();
        assert_eq!(session.message_count, 0);
        assert!(session.title.is_empty());

        // A dormant node (normalization emptied it) projects to no row.
        let dormant = transcript.ingest(
            "s1",
            &system_prompt(2, "", 1, 1, json!({ "op": "replace", "startSeq": 1, "endSeq": 1 })),
            "2026-11-16T00:00:02.000Z",
        );
        assert!(dormant.entry.is_none());

        // A replacement keeps its own turn/step and is marked as an update.
        let replaced = transcript.ingest(
            "s1",
            &system_prompt(
                3,
                "write-back instructions",
                2,
                1,
                json!({ "op": "replace", "startSeq": 2, "endSeq": 2 }),
            ),
            "2026-11-16T00:00:03.000Z",
        );
        let row = replaced.entry.expect("the updated prompt is a row");
        assert!(matches!(
            &row,
            DshEntry::System { seq: 3, turn: 2, step: 1, text, update: true, .. }
                if text == "write-back instructions"
        ));
        assert_eq!(transcript.entries("s1").unwrap().len(), 2);
        assert_eq!(transcript.session("s1").unwrap().message_count, 0);
    }

    fn injected_context(seq: u64, source: Value) -> Value {
        let mut value = event("user/message", seq);
        value["data"] = json!({
            "id": format!("m{seq}"),
            "role": "user",
            "content": [{ "type": "text", "text": "The working directory changed." }],
            "source": source,
        });
        value
    }

    #[test]
    fn injected_context_and_developer_changes_become_context_rows() {
        let mut transcript = Transcript::default();
        let injected = transcript.ingest(
            "s1",
            &injected_context(
                1,
                json!({
                    "kind": "agent-instructions",
                    "form": "instructions",
                    "changes": [{ "path": "AGENTS.md" }, { "path": "docs/" }]
                }),
            ),
            "2026-11-16T00:00:01.000Z",
        );
        assert!(matches!(
            &injected.entry,
            Some(DshEntry::Context { seq: 1, text, producer, form, .. })
                if text == "The working directory changed."
                    && producer.as_deref() == Some("AGENTS.md, docs/")
                    && form.as_deref() == Some("instructions")
        ));
        // Context, not a bubble: no title, no message count.
        let session = transcript.session("s1").unwrap();
        assert_eq!(session.message_count, 0);
        assert!(session.title.is_empty());

        // An opaque producer keeps its durable kind, like dsh's default arm.
        let skill = transcript.ingest(
            "s1",
            &injected_context(2, json!({ "kind": "time-context" })),
            "2026-11-16T00:00:02.000Z",
        );
        assert!(matches!(
            &skill.entry,
            Some(DshEntry::Context { producer, .. }) if producer.as_deref() == Some("time-context")
        ));

        // `developer/message` carries its own turn/step and the same shape.
        let mut developer = event("developer/message", 3);
        developer["data"] = json!({
            "turn": 2,
            "step": 3,
            "message": {
                "role": "developer",
                "content": [{ "type": "text", "text": "tools added" }],
                "source": { "kind": "policy-update" }
            }
        });
        let changed = transcript.ingest("s1", &developer, "2026-11-16T00:00:03.000Z");
        assert!(matches!(
            &changed.entry,
            Some(DshEntry::Context { seq: 3, turn: 2, step: 3, text, producer, .. })
                if text == "tools added" && producer.as_deref() == Some("policy-update")
        ));
    }

    #[test]
    fn request_header_rows_carry_the_route_and_tool_names_only() {
        let mut transcript = Transcript::default();
        let mut header = event("request/header", 1);
        header["data"] = json!({
            "reason": "initial",
            "header": {
                "config": {
                    "provider": "p1",
                    "model": "m1",
                    "reasoningEffort": "high",
                    "maxTokens": 4096
                },
                "adapterDefaults": {},
                "tools": [
                    { "name": "bash", "description": "run a command", "schema": { "deep": true } },
                    { "name": "read" }
                ]
            }
        });
        let ingested = transcript.ingest("s1", &header, "2026-11-16T00:00:01.000Z");
        assert!(matches!(
            &ingested.entry,
            Some(DshEntry::Request {
                seq: 1, reason, provider, model,
                effort, max_tokens: Some(4096), tools, ..
            })
            if reason == "initial" && provider.as_deref() == Some("p1")
                && model.as_deref() == Some("m1") && effort.as_deref() == Some("high")
                && tools == &["bash".to_string(), "read".to_string()]
        ));
        // Schemas and descriptions stay in the log.
        let row = serde_json::to_value(ingested.entry.as_ref().unwrap()).unwrap();
        assert!(row.to_string().find("description").is_none());
    }

    #[test]
    fn retries_and_attempts_expose_failed_requests() {
        let mut transcript = Transcript::default();
        let mut attempt = event("assistant/attempt", 1);
        attempt["data"] = json!({
            "turn": 1,
            "step": 2,
            "stream": [
                { "time": 1_700_000_000_000u64, "record": { "type": "text-delta" } },
                { "time": 1_700_000_000_500u64, "record": { "type": "text-delta" } }
            ]
        });
        let tried = transcript.ingest("s1", &attempt, "2026-11-16T00:00:01.000Z");
        assert!(matches!(
            &tried.entry,
            Some(DshEntry::Attempt {
                seq: 1, turn: 1, step: 2,
                started_at_ms: Some(1_700_000_000_000),
                ended_at_ms: Some(1_700_000_000_500), ..
            })
        ));

        let mut retry = event("llm/retry", 2);
        retry["data"] = json!({
            "retryId": "r1",
            "turn": 1,
            "step": 2,
            "provider": "p1",
            "mode": "normal",
            "policyKey": "net",
            "retry": 1,
            "maxRetries": 5,
            "delayMs": 8000,
            "failure": { "message": "HTTP 429", "code": "rate_limited", "status": 429 }
        });
        let waited = transcript.ingest("s1", &retry, "2026-11-16T00:00:02.000Z");
        assert!(matches!(
            &waited.entry,
            Some(DshEntry::Retry {
                seq: 2, provider, retry: 1, max_retries: Some(5),
                delay_ms: 8000, message, code, status: Some(429), ..
            })
            if provider == "p1" && message == "HTTP 429" && code == "rate_limited"
        ));

        // The wait ending changes no row; it prices nothing the panel shows.
        let mut started = event("llm/retry-started", 3);
        started["data"] = json!({ "retryId": "r1", "turn": 1, "step": 2, "retry": 1 });
        let resumed = transcript.ingest("s1", &started, "2026-11-16T00:00:03.000Z");
        assert!(resumed.entry.is_none());
    }

    #[test]
    fn compaction_cycles_merge_into_one_row() {
        let mut transcript = Transcript::default();
        let mut start = event("compaction/start", 1);
        start["data"] = json!({ "compactionId": "c1", "turn": 2 });
        let opened = transcript.ingest("s1", &start, "2026-11-16T00:00:01.000Z");
        assert!(matches!(
            &opened.entry,
            Some(DshEntry::Compaction { seq: 1, turn: 2, status: ToolStatus::Running, .. })
        ));

        let mut summary = event("compaction/summary", 2);
        summary["data"] = json!({
            "compactionId": "c1",
            "summary": [{ "type": "text", "text": "compacted summary" }],
            "shadowedRange": { "start": 0, "end": 10 },
            "shadowedTokenCount": 12345,
            "provider": "p1",
            "model": "m1"
        });
        let summarized = transcript.ingest("s1", &summary, "2026-11-16T00:00:02.000Z");
        assert!(matches!(
            &summarized.entry,
            Some(DshEntry::Compaction {
                seq: 1, status: ToolStatus::Running,
                summary: Some(text), shadowed_tokens: Some(12345), ..
            }) if text == "compacted summary"
        ));

        let mut end = event("compaction/end", 3);
        end["data"] = json!({ "compactionId": "c1", "turn": 2 });
        let closed = transcript.ingest("s1", &end, "2026-11-16T00:00:03.000Z");
        assert!(matches!(
            &closed.entry,
            Some(DshEntry::Compaction {
                seq: 1, status: ToolStatus::Ok,
                summary: Some(text), shadowed_tokens: Some(12345), error: None, ..
            }) if text == "compacted summary"
        ));

        // A cycle whose start is missing still opens a row, straight to error.
        let mut failed = event("compaction/end", 4);
        failed["data"] = json!({ "compactionId": "c2", "turn": 3, "error": "summarizer failed" });
        let broken = transcript.ingest("s1", &failed, "2026-11-16T00:00:04.000Z");
        assert!(matches!(
            &broken.entry,
            Some(DshEntry::Compaction {
                seq: 4, status: ToolStatus::Error,
                error: Some(message), ..
            }) if message == "summarizer failed"
        ));
        assert_eq!(transcript.entries("s1").unwrap().len(), 2);
    }

    #[test]
    fn subagent_catalog_binds_the_child_session_to_its_fork_call() {
        let mut transcript = Transcript::default();
        let mut call = event("tool/call", 1);
        call["data"] = json!({
            "turn": 1, "step": 1, "callId": "fork1", "name": "subagent_fork",
            "arguments": "{}"
        });
        transcript.ingest("s1", &call, "2026-11-16T00:00:01.000Z");

        let mut catalog = event("subagent/catalog", 2);
        catalog["data"] = json!({
            "version": 3, "childId": "child-9", "childCreatedAt": 1,
            "mode": "continuable", "label": "Review", "name": "agent-1"
        });
        let updated = transcript.ingest("s1", &catalog, "2026-11-16T00:00:02.000Z");
        assert!(matches!(
            &updated.entry,
            Some(DshEntry::Tool { seq: 1, child_session_id: Some(id), .. }) if id == "child-9"
        ));
        // The row keeps its call seq, so the incremental cursor does not move.
        let rows = transcript.entries("s1").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(matches!(
            &rows[0],
            DshEntry::Tool { seq: 1, child_session_id: Some(id), .. } if id == "child-9"
        ));
    }

    #[test]
    fn subcall_rows_pair_start_and_dispatch() {
        let mut transcript = Transcript::default();
        let mut parent = event("tool/call", 1);
        parent["data"] = json!({
            "turn": 1, "step": 1, "callId": "run1", "name": "run_code",
            "arguments": "{}"
        });
        transcript.ingest("s1", &parent, "2026-11-16T00:00:01.000Z");

        let mut dispatch_start = event("tool/ptc-dispatch-start", 2);
        dispatch_start["data"] = json!({
            "rootCallId": "run1",
            "parentCallId": "run1",
            "subCallId": "run1:ptc:0",
            "name": "bash",
            "arguments": { "cmd": "ls" }
        });
        let opened = transcript.ingest("s1", &dispatch_start, "2026-11-16T00:00:02.000Z");
        assert!(matches!(
            &opened.entry,
            Some(DshEntry::Subcall {
                seq: 2, call_id, parent_call_id, name, args,
                status: ToolStatus::Running, result: None, ..
            })
            if call_id == "run1:ptc:0" && parent_call_id == "run1"
                && name == "bash" && args == r#"{"cmd":"ls"}"#
        ));

        let mut dispatch = event("tool/ptc-dispatch", 3);
        dispatch["data"] = json!({
            "rootCallId": "run1",
            "parentCallId": "run1",
            "subCallId": "run1:ptc:0",
            "name": "bash",
            "arguments": { "cmd": "ls" },
            "isError": true,
            "content": [{ "type": "text", "text": "boom" }],
            "error": { "name": "BashError", "code": "exit_1" }
        });
        let settled = transcript.ingest("s1", &dispatch, "2026-11-16T00:00:03.000Z");
        assert!(matches!(
            &settled.entry,
            Some(DshEntry::Subcall {
                seq: 2, status: ToolStatus::Error,
                result: Some(text),
                started_at_ms: Some(_), ended_at_ms: Some(_), ..
            }) if text == "boom"
        ));
    }

    #[test]
    fn end_seed_marks_the_inherited_boundary() {
        let mut transcript = Transcript::default();
        let mut seed = event("session/end-seed", 1);
        seed["data"] = json!({ "inherited": true });
        let ingested = transcript.ingest("s1", &seed, "2026-11-16T00:00:01.000Z");
        assert!(matches!(
            &ingested.entry,
            Some(DshEntry::Seed { seq: 1, inherited: true, .. })
        ));
    }

    /// A `subagent-settled` user/message, as dsh writes it into the parent log
    /// when a child agent settles (continuation-messages.ts).
    fn notice(seq: u64, summary: &str, stop: Option<&str>, sender: &str) -> Value {
        let mut value = event("user/message", seq);
        let mut source = json!({
            "kind": "subagent-settled",
            "form": "notice",
            "summary": summary,
            "senderSessionId": sender,
        });
        if let Some(stop) = stop {
            source["stopReason"] = json!(stop);
        }
        value["data"] = json!({
            "id": format!("m{seq}"),
            "role": "user",
            "content": [{ "type": "text", "text": "child finished" }],
            "source": source,
        });
        value
    }

    #[test]
    fn todo_write_replaces_the_whole_list_once_per_seq() {
        let mut transcript = Transcript::default();
        let write = |seq: u64, todos: Value| {
            let mut value = event("todo/write", seq);
            value["data"] = json!({ "todos": todos });
            value
        };
        let first = transcript.ingest(
            "s1",
            &write(
                1,
                json!([
                    { "content": "survey", "status": "completed" },
                    { "content": "patch", "status": "in_progress" },
                ]),
            ),
            "2026-11-16T00:00:01.000Z",
        );
        // Session state, not a transcript row.
        assert!(first.entry.is_none());
        assert!(first.session_changed);

        let session = transcript.session("s1").unwrap();
        assert_eq!(session.todos.len(), 2);
        assert_eq!(session.todos[0].content, "survey");
        assert_eq!(session.todos[0].status, "completed");
        assert_eq!(session.todos[1].status, "in_progress");
        // The sorted list output the UI reads carries the same state.
        assert_eq!(transcript.sessions().len(), 1);
        assert_eq!(transcript.sessions()[0].todos.len(), 2);

        // A repeated seq (snapshot replayed over live) must not reapply.
        transcript.ingest(
            "s1",
            &write(1, json!([{ "content": "ghost", "status": "pending" }])),
            "2026-11-16T00:00:02.000Z",
        );
        assert_eq!(transcript.session("s1").unwrap().todos.len(), 2);

        // A later write replaces the list wholesale — including with an empty
        // one — and still produces no row.
        transcript.ingest("s1", &write(2, json!([])), "2026-11-16T00:00:03.000Z");
        assert!(transcript.session("s1").unwrap().todos.is_empty());
        assert!(transcript.entries("s1").unwrap().is_empty());
    }

    #[test]
    fn a_new_turn_folds_the_standing_todo_list_away() {
        let mut transcript = Transcript::default();
        let write = |seq: u64, todos: Value| {
            let mut value = event("todo/write", seq);
            value["data"] = json!({ "todos": todos });
            value
        };
        transcript.ingest(
            "s1",
            &write(
                1,
                json!([{ "content": "patch", "status": "completed" }]),
            ),
            "2026-11-16T00:00:01.000Z",
        );
        assert_eq!(transcript.session("s1").unwrap().todos.len(), 1);

        // dsh's own projection clears the standing checklist when the next
        // turn begins; the finished list stays visible through `turn/end`.
        let mut turn = event("turn/start", 2);
        turn["data"] = json!({ "turn": 2 });
        transcript.ingest("s1", &turn, "2026-11-16T00:00:02.000Z");
        assert!(transcript.session("s1").unwrap().todos.is_empty());

        // A stale replayed marker below the frontier must not fold again.
        transcript.ingest(
            "s1",
            &write(3, json!([{ "content": "next", "status": "pending" }])),
            "2026-11-16T00:00:03.000Z",
        );
        let mut stale = event("turn/start", 1);
        stale["data"] = json!({ "turn": 1 });
        transcript.ingest("s1", &stale, "2026-11-16T00:00:04.000Z");
        assert_eq!(transcript.session("s1").unwrap().todos.len(), 1);
    }

    #[test]
    fn a_subagent_settlement_is_a_notice_row_not_a_bubble() {
        let mut transcript = Transcript::default();
        let entry = transcript
            .ingest(
                "s1",
                &notice(4, "wrote the report", Some("completed"), "child-9"),
                "2026-11-16T00:00:04.000Z",
            )
            .entry
            .expect("the notice is transcript content");
        match &entry {
            DshEntry::Notice {
                seq,
                text,
                summary,
                stop_reason,
                sender_session_id,
                ..
            } => {
                assert_eq!(*seq, 4);
                assert_eq!(text, "child finished");
                assert_eq!(summary, "wrote the report");
                assert_eq!(stop_reason.as_deref(), Some("completed"));
                assert_eq!(sender_session_id, "child-9");
            }
            other => panic!("unexpected entry: {other:?}"),
        }
        let session = transcript.session("s1").unwrap();
        assert!(session.title.is_empty(), "a notice never names the session");
        assert_eq!(session.message_count, 0, "a notice is not a human turn");

        // Historical notices carry no stop reason; the key is omitted on the
        // wire, matching the camelCase contract.
        transcript.ingest(
            "s1",
            &notice(5, "revisited", None, "child-9"),
            "2026-11-16T00:00:05.000Z",
        );
        let json = serde_json::to_value(
            transcript
                .entries("s1")
                .unwrap()
                .into_iter()
                .find(|entry| entry.seq() == 5)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json["kind"], "notice");
        assert_eq!(json["summary"], "revisited");
        assert_eq!(json["senderSessionId"], "child-9");
        assert!(json.get("stopReason").is_none());
    }

    #[test]
    fn session_meta_is_idempotent_and_marks_child_sessions() {
        let mut transcript = Transcript::default();
        assert!(transcript.set_meta(
            "child-9",
            Some("subagent"),
            Some("root-1"),
            Some("author"),
            "2026-11-16T00:00:00.000Z",
        ));
        // A replayed frame (snapshot and live overlap) is not a change, and the
        // existing timestamp is not moved forward.
        assert!(!transcript.set_meta(
            "child-9",
            Some("subagent"),
            Some("root-1"),
            Some("author"),
            "2026-11-16T00:00:09.000Z",
        ));

        let session = transcript.session("child-9").unwrap();
        assert_eq!(session.parent_session.as_deref(), Some("root-1"));
        assert_eq!(session.agent_preset.as_deref(), Some("author"));

        // A root session sends no parent: nothing marks it a child.
        assert!(transcript.set_meta(
            "root-1",
            None,
            None,
            None,
            "2026-11-16T00:00:00.000Z",
        ));
        let json = serde_json::to_value(transcript.session("root-1").unwrap()).unwrap();
        assert!(json.get("parentSession").is_none());
        assert!(json.get("agentPreset").is_none());
        assert_eq!(json["todos"], json!([]));

        // The child row carries the contract's camelCase wire names.
        let json = serde_json::to_value(transcript.session("child-9").unwrap()).unwrap();
        assert_eq!(json["parentSession"], "root-1");
        assert_eq!(json["agentPreset"], "author");
        assert_eq!(json["todos"], json!([]));
    }

    #[test]
    fn a_notice_reaches_incremental_readers() {
        let mut transcript = Transcript::default();
        transcript.ingest("s1", &user(1, "go"), "2026-11-16T00:00:01.000Z");
        let (_, cursor) = transcript.entries_since("s1", 0).unwrap();

        transcript.ingest(
            "s1",
            &notice(9, "wrote the report", Some("completed"), "child-9"),
            "2026-11-16T00:00:09.000Z",
        );
        let (rows, cursor) = transcript.entries_since("s1", cursor).unwrap();
        assert_eq!(rows.len(), 1, "the notice must reach a paged reader");
        assert!(matches!(&rows[0], DshEntry::Notice { .. }));
        assert_eq!(cursor, 9);
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
        let first = transcript.ingest("s1", &event("session/title", 0), "2026-11-16T00:00:00.000Z");
        let second = transcript.ingest("s1", &event("session/title", 1), "2026-11-16T00:00:01.000Z");
        assert_eq!(first.unknown.as_deref(), Some("session/title"));
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
