//! Interactive terminals: shells running in PTYs, shared by the desktop tab
//! strip and the phone.
//!
//! One session = one shell process. Output is batched on a display-frame
//! cadence, kept in a bounded ring for replay, and fanned out to two consumers:
//! the webview (`terminal://output`) and any attached phone socket (see
//! `companion::terminal`). The ring, the cumulative byte counter and the
//! broadcast subscription are taken under the same lock, so a late subscriber
//! never replays bytes it also receives live.
//!
//! Exposed through `feature_command` names starting with `terminal_`.

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tapd_i18n::{tr, tr_args};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{broadcast, watch};

use crate::{agent_settings, pty_util, shell_path};

/// Simultaneous sessions. Each one is a shell plus two threads; the limit is a
/// real number, quoted back in the error, not a soft suggestion.
const MAX_SESSIONS: usize = 8;
/// Replay tail kept per session. A terminal screen is far smaller; this is
/// enough to rebuild a full-screen TUI after attaching.
const RING_BYTES: usize = 256 * 1024;
/// One `terminal_input` call may not exceed this: a paste flood must not wedge
/// the PTY writer.
const MAX_INPUT_BYTES: usize = 64 * 1024;
/// Bytes handed to the writer thread but not yet written. A shell that stops
/// reading its input must make the queue refuse new keystrokes instead of
/// growing without bound; the UI surfaces the refusal as "busy".
const MAX_QUEUED_INPUT_BYTES: usize = 1024 * 1024;
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
/// Exit code used when the child was killed by a signal, i.e. there is no
/// process exit code to report.
const UNKNOWN_EXIT: i32 = -1;

/// Every replay starts from a blank screen: a remounting webview or a phone
/// that wakes up gets a deterministic origin, never a frame painted on top of
/// whatever it was showing before.
const REPLAY_RESET: &str = "\x1b[0m\x1b[H\x1b[2J";
/// An OSC payload is a title or a URL, not a data stream. Capping the partial
/// sequence keeps a malformed stream from growing the parser forever.
const OSC_MAX_BYTES: usize = 4 * 1024;

/// WebSocket tickets are handed out over the authenticated feature proxy and
/// are single use; a minute is enough for the phone to open the socket.
const TICKET_TTL: Duration = Duration::from_secs(60);
/// Ticket table size. Reaching it evicts the oldest (soonest to expire)
/// instead of failing: a phone reconnecting in a loop still gets a ticket.
const MAX_TICKETS: usize = 64;

// Same frame cadence as the agent console: a full-screen TUI repaints every
// ~17 ms while animating, so an idle-gated flush would never fire.
const OUTPUT_FRAME: Duration = Duration::from_millis(16);
/// Hard cap per emit, so no single frame carries tens of thousands of escape
/// sequences.
const OUTPUT_BATCH_MAX: usize = 32 * 1024;
/// Idle wait when nothing is buffered; the next chunk wakes the thread early.
const OUTPUT_IDLE_WAIT: Duration = Duration::from_millis(250);
/// Broadcast backlog per session. A phone that falls further behind gets a
/// replay instead of a hole (see `companion::terminal`).
const OUTPUT_CHANNEL: usize = 256;

pub(crate) const OUTPUT_EVENT: &str = "terminal://output";
pub(crate) const EXIT_EVENT: &str = "terminal://exit";
pub(crate) const SESSIONS_EVENT: &str = "terminal://sessions";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// What both the tab strip and the phone list render. `exited` is `None` while
/// the shell runs, then the exit code (`-1` when the process died by signal).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMeta {
    id: String,
    title: String,
    cwd: String,
    shell: String,
    exited: Option<i32>,
}

/// One output frame handed to subscribers. No seq: the phone protocol has no
/// use for it (a replay always resets the screen), while the desktop event
/// reads the counter straight from the buffer it was recorded in.
#[derive(Clone, Debug)]
pub(crate) struct TerminalChunk {
    pub(crate) data: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CreateRequest {
    workspace_id: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Deserialize)]
struct IdRequest {
    id: String,
}

#[derive(Deserialize)]
struct InputRequest {
    id: String,
    data: String,
}

#[derive(Deserialize)]
struct ResizeRequest {
    id: String,
    cols: u16,
    rows: u16,
}

// ---------------------------------------------------------------------------
// Replay ring
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct TerminalBuffer {
    ring: String,
    seq: u64,
    /// Set once trimming dropped bytes off the front of `ring`. The tail no
    /// longer starts on a line boundary, so replays must skip ahead.
    truncated: bool,
}

impl TerminalBuffer {
    /// Appends one frame and returns the new cumulative byte count.
    ///
    /// The tail is trimmed on a char boundary: cutting mid-character would
    /// poison every later replay, and `String` cannot hold half a character.
    fn append(&mut self, data: &str) -> u64 {
        self.ring.push_str(data);
        self.seq += data.len() as u64;
        if self.ring.len() > RING_BYTES {
            let mut cut = self.ring.len() - RING_BYTES;
            while cut < self.ring.len() && !self.ring.is_char_boundary(cut) {
                cut += 1;
            }
            self.ring.drain(..cut);
            self.truncated = true;
        }
        self.seq
    }

    /// The screen a newly attached consumer should start from.
    ///
    /// Always begins with a reset + clear, so the consumer never renders on
    /// top of stale content. A trimmed ring starts mid-line (or mid escape
    /// sequence); skipping to after its first newline drops that orphaned
    /// fragment instead of painting it in the top-left corner. The result is
    /// still bounded by `RING_BYTES`, because it is a suffix of `ring`.
    fn replay(&self) -> String {
        let body = if self.truncated {
            self.ring.split_once('\n').map_or("", |(_, rest)| rest)
        } else {
            self.ring.as_str()
        };
        let mut out = String::with_capacity(REPLAY_RESET.len() + body.len());
        out.push_str(REPLAY_RESET);
        out.push_str(body);
        out
    }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/// What the tab strip calls this session and where its shell is.
///
/// Both values come from the shell itself (OSC 0/2 and OSC 7); the initial
/// values are the spawn cwd and no title. One lock covers both because a
/// single OSC sequence may update either, and readers take one consistent
/// snapshot for `TerminalMeta`.
#[derive(Debug)]
struct Identity {
    cwd: String,
    osc_title: Option<String>,
}

impl Identity {
    fn title(&self, shell: &str) -> String {
        self.osc_title
            .as_deref()
            .filter(|title| !title.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| session_title(Path::new(&self.cwd), shell))
    }
}

/// Bytes reserved in the input queue. Reservation and release are mirrored
/// around the writer thread, so the cap is a hard bound on queued bytes rather
/// than a check that a concurrent caller can race past.
#[derive(Debug, Default)]
struct InputBudget {
    queued: AtomicUsize,
}

impl InputBudget {
    /// Claims `len` bytes, or refuses when they would exceed the cap. Compare
    /// and swap in a loop so two callers cannot both pass the check.
    fn reserve(&self, len: usize) -> bool {
        self.queued
            .try_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                (queued + len <= MAX_QUEUED_INPUT_BYTES).then_some(queued + len)
            })
            .is_ok()
    }

    /// Returns bytes the writer has consumed. Saturating: a double release is
    /// a bug, but it must not wrap the counter and refuse all input forever.
    fn release(&self, len: usize) {
        let _ = self
            .queued
            .try_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                Some(queued.saturating_sub(len))
            });
    }

    fn queued(&self) -> usize {
        self.queued.load(Ordering::Acquire)
    }
}

