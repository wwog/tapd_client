//! 自由对话会话：在项目仓库目录里长驻一个 Agent PTY。
//!
//! 与缺陷任务队列完全独立：不导出 bug.json、不创建 worktree、不走审核/合并。
//! PTY、hook、运行状态和 transcript 缓存仍复用 `AgentCore` 里按 id 索引的表，
//! 因此 `agent_input` / `agent_resize` / `agent_chat` 与现有终端、对话组件可以
//! 直接使用会话 id 工作。

use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::RecvTimeoutError,
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use portable_pty::PtySize;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tapd_core::store::{read_json, write_json_atomic};
use tauri::{AppHandle, Emitter, Manager};

use super::{
    binary_for_task, now, prompt, pty, resume_args, runtime_descriptor, runtime_launch_options,
    status, truncate_text, valid_session_id, validate_binary, AgentCore, AgentRuntimeStatus,
    HookError,
};
use crate::cache::{ChatSearchQuery, ChatSessionQuery};

const CHAT_FILE: &str = "chat-sessions.json";
const DEFAULT_TITLE: &str = "新对话";
const TITLE_MAX_CHARS: usize = 40;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChatStatus {
    Starting,
    Running,
    Stopped,
    Failed,
}

impl ChatStatus {
    /// 与 `chat_sessions.status` 列写入的值保持一致。
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }
}

/// 一条对话会话的持久化记录。transcript 本身由各 CLI 落盘，这里只存元数据。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatSession {
    pub(crate) id: String,
    pub(crate) workspace_id: String,
    pub(crate) workspace_name: String,
    pub(crate) repo_path: String,
    pub(crate) runtime_id: String,
    #[serde(default)]
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) permission_mode: String,
    pub(crate) title: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) status: ChatStatus,
    /// hook 捕获的运行时 session id；续接旧会话时使用。
    #[serde(default)]
    pub(crate) agent_session_id: Option<String>,
    #[serde(default)]
    pub(crate) error: Option<String>,
    /// PTY 已产生输出：前端此时才允许发送消息，避免输入被 TUI 启动过程吞掉。
    #[serde(default)]
    pub(crate) ready: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct ChatStore {
    sessions: BTreeMap<String, ChatSession>,
}

/// 列表项：会话元数据 + 当前运行状态快照。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatSessionView {
    #[serde(flatten)]
    session: ChatSession,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime: Option<AgentRuntimeStatus>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatSessionsState {
    sessions: Vec<ChatSessionView>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ChatStartRequest {
    workspace_id: String,
    workspace_name: Option<String>,
    runtime_id: String,
    model: Option<String>,
    permission_mode: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ChatIdRequest {
    id: String,
}

/// 会话列表过滤；字段为空表示不限制。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ChatSessionsRequest {
    workspace_id: Option<String>,
    runtime_id: Option<String>,
    model: Option<String>,
    status: Option<String>,
    /// 匹配标题 / 项目名。
    keyword: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
}

impl ChatSessionsRequest {
    fn into_query(self) -> ChatSessionQuery {
        ChatSessionQuery {
            workspace_id: normalize_filter(self.workspace_id),
            runtime_id: normalize_filter(self.runtime_id),
            model: normalize_filter(self.model),
            status: normalize_filter(self.status),
            keyword: normalize_filter(self.keyword),
            limit: self.limit,
            offset: self.offset,
        }
    }
}

/// 消息内容搜索。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ChatSearchRequest {
    keyword: String,
    workspace_id: Option<String>,
    runtime_id: Option<String>,
    model: Option<String>,
    limit: Option<u32>,
}

impl ChatSearchRequest {
    fn into_query(self) -> ChatSearchQuery {
        ChatSearchQuery {
            keyword: self.keyword.trim().to_string(),
            workspace_id: normalize_filter(self.workspace_id),
            runtime_id: normalize_filter(self.runtime_id),
            model: normalize_filter(self.model),
            limit: self.limit,
        }
    }
}

