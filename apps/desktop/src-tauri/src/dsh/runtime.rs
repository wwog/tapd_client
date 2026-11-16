//! Runtime supervision: system Node, composed profile, stdio pump, approvals.
//!
//! One child process serves every session. Control traffic is newline-delimited
//! JSON-RPC over stdio (documented SDK protocol); token-level streaming arrives
//! separately from our bridge plugin (P2d). Anything unexpected on stdout is
//! logged and ignored — a single bad frame must not take the runtime down.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dsh_host::profile::{PluginRow, ProfileSpec, ProviderConfig, ProviderModel, PROFILE_NAME};
use dsh_host::protocol::{
    ApprovalRequestParams, Capabilities, InitializeParams, InitializeResult, SessionQueryParams,
    UserQuestionRequest,
};
use dsh_host::rpc::{self, Incoming, RpcId};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::{payload, EVENT_APPROVAL, EVENT_ERROR, EVENT_QUESTION, EVENT_READY, EVENT_STATUS};
use crate::agent_settings::{self, DshModelConfig};
use crate::shell_path;

/// Environment variable carrying the custom provider key into the runtime.
/// The profile references it by name; the secret never enters a config file.
const API_KEY_ENV: &str = "TAPD_DSH_API_KEY";

/// Requests that never answered in time are abandoned; the UI shows an error
/// instead of hanging forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(90);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Stopped,
    Starting,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshStatus {
    pub phase: Phase,
    pub payload_version: Option<String>,
    pub node_version: Option<String>,
    pub node_path: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// Stable machine code (`node_missing`, `model_missing`, `payload_missing`,
    /// `spawn_failed`, `initialize_failed`, `exited`).
    pub error_code: Option<String>,
    pub error: Option<String>,
}

impl Default for DshStatus {
    fn default() -> Self {
        Self {
            phase: Phase::Stopped,
            payload_version: None,
            node_version: None,
            node_path: None,
            provider: None,
            model: None,
            error_code: None,
            error: None,
        }
    }
}

impl DshStatus {
    fn starting(version: String) -> Self {
        Self {
            phase: Phase::Starting,
            payload_version: Some(version),
            ..Self::default()
        }
    }

    fn failed(code: &str, message: impl Into<String>) -> Self {
        Self {
            phase: Phase::Failed,
            error_code: Some(code.to_string()),
            error: Some(message.into()),
            ..Self::default()
        }
    }
}

struct Running {
    stdin: mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, rpc::RpcError>>>>>,
    ids: Arc<AtomicU64>,
    child: Child,
    #[allow(dead_code)]
    runtime_dir: PathBuf,
}

/// Managed Tauri state for the built-in agent runtime.
pub struct RuntimeState {
    status: std::sync::Mutex<DshStatus>,
    running: Mutex<Option<Running>>,
    /// Serialises start attempts so two UI actions cannot spawn twice.
    start_lock: Mutex<()>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            status: std::sync::Mutex::new(DshStatus::default()),
            running: Mutex::new(None),
            start_lock: Mutex::new(()),
        }
    }
}

impl RuntimeState {
    pub fn status(&self) -> DshStatus {
        self.status.lock().expect("dsh status lock").clone()
    }

    fn set_status(&self, app: &AppHandle, status: DshStatus) -> DshStatus {
        *self.status.lock().expect("dsh status lock") = status.clone();
        let _ = app.emit(EVENT_STATUS, &status);
        status
    }

    fn fail(&self, app: &AppHandle, code: &str, message: impl Into<String>) -> String {
        let message = message.into();
        self.set_status(app, DshStatus::failed(code, message.clone()));
        let _ = app.emit(EVENT_ERROR, json!({ "code": code, "message": message }));
        message
    }