/// One running (or finished) shell. The struct stays alive after the process
/// exits so the tab can show its exit code until the user closes it.
pub(crate) struct Session {
    id: String,
    identity: Mutex<Identity>,
    shell: String,
    app: AppHandle,
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Input goes through a queue drained by one writer thread: typing bursts
    /// arrive as one message per frame, and no async caller ever blocks on the
    /// PTY (which stalls when the shell stops consuming input).
    input: Mutex<Sender<String>>,
    /// Bytes queued but not yet written, bounded by `MAX_QUEUED_INPUT_BYTES`.
    input_budget: Arc<InputBudget>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// portable-pty starts the child in its own session, so its pid is also
    /// the process-group id used to kill the whole shell tree.
    pid: Option<u32>,
    buffer: Mutex<TerminalBuffer>,
    output: broadcast::Sender<TerminalChunk>,
    /// Set once the process is gone and `terminal://exit` has been emitted.
    closed: watch::Sender<bool>,
    exit_code: Mutex<Option<i32>>,
    /// Set by the waiter the moment `wait()` returns. `exit_code` is only
    /// written later, after the drain window, so `kill()` must not rely on it:
    /// a pid that has already been reaped may belong to another process.
    reaped: Arc<AtomicBool>,
}

impl Session {
    fn meta(&self) -> TerminalMeta {
        let identity = self.identity.lock().expect("terminal identity lock");
        TerminalMeta {
            id: self.id.clone(),
            title: identity.title(&self.shell),
            cwd: identity.cwd.clone(),
            shell: self.shell.clone(),
            exited: self.exit_code(),
        }
    }

    /// Replay tail plus a live subscription, taken together.
    ///
    /// Subscribing inside the buffer lock is what makes replay and live output
    /// disjoint: bytes already in the ring are published before this call,
    /// bytes published after it are delivered on the returned receiver.
    pub(crate) fn snapshot_and_subscribe(
        &self,
    ) -> (String, u64, broadcast::Receiver<TerminalChunk>) {
        let buffer = self.buffer.lock().expect("terminal buffer lock");
        (buffer.replay(), buffer.seq, self.output.subscribe())
    }

    pub(crate) fn snapshot(&self) -> (String, u64) {
        let buffer = self.buffer.lock().expect("terminal buffer lock");
        (buffer.replay(), buffer.seq)
    }

    /// Fires once, when the session reaches its terminal state.
    pub(crate) fn closed(&self) -> watch::Receiver<bool> {
        self.closed.subscribe()
    }

    pub(crate) fn exit_code(&self) -> Option<i32> {
        *self.exit_code.lock().expect("terminal exit code lock")
    }

    /// Queues user input for the session's writer thread. Returns as soon as the
    /// bytes are queued; a failing PTY surfaces as the process exit event.
    pub(crate) fn write(&self, data: &str) -> Result<(), String> {
        if self.exit_code().is_some() {
            return Err(tr("terminal.exited").to_string());
        }
        if data.len() > MAX_INPUT_BYTES {
            return Err(tr("terminal.inputTooLarge").to_string());
        }
        // Reserve before sending: the writer releases after each write, so the
        // counter covers exactly the bytes sitting in the channel.
        if !self.input_budget.reserve(data.len()) {
            tracing::warn!(
                id = %self.id,
                queued = self.input_budget.queued(),
                len = data.len(),
                "terminal input queue full"
            );
            return Err(tr("terminal.busy").to_string());
        }
        if self
            .input
            .lock()
            .expect("terminal input lock")
            .send(data.to_string())
            .is_err()
        {
            // The writer is gone, so this reservation would never be released.
            self.input_budget.release(data.len());
            // The writer thread only stops when the slave side is gone, which
            // is the same condition as the shell having exited.
            return Err(tr("terminal.exited").to_string());
        }
        Ok(())
    }

    pub(crate) fn resize(&self, cols: u16, rows: u16) {
        // A hidden/zero-sized panel must not shrink the PTY to nothing; the
        // next resize with a real size wins.
        if cols == 0 || rows == 0 {
            return;
        }
        let master = self.master.lock().expect("terminal master lock");
        let _ = master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }

    /// Signals the process group and the direct child, mirroring
    /// `pty_util::kill_process_group`.
    fn kill(&self) {
        // An already reaped pid may belong to another process by now; killing
        // it would signal an innocent group. `reaped` is set by the waiter the
        // instant `wait()` returns, which is earlier than `exit_code`.
        if self.reaped.load(Ordering::SeqCst) || self.exit_code().is_some() {
            return;
        }
        if let Some(pid) = self.pid {
            pty_util::kill_process_group(pid, SIGTERM);
        }
        if let Ok(mut killer) = self.killer.lock() {
            // portable-pty sends SIGHUP to the direct child on Unix.
            let _ = killer.kill();
        }
        if let Some(pid) = self.pid {
            // Own session: this also reaps grandchildren that ignore
            // SIGHUP/SIGTERM.
            pty_util::kill_process_group(pid, SIGKILL);
        }
    }
}

// ---------------------------------------------------------------------------
// Process group kill
// ---------------------------------------------------------------------------

const SIGTERM: i32 = 15;
const SIGKILL: i32 = 9;

// ---------------------------------------------------------------------------
// Output pipeline
// ---------------------------------------------------------------------------

/// Reader → writer thread messages. The exit code travels on the same channel
/// so the exit event can never overtake output that was already queued.
enum PtyMessage {
    Data(Vec<u8>),
    Exited(i32),
}

