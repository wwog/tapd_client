//! PTY runtime: spawn the TUI, batch output, and apply the finish outcome.

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
fn kill_process_group(pid: u32, signal: i32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: plain syscall wrapper, no memory is shared.
    unsafe { kill(-(pid as i32), signal) == 0 }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: u32, _signal: i32) -> bool {
    false
}

pub(super) struct AgentRuntime {
    pub(super) master: Box<dyn MasterPty + Send>,
    pub(super) writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// The TUI is started with `setsid`, so its pid is also the process-group
    /// id used to kill the whole TUI tree.
    pid: Option<u32>,
    pub(super) canceled: Arc<AtomicBool>,
}

impl AgentRuntime {
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
pub(super) fn take_utf8_prefix(buffer: &mut Vec<u8>) -> Vec<u8> {
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
        // don't spawn a process that is already doomed.
        if self.current_status(&task.id) == Some(TaskStatus::Canceled) {
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
                    error: Some(format!("启动 Agent 终端失败：{error}")),
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

        let canceled = Arc::new(AtomicBool::new(false));
        let runtime = Arc::new(Mutex::new(AgentRuntime {
            master,
            writer,
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

        // Close the race where a cancel arrived just before the runtime became
        // visible to `agent_task_cancel`.
        if self.current_status(&task.id) == Some(TaskStatus::Canceled) {
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
                        "TUI 就绪检测超时，已强制注入任务".to_string()
                    } else {
                        "未检测到 TUI 输出，已按超时注入任务".to_string()
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
                    let mut runtime = runtime.lock().expect("agent runtime lock");
                    runtime
                        .writer
                        .write_all(&payload)
                        .and_then(|_| runtime.writer.flush())
                };
                match injected {
                    Ok(()) => {
                        guard.mark_injected();
                        injected_at = Some(Instant::now());
                    }
                    Err(error) => {
                        warning = Some(match warning {
                            Some(existing) => format!("{existing}；注入任务失败：{error}"),
                            None => format!("注入任务失败：{error}"),
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
                        outcome.error = Some(format!("Agent 进程被信号终止：{signal}"));
                    }
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    outcome.error = Some(format!("等待 Agent 进程失败：{error}"));
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
                        } else {
                            let message = "Agent 回合已结束，自动完成本轮".to_string();
                            outcome.completed = true;
                            outcome.warning = Some(match outcome.warning.take() {
                                Some(existing) => format!("{existing}；{message}"),
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
                    let message = format!("Agent 输出静默 {}s，已结束本轮", idle.as_secs());
                    tracing::warn!(task_id = %task.id, %message, "agent idle completion");
                    outcome.completed = true;
                    outcome.warning = Some(match outcome.warning.take() {
                        Some(existing) => format!("{existing}；{message}"),
                        None => message,
                    });
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
                    outcome.error = Some(format!(
                        "Agent 启动后 {}s 没有任何输出，请检查命令、登录态或首次启动的信任提示",
                        idle.as_secs()
                    ));
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

    pub(super) async fn finish_task(&self, task_id: &str, outcome: PtyOutcome) {
        // Shutdown already suspended the task back to Queued. A late PTY
        // outcome must not turn that into Canceled/Failed/Succeeded.
        if self.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let warning = outcome.warning.clone();
        let (dirty_files, committed, changed_files, inspection_error) =
            match self.task_snapshot(task_id) {
                Some(task)
                    if !task.status.is_terminal()
                        && !matches!(
                            task.status,
                            TaskStatus::AwaitingApproval
                                | TaskStatus::AwaitingMerge
                                | TaskStatus::Merging
                        ) =>
                {
                    // git status/diff/rev-parse block; keep them off the async
                    // runtime.
                    let task_for_git = task.clone();
                    let inspection = tokio::task::spawn_blocking(move || {
                        let dirty = uncommitted_files(task_for_git.work_dir())?
                            .into_iter()
                            .filter(|file| !task_for_git.baseline_dirty.contains(file))
                            .collect::<Vec<_>>();
                        let committed = committed_since_baseline(&task_for_git)?;
                        let changed = if committed {
                            let mut files = changed_files_since(
                                task_for_git.work_dir(),
                                task_for_git.baseline_head.as_deref(),
                            )?;
                            for file in &dirty {
                                if !files.contains(file) {
                                    files.push(file.clone());
                                }
                            }
                            files
                        } else {
                            dirty.clone()
                        };
                        Ok::<_, String>((dirty, committed, changed))
                    })
                    .await;
                    match inspection {
                        Ok(Ok((dirty, committed, changed))) => (dirty, committed, changed, None),
                        Ok(Err(error)) => (Vec::new(), false, Vec::new(), Some(error)),
                        Err(error) => (
                            Vec::new(),
                            false,
                            Vec::new(),
                            Some(format!("检查工作区失败：{error}")),
                        ),
                    }
                }
                _ => (Vec::new(), false, Vec::new(), None),
            };
        let review_files = if committed {
            Vec::new()
        } else {
            dirty_files.clone()
        };
        let snapshot = self.update_task(task_id, |task| {
            let at = now();
            apply_finish(task, &outcome, &at);
            if task.status != TaskStatus::Succeeded {
                return;
            }
            if let Some(error) = inspection_error.as_deref() {
                task.status = TaskStatus::Failed;
                task.error = Some(format!("无法确认工作区状态，已停止：{error}"));
                task.finished_at = Some(at);
                return;
            }

            // Worktree tasks always pass through review/merge: the branch is
            // the deliverable, so any change (committed or dirty) needs a human
            // decision before it lands in the main repository.
            let is_worktree = task.worktree_branch.is_some();
            if is_worktree {
                if task.commit_only {
                    // The commit phase is the last chance to persist the
                    // approved change on the task branch.
                    if !dirty_files.is_empty() {
                        task.status = TaskStatus::Failed;
                        task.error =
                            Some("提交轮未提交改动，已停止；请检查工作区后重试".to_string());
                        task.finished_at = Some(at);
                        return;
                    }
                    task.status = TaskStatus::AwaitingMerge;
                    task.commit_only = false;
                    task.finished_at = None;
                    task.error = None;
                    let repo = task.repo_path.clone();
                    let branch = task.worktree_branch.clone().unwrap_or_default();
                    task.merge = Some(TaskMerge {
                        instructions: Some(manual_merge_instructions(&repo, &branch)),
                        ..TaskMerge::default()
                    });
                    return;
                }

                if changed_files.is_empty() {
                    // Nothing to merge: success without a merge stage.
                    return;
                }
                set_awaiting_approval(
                    task,
                    "Agent 已完成修改，等待审核后合并。".to_string(),
                    changed_files.clone(),
                    Some("改动在任务分支，审核通过后合并回主仓库".to_string()),
                    &at,
                );
                return;
            }

            if task.commit_only {
                // Non-worktree commit phase: reporting success with a dirty
                // tree would leave the fix uncommitted and TAPD not written
                // back.
                if dirty_files.is_empty() {
                    return;
                }
                task.status = TaskStatus::Failed;
                task.error = Some("提交轮未提交改动，已停止；请检查工作区后重试".to_string());
                task.finished_at = Some(at);
                return;
            }
            if review_files.is_empty() {
                return;
            }
            set_awaiting_approval(
                task,
                "Agent 已完成修改但未提交，等待确认后提交。".to_string(),
                review_files,
                Some("存在未提交的改动".to_string()),
                &at,
            );
        });

        if let Some(task) = &snapshot {
            // A successful task no longer needs its isolated directory; the
            // branch keeps the commit. Cleanup failure must not turn a
            // finished fix into a failure, so it only warns.
            if task.status == TaskStatus::Succeeded {
                if let Some(path) = task.worktree_path.clone() {
                    if !dirty_files.is_empty() {
                        // The agent committed part of its work but left other
                        // files dirty. Never force-delete those: keep the
                        // worktree so the user can inspect or commit them.
                        tracing::warn!(
                            task_id,
                            files = dirty_files.len(),
                            "worktree kept: uncommitted files remain after commit"
                        );
                    } else {
                        let repo = task.repo_path.clone();
                        let removed = {
                            let _worktree_guard = self.worktree_lock.lock().await;
                            tokio::task::spawn_blocking(move || worktree::remove(&repo, &path))
                                .await
                        };
                        match removed {
                            Ok(Ok(())) => {
                                self.update_task(task_id, |task| {
                                    if task.status == TaskStatus::Succeeded {
                                        task.worktree_path = None;
                                    }
                                });
                            }
                            Ok(Err(error)) => {
                                tracing::warn!(task_id, %error, "failed to remove agent worktree");
                            }
                            Err(error) => {
                                tracing::warn!(task_id, %error, "worktree cleanup task failed");
                            }
                        }
                    }
                }
            }
            if task.status == TaskStatus::Succeeded {
                if let Some(warning) = warning {
                    tracing::warn!(task_id, %warning, "agent finished with a warning");
                }
                tracing::info!(task_id, exit_code = ?task.exit_code, "agent task succeeded");
            } else if task.status == TaskStatus::Failed || task.status == TaskStatus::Canceled {
                tracing::warn!(
                    task_id,
                    status = ?task.status,
                    error = ?task.error,
                    "agent task did not succeed"
                );
            }
        }
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