    /// Ensures the payload is extracted and the runtime is running and
    /// initialized. Safe to call repeatedly; concurrent callers serialise.
    pub async fn ensure_ready(&self, app: &AppHandle) -> Result<DshStatus, String> {
        let _guard = self.start_lock.lock().await;
        if let Some(running) = self.running.lock().await.as_mut() {
            if running.child.try_wait().ok().flatten().is_none() {
                return Ok(self.status());
            }
            // Reap and fall through to a fresh start.
            *self.running.lock().await = None;
        }

        let payload = match payload::ensure_payload(app) {
            Ok(payload) => payload,
            Err(error) => return Err(self.fail(app, "payload_missing", error)),
        };
        self.set_status(app, DshStatus::starting(payload.version.clone()));

        let (node_path, node_version) = match resolve_node() {
            Ok(node) => node,
            Err(error) => return Err(self.fail(app, "node_missing", error)),
        };

        let config = agent_settings::config_for(app);
        if !config.dsh_model.is_configured() {
            return Err(self.fail(
                app,
                "model_missing",
                "还没有配置模型 API：请先在「设置 → 模型」填写 API 地址与模型。",
            ));
        }

        let layout = match prepare_profile(app, &payload, &config.dsh_model) {
            Ok(layout) => layout,
            Err(error) => return Err(self.fail(app, "profile_failed", error)),
        };

        let mut child = match spawn_runtime(&node_path, &layout, &config.dsh_model) {
            Ok(child) => child,
            Err(error) => return Err(self.fail(app, "spawn_failed", error)),
        };

        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill().await;
                return Err(self.fail(app, "spawn_failed", "runtime stdout is unavailable"));
            }
        };
        if let Some(stderr) = child.stderr.take() {
            pump_stderr(stderr).await;
        }

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| self.fail(app, "spawn_failed", "runtime stdin is unavailable"))?;
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let mut stdin = stdin;
        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, rpc::RpcError>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let ids = Arc::new(AtomicU64::new(0));
        spawn_reader(app.clone(), stdout, pending.clone());

        *self.running.lock().await = Some(Running {
            stdin: tx,
            pending: pending.clone(),
            ids: ids.clone(),
            child,
            runtime_dir: layout.runtime_dir.clone(),
        });

        let provider = config.dsh_model.provider_id.clone();
        let model = config.dsh_model.model.clone();
        let params = InitializeParams {
            cwd: layout.default_cwd.to_string_lossy().to_string(),
            provider: provider.clone(),
            model: model.clone(),
            reasoning_effort: None,
            max_tokens: None,
            approval_requests: true,
            capabilities: Capabilities {
                user_questions: true,
            },
        };

        match self
            .call_with_timeout(
                rpc::METHOD_INITIALIZE,
                serde_json::to_value(params).unwrap_or(Value::Null),
                INITIALIZE_TIMEOUT,
            )
            .await
        {
            Ok(value) => {
                let result: InitializeResult = serde_json::from_value(value)
                    .map_err(|error| self.fail(app, "initialize_failed", error.to_string()))?;
                tracing::info!(server = %result.server_info.name, "built-in agent runtime ready");
            }
            Err(error) => {
                let _ = self.stop(app).await;
                return Err(self.fail(app, "initialize_failed", error));
            }
        }

        let status = DshStatus {
            phase: Phase::Ready,
            payload_version: Some(payload.version),
            node_version: Some(node_version),
            node_path: Some(node_path.to_string_lossy().to_string()),
            provider: Some(provider),
            model: Some(model),
            error_code: None,
            error: None,
        };
        let status = self.set_status(app, status);
        let _ = app.emit(EVENT_READY, &status);
        Ok(status)
    }

    /// Sends one request and waits for its response.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call_with_timeout(method, params, CALL_TIMEOUT).await
    }

    async fn call_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        let id = {
            let running = self.running.lock().await;
            let Some(running) = running.as_ref() else {
                return Err("内置 Agent 运行时未启动".to_string());
            };
            let id = running.ids.fetch_add(1, Ordering::SeqCst) + 1;
            running.pending.lock().await.insert(id, tx);
            running
                .stdin
                .send(rpc::encode_request(RpcId(id), method, params))
                .map_err(|_| "内置 Agent 运行时已退出".to_string())?;
            id
        };

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(error.message),
            Ok(Err(_)) => Err("内置 Agent 运行时中断了请求".to_string()),
            Err(_) => {
                let running = self.running.lock().await;
                if let Some(running) = running.as_ref() {
                    running.pending.lock().await.remove(&id);
                }
                Err(format!("{method} 超时"))
            }
        }
    }

    /// Answers a server-initiated request (approval / question) by its RPC id.
    pub async fn respond(&self, id: u64, result: Value) -> Result<(), String> {
        let running = self.running.lock().await;
        let Some(running) = running.as_ref() else {
            return Err("内置 Agent 运行时未启动".to_string());
        };
        running
            .stdin
            .send(rpc::encode_success(RpcId(id), result))
            .map_err(|_| "内置 Agent 运行时已退出".to_string())
    }

    /// Queues one prompt on a session, creating it on first use.
    pub async fn query(&self, session_id: &str, text: &str) -> Result<Value, String> {
        let params = SessionQueryParams {
            session_id: session_id.to_string(),
            content_blocks: vec![dsh_host::protocol::ContentBlock::Text {
                text: text.to_string(),
            }],
        };
        self.call(
            rpc::METHOD_SESSION_QUERY,
            serde_json::to_value(params).unwrap_or(Value::Null),
        )
        .await
    }

    pub async fn stop(&self, app: &AppHandle) -> Result<(), String> {
        let mut guard = self.running.lock().await;
        let Some(mut running) = guard.take() else {
            let status = self.set_status(app, DshStatus::default());
            let _ = status;
            return Ok(());
        };
        let _ = running
            .stdin
            .send(rpc::encode_request(RpcId(0), rpc::METHOD_SHUTDOWN, Value::Null));
        let deadline = tokio::time::Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            match running.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if tokio::time::Instant::now() >= deadline {
                        let _ = running.child.kill().await;
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(_) => break,
            }
        }
        drop(guard);
        self.set_status(app, DshStatus::default());
        Ok(())
    }
}