/// Reads the PTY until EOF. Reaping lives on its own thread (`spawn_waiter`),
/// so a grandchild holding the slave side open cannot keep the session alive
/// after the shell itself is gone.
fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    messages: Sender<PtyMessage>,
    id: &str,
) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name(format!("terminal-reader-{id}"))
        .spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        if messages
                            .send(PtyMessage::Data(buffer[..count].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    // A signal (SIGWINCH from a resize, SIGCHLD) may interrupt
                    // the read; that is not the shell going away.
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        })
        .map(|_| ())
}

/// Waits for the direct child and reports its exit code.
///
/// This must not wait for PTY EOF: a background grandchild can keep the slave
/// side open indefinitely, and an exited shell with a lingering tab would
/// never reach its terminal state. A failed wait still reports `UNKNOWN_EXIT`
/// because the session must always become observably closed.
fn spawn_waiter(
    mut child: Box<dyn Child + Send + Sync>,
    messages: Sender<PtyMessage>,
    id: &str,
    reaped: Arc<AtomicBool>,
) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name(format!("terminal-waiter-{id}"))
        .spawn(move || {
            let code = match child.wait() {
                Ok(status) if status.signal().is_none() => status.exit_code() as i32,
                Ok(_) => UNKNOWN_EXIT,
                Err(_) => UNKNOWN_EXIT,
            };
            // The pid is gone from here on; `kill()` must never signal it
            // again, even before the writer thread records the exit code.
            reaped.store(true, Ordering::SeqCst);
            let _ = messages.send(PtyMessage::Exited(code));
        })
        .map(|_| ())
}

/// Drains queued keystrokes into the PTY on its own thread, so callers never
/// block on a shell that has stopped reading. Bytes keep their order.
fn spawn_input_writer(
    mut writer: Box<dyn Write + Send>,
    queue: Receiver<String>,
    budget: Arc<InputBudget>,
    id: &str,
) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name(format!("terminal-input-{id}"))
        .spawn(move || {
            while let Ok(data) = queue.recv() {
                if writer.write_all(data.as_bytes()).is_err() {
                    budget.release(data.len());
                    break;
                }
                let _ = writer.flush();
                budget.release(data.len());
            }
            // Whatever is still queued will never be written; release its
            // reservation or the budget stays permanently occupied.
            while let Ok(data) = queue.try_recv() {
                budget.release(data.len());
            }
        })
        .map(|_| ())
}

/// Coalesces PTY chunks into one frame per display tick, records them and
/// emits. Also the single place that finishes a session.
fn spawn_writer(
    session: Arc<Session>,
    messages: std::sync::mpsc::Receiver<PtyMessage>,
) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name(format!("terminal-writer-{}", session.id))
        .spawn(move || {
            let mut pending: Vec<u8> = Vec::new();
            // Deadline of the frame currently being collected, if any.
            let mut deadline: Option<Instant> = None;
            // OSC sequences are split at arbitrary frame boundaries, so the
            // scanner is owned here and outlives any single flush.
            let mut osc = OscParser::default();
            // The waiter reports the shell's exit; the reader may still be
            // holding its last frame. Keep draining briefly so the final
            // prompt is not dropped, then finish even if a grandchild keeps
            // the slave side open.
            const EXIT_DRAIN: Duration = Duration::from_millis(150);
            let mut exit_code: Option<i32> = None;
            let mut exit_deadline: Option<Instant> = None;

            loop {
                // The drain window caps how long a dead shell's leftovers may
                // keep the tab open; checked before waiting so continuous
                // post-exit output cannot extend it forever.
                if exit_deadline
                    .map(|at| Instant::now() >= at)
                    .unwrap_or(false)
                {
                    flush(&session, &mut osc, &mut pending);
                    finish(&session, exit_code.unwrap_or(UNKNOWN_EXIT));
                    break;
                }
                let wait = match exit_deadline {
                    Some(at) => at
                        .saturating_duration_since(Instant::now())
                        .max(Duration::from_millis(1)),
                    None => match deadline {
                        Some(at) => at
                            .saturating_duration_since(Instant::now())
                            .max(Duration::from_millis(1)),
                        None => OUTPUT_IDLE_WAIT,
                    },
                };
                match messages.recv_timeout(wait) {
                    Ok(PtyMessage::Data(chunk)) => {
                        pending.extend_from_slice(&chunk);
                        if exit_code.is_none() && deadline.is_none() {
                            deadline = Some(Instant::now() + OUTPUT_FRAME);
                        }
                        if pending.len() >= OUTPUT_BATCH_MAX {
                            flush(&session, &mut osc, &mut pending);
                            deadline = None;
                        }
                    }
                    Ok(PtyMessage::Exited(code)) => {
                        flush(&session, &mut osc, &mut pending);
                        exit_code = Some(code);
                        exit_deadline = Some(Instant::now() + EXIT_DRAIN);
                        deadline = None;
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        // Either the frame deadline passed or the stream is
                        // idle; both mean "ship what is buffered".
                        flush(&session, &mut osc, &mut pending);
                        deadline = None;
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        // Every producer is gone: finish with the exit code we
                        // already know, or the unknown marker when the threads
                        // could not even be spawned.
                        flush(&session, &mut osc, &mut pending);
                        finish(&session, exit_code.unwrap_or(UNKNOWN_EXIT));
                        break;
                    }
                }
            }
        })
        .map(|_| ())
}

/// Publishes one decoded frame: ring first, then broadcast, then the webview.
fn flush(session: &Session, osc: &mut OscParser, pending: &mut Vec<u8>) {
    let bytes = pty_util::take_utf8_prefix(pending);
    if bytes.is_empty() {
        return;
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if text.is_empty() {
        return;
    }

    // A prompt rewriting its title/cwd must be noticed even when no one is
    // watching: the tab strip reads the identity, not the output stream.
    if let Some(change) = osc.feed(&text) {
        apply_identity(session, change);
    }

    let seq = {
        let mut buffer = session.buffer.lock().expect("terminal buffer lock");
        let seq = buffer.append(&text);
        // Sent under the buffer lock: a subscriber that snapshots between the
        // ring write and this send would otherwise replay the frame it is also
        // about to receive live.
        let _ = session.output.send(TerminalChunk { data: text.clone() });
        seq
    };

    emit_to_app(
        &session.app,
        OUTPUT_EVENT,
        json!({ "id": session.id, "data": text, "seq": seq }),
    );
}

/// Emits to app windows only. `AppHandle::emit` reaches every webview,
/// including the hidden TAPD page, whose `core:event:default` permission lets
/// any script there listen: terminal output routinely contains tokens.
fn emit_to_app<S: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    use tauri::EventTarget;
    let _ = app.emit_filter(event, payload, |target| {
        let label = match target {
            EventTarget::AnyLabel { label }
            | EventTarget::Window { label }
            | EventTarget::Webview { label }
            | EventTarget::WebviewWindow { label } => label.as_str(),
            _ => return true,
        };
        label != crate::session::SESSION_LABEL
    });
}