fn normalize_filter(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn query_has_constraints(query: &ChatSessionQuery) -> bool {
    query.workspace_id.is_some()
        || query.runtime_id.is_some()
        || query.model.is_some()
        || query.status.is_some()
        || query.keyword.is_some()
        || query.limit.is_some()
        || query.offset.is_some()
}

/// SQLite 不可用时的内存兜底过滤，规则与 SQL 侧保持一致。
fn filter_sessions(sessions: Vec<ChatSession>, query: &ChatSessionQuery) -> Vec<ChatSession> {
    let keyword = query.keyword.as_deref().map(str::to_lowercase);
    let mut sessions: Vec<ChatSession> = sessions
        .into_iter()
        .filter(|session| {
            matches_filter(&query.workspace_id, &session.workspace_id)
                && matches_filter(&query.runtime_id, &session.runtime_id)
                && matches_filter(&query.model, &session.model)
                && match query.status.as_deref() {
                    Some(status) => status == session.status.key(),
                    None => true,
                }
                && keyword.as_ref().is_none_or(|keyword| {
                    session.title.to_lowercase().contains(keyword)
                        || session.workspace_name.to_lowercase().contains(keyword)
                })
        })
        .collect();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let offset = query.offset.unwrap_or(0) as usize;
    // 没有 limit 时保持「全部」，与 SQL 查询的语义一致。
    match query.limit {
        Some(limit) => sessions
            .into_iter()
            .skip(offset)
            .take(limit as usize)
            .collect(),
        None => sessions.into_iter().skip(offset).collect(),
    }
}

fn matches_filter(filter: &Option<String>, value: &str) -> bool {
    match filter.as_deref() {
        Some(expected) => expected == value,
        None => true,
    }
}

#[derive(Debug, Default)]
struct ChatPtyOutcome {
    canceled: bool,
    exit_code: Option<i32>,
    error: Option<String>,
}

/// transcript 定位所需的上下文；与任务的 `AgentTask` 解耦。
pub(super) struct ChatTranscriptContext {
    pub(super) runtime_id: String,
    pub(super) session_id: String,
    pub(super) work_dir: String,
}

impl AgentCore {
    fn chat_path(&self) -> PathBuf {
        self.state.paths.data_dir.join(CHAT_FILE)
    }

    /// 启动时加载会话：优先读 SQLite；空表时一次性导入旧版
    /// `chat-sessions.json`，导入后改名避免删空会话后又被旧文件复活。
    /// 上次进程退出时仍在运行的会话归一为已停止，保留 `agent_session_id`
    /// 以便继续对话。
    pub(super) fn load_chats(&self) {
        let path = self.chat_path();
        // SQLite 不可用时退回旧的 JSON 文件，保证缓存故障不影响对话。
        let (mut store, imported) = match self.state.cache.load_chat_sessions() {
            Some(sessions) if !sessions.is_empty() => (store_from_sessions(sessions), false),
            Some(_) => match import_legacy_chats(&path) {
                Some(store) => (store, true),
                None => (ChatStore::default(), false),
            },
            None => (read_json::<ChatStore>(&path).unwrap_or_default(), false),
        };
        let mut changed = false;
        for session in store.sessions.values_mut() {
            if matches!(session.status, ChatStatus::Starting | ChatStatus::Running) {
                session.status = ChatStatus::Stopped;
                session.ready = false;
                changed = true;
            }
        }
        if let Ok(mut chats) = self.chats.lock() {
            *chats = store;
        }
        if changed || imported {
            self.persist_chats();
        }
    }

    fn persist_chats(&self) {
        let snapshot = match self.chats.lock() {
            Ok(store) => store.clone(),
            Err(_) => return,
        };
        let _guard = self.persist_lock.lock();
        // SQLite 是主存储；只有它不可用 / 写入失败时才回退到 JSON。
        let sessions: Vec<ChatSession> = snapshot.sessions.values().cloned().collect();
        if self.state.cache.save_chat_sessions(&sessions) {
            return;
        }
        if let Err(error) = write_json_atomic(&self.chat_path(), &snapshot) {
            tracing::warn!(%error, "failed to persist chat sessions");
        }
    }

    pub(super) fn chat_session(&self, id: &str) -> Option<ChatSession> {
        self.chats.lock().ok()?.sessions.get(id).cloned()
    }

    pub(super) fn is_chat_session(&self, id: &str) -> bool {
        self.chats
            .lock()
            .map(|store| store.sessions.contains_key(id))
            .unwrap_or(false)
    }

    pub(super) fn chat_runtime_id(&self, id: &str) -> Option<String> {
        self.chat_session(id).map(|session| session.runtime_id)
    }

    /// 退出前停止所有会话，并把仍在运行的状态落成已停止。
    pub(super) fn stop_chats_for_shutdown(&self) {
        let ids: Vec<String> = match self.chats.lock() {
            Ok(mut store) => {
                let at = now();
                let mut ids = Vec::with_capacity(store.sessions.len());
                for session in store.sessions.values_mut() {
                    ids.push(session.id.clone());
                    if matches!(session.status, ChatStatus::Starting | ChatStatus::Running) {
                        session.status = ChatStatus::Stopped;
                        session.ready = false;
                        session.updated_at = at.clone();
                    }
                }
                ids
            }
            Err(_) => return,
        };
        if ids.is_empty() {
            return;
        }
        self.persist_chats();
        for id in &ids {
            self.teardown_task(id);
        }
        tracing::info!(chats = ids.len(), "chat sessions stopped");
    }

    pub(super) fn chat_transcript_context(&self, id: &str) -> Option<ChatTranscriptContext> {
        let session = self.chat_session(id)?;
        Some(ChatTranscriptContext {
            runtime_id: session.runtime_id,
            session_id: session.agent_session_id.unwrap_or_default(),
            work_dir: session.repo_path,
        })
    }

    fn chat_sessions_state(&self) -> ChatSessionsState {
        let sessions: Vec<ChatSession> = match self.chats.lock() {
            Ok(store) => store.sessions.values().cloned().collect(),
            Err(_) => Vec::new(),
        };
        self.chat_sessions_state_for(sessions)
    }

    /// 把会话列表附上运行状态并排序；内存列表与 SQLite 查询共用。
    fn chat_sessions_state_for(&self, sessions: Vec<ChatSession>) -> ChatSessionsState {
        let statuses = self
            .runtime_status
            .lock()
            .map(|statuses| statuses.clone())
            .unwrap_or_default();
        let mut views: Vec<ChatSessionView> = sessions
            .into_iter()
            .map(|session| {
                let runtime = statuses.get(&session.id).cloned();
                ChatSessionView { session, runtime }
            })
            .collect();
        views.sort_by(|a, b| b.session.updated_at.cmp(&a.session.updated_at));
        ChatSessionsState { sessions: views }
    }

    fn emit_chat_state(&self) {
        let _ = self.app.emit("chat://state", self.chat_sessions_state());
    }

    /// PTY 首次输出：会话进入可发送状态。
    fn mark_chat_ready(&self, id: &str) {
        let changed = match self.chats.lock() {
            Ok(mut store) => match store.sessions.get_mut(id) {
                // 已停止 / 删除的会话不能被迟到的首次输出重新点亮。
                Some(session)
                    if matches!(session.status, ChatStatus::Starting | ChatStatus::Running)
                        && (!session.ready || session.status != ChatStatus::Running) =>
                {
                    session.ready = true;
                    session.status = ChatStatus::Running;
                    session.updated_at = now();
                    true
                }
                _ => false,
            },
            Err(_) => false,
        };
        if changed {
            self.persist_chats();
            self.emit_chat_state();
        }
    }

    /// 用户发出一条消息：刷新排序时间，首条消息生成会话标题。
    pub(super) fn touch_chat(&self, id: &str, text: &str) {
        let mut title_changed = false;
        let changed = match self.chats.lock() {
            Ok(mut store) => match store.sessions.get_mut(id) {
                Some(session) => {
                    session.updated_at = now();
                    if session.title.trim().is_empty() || session.title == DEFAULT_TITLE {
                        let title = chat_title(text);
                        if !title.is_empty() && title != session.title {
                            session.title = title;
                            title_changed = true;
                        }
                    }
                    true
                }
                None => false,
            },
            Err(_) => false,
        };
        if changed {
            self.persist_chats();
            if title_changed {
                self.emit_chat_state();
            }
        }
    }

    async fn chat_start(
        self: &Arc<Self>,
        request: ChatStartRequest,
    ) -> Result<ChatSession, String> {
        let config = self.config_snapshot();
        let workspace_id = request.workspace_id.trim().to_string();
        if workspace_id.is_empty() {
            return Err("缺少 workspaceId".to_string());
        }
        let project = config
            .projects
            .get(&workspace_id)
            .ok_or_else(|| format!("项目 {workspace_id} 还没有配置本地仓库目录"))?;
        let repo_path = project.repo_path.trim().to_string();
        if repo_path.is_empty() {
            return Err("项目还没有配置本地仓库目录，请先在「项目」页配置".to_string());
        }
        if !Path::new(&repo_path).is_dir() {
            return Err(format!("项目仓库目录不存在：{repo_path}"));
        }

        let requested_runtime = request.runtime_id.trim();
        let runtime_id = if runtime_descriptor(requested_runtime).is_some() {
            requested_runtime.to_string()
        } else {
            config.runtime_id.clone()
        };
        if runtime_descriptor(&runtime_id).is_none() {
            return Err(format!("未知的 Agent 运行时：{runtime_id}"));
        }
        let runtime_options = config
            .runtime_options
            .get(&runtime_id)
            .cloned()
            .unwrap_or_default();
        let model = request
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&runtime_options.model)
            .to_string();
        let permission_mode = request
            .permission_mode
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| runtime_options.permission_mode.clone());

        // 目录与命令先校验：不可用时不要留下一条必然失败的会话记录。
        let binary = binary_for_task(&config, &runtime_id, self.scan_snapshot().as_ref());
        let binary = tokio::task::spawn_blocking(move || validate_binary(&binary))
            .await
            .map_err(|error| format!("检查 Agent 命令失败：{error}"))??;

        let workspace_name = request
            .workspace_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| workspace_id.clone());
        let at = now();
        let session = ChatSession {
            id: uuid::Uuid::new_v4().simple().to_string(),
            workspace_id,
            workspace_name,
            repo_path,
            runtime_id,
            model,
            permission_mode,
            title: DEFAULT_TITLE.to_string(),
            created_at: at.clone(),
            updated_at: at,
            status: ChatStatus::Starting,
            agent_session_id: None,
            error: None,
            ready: false,
        };
        if let Ok(mut store) = self.chats.lock() {
            store.sessions.insert(session.id.clone(), session.clone());
        }
        self.persist_chats();
        self.emit_chat_state();
        tracing::info!(
            chat_id = %session.id,
            workspace = %session.workspace_id,
            runtime = %session.runtime_id,
            "chat session started"
        );
        self.spawn_chat(
            session.clone(),
            binary.to_string_lossy().into_owned(),
            false,
        );
        Ok(session)
    }

    fn spawn_chat(self: &Arc<Self>, session: ChatSession, binary: String, resume: bool) {
        let core = Arc::clone(self);
        let id = session.id.clone();
        let thread_id = id.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("chat-tui-{id}"))
            .spawn(move || {
                let outcome = core.run_chat_pty(&session, &binary, resume);
                core.finish_chat(&thread_id, outcome);
            });
        if let Err(error) = spawned {
            self.finish_chat(
                &id,
                ChatPtyOutcome {
                    error: Some(format!("启动对话线程失败：{error}")),
                    ..ChatPtyOutcome::default()
                },
            );
        }
    }

    /// 长驻 PTY：只关心进程退出或用户停止，不判断「回合结束」。
    fn run_chat_pty(&self, session: &ChatSession, binary: &str, resume: bool) -> ChatPtyOutcome {
        // 停止请求可能在线程启动前就到了：先看会话状态，别再拉起一个进程。
        match self.chat_session(&session.id) {
            Some(current)
                if matches!(current.status, ChatStatus::Starting | ChatStatus::Running) => {}
            _ => {
                return ChatPtyOutcome {
                    canceled: true,
                    ..ChatPtyOutcome::default()
                }
            }
        }
        let Some(descriptor) = runtime_descriptor(&session.runtime_id) else {
            return ChatPtyOutcome {
                error: Some(format!("未知的 Agent 运行时：{}", session.runtime_id)),
                ..ChatPtyOutcome::default()
            };
        };
        let mut args: Vec<String> = descriptor.args.iter().map(|arg| arg.to_string()).collect();
        // OpenCode 2.x 的插件运行在后台服务里，服务收不到本次会话的 hook 环境
        // 变量；私有服务才能把会话 id / 回合事件上报到桌面端。
        if matches!(session.runtime_id.as_str(), "opencode" | "opencode2") {
            args.extend(super::opencode_standalone_args(binary));
        }
        args.extend(runtime_launch_options(
            &session.runtime_id,
            &session.model,
            &session.permission_mode,
        ));
        if resume {
            let Some(session_id) = session
                .agent_session_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
            else {
                return ChatPtyOutcome {
                    error: Some("没有可续接的会话".to_string()),
                    ..ChatPtyOutcome::default()
                };
            };
            args.extend(resume_args(&session.runtime_id, Some(session_id)));
        }
        let mut envs: Vec<(String, String)> = Vec::new();
        if descriptor.session_hook {
            match self.prepare_hook_for(&session.id, &session.runtime_id, descriptor.hook_kind) {
                Some(launch) => {
                    args.extend(launch.args);
                    envs.extend(launch.envs);
                }
                None => tracing::warn!(
                    chat_id = %session.id,
                    "chat session hook is unavailable; transcript may be delayed"
                ),
            }
        }

        let handles =
            match pty::open_pty(binary, &args, &envs, Path::new(&session.repo_path), 120, 32) {
                Ok(handles) => handles,
                Err(error) => {
                    return ChatPtyOutcome {
                        error: Some(format!("启动 Agent 终端失败：{error}")),
                        ..ChatPtyOutcome::default()
                    }
                }
            };
        let pty::PtyHandles {
            master,
            writer,
            mut reader,
            mut child,
        } = handles;

        let canceled = Arc::new(AtomicBool::new(false));
        let runtime = Arc::new(Mutex::new(pty::AgentRuntime::new(
            master,
            writer,
            child.clone_killer(),
            child.process_id(),
            canceled.clone(),
        )));
        self.runtimes
            .lock()
            .expect("agent runtimes lock")
            .insert(session.id.clone(), runtime.clone());

        // 关闭「停止先到、runtime 后插入」的竞态：状态已不是启动/运行时立刻杀掉。
        let stopped = match self.chat_session(&session.id) {
            Some(current) => !matches!(current.status, ChatStatus::Starting | ChatStatus::Running),
            None => true,
        };
        if stopped {
            canceled.store(true, Ordering::SeqCst);
            if let Ok(mut runtime) = runtime.lock() {
                runtime.kill();
            }
        }

        // 终端可能在 PTY 启动前就请求过尺寸；这里补上，避免 TUI 先按 120x32 绘制。
        if let Some((cols, rows)) = self
            .sizes
            .lock()
            .ok()
            .and_then(|sizes| sizes.get(&session.id).copied())
        {
            if let Ok(runtime) = runtime.lock() {
                let _ = runtime.master.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        }

        let has_output = Arc::new(AtomicBool::new(false));
        let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let reader_has_output = has_output.clone();
        let reader_handle = std::thread::Builder::new()
            .name(format!("chat-reader-{}", session.id))
            .spawn(move || {
                let mut buffer = [0u8; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => {
                            reader_has_output.store(true, Ordering::SeqCst);
                            if chunk_tx.send(buffer[..count].to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            })
            .ok();

        // 与任务终端相同的按帧批量：TUI 全屏重绘时逐块发送会明显卡顿。
        let batch_app = self.app.clone();
        let batch_id = session.id.clone();
        let batcher_handle = std::thread::Builder::new()
            .name(format!("chat-batch-{}", session.id))
            .spawn(move || {
                let mut pending: Vec<u8> = Vec::new();
                let mut deadline: Option<Instant> = None;
                loop {
                    let wait = match deadline {
                        Some(at) => at
                            .saturating_duration_since(Instant::now())
                            .max(Duration::from_millis(1)),
                        None => pty::OUTPUT_IDLE_WAIT,
                    };
                    match chunk_rx.recv_timeout(wait) {
                        Ok(chunk) => {
                            pending.extend_from_slice(&chunk);
                            if deadline.is_none() {
                                deadline = Some(Instant::now() + pty::OUTPUT_FRAME);
                            }
                            if pending.len() >= pty::OUTPUT_BATCH_MAX {
                                pty::flush_output(&batch_app, &batch_id, &mut pending);
                                deadline = None;
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            pty::flush_output(&batch_app, &batch_id, &mut pending);
                            deadline = None;
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            pty::flush_output(&batch_app, &batch_id, &mut pending);
                            break;
                        }
                    }
                }
            })
            .ok();

        let mut outcome = ChatPtyOutcome::default();
        let mut ready = false;
        loop {
            if canceled.load(Ordering::SeqCst) {
                outcome.canceled = true;
                break;
            }
            if !ready && has_output.load(Ordering::SeqCst) {
                ready = true;
                self.mark_chat_ready(&session.id);
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
            std::thread::sleep(Duration::from_millis(200));
        }
        outcome.canceled = outcome.canceled || canceled.load(Ordering::SeqCst);

        pty::join_with_timeout(reader_handle, Duration::from_millis(500));
        pty::join_with_timeout(batcher_handle, Duration::from_millis(500));
        self.runtimes
            .lock()
            .expect("agent runtimes lock")
            .remove(&session.id);
        outcome
    }

    fn finish_chat(&self, id: &str, outcome: ChatPtyOutcome) {
        let (status, error) = if outcome.canceled {
            (ChatStatus::Stopped, None)
        } else if let Some(error) = outcome.error {
            (ChatStatus::Failed, Some(error))
        } else if let Some(code) = outcome.exit_code.filter(|code| *code != 0) {
            (
                ChatStatus::Failed,
                Some(format!("Agent 进程异常退出（exit {code}）")),
            )
        } else {
            (ChatStatus::Stopped, None)
        };
        let changed = match self.chats.lock() {
            Ok(mut store) => match store.sessions.get_mut(id) {
                Some(session) => {
                    session.status = status;
                    session.ready = false;
                    session.error = error;
                    session.updated_at = now();
                    true
                }
                None => false,
            },
            Err(_) => false,
        };
        if changed {
            self.persist_chats();
            self.emit_chat_state();
        }
        // 运行状态与 hook token 只在会话存活期间有意义。
        self.teardown_task(id);
    }

    fn chat_stop(&self, id: &str) -> Result<(), String> {
        if !self.is_chat_session(id) {
            return Err("会话不存在".to_string());
        }
        // 先落状态再杀进程：PTY 线程可能还没把 runtime 插入 map，状态是兜底。
        let changed = match self.chats.lock() {
            Ok(mut store) => match store.sessions.get_mut(id) {
                Some(session) => {
                    session.status = ChatStatus::Stopped;
                    session.ready = false;
                    session.error = None;
                    session.updated_at = now();
                    true
                }
                None => false,
            },
            Err(_) => false,
        };
        if changed {
            self.persist_chats();
            self.emit_chat_state();
        }
        self.stop_chat_runtime(id);
        Ok(())
    }

    /// 只杀进程、不摘除 runtime：运行线程退出时自己清理，`runtimes` 里是否
    /// 还有这个 id 就是「会话仍在停止中」的可靠判据。
    fn stop_chat_runtime(&self, id: &str) {
        let runtime = self
            .runtimes
            .lock()
            .ok()
            .and_then(|runtimes| runtimes.get(id).cloned());
        if let Some(runtime) = runtime {
            if let Ok(mut runtime) = runtime.lock() {
                runtime.canceled.store(true, Ordering::SeqCst);
                runtime.kill();
            }
        }
    }

    fn chat_resume(self: &Arc<Self>, id: &str) -> Result<ChatSession, String> {
        if self
            .runtimes
            .lock()
            .map(|runtimes| runtimes.contains_key(id))
            .unwrap_or(false)
        {
            return Err("会话仍在停止中，请稍候".to_string());
        }
        let mut session = self
            .chat_session(id)
            .ok_or_else(|| "会话不存在".to_string())?;
        // 刚创建、线程尚未插入 runtime 时也不能重复拉起。
        if !matches!(session.status, ChatStatus::Stopped | ChatStatus::Failed) {
            return Err("会话仍在运行".to_string());
        }
        if session
            .agent_session_id
            .as_deref()
            .map(str::trim)
            .filter(|session_id| !session_id.is_empty())
            .is_none()
        {
            return Err("没有可续接的会话，请新建对话".to_string());
        }
        if !Path::new(&session.repo_path).is_dir() {
            return Err(format!("项目仓库目录不存在：{}", session.repo_path));
        }

        let config = self.config_snapshot();
        let binary = binary_for_task(&config, &session.runtime_id, self.scan_snapshot().as_ref());
        let binary = validate_binary(&binary)?;

        session.status = ChatStatus::Starting;
        session.ready = false;
        session.error = None;
        session.updated_at = now();
        if let Ok(mut store) = self.chats.lock() {
            store.sessions.insert(id.to_string(), session.clone());
        }
        self.persist_chats();
        self.emit_chat_state();
        tracing::info!(chat_id = %session.id, "chat session resumed");
        self.spawn_chat(session.clone(), binary.to_string_lossy().into_owned(), true);
        Ok(session)
    }

    fn chat_delete(&self, id: &str) -> Result<(), String> {
        // 先移除记录：PTY 线程随后的收尾会看到会话已不存在，不会再写回状态。
        let removed = match self.chats.lock() {
            Ok(mut store) => store.sessions.remove(id).is_some(),
            Err(_) => false,
        };
        if !removed {
            return Err("会话不存在".to_string());
        }
        self.stop_chat_runtime(id);
        self.teardown_task(id);
        if let Ok(mut cache) = self.transcript_cache.lock() {
            cache.remove(id);
        }
        self.persist_chats();
        self.emit_chat_state();
        Ok(())
    }

    /// hook 事件进入 chat 分支：只更新 session id 与运行状态，不喂给 workflow。
    pub(super) fn record_chat_hook(
        &self,
        id: &str,
        event: &str,
        session_id: Option<&str>,
        payload: Option<&Value>,
        will_continue: bool,
        awaiting_async_work: bool,
    ) -> Result<(), HookError> {
        let Some(session) = self.chat_session(id) else {
            return Err(HookError::UnknownTask);
        };
        // 停止 / 删除后的迟到 hook 不能把状态改回运行中。
        if !matches!(session.status, ChatStatus::Starting | ChatStatus::Running) {
            return Ok(());
        }
        let runtime_id = session.runtime_id;

        let mut persist = false;
        if let Some(session_id) = session_id
            .map(str::trim)
            .filter(|session_id| valid_session_id(session_id))
        {
            if let Ok(mut store) = self.chats.lock() {
                if let Some(session) = store.sessions.get_mut(id) {
                    if session.agent_session_id.as_deref() != Some(session_id) {
                        session.agent_session_id = Some(session_id.to_string());
                        session.updated_at = now();
                        persist = true;
                    }
                }
            }
        }
        if persist {
            self.persist_chats();
            self.emit_chat_state();
        }

        let previous = self
            .runtime_status
            .lock()
            .ok()
            .and_then(|statuses| statuses.get(id).cloned());
        let at = now();
        let activity = status::normalize(
            previous.as_ref(),
            event,
            payload,
            session_id,
            &at,
            will_continue,
            awaiting_async_work,
        );
        if let Some(mut next) = activity.status {
            if let Some(prompt) = next.prompt.as_mut() {
                // prompt id 绑定会话与本次事件：旧卡片不会误操作新请求。
                prompt.prompt_id = format!("{id}:{at}");
                prompt.can_answer = prompt::can_answer(&runtime_id, prompt);
                prompt.answer_hint = prompt::answer_hint(&runtime_id, prompt);
            }
            self.set_runtime_status(id, next);
        }
        Ok(())
    }
}

/// 把缓存层返回的会话列表还原成内存存储。
fn store_from_sessions(sessions: Vec<ChatSession>) -> ChatStore {
    let mut store = ChatStore::default();
    store
        .sessions
        .extend(sessions.into_iter().map(|session| (session.id.clone(), session)));
    store
}

/// 导入旧版 `chat-sessions.json`。整文件解析失败时保留原文件；解析成功后
/// 改名作为「已迁移」标记，避免会话被删空后重启又从旧文件恢复。
fn import_legacy_chats(path: &Path) -> Option<ChatStore> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let mut store = ChatStore::default();
    if let Some(sessions) = value.get("sessions").and_then(Value::as_object) {
        for (id, entry) in sessions {
            match serde_json::from_value::<ChatSession>(entry.clone()) {
                Ok(session) => {
                    store.sessions.insert(id.clone(), session);
                }
                Err(error) => {
                    tracing::warn!(%error, chat_id = %id, "skip malformed chat session");
                }
            }
        }
    }
    let archived = path.with_extension("json.imported");
    if let Err(error) = std::fs::rename(path, &archived) {
        tracing::warn!(%error, "failed to archive legacy chat store");
    }
    Some(store)
}

/// 首条消息 → 单行标题。
fn chat_title(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_text(&line, TITLE_MAX_CHARS)
}

pub(crate) async fn command(app: &AppHandle, name: &str, payload: Value) -> Result<Value, String> {
    let core = app
        .try_state::<Arc<AgentCore>>()
        .ok_or_else(|| "Agent 未初始化".to_string())?
        .inner()
        .clone();
    match name {
        "chat_sessions" => {
            let request: ChatSessionsRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的会话参数：{error}"))?;
            let query = request.into_query();
            // 没有过滤条件时直接返回内存列表，保持原有行为（含运行状态）。
            if !query_has_constraints(&query) {
                return Ok(json!(core.chat_sessions_state()));
            }
            let sessions = match core.state.cache.query_chat_sessions(&query) {
                Some(sessions) => sessions,
                None => {
                    // SQLite 不可用：退回内存列表，用相同条件过滤。
                    let sessions = core
                        .chats
                        .lock()
                        .map(|store| store.sessions.values().cloned().collect())
                        .unwrap_or_default();
                    filter_sessions(sessions, &query)
                }
            };
            Ok(json!(core.chat_sessions_state_for(sessions)))
        }
        "chat_search" => {
            let request: ChatSearchRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的搜索参数：{error}"))?;
            let query = request.into_query();
            if query.keyword.is_empty() {
                return Ok(json!({ "hits": [] }));
            }
            let hits = core
                .state
                .cache
                .search_chat_messages(&query)
                .unwrap_or_default();
            Ok(json!({ "hits": hits }))
        }
        "chat_start" => {
            let request: ChatStartRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的对话参数：{error}"))?;
            let session = core.chat_start(request).await?;
            Ok(json!({ "session": session }))
        }
        "chat_stop" => {
            let request: ChatIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的会话参数：{error}"))?;
            core.chat_stop(request.id.trim())?;
            Ok(json!({ "ok": true }))
        }
        "chat_resume" => {
            let request: ChatIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的会话参数：{error}"))?;
            let session = core.chat_resume(request.id.trim())?;
            Ok(json!({ "session": session }))
        }
        "chat_delete" => {
            let request: ChatIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的会话参数：{error}"))?;
            core.chat_delete(request.id.trim())?;
            Ok(json!({ "deleted": true }))
        }
        other => Err(format!("unknown chat command: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_session(id: &str, status: ChatStatus) -> ChatSession {
        ChatSession {
            id: id.to_string(),
            workspace_id: "100".to_string(),
            workspace_name: "项目".to_string(),
            repo_path: "/tmp/repo".to_string(),
            runtime_id: "claude".to_string(),
            model: String::new(),
            permission_mode: String::new(),
            title: DEFAULT_TITLE.to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            status,
            agent_session_id: Some("s-1".to_string()),
            error: None,
            ready: false,
        }
    }

    #[test]
    fn legacy_json_is_imported_and_archived() {
        let dir = std::env::temp_dir().join(format!(
            "tapd-chat-import-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join(CHAT_FILE);
        let valid = serde_json::to_value(sample_session("a", ChatStatus::Stopped))
            .expect("session json");
        std::fs::write(
            &path,
            serde_json::json!({
                "sessions": {
                    "a": valid,
                    "bad": { "id": "bad" }
                }
            })
            .to_string(),
        )
        .expect("write legacy store");

        let store = import_legacy_chats(&path).expect("import legacy chat store");
        assert_eq!(store.sessions.len(), 1, "malformed entry is skipped");
        assert!(store.sessions.contains_key("a"));
        assert!(!path.exists(), "legacy file must be archived");
        assert!(dir.join("chat-sessions.json.imported").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn memory_filter_matches_sql_semantics() {
        let mut first = sample_session("a", ChatStatus::Stopped);
        first.runtime_id = "opencode".to_string();
        first.model = "model-a".to_string();
        first.updated_at = "2026-01-02T00:00:00Z".to_string();
        let second = sample_session("b", ChatStatus::Stopped);

        let query = ChatSessionQuery {
            workspace_id: Some("100".to_string()),
            runtime_id: Some("opencode".to_string()),
            ..ChatSessionQuery::default()
        };
        let filtered = filter_sessions(vec![first.clone(), second], &query);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "a");

        let query = ChatSessionQuery {
            keyword: Some("项目".to_string()),
            limit: Some(1),
            ..ChatSessionQuery::default()
        };
        let filtered = filter_sessions(vec![first], &query);
        assert_eq!(filtered.len(), 1, "keyword matches workspace name");
        assert!(query_has_constraints(&query));
        assert!(!query_has_constraints(&ChatSessionQuery::default()));
    }

    #[test]
    fn store_round_trips() {
        let mut store = ChatStore::default();
        store
            .sessions
            .insert("a".to_string(), sample_session("a", ChatStatus::Running));
        let encoded = serde_json::to_string(&store).expect("serialize chat store");
        let loaded: ChatStore = serde_json::from_str(&encoded).expect("deserialize chat store");
        assert_eq!(loaded.sessions.len(), 1);
        let session = loaded.sessions.get("a").expect("session");
        assert_eq!(session.agent_session_id.as_deref(), Some("s-1"));
        assert_eq!(session.status, ChatStatus::Running);
    }

    #[test]
    fn title_collapses_whitespace_and_clips() {
        assert_eq!(chat_title("  hello\n world  "), "hello world");
        let long = "a".repeat(TITLE_MAX_CHARS + 20);
        let title = chat_title(&long);
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS);
        assert!(title.ends_with('…'));
    }
}
