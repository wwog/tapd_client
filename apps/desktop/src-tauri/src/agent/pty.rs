//! PTY runtime: spawn the TUI, batch output, and apply the finish outcome.

use tapd_i18n::{tr, tr_args};

use super::*;

pub(super) struct PtyHandles {
    pub(super) master: Box<dyn MasterPty + Send>,
    pub(super) writer: Box<dyn Write + Send>,
    pub(super) reader: Box<dyn Read + Send>,
    pub(super) child: Box<dyn Child + Send + Sync>,
}

pub(super) fn open_pty(
    binary: &str,
    args: &[String],
    envs: &[(String, String)],
    cwd: &Path,
    cols: u16,
    rows: u16,
) -> Result<PtyHandles, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;

    let mut command = CommandBuilder::new(binary);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    // Finder-launched apps inherit a minimal PATH; hand the TUI (and whatever
    // it shells out to) the user's shell PATH instead.
    command.env("PATH", shell_path::user_path());
    for arg in args {
        command.arg(arg);
    }
    for (key, value) in envs {
        command.env(key, value);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);
    let master = pair.master;
    let reader = master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = master.take_writer().map_err(|error| error.to_string())?;

    Ok(PtyHandles {
        master,
        writer,
        reader,
        child,
    })
}

const SIGTERM: i32 = 15;
const SIGKILL: i32 = 9;

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

/// Signals a whole process group. The TUI is spawned through portable-pty,
/// which puts it in its own session, so its pid is also the group id.
pub(crate) fn kill_process_group(pid: u32, signal: i32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: plain syscall wrapper, no memory is shared.
    unsafe { kill(-(pid as i32), signal) == 0 }
}

#[cfg(not(unix))]
pub(crate) fn kill_process_group(_pid: u32, _signal: i32) -> bool {
    false
}

/// One write for the PTY writer thread. The optional ack carries the result
/// back to a blocking caller (the startup prompt injection).
pub(super) enum PtyInput {
    Data(
        Vec<u8>,
        Option<std::sync::mpsc::SyncSender<Result<(), String>>>,
    ),
}

pub(super) struct AgentRuntime {
    pub(super) master: Box<dyn MasterPty + Send>,
    /// All writes go through one thread: `write_all` blocks when the TUI stops
    /// reading, which must never happen on a tokio worker (keystrokes arrive
    /// from async commands) and must not interleave with the prompt injection.
    input: Arc<std::sync::mpsc::SyncSender<PtyInput>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// The TUI is started with `setsid`, so its pid is also the process-group
    /// id used to kill the whole TUI tree.
    pid: Option<u32>,
    pub(super) canceled: Arc<AtomicBool>,
}

impl AgentRuntime {
    /// A sender that can be used without holding the runtime lock. The startup
    /// prompt injection clones it so a stalled TUI never blocks `input` calls.
    pub(super) fn input_sender(&self) -> Arc<std::sync::mpsc::SyncSender<PtyInput>> {
        self.input.clone()
    }

    /// Hands input to the writer thread without ever blocking the caller.
    pub(super) fn try_write(&self, data: &[u8]) -> Result<(), String> {
        self.input
            .try_send(PtyInput::Data(data.to_vec(), None))
            .map_err(|error| match error {
                std::sync::mpsc::TrySendError::Full(_) => {
                    tr("agent.pty.input.busy").to_string()
                }
                std::sync::mpsc::TrySendError::Disconnected(_) => {
                    tr("agent.task.not.running").to_string()
                }
            })
    }

    /// Signals the TUI process group and the direct child.
    pub(super) fn kill(&mut self) {
        if let Some(pid) = self.pid {
            kill_process_group(pid, SIGTERM);
        }
        // portable-pty sends SIGHUP to the direct child on Unix.
        let _ = self.killer.kill();
        if let Some(pid) = self.pid {
            // The TUI is in its own session, so this also reaps grandchildren
            // (MCP servers, tool subprocesses) that ignore SIGHUP/SIGTERM.
            kill_process_group(pid, SIGKILL);
        }
    }
}