/// Applies one completed OSC sequence. The session list is emitted only when a
/// value actually changed: prompts rewrite the same title/cwd on every command,
/// and the tab strip must not re-render for that.
fn apply_identity(session: &Session, change: IdentityChange) {
    let changed = {
        let mut identity = session.identity.lock().expect("terminal identity lock");
        let mut changed = false;
        if let Some(title) = change.title {
            if identity.osc_title.as_deref() != Some(title.as_str()) {
                identity.osc_title = Some(title);
                changed = true;
            }
        }
        if let Some(cwd) = change.cwd {
            if identity.cwd != cwd {
                identity.cwd = cwd;
                changed = true;
            }
        }
        changed
    };
    // Release the identity lock before touching the core: `list()` takes the
    // sessions lock and then each identity, so nesting them the other way
    // would deadlock.
    if changed {
        emit_sessions(&session.app);
    }
}

/// Moves the session to its terminal state exactly once.
fn finish(session: &Session, code: i32) {
    {
        // Terminal state must not regress: a late signal/handle must never
        // overwrite the first exit code.
        let mut exit = session.exit_code.lock().expect("terminal exit code lock");
        if exit.is_some() {
            return;
        }
        *exit = Some(code);
    }
    emit_to_app(
        &session.app,
        EXIT_EVENT,
        json!({ "id": session.id, "code": code }),
    );
    emit_sessions(&session.app);
    // `send` refuses to store the value when no one is listening yet; a phone
    // attaching after the exit must still see the closed state.
    session.closed.send_replace(true);
}

/// Pushes the full session list to the desktop tab strip and the phone list.
fn emit_sessions(app: &AppHandle) {
    if let Some(core) = app.try_state::<Arc<TerminalCore>>() {
        let sessions = core.list();
        emit_to_app(app, SESSIONS_EVENT, json!({ "sessions": sessions }));
    }
}

// ---------------------------------------------------------------------------
// OSC identity parser
// ---------------------------------------------------------------------------

/// What one completed OSC sequence asks the tab label/cwd to become. `None`
/// means "this sequence says nothing about that field".
#[derive(Debug, Default, PartialEq, Eq)]
struct IdentityChange {
    title: Option<String>,
    cwd: Option<String>,
}

impl IdentityChange {
    fn merge(&mut self, next: Self) {
        if next.title.is_some() {
            self.title = next.title;
        }
        if next.cwd.is_some() {
            self.cwd = next.cwd;
        }
    }
}

#[derive(Debug, Default)]
enum OscState {
    #[default]
    Ground,
    /// Saw ESC, waiting to see whether this is the `]` introducer.
    Escape,
    /// Inside an OSC payload.
    Osc,
    /// Saw ESC inside the payload, possibly the first byte of ST (`ESC \\`).
    OscEscape,
}

/// Incremental OSC scanner.
///
/// Decoded PTY chunks split at arbitrary boundaries, so a sequence may start in
/// one `flush` and end in the next; state and payload persist across calls.
/// Only the sequences the tab strip needs are interpreted: OSC 0/2 (title) and
/// OSC 7 (cwd). Anything else is consumed and dropped.
#[derive(Debug, Default)]
struct OscParser {
    state: OscState,
    payload: String,
}

impl OscParser {
    /// Consumes `text` and returns the accumulated effect of every sequence
    /// completed by it. The newest title/cwd wins, matching terminal semantics.
    fn feed(&mut self, text: &str) -> Option<IdentityChange> {
        let mut change: Option<IdentityChange> = None;
        for ch in text.chars() {
            match self.state {
                OscState::Ground => {
                    if ch == '\x1b' {
                        self.state = OscState::Escape;
                    }
                }
                OscState::Escape => {
                    self.state = match ch {
                        ']' => {
                            self.payload.clear();
                            OscState::Osc
                        }
                        // A second ESC just restarts the wait for the
                        // introducer; it is not data.
                        '\x1b' => OscState::Escape,
                        _ => OscState::Ground,
                    };
                }
                OscState::Osc => match ch {
                    '\x07' => {
                        finish_osc(&mut self.payload, &mut change);
                        self.state = OscState::Ground;
                    }
                    '\x1b' => self.state = OscState::OscEscape,
                    _ => self.push(ch),
                },
                OscState::OscEscape => match ch {
                    '\\' => {
                        finish_osc(&mut self.payload, &mut change);
                        self.state = OscState::Ground;
                    }
                    // Not ST after all: the sequence is malformed. Drop it and
                    // rescan from ground, so a valid sequence after the stray
                    // ESC still works.
                    _ => {
                        self.payload.clear();
                        self.state = OscState::Ground;
                    }
                },
            }
        }
        change
    }

    fn push(&mut self, ch: char) {
        if self.payload.len() + ch.len_utf8() > OSC_MAX_BYTES {
            // A real title/URL never gets this large. Discard the partial
            // sequence and resync at ground; its terminator is then just
            // ignored text.
            self.payload.clear();
            self.state = OscState::Ground;
            return;
        }
        self.payload.push(ch);
    }
}

fn finish_osc(payload: &mut String, change: &mut Option<IdentityChange>) {
    if let Some(next) = parse_osc(payload) {
        change
            .get_or_insert_with(IdentityChange::default)
            .merge(next);
    }
    payload.clear();
}