/// Composed paths for one runtime.
struct RuntimeLayout {
    runtime_dir: PathBuf,
    entry: PathBuf,
    home: PathBuf,
    default_cwd: PathBuf,
}

fn prepare_profile(
    app: &AppHandle,
    payload: &payload::PayloadStatus,
    model: &DshModelConfig,
) -> Result<RuntimeLayout, String> {
    let state = app
        .try_state::<Arc<crate::state::AppState>>()
        .ok_or_else(|| "app state unavailable".to_string())?;
    let data_dir = state.paths.data_dir.join("dsh");
    let home = data_dir.join("home");
    let profile_dir = home.join("profiles").join(PROFILE_NAME);
    let runtime_dir = payload.runtime_dir.clone();
    let entry = runtime_dir.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
    if !entry.exists() {
        return Err(format!("payload launcher missing at {}", entry.display()));
    }

    let plugins = plugin_rows(&runtime_dir);
    let provider = ProviderConfig {
        id: model.provider_id.clone(),
        display_name: if model.display_name.is_empty() {
            model.provider_id.clone()
        } else {
            model.display_name.clone()
        },
        api: model.protocol.clone(),
        base_url: model.base_url.clone(),
        api_key_env: if model.api_key.is_empty() {
            None
        } else {
            Some(API_KEY_ENV.to_string())
        },
        models: provider_models(model),
    };
    let spec = ProfileSpec {
        plugins,
        provider: Some(provider),
        team_default_enabled: Some(false),
    };
    spec.write(&profile_dir)
        .map_err(|error| format!("failed to write profile: {error}"))?;

    Ok(RuntimeLayout {
        runtime_dir,
        entry,
        home,
        default_cwd: default_cwd(app),
    })
}