/// Blocking write used by the startup prompt injection (already on the PTY
/// thread). Waits for the writer thread's result without holding any lock.
pub(super) fn write_blocking(
    input: &std::sync::mpsc::SyncSender<PtyInput>,
    data: &[u8],
) -> Result<(), String> {
    let (ack, result) = std::sync::mpsc::sync_channel(1);
    input
        .try_send(PtyInput::Data(data.to_vec(), Some(ack)))
        .map_err(|_| tr("agent.pty.input.busy").to_string())?;
    result
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| tr("agent.pty.input.busy").to_string())?
}

#[derive(Debug, Default)]
pub(super) struct PtyOutcome {
    pub(super) exit_code: Option<i32>,
    pub(super) canceled: bool,
    /// The turn was ended by the client (session hook settle or idle fallback)
    /// instead of the TUI exiting on its own.
    pub(super) completed: bool,
    pub(super) warning: Option<String>,
    pub(super) error: Option<String>,
}

/// Tracks whether the initial prompt has been written to the TUI.
#[derive(Debug, Default)]
pub(super) struct PromptGuard {
    injected: AtomicBool,
}

impl PromptGuard {
    fn mark_injected(&self) {
        self.injected.store(true, Ordering::SeqCst);
    }

    fn injected(&self) -> bool {
        self.injected.load(Ordering::SeqCst)
    }
}

/// Takes the longest complete UTF-8 prefix out of `buffer` and keeps an
/// incomplete trailing sequence for the next batch.
///
/// PTY reads are chunked, so a multi-byte character (e.g. Chinese text in the
/// TUI) can be split in half. Decoding such a batch used to surface as U+FFFD
/// in the terminal, which looked like corrupted output.
pub(crate) fn take_utf8_prefix(buffer: &mut Vec<u8>) -> Vec<u8> {
    let cut = match std::str::from_utf8(buffer) {
        Ok(_) => buffer.len(),
        Err(error) => {
            let valid = error.valid_up_to();
            if error.error_len().is_some() {
                // A genuinely invalid byte would block the buffer forever;
                // emit it (the terminal shows U+FFFD) and keep going.
                valid.max(1)
            } else {
                valid
            }
        }
    };
    if cut == 0 {
        return Vec::new();
    }
    let rest = buffer.split_off(cut);
    std::mem::replace(buffer, rest)
}

/// Output is flushed on a display-frame cadence, not when the stream goes
/// quiet. A full-screen TUI repaints every ~17 ms while it animates, so an
/// idle-gated flush never fires and seconds of output pile up in memory before
/// the console sees the first byte — that is what made typing feel dead.
const OUTPUT_FRAME: Duration = Duration::from_millis(16);
/// Hard cap per emit, so the terminal never parses tens of thousands of escape
/// sequences in a single write.
const OUTPUT_BATCH_MAX: usize = 32 * 1024;
/// Idle wait when nothing is buffered; the next chunk wakes the thread early.
const OUTPUT_IDLE_WAIT: Duration = Duration::from_millis(250);