/// Interprets a completed OSC payload (`code;argument`).
fn parse_osc(payload: &str) -> Option<IdentityChange> {
    let (code, argument) = payload.split_once(';')?;
    match code {
        // OSC 0 and 2 both set the window/terminal title.
        "0" | "2" if !argument.is_empty() => Some(IdentityChange {
            title: Some(argument.to_string()),
            cwd: None,
        }),
        // OSC 7 is `file://host/path`. The host is ignored (the shell is
        // always local) and the path is percent-decoded like a URL path.
        "7" => {
            let authority_and_path = argument.strip_prefix("file://")?;
            let (_, path) = authority_and_path.split_once('/')?;
            let decoded = percent_encoding::percent_decode_str(&format!("/{path}"))
                .decode_utf8()
                .ok()?
                .into_owned();
            Some(IdentityChange {
                title: None,
                cwd: Some(decoded),
            })
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// One-shot WebSocket tickets
// ---------------------------------------------------------------------------

/// A single-use, short-lived credential for attaching the phone socket. The
/// phone gets it over the authenticated feature proxy, so a session id in a
/// WebSocket URL never doubles as a bearer token that lives in browser history
/// and server logs.
#[derive(Debug)]
struct Ticket {
    session_id: String,
    expires_at: Instant,
}

impl Ticket {
    fn valid_at(&self, now: Instant, session_id: &str) -> bool {
        self.session_id == session_id && now < self.expires_at
    }
}

/// The ticket table, kept separate from `TerminalCore` so expiry and capacity
/// are testable with an injected clock instead of a real `AppHandle`.
#[derive(Debug, Default)]
struct TicketBook {
    tickets: HashMap<String, Ticket>,
}

impl TicketBook {
    /// Issues a ticket and keeps the table bounded. A full table evicts the
    /// oldest ticket instead of refusing: a phone reconnecting in a loop must
    /// still be able to attach, and eviction can only invalidate a ticket the
    /// holder never used within a minute.
    fn issue(&mut self, session_id: &str, now: Instant) -> String {
        self.purge(now);
        while self.tickets.len() >= MAX_TICKETS {
            let oldest = self
                .tickets
                .iter()
                .min_by_key(|(_, ticket)| ticket.expires_at)
                .map(|(key, _)| key.clone());
            match oldest {
                Some(key) => {
                    self.tickets.remove(&key);
                }
                // Cannot happen with a non-zero cap, but avoid spinning.
                None => break,
            }
        }
        let ticket = uuid::Uuid::new_v4().simple().to_string();
        self.tickets.insert(
            ticket.clone(),
            Ticket {
                session_id: session_id.to_string(),
                expires_at: now + TICKET_TTL,
            },
        );
        ticket
    }

    /// Uses a ticket exactly once. Removal happens before validation, so a
    /// wrong session id or a stale ticket is burned rather than left for a
    /// second guess; a legitimate holder can always request a fresh one.
    fn consume(&mut self, ticket: &str, session_id: &str, now: Instant) -> bool {
        match self.tickets.remove(ticket) {
            Some(entry) => entry.valid_at(now, session_id),
            None => false,
        }
    }

    fn purge(&mut self, now: Instant) {
        self.tickets.retain(|_, ticket| now < ticket.expires_at);
    }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/// Capacity rule, pure so it is testable: exited sessions occupy a tab but no
/// process, so they can be reclaimed before the limit is enforced.
fn capacity_after_reclaim(total: usize, exited: usize) -> bool {
    has_capacity(total.saturating_sub(exited))
}

pub struct TerminalCore {
    app: AppHandle,
    sessions: Mutex<Vec<Arc<Session>>>,
    tickets: Mutex<TicketBook>,
}

impl TerminalCore {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
            sessions: Mutex::new(Vec::new()),
            tickets: Mutex::new(TicketBook::default()),
        }
    }

    fn list(&self) -> Vec<TerminalMeta> {
        self.sessions
            .lock()
            .expect("terminal sessions lock")
            .iter()
            .map(|session| session.meta())
            .collect()
    }

    /// One session by id; the phone attach path and every per-session command
    /// go through here.
    pub(crate) fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .expect("terminal sessions lock")
            .iter()
            .find(|session| session.id == id)
            .cloned()
    }

    /// Spawns a shell. Reclaiming exited sessions, the capacity check and the
    /// push share one critical section, so concurrent creates cannot exceed the
    /// limit and cannot both reclaim the same tab.
    fn create(&self, request: CreateRequest) -> Result<TerminalMeta, String> {
        let mut sessions = self.sessions.lock().expect("terminal sessions lock");
        // Exited sessions have no process left; their tab is the only thing
        // occupying a slot. Pure removal, never a kill: the pid may already
        // belong to an unrelated process. Only reclaim when the limit is
        // actually reached — opening a terminal must not clear dead tabs that
        // the user may still want to read.
        let exited = if has_capacity(sessions.len()) {
            0
        } else {
            sessions
                .iter()
                .filter(|session| session.exit_code().is_some())
                .count()
        };
        let fits = capacity_after_reclaim(sessions.len(), exited);
        if exited > 0 {
            sessions.retain(|session| session.exit_code().is_none());
        }
        if !fits {
            drop(sessions);
            // Reclaiming already happened, so a tab strip that missed the
            // individual exit events must still see the removal.
            if exited > 0 {
                emit_sessions(&self.app);
            }
            return Err(tr_args("terminal.limit", &[&MAX_SESSIONS]));
        }
        let cwd = session_cwd(
            &self.app,
            request.workspace_id.as_deref(),
            request.cwd.as_deref(),
        );
        let spawned = spawn_session(&self.app, session_shell(), cwd, request.cols, request.rows);
        match spawned {
            Ok(session) => {
                let meta = session.meta();
                sessions.push(session);
                drop(sessions);
                emit_sessions(&self.app);
                Ok(meta)
            }
            Err(error) => {
                drop(sessions);
                if exited > 0 {
                    emit_sessions(&self.app);
                }
                Err(error)
            }
        }
    }

    /// Issues a single-use ticket for attaching a session socket.
    ///
    /// The session is deliberately not checked here: a stale page must reach
    /// the socket, where a missing session is reported as a readable
    /// `not_found` frame and the phone can show "terminal ended". A ticket for
    /// a dead id is harmless — it expires in a minute and is burned by the
    /// single upgrade attempt.
    pub(crate) fn issue_ticket(&self, session_id: &str) -> String {
        let mut tickets = self.tickets.lock().expect("terminal tickets lock");
        tickets.issue(session_id, Instant::now())
    }

    /// Validates and burns a ticket. Returns `false` for unknown, expired or
    /// session-mismatched tickets; the caller reports one generic error so a
    /// prober learns nothing about which check failed.
    pub(crate) fn consume_ticket(&self, ticket: &str, session_id: &str) -> bool {
        self.tickets.lock().expect("terminal tickets lock").consume(
            ticket,
            session_id,
            Instant::now(),
        )
    }

    /// Removes the session from the list and kills it. A finished shell is
    /// simply forgotten; a running one is stopped and reports its exit later.
    fn close(&self, id: &str) -> Result<(), String> {
        let session = {
            let mut sessions = self.sessions.lock().expect("terminal sessions lock");
            let index = sessions
                .iter()
                .position(|session| session.id == id)
                .ok_or_else(|| tr("terminal.notFound").to_string())?;
            sessions.remove(index)
        };
        session.kill();
        emit_sessions(&self.app);
        Ok(())
    }

    /// App exit: no shell may outlive the process.
    fn shutdown(&self) {
        let sessions = {
            let mut guard = self.sessions.lock().expect("terminal sessions lock");
            std::mem::take(&mut *guard)
        };
        for session in &sessions {
            session.kill();
        }
    }
}

/// Tauri setup hook: registers the core the command surface looks up.
pub fn init(app: &AppHandle) {
    let core = Arc::new(TerminalCore::new(app.clone()));
    app.manage(core);
}

/// App exit hook: kills every shell. Called from `RunEvent::Exit`.
pub fn shutdown(app: &AppHandle) {
    if let Some(core) = app.try_state::<Arc<TerminalCore>>() {
        core.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Session construction
// ---------------------------------------------------------------------------

fn create_error(error: impl std::fmt::Display) -> String {
    tr_args("terminal.createFailed", &[&error])
}

fn spawn_session(
    app: &AppHandle,
    shell: String,
    cwd: PathBuf,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<Arc<Session>, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.filter(|rows| *rows > 0).unwrap_or(DEFAULT_ROWS),
            cols: cols.filter(|cols| *cols > 0).unwrap_or(DEFAULT_COLS),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(create_error)?;

    let mut command = CommandBuilder::new(&shell);
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    // Finder-launched apps inherit a minimal PATH; the shell must see the same
    // tools the rest of the app does.
    command.env("PATH", shell_path::user_path());

    let child = pair.slave.spawn_command(command).map_err(create_error)?;
    drop(pair.slave);
    let master = pair.master;
    let reader = master.try_clone_reader().map_err(create_error)?;
    let writer = master.take_writer().map_err(create_error)?;

    let id = uuid::Uuid::new_v4().simple().to_string();
    let (output, _) = broadcast::channel(OUTPUT_CHANNEL);
    let (closed, _) = watch::channel(false);
    let (input, input_queue) = mpsc::channel::<String>();
    let input_budget = Arc::new(InputBudget::default());
    let reaped = Arc::new(AtomicBool::new(false));
    let session = Arc::new(Session {
        identity: Mutex::new(Identity {
            cwd: cwd.display().to_string(),
            osc_title: None,
        }),
        shell,
        app: app.clone(),
        master: Mutex::new(master),
        input: Mutex::new(input),
        input_budget: input_budget.clone(),
        killer: Mutex::new(child.clone_killer()),
        pid: child.process_id(),
        buffer: Mutex::new(TerminalBuffer::default()),
        output,
        closed,
        exit_code: Mutex::new(None),
        reaped: reaped.clone(),
        id: id.clone(),
    });

    let (messages, receiver) = std::sync::mpsc::channel();
    // A thread that cannot start must not leave an unowned shell behind.
    if let Err(error) = spawn_reader(reader, messages.clone(), &id) {
        session.kill();
        return Err(create_error(error));
    }
    if let Err(error) = spawn_waiter(child, messages, &id, reaped) {
        session.kill();
        return Err(create_error(error));
    }
    if let Err(error) = spawn_input_writer(writer, input_queue, input_budget, &id) {
        session.kill();
        return Err(create_error(error));
    }
    if let Err(error) = spawn_writer(session.clone(), receiver) {
        session.kill();
        return Err(create_error(error));
    }
    Ok(session)
}

/// Tab label fallback when the shell has not set an OSC title: the working
/// directory's name tells two shells apart, and the shell name covers a cwd
/// with no name (e.g. `/`). OSC titles replace this once they arrive.
fn session_title(cwd: &Path, shell: &str) -> String {
    cwd.file_name()
        .or_else(|| Path::new(shell).file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| shell.to_string())
}

/// `$SHELL` when it is an executable, else the platform default: the terminal
/// should feel like the user's own login shell.
fn session_shell() -> String {
    std::env::var_os("SHELL")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| shell_path::is_executable(path))
        .and_then(|path| path.to_str().map(str::to_string))
        .unwrap_or_else(|| shell_path::default_shell().to_string_lossy().into_owned())
}

/// Working directory for a new session: explicit path, then the TAPD
/// workspace's configured folder, then a local project with the same id, then
/// home.
fn session_cwd(app: &AppHandle, workspace_id: Option<&str>, explicit: Option<&str>) -> PathBuf {
    let explicit = real_dir(explicit.map(Path::new));
    let project = workspace_id.and_then(|workspace_id| {
        let repo_path = agent_settings::mcp_agent_config(app)
            .projects
            .get(workspace_id)?
            .repo_path
            .clone();
        real_dir(Some(Path::new(&repo_path)))
    });
    let project = project.or_else(|| workspace_id.and_then(|id| local_repo_dir(app, id)));
    let home = tapd_core::paths::home_dir().ok();
    pick_cwd(explicit, project, real_dir(home.as_deref()))
}

/// Local project folder for an id; no TAPD workspace folder needed. Missing
/// state or a disabled local store contributes no fallback.
fn local_repo_dir(app: &AppHandle, workspace_id: &str) -> Option<PathBuf> {
    let state = app.try_state::<crate::state::SharedState>()?;
    let repo_path = state.local.repo_path(workspace_id)?;
    real_dir(Some(Path::new(&repo_path)))
}

/// Precedence rule, pure so it is testable without a PTY: explicit path, then
/// the workspace's project repo, then home, then the filesystem root — a shell
/// always needs *some* directory.
fn pick_cwd(explicit: Option<PathBuf>, project: Option<PathBuf>, home: Option<PathBuf>) -> PathBuf {
    explicit
        .or(project)
        .or(home)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// A candidate directory, canonicalized so `cwd` is always absolute. A path
/// that is not a directory is skipped, letting the next candidate win.
fn real_dir(path: Option<&Path>) -> Option<PathBuf> {
    path.filter(|path| path.is_dir())
        .and_then(|path| path.canonicalize().ok())
}

fn has_capacity(count: usize) -> bool {
    count < MAX_SESSIONS
}

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

pub async fn command(app: &AppHandle, name: &str, payload: Value) -> Result<Value, String> {
    // `init` runs in the setup hook before any window exists, so a missing core
    // is a wiring bug, not a state the UI can recover from.
    let core = app
        .try_state::<Arc<TerminalCore>>()
        .expect("terminal::init must run during setup")
        .inner()
        .clone();

    match name {
        "terminal_create" => {
            let request: CreateRequest = serde_json::from_value(payload)
                .map_err(|error| tr_args("terminal.createFailed", &[&error]))?;
            // fork/exec blocks; keep it off the async runtime threads.
            let spawner = core.clone();
            let meta = tokio::task::spawn_blocking(move || spawner.create(request))
                .await
                .map_err(|error| tr_args("terminal.createFailed", &[&error]))??;
            Ok(json!({ "session": meta }))
        }
        "terminal_list" => Ok(json!({ "sessions": core.list() })),
        "terminal_input" => {
            let request: InputRequest = parse_request(payload)?;
            let session = core
                .session(&request.id)
                .ok_or_else(|| tr("terminal.notFound").to_string())?;
            // Queueing is instant; the session's writer thread does the PTY IO.
            session.write(&request.data)?;
            Ok(Value::Null)
        }
        "terminal_resize" => {
            let request: ResizeRequest = parse_request(payload)?;
            let session = core
                .session(&request.id)
                .ok_or_else(|| tr("terminal.notFound").to_string())?;
            session.resize(request.cols, request.rows);
            Ok(Value::Null)
        }
        "terminal_close" => {
            let request: IdRequest = parse_request(payload)?;
            core.close(&request.id)?;
            Ok(Value::Null)
        }
        "terminal_replay" => {
            let request: IdRequest = parse_request(payload)?;
            let session = core
                .session(&request.id)
                .ok_or_else(|| tr("terminal.notFound").to_string())?;
            let (data, seq) = session.snapshot();
            Ok(json!({ "data": data, "seq": seq }))
        }
        "terminal_ticket" => {
            let request: IdRequest = parse_request(payload)?;
            let ticket = core.issue_ticket(&request.id);
            Ok(json!({ "ticket": ticket }))
        }
        other => Err(format!("unknown terminal command: {other}")),
    }
}

/// Payloads the frontend owns; a shape mismatch is a programming error, so the
/// serde text is diagnostic (same policy as the unknown-command error).
fn parse_request<T: serde::de::DeserializeOwned>(payload: Value) -> Result<T, String> {
    serde_json::from_value(payload).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_a_valid_utf8_tail_under_the_limit() {
        let mut buffer = TerminalBuffer::default();
        // Exceeds the cap mid-character: trimming must skip to the next char
        // boundary instead of leaving half a code point.
        let chunk = "中".repeat(RING_BYTES / 3 + 1);

        buffer.append(&chunk);

        assert!(buffer.ring.len() <= RING_BYTES);
        assert!(!buffer.ring.is_empty());
        assert!(buffer.ring.chars().all(|c| c == '中'));
        assert_eq!(buffer.ring.len() % '中'.len_utf8(), 0);
        assert_eq!(buffer.seq, chunk.len() as u64);
    }

    #[test]
    fn ring_trim_drops_the_oldest_bytes_only() {
        let mut buffer = TerminalBuffer::default();

        buffer.append(&"a".repeat(RING_BYTES));
        buffer.append("tail");

        assert!(buffer.ring.len() <= RING_BYTES);
        assert!(buffer.ring.ends_with("tail"));
    }

    #[test]
    fn cwd_precedence_is_explicit_project_home_root() {
        let explicit = Some(PathBuf::from("/explicit"));
        let project = Some(PathBuf::from("/project"));
        let home = Some(PathBuf::from("/home"));

        assert_eq!(
            pick_cwd(explicit.clone(), project.clone(), home.clone()),
            PathBuf::from("/explicit")
        );
        assert_eq!(
            pick_cwd(None, project.clone(), home.clone()),
            PathBuf::from("/project")
        );
        assert_eq!(pick_cwd(None, None, home), PathBuf::from("/home"));
        assert_eq!(pick_cwd(None, None, None), PathBuf::from("/"));
    }

    #[test]
    fn session_title_prefers_the_working_directory_name() {
        assert_eq!(
            session_title(Path::new("/Users/me/project"), "/bin/zsh"),
            "project"
        );
        // A cwd with no name falls back to the shell, never to an empty tab.
        assert_eq!(session_title(Path::new("/"), "/bin/zsh"), "zsh");
    }

    #[test]
    fn session_limit_rejects_the_ninth_terminal() {
        assert!(has_capacity(0));
        assert!(has_capacity(MAX_SESSIONS - 1));
        assert!(!has_capacity(MAX_SESSIONS));
        assert!(!has_capacity(MAX_SESSIONS + 1));
    }

    #[test]
    fn seq_counts_bytes_monotonically() {
        let mut buffer = TerminalBuffer::default();

        assert_eq!(buffer.append("a"), 1);
        assert_eq!(buffer.append("中"), 4);
        assert_eq!(buffer.append("bc"), 6);
        assert_eq!(buffer.seq, 6);
    }

    #[test]
    fn replay_keeps_the_beginning_when_nothing_was_trimmed() {
        let mut buffer = TerminalBuffer::default();

        buffer.append("hello\nworld");

        assert!(!buffer.truncated);
        assert_eq!(buffer.replay(), format!("{REPLAY_RESET}hello\nworld"));
    }

    #[test]
    fn replay_starts_with_a_clear_and_a_whole_line_after_trimming() {
        let mut buffer = TerminalBuffer::default();
        // Comfortably over the ring cap, so the tail starts mid-line.
        for index in 0..30_000 {
            buffer.append(&format!("line-{index:05}\r\n"));
        }

        let replay = buffer.replay();

        assert!(buffer.truncated);
        assert!(replay.starts_with(REPLAY_RESET));
        let body = &replay[REPLAY_RESET.len()..];
        assert!(
            body.starts_with("line-"),
            "starts mid-line: {:?}",
            &body[..20.min(body.len())]
        );
        assert!(body.contains("line-29999"));
        assert!(replay.len() <= REPLAY_RESET.len() + RING_BYTES);
    }

    #[test]
    fn replay_drops_a_trimmed_tail_without_a_newline() {
        let mut buffer = TerminalBuffer::default();

        buffer.append(&"x".repeat(RING_BYTES + 1));

        assert!(buffer.truncated);
        // Only the clear survives: there is no line boundary to resume from.
        assert_eq!(buffer.replay(), REPLAY_RESET);
    }

    #[test]
    fn input_budget_accepts_up_to_the_cap_and_refuses_the_next_byte() {
        let budget = InputBudget::default();

        assert!(budget.reserve(MAX_QUEUED_INPUT_BYTES));
        assert_eq!(budget.queued(), MAX_QUEUED_INPUT_BYTES);
        assert!(!budget.reserve(1));
        assert_eq!(budget.queued(), MAX_QUEUED_INPUT_BYTES);

        budget.release(MAX_QUEUED_INPUT_BYTES);
        assert_eq!(budget.queued(), 0);
        assert!(budget.reserve(1));
    }

    #[test]
    fn input_budget_release_saturates() {
        let budget = InputBudget::default();

        budget.release(1024);

        assert_eq!(budget.queued(), 0);
    }

    #[test]
    fn concurrent_input_reservations_stop_exactly_at_the_cap() {
        let budget = Arc::new(InputBudget::default());
        let accepted = Arc::new(AtomicUsize::new(0));
        let chunk = 64;
        let attempts = MAX_QUEUED_INPUT_BYTES / chunk;

        let threads: Vec<_> = (0..8)
            .map(|_| {
                let budget = budget.clone();
                let accepted = accepted.clone();
                std::thread::spawn(move || {
                    for _ in 0..attempts {
                        if budget.reserve(chunk) {
                            accepted.fetch_add(chunk, Ordering::Relaxed);
                        }
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().expect("reservation thread");
        }

        assert_eq!(budget.queued(), MAX_QUEUED_INPUT_BYTES);
        assert_eq!(accepted.load(Ordering::Relaxed), MAX_QUEUED_INPUT_BYTES);
    }

    #[test]
    fn capacity_counts_only_sessions_whose_process_is_alive() {
        assert!(capacity_after_reclaim(0, 0));
        assert!(capacity_after_reclaim(7, 0));
        assert!(!capacity_after_reclaim(MAX_SESSIONS, 0));
        // A full list still accepts a session once an exited one is dropped.
        assert!(capacity_after_reclaim(MAX_SESSIONS, 1));
        assert!(capacity_after_reclaim(MAX_SESSIONS, MAX_SESSIONS));
        assert!(!capacity_after_reclaim(MAX_SESSIONS + 1, 1));
        // More exited sessions than total cannot make the live count wrap.
        assert!(capacity_after_reclaim(3, 5));
    }

    #[test]
    fn identity_title_prefers_osc_then_the_cwd_name() {
        let mut identity = Identity {
            cwd: "/Users/me/project".to_string(),
            osc_title: None,
        };
        assert_eq!(identity.title("/bin/zsh"), "project");

        identity.osc_title = Some("shell title".to_string());
        assert_eq!(identity.title("/bin/zsh"), "shell title");

        // An empty OSC title is not a title; the cwd name stays.
        identity.osc_title = Some(String::new());
        assert_eq!(identity.title("/bin/zsh"), "project");
    }

    #[test]
    fn osc_title_is_read_from_bel_and_st_terminators() {
        let mut parser = OscParser::default();

        assert_eq!(
            parser.feed("before\x1b]0;first title\x07after"),
            Some(IdentityChange {
                title: Some("first title".to_string()),
                cwd: None,
            })
        );
        assert_eq!(
            parser.feed("\x1b]2;second\x1b\\"),
            Some(IdentityChange {
                title: Some("second".to_string()),
                cwd: None,
            })
        );
    }

    #[test]
    fn osc_parser_keeps_state_across_split_feeds() {
        let mut parser = OscParser::default();

        assert_eq!(parser.feed("noise\x1b]0;half"), None);
        assert_eq!(
            parser.feed(" title\x07tail"),
            Some(IdentityChange {
                title: Some("half title".to_string()),
                cwd: None,
            })
        );
    }

    #[test]
    fn osc_seven_decodes_the_cwd_and_ignores_other_sequences() {
        let mut parser = OscParser::default();
        assert_eq!(parser.feed("\x1b]8;;https://example.com\x07"), None);
        assert_eq!(parser.feed("\x1b]0\x07"), None);

        let change = parser
            .feed("\x1b]7;file://myhost/Users/me/My%20Repo\x07")
            .expect("cwd change");
        assert_eq!(change.cwd.as_deref(), Some("/Users/me/My Repo"));
        assert!(change.title.is_none());
    }

    #[test]
    fn oversized_osc_payload_is_dropped_and_the_parser_resyncs() {
        let mut parser = OscParser::default();
        let oversized = format!("\x1b]0;{}\x07", "a".repeat(OSC_MAX_BYTES + 1));

        assert_eq!(parser.feed(&oversized), None);
        assert!(parser.payload.is_empty());

        let change = parser.feed("\x1b]0;ok\x07").expect("title change");
        assert_eq!(change.title.as_deref(), Some("ok"));
    }

    #[test]
    fn ticket_is_single_use_and_bound_to_its_session() {
        let mut book = TicketBook::default();
        let now = Instant::now();

        let ticket = book.issue("s1", now);
        assert!(!book.consume(&ticket, "s2", now));
        // The mismatch burned the ticket; it cannot be retried.
        assert!(!book.consume(&ticket, "s1", now));

        let ticket = book.issue("s1", now);
        assert!(book.consume(&ticket, "s1", now));
        assert!(!book.consume(&ticket, "s1", now));
    }

    #[test]
    fn ticket_expires_after_its_ttl() {
        let mut book = TicketBook::default();
        let now = Instant::now();

        let ticket = book.issue("s1", now);
        assert!(book.consume(&ticket, "s1", now + TICKET_TTL - Duration::from_millis(1)));

        let ticket = book.issue("s1", now);
        assert!(!book.consume(&ticket, "s1", now + TICKET_TTL + Duration::from_millis(1)));
    }

    #[test]
    fn full_ticket_table_evicts_the_oldest_instead_of_refusing() {
        let mut book = TicketBook::default();
        let start = Instant::now();
        let tickets: Vec<String> = (0..=MAX_TICKETS)
            .map(|index| book.issue("s1", start + Duration::from_millis(index as u64)))
            .collect();

        assert_eq!(book.tickets.len(), MAX_TICKETS);
        // The first ticket had the earliest expiry and was evicted.
        assert!(!book.consume(&tickets[0], "s1", start));
        assert!(book.consume(&tickets[1], "s1", start));
    }

    #[test]
    fn issuing_a_ticket_purges_expired_entries_first() {
        let mut book = TicketBook::default();
        let start = Instant::now();

        let ticket = book.issue("s1", start);
        book.issue("s1", start + TICKET_TTL + Duration::from_secs(1));

        // The stale entry is gone, and the fresh one is the only ticket left.
        assert_eq!(book.tickets.len(), 1);
        assert!(!book.consume(&ticket, "s1", start + TICKET_TTL + Duration::from_secs(2)));
    }
}