/// Every `@tapd/*` package in the payload becomes a mounted plugin row.
fn plugin_rows(runtime_dir: &Path) -> Vec<PluginRow> {
    let scope = runtime_dir.join("node_modules/@tapd");
    let Ok(entries) = std::fs::read_dir(&scope) else {
        return Vec::new();
    };
    let mut rows: Vec<PluginRow> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let entry_path = entry.path().join("index.js");
            if !entry_path.exists() {
                return None;
            }
            let dir_name = entry.file_name().to_string_lossy().to_string();
            Some(PluginRow {
                id: dir_name.clone(),
                entry: entry_path.to_string_lossy().to_string(),
            })
        })
        .collect();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    rows
}

fn provider_models(model: &DshModelConfig) -> Vec<ProviderModel> {
    let mut ids: Vec<String> = Vec::new();
    if !model.model.trim().is_empty() {
        ids.push(model.model.trim().to_string());
    }
    for id in &model.models {
        let id = id.trim();
        if id.is_empty() || ids.iter().any(|item| item == id) {
            continue;
        }
        ids.push(id.to_string());
    }
    ids.into_iter()
        .map(|id| ProviderModel {
            name: id.clone(),
            id,
            context_window: model.context_window,
        })
        .collect()
}

/// Sessions inherit this directory unless the task later moves them.
fn default_cwd(app: &AppHandle) -> PathBuf {
    let state = app
        .try_state::<Arc<crate::state::AppState>>()
        .map(|state| state.paths.data_dir.clone());
    let config = agent_settings::config_for(app);
    let workspace = state
        .as_ref()
        .and_then(|_| config.projects.values().find(|project| !project.repo_path.is_empty()));
    if let Some(project) = workspace {
        let path = PathBuf::from(&project.repo_path);
        if path.is_dir() {
            return path;
        }
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or(state)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn spawn_runtime(
    node: &Path,
    layout: &RuntimeLayout,
    model: &DshModelConfig,
) -> Result<Child, String> {
    let mut command = Command::new(node);
    command
        .arg(&layout.entry)
        .arg("--profile")
        .arg(PROFILE_NAME)
        .current_dir(&layout.default_cwd)
        .env("DSH_HOME", &layout.home)
        // Finder-launched apps inherit a minimal PATH; the runtime shells out.
        .env("PATH", shell_path::user_path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if !model.api_key.is_empty() {
        command.env(API_KEY_ENV, &model.api_key);
    }
    command.spawn().map_err(|error| {
        format!(
            "failed to start {} {}: {error}",
            node.display(),
            layout.entry.display()
        )
    })
}

/// Reads stdout line by line and dispatches frames.
fn spawn_reader(
    app: AppHandle,
    stdout: tokio::process::ChildStdout,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, rpc::RpcError>>>>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    match rpc::decode(&line) {
                        Ok(Some(Incoming::Response { id, result })) => {
                            if let Some(sender) = pending.lock().await.remove(&id.0) {
                                let _ = sender.send(result);
                            }
                        }
                        Ok(Some(Incoming::Request { id, method, params })) => {
                            forward_request(&app, id, &method, params);
                        }
                        Ok(Some(Incoming::Notification { method, params })) => {
                            forward_notification(&app, &method, params);
                        }
                        Ok(None) => {}
                        Err(error) => {
                            tracing::warn!(%error, "ignored a malformed dsh frame");
                        }
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::warn!(%error, "dsh stdout closed");
                    break;
                }
            }
        }

        // The process ended: fail every request still waiting for an answer.
        pending.lock().await.clear();
        if let Some(state) = app.try_state::<Arc<RuntimeState>>() {
            let status = state.status();
            if status.phase != Phase::Stopped {
                state.set_status(&app, DshStatus::failed("exited", "内置 Agent 运行时已退出"));
            }
        }
    });
}