/// Ships the buffered PTY bytes to the console. Nothing is recorded: the live
/// terminal is the only place the agent's output exists.
fn flush_output(app: &AppHandle, task_id: &str, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    let bytes = take_utf8_prefix(pending);
    if bytes.is_empty() {
        return;
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    if text.is_empty() {
        return;
    }
    let _ = app.emit("agent://output", json!({ "taskId": task_id, "data": text }));
}

/// Quotes one shell word so a path with spaces/quotes survives `zsh -c`.

impl AgentCore {
    pub(super) fn run_pty(
        &self,
        task: &AgentTask,
        config: &AgentConfig,
        args: Vec<String>,
        envs: Vec<(String, String)>,
        guard: Arc<PromptGuard>,
        inject_prompt: bool,
        idle_complete: Option<Duration>,
        monitor_hook: bool,
    ) -> PtyOutcome {
        // A cancel can land between the status update and this thread starting;
        // don't spawn a process that is already doomed. Shutdown is the same
        // case: its teardown already ran and would not find this runtime.
        if self.shutting_down() || self.workflow_status(&task.id) == Some(WorkflowStatus::Canceled) {
            return PtyOutcome {
                canceled: true,
                ..PtyOutcome::default()
            };
        }

        let handles = match open_pty(
            &config.binary_path,
            &args,
            &envs,
            Path::new(task.work_dir()),
            120,
            32,
        ) {
            Ok(handles) => handles,
            Err(error) => {
                return PtyOutcome {
                    error: Some(tr_args("agent.pty.start.failed", &[&error])),
                    ..PtyOutcome::default()
                }
            }
        };

        let PtyHandles {
            master,
            writer,
            mut reader,
            mut child,
        } = handles;

        // One writer thread owns the PTY writer. Callers only enqueue, so a TUI
        // that stops reading can never block a tokio worker or reorder input.
        let (input, input_queue) = std::sync::mpsc::sync_channel::<PtyInput>(256);
        let input = Arc::new(input);
        if let Err(error) = std::thread::Builder::new()
            .name(format!("agent-input-{}", task.id))
            .spawn(move || {
                let mut writer = writer;
                while let Ok(PtyInput::Data(data, ack)) = input_queue.recv() {
                    let result = writer
                        .write_all(&data)
                        .and_then(|_| writer.flush())
                        .map_err(|error| error.to_string());
                    let failed = result.is_err();
                    if let Some(ack) = ack {
                        let _ = ack.send(result);
                    }
                    if failed {
                        break;
                    }
                }
            })
        {
            // The writer thread could not start, so the shell would never
            // receive input: kill it instead of leaving a stuck session.
            let _ = child.clone_killer().kill();
            return PtyOutcome {
                error: Some(tr_args("agent.pty.start.failed", &[&error])),
                ..PtyOutcome::default()
            };
        }

        let canceled = Arc::new(AtomicBool::new(false));
        let runtime = Arc::new(Mutex::new(AgentRuntime {
            master,
            input,
            killer: child.clone_killer(),
            pid: child.process_id(),
            canceled: canceled.clone(),
        }));
        self.runtimes
            .lock()
            .expect("agent runtimes lock")
            .insert(task.id.clone(), runtime.clone());

        // The console may already be open and have asked for a size before the
        // PTY existed; apply it now so the TUI lays out for that panel.
        let requested = self
            .sizes
            .lock()
            .ok()
            .and_then(|sizes| sizes.get(&task.id).copied());
        if let Some((cols, rows)) = requested {
            if let Ok(runtime) = runtime.lock() {
                let _ = runtime.master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        }

        // Close the race where a cancel (or shutdown) arrived just before the
        // runtime became visible to `agent_task_cancel` / `teardown_task`.
        if self.shutting_down() || self.workflow_status(&task.id) == Some(WorkflowStatus::Canceled) {
            canceled.store(true, Ordering::SeqCst);
            if let Ok(mut runtime) = runtime.lock() {
                runtime.kill();
            }
        }

        let has_output = Arc::new(AtomicBool::new(false));
        let last_output = Arc::new(Mutex::new(Instant::now()));

        // Reader: blocking reads on its own thread, forwarded as raw chunks.
        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let reader_has_output = has_output.clone();
        let reader_last_output = last_output.clone();
        let reader_handle = std::thread::Builder::new()
            .name(format!("agent-reader-{}", task.id))
            .spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => {
                            reader_has_output.store(true, Ordering::SeqCst);
                            if let Ok(mut last) = reader_last_output.lock() {
                                *last = Instant::now();
                            }
                            if chunk_tx.send(buffer[..count].to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
            .ok();

        // Batcher: coalesces chunks into one event per display frame. A burst
        // still gets split at `OUTPUT_BATCH_MAX`.
        let batch_app = self.app.clone();
        let batch_task_id = task.id.clone();
        let batcher_handle = std::thread::Builder::new()
            .name(format!("agent-batch-{}", task.id))
            .spawn(move || {
                let mut pending: Vec<u8> = Vec::new();
                // Deadline of the frame currently being collected, if any.
                let mut deadline: Option<Instant> = None;

                loop {
                    let wait = match deadline {
                        Some(at) => at
                            .saturating_duration_since(Instant::now())
                            .max(Duration::from_millis(1)),
                        None => OUTPUT_IDLE_WAIT,
                    };
                    match chunk_rx.recv_timeout(wait) {
                        Ok(chunk) => {
                            pending.extend_from_slice(&chunk);
                            if deadline.is_none() {
                                deadline = Some(Instant::now() + OUTPUT_FRAME);
                            }
                            if pending.len() >= OUTPUT_BATCH_MAX {
                                flush_output(&batch_app, &batch_task_id, &mut pending);
                                deadline = None;
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            // Either the frame deadline passed or the stream is
                            // idle; both mean "ship what is buffered".
                            flush_output(&batch_app, &batch_task_id, &mut pending);
                            deadline = None;
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            flush_output(&batch_app, &batch_task_id, &mut pending);
                            break;
                        }
                    }
                }
            })
            .ok();

        // Wait for the TUI to settle before injecting the prompt. argv/flag
        // runtimes already received the prompt at spawn, so there is nothing to
        // wait for and nothing to write.
        let mut warning: Option<String> = None;
        // argv/flag modes started the turn at spawn; stdin starts it after the
        // write below. The timestamp is the no-output watchdog anchor.
        let mut injected_at: Option<Instant> = if inject_prompt {
            None
        } else {
            Some(Instant::now())
        };
        if inject_prompt {
            let ready_quiet = Duration::from_millis(config.ready_quiet_ms.clamp(100, 10_000));
            let ready_timeout =
                Duration::from_millis(config.ready_timeout_ms.clamp(1_000, 120_000));
            let started = Instant::now();
            let mut ready = false;

            while started.elapsed() < ready_timeout {
                if canceled.load(Ordering::SeqCst) {
                    break;
                }
                let produced_output = has_output.load(Ordering::SeqCst);
                let quiet_for = last_output
                    .lock()
                    .map(|last| last.elapsed())
                    .unwrap_or_default();
                if produced_output && quiet_for >= ready_quiet {
                    ready = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }

            if !canceled.load(Ordering::SeqCst) {
                if !ready {
                    warning = Some(if has_output.load(Ordering::SeqCst) {
                        tr("agent.pty.ready.timeout").to_string()
                    } else {
                        tr("agent.pty.ready.noOutput").to_string()
                    });
                    tracing::warn!(task_id = %task.id, warning = ?warning, "agent ready detection timed out");
                }

                // Bracketed paste keeps multi-line prompts intact instead of
                // letting the TUI submit at the first newline.
                let mut payload = Vec::with_capacity(task.prompt.len() + 8);
                payload.extend_from_slice(b"\x1b[200~");
                payload.extend_from_slice(task.prompt.as_bytes());
                payload.extend_from_slice(b"\x1b[201~\r");
                let injected = {
                    // Clone the sender and release the runtime lock: a TUI that
                    // stops reading must not block other input calls for the
                    // whole 30 s wait.
                    let input = {
                        let runtime = runtime.lock().expect("agent runtime lock");
                        runtime.input_sender()
                    };
                    write_blocking(&input, &payload)
                };
                match injected {
                    Ok(()) => {
                        guard.mark_injected();
                        injected_at = Some(Instant::now());
                    }
                    Err(error) => {
                        warning = Some(match warning {
                            Some(existing) => {
                                tr_args("agent.pty.inject.prepend.failed", &[&existing, &error])
                            }
                            None => tr_args("agent.pty.inject.failed", &[&error]),
                        });
                    }
                }
            }
        }

        // Wait for the agent process to exit. TUI runtimes usually keep their
        // TUI open after the turn, so `idle_complete` is the fallback that lets
        // the queue advance when the process never exits on its own.
        let mut outcome = PtyOutcome {
            canceled: canceled.load(Ordering::SeqCst),
            warning,
            ..PtyOutcome::default()
        };
        let idle_after = idle_complete.filter(|duration| !duration.is_zero());
        loop {
            if canceled.load(Ordering::SeqCst) {
                outcome.canceled = true;
                break;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    outcome.exit_code = Some(status.exit_code() as i32);
                    if let Some(signal) = status.signal() {
                        outcome.error = Some(tr_args("agent.pty.signal", &[&signal]));
                    }
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    outcome.error = Some(tr_args("agent.pty.wait.failed", &[&error]));
                    break;
                }
            }

            // 会话 hook 在 session_start / agent_end 等事件上报到 loopback：
            // session id 已在服务端落库，这里只处理回合结束。
            if monitor_hook {
                if let Some(state) = self.take_hook_event(&task.id) {
                    if state.phase == "agent_end"
                        && !state.will_continue
                        && !state.awaiting_async_work
                    {
                        tracing::info!(task_id = %task.id, "agent session hook reported agent_end");
                        if let Some(error) = state.error {
                            // StopFailure 等事件表示本轮失败，不能按成功收尾。
                            outcome.error = Some(error);
                        } else if let Some(error) = self.transcript_error(task) {
                            // provider 记录的错误（重试耗尽、网络中断、API 错误）
                            // 不一定出现在 hook 里；标记失败而不是按完成收尾。
                            tracing::warn!(
                                task_id = %task.id,
                                %error,
                                "agent transcript reported a provider error"
                            );
                            outcome.error = Some(error);
                        } else {
                            let message = tr("agent.pty.turn.completed").to_string();
                            outcome.completed = true;
                            outcome.warning = Some(match outcome.warning.take() {
                                Some(existing) => {
                                    tr_args("agent.pty.warning.join", &[&existing, &message])
                                }
                                None => message,
                            });
                        }
                        if let Ok(mut runtime) = runtime.lock() {
                            runtime.kill();
                        }
                        // Reap the process so the PTY reader sees EOF.
                        if let Ok(status) = child.wait() {
                            outcome.exit_code = Some(status.exit_code() as i32);
                        }
                        break;
                    }
                }
            }

            if let Some(idle) = idle_after {
                let produced_output = has_output.load(Ordering::SeqCst);
                let quiet_for = last_output
                    .lock()
                    .map(|last| last.elapsed())
                    .unwrap_or_default();
                // argv/flag modes have no injection handshake; output is the
                // only proof that the prompt actually started.
                let prompt_started = !inject_prompt || guard.injected();
                if produced_output && prompt_started && quiet_for >= idle {
                    if let Some(error) = self.transcript_error(task) {
                        // 静默兜底也不能把 provider 失败当成完成。
                        tracing::warn!(
                            task_id = %task.id,
                            %error,
                            "agent went idle after a provider error"
                        );
                        outcome.error = Some(error);
                    } else {
                        let message = tr_args("agent.pty.idle.completed", &[&idle.as_secs()]);
                        tracing::warn!(task_id = %task.id, %message, "agent idle completion");
                        outcome.completed = true;
                        outcome.warning = Some(match outcome.warning.take() {
                            Some(existing) => {
                                tr_args("agent.pty.warning.join", &[&existing, &message])
                            }
                            None => message,
                        });
                    }
                    if let Ok(mut runtime) = runtime.lock() {
                        runtime.kill();
                    }
                    // Reap the process so the PTY reader sees EOF.
                    if let Ok(status) = child.wait() {
                        outcome.exit_code = Some(status.exit_code() as i32);
                    }
                    break;
                }

                // A TUI that never produced any output after the prompt was
                // delivered is stuck (trust menu, crash, wrong CLI flags). Fail
                // instead of blocking the serial queue forever.
                let no_output_for = injected_at.map(|at| at.elapsed()).unwrap_or_default();
                if prompt_started && !produced_output && no_output_for >= idle {
                    outcome.error = Some(tr_args("agent.pty.nooutput", &[&idle.as_secs()]));
                    if let Ok(mut runtime) = runtime.lock() {
                        runtime.kill();
                    }
                    let _ = child.wait();
                    break;
                }
            }

            std::thread::sleep(Duration::from_millis(200));
        }
        outcome.canceled = outcome.canceled || canceled.load(Ordering::SeqCst);

        // 没有 hook / 静默兜底时，非零退出码就是失败；不能留下“完成但 exit 1”
        // 的记录。hook 已判定完成时进程是被我们杀掉的，不看退出码。
        if !outcome.canceled && outcome.error.is_none() && !outcome.completed {
            if let Some(code) = outcome.exit_code.filter(|code| *code != 0) {
                outcome.error = Some(tr_args("agent.pty.exit.failed", &[&code]));
            }
        }

        // Do not block forever on the readers: a grandchild process may keep
        // the slave fd open after the TUI exits, which delays EOF.
        join_with_timeout(reader_handle, Duration::from_millis(500));
        join_with_timeout(batcher_handle, Duration::from_millis(500));

        self.runtimes
            .lock()
            .expect("agent runtimes lock")
            .remove(&task.id);

        outcome
    }
}

fn join_with_timeout(handle: Option<std::thread::JoinHandle<()>>, timeout: Duration) {
    let Some(handle) = handle else {
        return;
    };
    let started = Instant::now();
    while !handle.is_finished() && started.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(10));
    }
    if handle.is_finished() {
        let _ = handle.join();
    }
    // Dropping a JoinHandle detaches the thread; it will exit once the fds close.
}