/// Server → client requests become UI events; the answer travels back by RPC id.
fn forward_request(app: &AppHandle, id: RpcId, method: &str, params: Value) {
    match method {
        rpc::METHOD_APPROVAL_REQUEST => match serde_json::from_value::<ApprovalRequestParams>(params) {
            Ok(params) => {
                let _ = app.emit(
                    EVENT_APPROVAL,
                    json!({ "rpcId": id.0, "request": params }),
                );
            }
            Err(error) => {
                tracing::warn!(%error, "invalid approval/request payload");
                answer_now(app, id, &json!({ "outcome": "cancelled" }));
            }
        },
        rpc::METHOD_USER_QUESTION => match serde_json::from_value::<UserQuestionRequest>(params) {
            Ok(params) => {
                let _ = app.emit(EVENT_QUESTION, json!({ "rpcId": id.0, "request": params }));
            }
            Err(error) => {
                tracing::warn!(%error, "invalid user-question payload");
                answer_now(app, id, &json!({ "cancelled": true }));
            }
        },
        other => {
            tracing::warn!(method = other, "unhandled dsh request");
            let _ = app.emit(EVENT_ERROR, json!({ "code": "unhandled_request", "message": other }));
            let _ = app.emit(EVENT_STATUS, ());
        }
    }
}

fn answer_now(app: &AppHandle, id: RpcId, result: &Value) {
    if let Some(state) = app.try_state::<Arc<RuntimeState>>() {
        let state = state.inner().clone();
        let result = result.clone();
        tauri::async_runtime::spawn(async move {
            let _ = state.respond(id.0, result).await;
        });
    }
}

fn forward_notification(app: &AppHandle, method: &str, params: Value) {
    match method {
        rpc::METHOD_SESSION_EVENT => {
            let _ = app.emit(super::EVENT_SESSION_EVENT, params);
        }
        rpc::METHOD_SESSION_QUERY_COMPLETED => {
            let _ = app.emit("dsh://query-completed", params);
        }
        other => {
            // session.status, subagent.*, user-question.cancelled: forwarded
            // verbatim so the UI can pick up anything the runtime adds.
            let _ = app.emit(
                "dsh://notification",
                json!({ "method": other, "params": params }),
            );
        }
    }
}

/// Continues reading stderr into the app log so a failed boot is diagnosable.
async fn pump_stderr(stderr: tokio::process::ChildStderr) {
    let lines = BufReader::new(stderr);
    tauri::async_runtime::spawn(async move {
        let mut lines = lines.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::info!(target: "dsh", "{line}");
        }
    });
}

/// Finds `node` on the user's shell PATH and applies the engine gate.
fn resolve_node() -> Result<(PathBuf, String), String> {
    let path = shell_path::user_path().to_string_lossy().to_string();
    let mut candidates: Vec<PathBuf> = Vec::new();
    for dir in path.split(':') {
        if dir.is_empty() {
            continue;
        }
        #[cfg(unix)]
        let candidate = Path::new(dir).join("node");
        #[cfg(windows)]
        let candidate = Path::new(dir).join("node.exe");
        if is_executable(&candidate) {
            candidates.push(candidate);
        }
    }
    // Finder-launched bundles sometimes miss Homebrew in their PATH.
    for extra in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        let candidate = PathBuf::from(extra);
        if is_executable(&candidate) {
            candidates.push(candidate);
        }
    }

    let mut last_error = String::new();
    for candidate in candidates {
        match node_version(&candidate) {
            Ok(version) => match dsh_host::node::evaluate(Some(&version)) {
                Ok(_) => return Ok((candidate, version)),
                Err(error) => {
                    return Err(format!(
                        "{error}。请升级 Node（https://nodejs.org）后重试。"
                    ))
                }
            },
            Err(error) => last_error = error,
        }
    }
    if last_error.is_empty() {
        Err("找不到 node。内置 Agent 需要系统安装 Node.js >= 24.9（不会随 App 打包）。".to_string())
    } else {
        Err(format!("{last_error}。内置 Agent 需要 Node.js >= 24.9。"))
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn node_version(node: &Path) -> Result<String, String> {
    let output = std::process::Command::new(node)
        .arg("--version")
        .output()
        .map_err(|error| format!("failed to run {}: {error}", node.display()))?;
    if !output.status.success() {
        return Err(format!("{} --version failed", node.display()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
