//! M7 — opencode agent queue, PTY session and console window.
//!
//! Owned by the M7 implementation. Exposed through `feature_command` names
//! starting with `agent_`.
//!
//! Design notes:
//! - The queue is strictly serial: one tokio worker picks `queued` tasks and
//!   runs them one at a time. Commands never start tasks directly. Every task
//!   body runs inside its own `tokio::spawn` so a panic cannot kill the worker.
//! - Each task gets a private `opencode serve` on a free loopback port. The
//!   TUI runs in a PTY connected to that server (`--server`), which lets the
//!   worker observe turn completion/permission asks and advance the queue
//!   without waiting for the TUI to exit.
//! - PTY work happens on dedicated std threads (reader, batcher, wait) so the
//!   async worker only awaits a oneshot result (or an event-driven completion
//!   notification).
//! - All task state changes are persisted atomically and broadcast through
//!   `agent://state` plus the lightweight `agent://summary`. Terminal output is
//!   batched and sent via `agent://output`.
//! - If the server surface is unavailable the worker falls back to the old
//!   TUI-only path (the TUI exit code decides), logging the reason instead of
//!   hanging the queue.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::RecvTimeoutError,
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tapd_core::store::{read_json, write_json_atomic};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::mpsc as tokio_mpsc;

use crate::{
    opencode::{self, PermissionReview, ServerProcess},
    shell_path,
    state::SharedState,
};

pub const MAIN_LABEL: &str = "main";

const CONFIG_FILE: &str = "agent.json";
const LOG_DIR: &str = "agent-logs";
const EVENTS_DIR: &str = "agent-events";
/// Pasted screenshots/videos; only their paths are handed to the agent.
const RESOURCE_DIR: &str = "agent-resources";
/// Keep per-task logs/events for the newest N tasks; older artifacts are
/// pruned so the data directory cannot grow without bound.
const ARTIFACT_TASK_LIMIT: usize = 200;
const ARTIFACT_PRUNE_INTERVAL_SECS: u64 = 6 * 60 * 60;

const DEFAULT_BINARY: &str = "opencode";
const DEFAULT_RUNTIME_ID: &str = "opencode";
const DEFAULT_TRANSPORT: &str = "acp";
const MAX_LOG_TAIL_BYTES: usize = 400 * 1024;
/// Cap the diff preview so a huge refactor cannot freeze the review panel.
const MAX_REVIEW_DIFF_CHARS: usize = 120_000;
/// Ignore completion events that arrive immediately after prompt injection
/// (the TUI may still be replaying history).
const COMPLETION_GRACE: Duration = Duration::from_secs(2);
/// Upper bound for waiting on the TUI to exit after a completion/cancel signal.
const PTY_TEARDOWN_TIMEOUT: Duration = Duration::from_secs(3);
/// When no session event shows up after the prompt was injected, the TUI
/// dropped the text (it was not accepting input yet). Re-inject once after this
/// delay; the task used to stay `running` forever in that case.
const PROMPT_RETRY_AFTER: Duration = Duration::from_secs(12);
/// Give up and fail the task when the agent session still never started.
const PROMPT_VERIFY_TIMEOUT: Duration = Duration::from_secs(30);
/// How often the injection watchdog re-checks the guard.
const PROMPT_WATCHDOG_TICK: Duration = Duration::from_secs(2);

pub const DEFAULT_PROMPT_TEMPLATE: &str = "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n项目规则：\n{{project_rule}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频，定位根因，做最小必要修改，并遵循团队代码规范。\n2. 修改后运行相关测试或构建。\n3. 判断改动复杂度：\n   - 简单缺陷（单文件或少量文件、局部改动，不涉及公共接口/数据模型/依赖/构建配置，测试通过）：直接 git commit（不要 push），提交成功后再在 TAPD 中评论并更新状态。\n   - 复杂缺陷（多文件、跨模块、涉及公共接口/数据模型/依赖/构建配置、风险较高或测试失败）：不要 commit，也不要修改 TAPD。调用 tapd_request_review 工具，taskId 使用 {{task_id}}，summary 说明根因、方案与影响范围，files 列出改动文件，risk 说明风险点，然后结束本轮等待用户审核。\n4. 任何情况下都不要在提交成功前评论或更新 TAPD 状态。";

/// Follow-up prompt injected after the user approves a paused review. The
/// working tree still holds the reviewed changes, so the agent only commits
/// and writes back to TAPD instead of redoing the fix.
pub const DEFAULT_COMMIT_PROMPT_TEMPLATE: &str = "审核已通过，请继续完成 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n项目规则：\n{{project_rule}}\n\n要求：\n1. 当前工作区保留了上一轮审核过的修改。先运行 git status / git diff 核对改动，不要重做或扩大范围。\n2. 运行必要的测试或构建，确认改动与缺陷相关。\n3. 提交代码（git commit，不要 push）。\n4. 提交成功后，再在 TAPD 中追加评论并更新缺陷状态；评论说明原由、解决方案与影响范围。\n5. 如果工作区已经没有未提交改动，说明上一轮已提交：核对提交记录后直接更新 TAPD，不要重复提交。\n6. 绝对不要在提交成功前评论或更新 TAPD 状态。";

/// Previous defaults; untouched installs are migrated to the current default
/// (which also carries the `{{project_rule}}` slot).
const LEGACY_PROMPT_TEMPLATES: &[&str] = &[
    "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频。\n2. 定位根因，做最小必要修改。\n3.修复时请遵循团队代码规范，确保代码可读、可维护。\n4. 修复完成后，提交代码并在 TAPD 中更新缺陷状态并简要评论原由以及解决方案和修复影响范围。",
    "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频。\n2. 定位根因，做最小必要修改。\n3. 修改后运行相关测试或构建。\n4. 不要自行 git commit / push，完成后说明改了哪些文件。",
];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Per-project agent settings, edited from the project card.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectAgentConfig {
    /// Absolute local repository path used as the agent's working directory.
    pub repo_path: String,
    /// Project-specific rules appended to (or injected into) the prompt.
    pub rule: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfig {
    /// Selected agent runtime id. Only `opencode` is available today; the
    /// runtime catalog is the single source of truth for this list.
    pub runtime_id: String,
    /// Wire protocol for the selected runtime. `acp` uses the bidirectional
    /// Agent Client Protocol; `pty` keeps the interactive TUI transport.
    pub transport: String,
    pub binary_path: String,
    /// Legacy map kept only for migration; use `projects` instead.
    pub repo_mappings: BTreeMap<String, String>,
    /// TAPD workspace id -> repository path + project rules.
    pub projects: BTreeMap<String, ProjectAgentConfig>,
    pub prompt_template: String,
    /// How long the TUI must stay quiet (after producing output) before we
    /// consider it ready and inject the task.
    pub ready_quiet_ms: u64,
    /// Upper bound for readiness detection; on expiry we inject anyway.
    pub ready_timeout_ms: u64,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            runtime_id: DEFAULT_RUNTIME_ID.to_string(),
            transport: DEFAULT_TRANSPORT.to_string(),
            binary_path: DEFAULT_BINARY.to_string(),
            repo_mappings: BTreeMap::new(),
            projects: BTreeMap::new(),
            prompt_template: DEFAULT_PROMPT_TEMPLATE.to_string(),
            ready_quiet_ms: 900,
            ready_timeout_ms: 15_000,
        }
    }
}

impl AgentConfig {
    fn sanitized(mut self) -> Self {
        let runtime = self.runtime_id.trim();
        self.runtime_id = match runtime_descriptor(runtime) {
            Some(descriptor) if descriptor.available => runtime.to_string(),
            _ => DEFAULT_RUNTIME_ID.to_string(),
        };

        self.transport = match self.transport.trim() {
            "pty" => "pty".to_string(),
            _ => DEFAULT_TRANSPORT.to_string(),
        };

        let binary = self.binary_path.trim();
        self.binary_path = if binary.is_empty() {
            DEFAULT_BINARY.to_string()
        } else {
            binary.to_string()
        };

        if self.prompt_template.trim().is_empty()
            || LEGACY_PROMPT_TEMPLATES
                .iter()
                .any(|legacy| self.prompt_template.trim() == *legacy)
        {
            self.prompt_template = DEFAULT_PROMPT_TEMPLATE.to_string();
        }

        self.ready_quiet_ms = self.ready_quiet_ms.clamp(100, 10_000);
        self.ready_timeout_ms = self.ready_timeout_ms.clamp(1_000, 120_000);

        // Migrate the old id -> path map into per-project settings once.
        for (workspace_id, path) in std::mem::take(&mut self.repo_mappings) {
            let path = path.trim().to_string();
            if path.is_empty() {
                continue;
            }
            self.projects
                .entry(workspace_id)
                .or_insert_with(ProjectAgentConfig::default)
                .repo_path = path;
        }

        self.projects = self
            .projects
            .into_iter()
            .map(|(workspace_id, project)| {
                let repo_path = project.repo_path.trim().to_string();
                let rule = project.rule.trim().to_string();
                (workspace_id, ProjectAgentConfig { repo_path, rule })
            })
            .filter(|(_, project)| !project.repo_path.is_empty() || !project.rule.is_empty())
            .collect();

        self
    }

    /// Repository path for a workspace (legacy map only exists pre-migration).
    fn repo_path_for(&self, workspace_id: &str) -> String {
        self.projects
            .get(workspace_id)
            .map(|project| project.repo_path.clone())
            .filter(|path| !path.is_empty())
            .or_else(|| self.repo_mappings.get(workspace_id).cloned())
            .unwrap_or_default()
    }

    /// Project rules for a workspace.
    fn rule_for(&self, workspace_id: &str) -> String {
        self.projects
            .get(workspace_id)
            .map(|project| project.rule.clone())
            .unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// Runtime catalog
// ---------------------------------------------------------------------------

/// A lifecycle stage every runtime must declare. `needs_human` stages block the
/// serial queue until the user acts; `terminal` stages are final states.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLifecycleStage {
    /// Matches `TaskStatus` snake_case keys (plus UI-only review stages).
    pub key: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub needs_human: bool,
    pub terminal: bool,
}

/// What the desktop is allowed to assume about a runtime. Anything false must
/// degrade to "send the user to review" instead of pretending it worked.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeCapabilities {
    /// PTY output + keystrokes.
    pub interactive_terminal: bool,
    /// Runtime raises blocking permission prompts at all.
    pub permission_prompt: bool,
    /// Desktop can answer the prompt and the runtime accepts that decision.
    pub external_decision: bool,
    /// Runtime exposes a session id that can be reopened later.
    pub session_resume: bool,
    /// Runtime can pause before committing for a human commit decision.
    pub commit_review: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub vendor: &'static str,
    pub description: &'static str,
    /// Default executable, used as the placeholder in the settings form.
    pub binary: &'static str,
    /// Wire protocols supported by this runtime, in preferred order.
    pub transports: Vec<&'static str>,
    pub default_transport: &'static str,
    /// False for future runtimes that are listed but not executable yet.
    pub available: bool,
    pub capabilities: AgentRuntimeCapabilities,
    pub lifecycle: Vec<AgentLifecycleStage>,
    /// Declared interoperability gaps, rendered verbatim in the management UI.
    pub limitations: Vec<&'static str>,
    /// What the UI does when an external decision cannot be applied.
    pub fallback: &'static str,
}

/// Single source of truth for the runtime list. Adding Claude Code later means
/// adding an adapter + one descriptor here, not branching the UI.
pub fn runtime_catalog() -> Vec<AgentRuntimeDescriptor> {
    vec![AgentRuntimeDescriptor {
        id: "opencode",
        name: "OpenCode",
        vendor: "SST",
        description: "终端式编码 Agent，支持 ACP 双向通信与 PTY 终端两种模式。",
        binary: DEFAULT_BINARY,
        transports: vec!["acp", "pty"],
        default_transport: "acp",
        available: true,
        capabilities: AgentRuntimeCapabilities {
            interactive_terminal: true,
            permission_prompt: true,
            external_decision: true,
            session_resume: true,
            commit_review: true,
        },
        lifecycle: vec![
            AgentLifecycleStage {
                key: "queued",
                label: "入队",
                description: "按 FIFO 排队，等待串行 worker 取出。",
                needs_human: false,
                terminal: false,
            },
            AgentLifecycleStage {
                key: "preparing",
                label: "启动",
                description: "导出缺陷包并在项目仓库中启动运行时。",
                needs_human: false,
                terminal: false,
            },
            AgentLifecycleStage {
                key: "running",
                label: "执行中",
                description: "Agent 修改代码；终端可随时接管操作。",
                needs_human: false,
                terminal: false,
            },
            AgentLifecycleStage {
                key: "waiting_review",
                label: "需要人工授权",
                description: "敏感操作必须人工确认；不能外部确认的运行时会被引导到终端。",
                needs_human: true,
                terminal: false,
            },
            AgentLifecycleStage {
                key: "awaiting_approval",
                label: "改动待审核",
                description: "复杂改动暂停提交，等待通过并提交或停止储藏。",
                needs_human: true,
                terminal: false,
            },
            AgentLifecycleStage {
                key: "succeeded",
                label: "任务完成",
                description: "提交与 TAPD 回写完成。",
                needs_human: false,
                terminal: true,
            },
            AgentLifecycleStage {
                key: "failed",
                label: "任务失败",
                description: "启动、执行或回写失败，错误保留在历史记录中。",
                needs_human: false,
                terminal: true,
            },
            AgentLifecycleStage {
                key: "canceled",
                label: "已取消",
                description: "用户中断任务或取消排队。",
                needs_human: false,
                terminal: true,
            },
        ],
        limitations: vec![
            "ACP 模式支持运行时给出的任意权限选项；PTY 模式仅支持「允许一次 / 总是允许 / 拒绝」。",
            "ACP 模式不提供交互式 TUI；需要手动接管时请切换到 PTY 传输。",
            "会话恢复依赖运行时返回 sessionId；未返回时只能查看日志。",
            "运行时不接受桌面回执时不会自动重试，任务会停在待审核并提示人工处理。",
        ],
        fallback: "当 ACP 权限请求无法回执或运行时不接受回执时，任务保持「待审核」；可切换到 PTY 传输后在终端处理。",
    }]
}

fn runtime_descriptor(id: &str) -> Option<AgentRuntimeDescriptor> {
    runtime_catalog()
        .into_iter()
        .find(|runtime| runtime.id == id)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AgentConfigPatch {
    runtime_id: Option<String>,
    transport: Option<String>,
    binary_path: Option<String>,
    repo_mappings: Option<BTreeMap<String, String>>,
    projects: Option<BTreeMap<String, ProjectAgentConfig>>,
    prompt_template: Option<String>,
    ready_quiet_ms: Option<u64>,
    ready_timeout_ms: Option<u64>,
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Preparing,
    Running,
    /// opencode asked for a permission decision (edit / bash / ...).
    WaitingReview,
    /// The agent finished a complex change and is waiting for the user to
    /// approve the commit. The working tree keeps the diff; the queue is
    /// blocked until the user approves or stops the task.
    AwaitingApproval,
    Succeeded,
    Failed,
    Canceled,
}

impl TaskStatus {
    /// A task occupying the single worker slot. `WaitingReview` still owns the
    /// slot: the agent is blocked on a human decision, not finished.
    /// `AwaitingApproval` also blocks the queue, but through the explicit
    /// awaiting-review check so the worker does not mistake it for a live turn.
    fn is_active(self) -> bool {
        matches!(self, Self::Preparing | Self::Running | Self::WaitingReview)
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Canceled)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    pub id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub bug_id: String,
    pub title: String,
    pub severity: String,
    pub priority: String,
    pub md_path: String,
    pub repo_path: String,
    pub status: TaskStatus,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub log_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub prompt: String,
    pub source: String,
    /// Runtime and transport selected when the task was enqueued, so switching
    /// settings later cannot change how an existing/queued task runs.
    #[serde(default = "default_task_runtime")]
    pub runtime_id: String,
    #[serde(default = "default_task_transport")]
    pub transport: String,
    /// opencode session id, learned from the server event stream. Persisted so
    /// history rows can reopen the conversation in a real terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Pending opencode permission ask; present while `status` is
    /// `waiting_review`. Absent in older persisted files (hence `default`).
    #[serde(default)]
    pub review: Option<PermissionReview>,
    /// Post-work review (complex change) shown in the 待审核 tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<TaskApproval>,
    /// Set after approval: the next run only verifies, commits and writes back
    /// to TAPD instead of repeating the fix.
    #[serde(default)]
    pub commit_only: bool,
    /// Files already dirty when the run started. The "uncommitted changes"
    /// safety net only considers files outside this set, so unrelated local
    /// work cannot turn every successful task into a review.
    #[serde(default)]
    pub baseline_dirty: Vec<String>,
    /// HEAD when the run started. If the agent committed, the safety net does
    /// not force a review for leftover untracked build artifacts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_head: Option<String>,
    /// User instructions from the compose sheet; appended to the prompt.
    #[serde(default)]
    pub extra_prompt: String,
    /// Local resource paths supplied with the task. Only paths reach the agent.
    #[serde(default)]
    pub attachments: Vec<String>,
}

/// A complex change the agent wants the user to approve before committing.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskApproval {
    pub summary: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<String>,
    pub requested_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_at: Option<String>,
    /// Stash reference recorded when the user stops instead of approving.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stash: Option<String>,
}

/// A bug another MCP client (external AI) is working on. The desktop queue
/// never takes over a fresh claim, and the list renders it as a live row.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExternalClaim {
    pub workspace_id: String,
    pub bug_id: String,
    #[serde(default)]
    pub title: String,
    /// MCP client name from the handshake (for example "Zcode").
    pub client: String,
    /// Model the client reports; empty when it did not say.
    #[serde(default)]
    pub model: String,
    /// `queued` (client is waiting for its turn) or `running`.
    pub status: String,
    #[serde(default)]
    pub note: String,
    pub claimed_at: String,
    pub last_seen_at: String,
}

/// How long a claim survives without a heartbeat. A crashed client must not
/// block a bug forever.
const EXTERNAL_CLAIM_TTL_SECS: i64 = 15 * 60;
/// Upper bound so a misbehaving client cannot grow the claim list forever.
const MAX_EXTERNAL_CLAIMS: usize = 200;
const EXTERNAL_CLAIMS_CACHE_KIND: &str = "external_claims";

/// Arguments for `tapd_claim_bug` / `agent_external_release`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExternalClaimRequest {
    pub workspace_id: String,
    pub bug_id: String,
    pub title: String,
    pub client: String,
    pub model: String,
    pub status: String,
    pub note: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExternalReleaseRequest {
    pub workspace_id: String,
    pub bug_id: String,
    pub client: Option<String>,
}

/// Why a claim was refused. `kind` is `desktop_agent` or `external`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalClaimConflict {
    pub kind: String,
    pub client: String,
    pub model: String,
    pub status: String,
    pub claimed_at: String,
    pub message: String,
}

pub struct ExternalClaimOutcome {
    pub claimed: bool,
    pub claim: Option<ExternalClaim>,
    pub conflict: Option<ExternalClaimConflict>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnqueueRequest {
    pub workspace_id: String,
    pub bug_id: String,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    /// Markdown instructions typed in the compose sheet.
    #[serde(default)]
    pub extra_prompt: Option<String>,
    /// Absolute paths to screenshots, videos or other resources.
    #[serde(default)]
    pub attachments: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTasksState {
    /// Live tasks only (`queued` .. `awaiting_approval`). Terminal history is
    /// fetched page by page through `agent_tasks_history`.
    tasks: Vec<AgentTask>,
    active_task_id: Option<String>,
    queued_count: usize,
    waiting_review_count: usize,
    awaiting_approval_count: usize,
    /// True after the user stopped a review; the worker stays idle until
    /// `agent_queue_resume`.
    queue_paused: bool,
    /// Fresh external AI claims. Stale ones are dropped when read.
    external_claims: Vec<ExternalClaim>,
}

/// Paginated terminal-task history. Filters and paging run in Rust so the
/// frontend never receives the full history.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct HistoryQuery {
    workspace_id: Option<String>,
    status: Option<String>,
    keyword: Option<String>,
    /// Focused task id; used by the island/enqueue flow to locate one row.
    task_id: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTasksPage {
    tasks: Vec<AgentTask>,
    total: usize,
    has_more: bool,
    /// Workspaces present in history, for the filter dropdown.
    workspaces: Vec<AgentWorkspaceRef>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentWorkspaceRef {
    id: String,
    name: String,
}

/// Lightweight state for the island capsule / tray badge.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    running: bool,
    waiting_review: bool,
    /// Number of tasks waiting for a commit decision (island/top-bar badge).
    awaiting_approval: usize,
    active_task_id: Option<String>,
    title: Option<String>,
    workspace_name: Option<String>,
    bug_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TaskCounts {
    queued: usize,
    active: usize,
    waiting_review: usize,
    awaiting_approval: usize,
}

/// Permission decision sent back to opencode.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PermissionReply {
    Once,
    Always,
    Reject,
}

impl PermissionReply {
    fn as_str(self) -> &'static str {
        match self {
            Self::Once => "once",
            Self::Always => "always",
            Self::Reject => "reject",
        }
    }
}

fn find_option(options: &[crate::acp::PermissionOption], kinds: &[&str]) -> Option<String> {
    kinds.iter().find_map(|kind| {
        options
            .iter()
            .find(|option| option.kind == *kind)
            .map(|option| option.option_id.clone())
    })
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TaskIdRequest {
    task_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskInputRequest {
    task_id: String,
    data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskResizeRequest {
    task_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionReplyRequest {
    task_id: String,
    response: PermissionReply,
    #[serde(default = "default_true")]
    remember: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PermissionOptionRequest {
    task_id: String,
    option_id: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DetectRequest {
    path: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SaveResourceRequest {
    /// Original file name, used only for the extension.
    name: String,
    /// Base64 bytes (a `data:` prefix is accepted).
    data: String,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptVars {
    /// Agent task id, passed to `tapd_request_review` for complex changes.
    pub task_id: String,
    pub title: String,
    pub md_path: String,
    pub repo_path: String,
    pub workspace_name: String,
    pub bug_id: String,
    pub severity: String,
    pub priority: String,
    /// Project-specific rules (from the project card in settings).
    pub project_rule: String,
    /// Extra instructions from the compose sheet, rendered as Markdown.
    pub user_prompt: String,
    /// Absolute resource paths; inserted into the prompt as a path list.
    pub attachments: Vec<String>,
}

impl PromptVars {
    fn from_task(task: &AgentTask) -> Self {
        Self {
            task_id: task.id.clone(),
            title: task.title.clone(),
            md_path: task.md_path.clone(),
            repo_path: task.repo_path.clone(),
            workspace_name: task.workspace_name.clone(),
            bug_id: task.bug_id.clone(),
            severity: task.severity.clone(),
            priority: task.priority.clone(),
            project_rule: String::new(),
            user_prompt: task.extra_prompt.clone(),
            attachments: task.attachments.clone(),
        }
    }
}

/// Replaces `{{variable}}` placeholders; unknown placeholders are left intact.
///
/// The project rule is exposed as `{{project_rule}}` so a global template can
/// decide where it lands; when the template has no such placeholder the rule is
/// appended as its own section instead of being silently dropped.
pub fn render_prompt(template: &str, vars: &PromptVars) -> String {
    let attachments = render_attachments(&vars.attachments);
    let pairs = [
        ("task_id", vars.task_id.as_str()),
        ("title", vars.title.as_str()),
        ("md_path", vars.md_path.as_str()),
        ("repo_path", vars.repo_path.as_str()),
        ("workspace_name", vars.workspace_name.as_str()),
        ("bug_id", vars.bug_id.as_str()),
        ("severity", vars.severity.as_str()),
        ("priority", vars.priority.as_str()),
        ("project_rule", vars.project_rule.as_str()),
        ("user_prompt", vars.user_prompt.as_str()),
        ("attachments", attachments.as_str()),
    ];

    let has_rule_slot = template.contains("{{project_rule}}");
    let has_prompt_slot = template.contains("{{user_prompt}}");
    let has_attachments_slot = template.contains("{{attachments}}");
    let mut rendered = template.to_string();
    for (key, value) in pairs {
        rendered = rendered.replace(&format!("{{{{{key}}}}}"), value);
    }

    let rule = vars.project_rule.trim();
    if !has_rule_slot && !rule.is_empty() {
        rendered.push_str("\n\n项目规则：\n");
        rendered.push_str(rule);
    }

    // The compose sheet works with any template: when the global template has
    // no explicit slot, append its sections instead of dropping the user input.
    let user_prompt = vars.user_prompt.trim();
    if !has_prompt_slot && !user_prompt.is_empty() {
        rendered.push_str("\n\n用户补充说明：\n");
        rendered.push_str(user_prompt);
    }
    if !has_attachments_slot && !attachments.is_empty() {
        rendered.push_str("\n\n用户附加资源（本地路径，请直接读取）：\n");
        rendered.push_str(&attachments);
    }
    rendered
}

/// One path per line, labelled by kind. Only paths are passed to the agent.
fn render_attachments(paths: &[String]) -> String {
    paths
        .iter()
        .filter(|path| !path.trim().is_empty())
        .map(|path| format!("- {}：{}", attachment_kind(path), path.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn attachment_kind(path: &str) -> &'static str {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "heic" | "svg" => "图片",
        "mp4" | "mov" | "webm" | "m4v" | "avi" | "mkv" => "视频",
        _ => "文件",
    }
}

fn next_queued_index(tasks: &[AgentTask]) -> Option<usize> {
    tasks
        .iter()
        .position(|task| task.status == TaskStatus::Queued)
}

fn default_task_runtime() -> String {
    DEFAULT_RUNTIME_ID.to_string()
}

/// Tasks persisted before ACP existed were all PTY runs.
fn default_task_transport() -> String {
    "pty".to_string()
}

/// The live task that already owns a bug, if any. Terminal tasks are ignored so
/// a bug can be fixed again after a cancel/failure.
fn live_task_for_bug<'a>(
    tasks: &'a [AgentTask],
    workspace_id: &str,
    bug_id: &str,
) -> Option<&'a AgentTask> {
    tasks.iter().find(|task| {
        task.workspace_id == workspace_id && task.bug_id == bug_id && !task.status.is_terminal()
    })
}

fn task_counts(tasks: &[AgentTask]) -> TaskCounts {
    let mut counts = TaskCounts {
        queued: 0,
        active: 0,
        waiting_review: 0,
        awaiting_approval: 0,
    };
    for task in tasks {
        match task.status {
            TaskStatus::Queued => counts.queued += 1,
            TaskStatus::Preparing | TaskStatus::Running | TaskStatus::WaitingReview => {
                counts.active += 1
            }
            TaskStatus::AwaitingApproval => counts.awaiting_approval += 1,
            _ => {}
        }
        if task.status == TaskStatus::WaitingReview {
            counts.waiting_review += 1;
        }
    }
    counts
}

/// Picks the task the console should display: active first, then the next
/// queued task, then the most recently created finished task.
fn active_task_id(tasks: &[AgentTask]) -> Option<String> {
    tasks
        .iter()
        .find(|task| task.status.is_active())
        .or_else(|| {
            tasks
                .iter()
                .find(|task| task.status == TaskStatus::AwaitingApproval)
        })
        .or_else(|| tasks.iter().find(|task| task.status == TaskStatus::Queued))
        .or_else(|| tasks.iter().rev().find(|task| task.status.is_terminal()))
        .map(|task| task.id.clone())
}

fn agent_summary(tasks: &[AgentTask]) -> AgentSummary {
    let active_id = active_task_id(tasks);
    let active = active_id
        .as_ref()
        .and_then(|id| tasks.iter().find(|task| &task.id == id));

    AgentSummary {
        running: tasks.iter().any(|task| task.status.is_active()),
        waiting_review: tasks
            .iter()
            .any(|task| task.status == TaskStatus::WaitingReview),
        awaiting_approval: tasks
            .iter()
            .filter(|task| task.status == TaskStatus::AwaitingApproval)
            .count(),
        active_task_id: active_id,
        title: active.map(|task| task.title.clone()),
        workspace_name: active.map(|task| task.workspace_name.clone()),
        bug_id: active.map(|task| task.bug_id.clone()),
    }
}

/// Repository path for a task: the value resolved when the task was enqueued
/// wins, then the current per-project config. The old `repo_mappings` map is
/// always empty after `sanitized()`, which used to fail every task.
fn resolve_repo_path(task: &AgentTask, config: &AgentConfig) -> Result<String, String> {
    let from_task = task.repo_path.trim();
    if !from_task.is_empty() {
        return Ok(from_task.to_string());
    }

    let from_config = config.repo_path_for(&task.workspace_id);
    let from_config = from_config.trim();
    if !from_config.is_empty() {
        return Ok(from_config.to_string());
    }

    Err("未配置项目仓库路径，请在 设置 → Agent 修复 中配置".to_string())
}

fn finish_status(canceled: bool, exit_code: Option<i32>) -> TaskStatus {
    if canceled {
        TaskStatus::Canceled
    } else if exit_code == Some(0) {
        TaskStatus::Succeeded
    } else {
        TaskStatus::Failed
    }
}

/// Parses `git status --porcelain` output into changed file paths.
fn parse_porcelain_files(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim_end();
            if line.len() < 4 {
                return None;
            }
            let path = line.get(3..)?.trim();
            if path.is_empty() {
                return None;
            }
            // Renames are reported as `old -> new`; keep the new path.
            let path = path.rsplit(" -> ").next().unwrap_or(path);
            Some(path.trim_matches('"').to_string())
        })
        .take(50)
        .collect()
}

/// Files still uncommitted in the task's repository. Empty on a clean tree or
/// when git is unavailable, so a failed check never blocks a task.
fn uncommitted_files(repo_path: &str) -> Vec<String> {
    let repo_path = repo_path.trim();
    if repo_path.is_empty() {
        return Vec::new();
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["status", "--porcelain"])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            parse_porcelain_files(&String::from_utf8_lossy(&output.stdout))
        }
        _ => Vec::new(),
    }
}

/// Current HEAD of the task repository, used to tell "committed" from "left
/// uncommitted changes".
fn git_head(repo_path: &str) -> Option<String> {
    let repo_path = repo_path.trim();
    if repo_path.is_empty() {
        return None;
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!sha.is_empty()).then_some(sha)
}

/// True when the task's repository gained a commit since the run started.
fn committed_since_baseline(task: &AgentTask) -> bool {
    let Some(before) = task.baseline_head.as_deref() else {
        return false;
    };
    git_head(&task.repo_path).is_some_and(|after| after != before)
}

/// Stashes the reviewed files (tracked and untracked) so a rejected review
/// never loses the agent's work. Restricting the pathspec keeps unrelated local
/// changes out of the stash. Returns a human-readable stash ref.
fn stash_changes(repo_path: &str, label: &str, files: &[String]) -> Result<String, String> {
    let mut command = std::process::Command::new("git");
    command
        .arg("-C")
        .arg(repo_path)
        .args(["stash", "push", "--include-untracked", "-m", label]);
    if !files.is_empty() {
        // Agent-supplied paths may be absolute; git pathspecs are repo-relative.
        let prefix = format!("{}/", repo_path.trim_end_matches('/'));
        command.arg("--");
        for file in files {
            let file = file.trim();
            if file.is_empty() {
                continue;
            }
            command.arg(file.strip_prefix(&prefix).unwrap_or(file));
        }
    }
    let output = command
        .output()
        .map_err(|error| format!("无法执行 git：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git stash 失败".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("No local changes") {
        return Ok("无未提交改动".to_string());
    }

    let reference = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["rev-parse", "--short", "refs/stash"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|reference| !reference.is_empty());
    Ok(match reference {
        Some(reference) => format!("stash@{{0}} ({reference})"),
        None => "stash@{0}".to_string(),
    })
}

/// Moves a task into the post-work review state without touching the working
/// tree. Returns whether the status changed.
fn set_awaiting_approval(
    task: &mut AgentTask,
    summary: String,
    files: Vec<String>,
    risk: Option<String>,
    now: &str,
) -> bool {
    task.status = TaskStatus::AwaitingApproval;
    task.review = None;
    task.finished_at = None;
    task.error = None;
    task.approval = Some(TaskApproval {
        summary,
        files,
        risk,
        requested_at: now.to_string(),
        approved_at: None,
        stash: None,
    });
    true
}

/// Applies a PTY/event outcome to a task. Returns whether anything changed.
///
/// A task that already reached a terminal state is never downgraded: a late
/// `finish_task` must not turn an event-driven `succeeded` into `failed`.
fn apply_finish(task: &mut AgentTask, outcome: &PtyOutcome, now: &str) -> bool {
    if task.status.is_terminal() || task.status == TaskStatus::AwaitingApproval {
        return false;
    }

    if task.status == TaskStatus::Canceled || outcome.canceled {
        task.status = TaskStatus::Canceled;
        task.finished_at = Some(now.to_string());
        if task.error.is_none() {
            task.error = Some("已取消".to_string());
        }
        task.review = None;
        return true;
    }

    task.finished_at = Some(now.to_string());
    task.exit_code = outcome.exit_code;
    task.review = None;

    let status = if outcome.completed {
        TaskStatus::Succeeded
    } else {
        finish_status(false, outcome.exit_code)
    };
    if status == TaskStatus::Succeeded {
        task.status = TaskStatus::Succeeded;
        task.error = None;
    } else {
        task.status = TaskStatus::Failed;
        let message = outcome
            .error
            .clone()
            .unwrap_or_else(|| match outcome.exit_code {
                Some(code) => format!("Agent 进程退出码 {code}"),
                None => "Agent 进程异常结束".to_string(),
            });
        task.error = Some(message);
    }
    true
}

/// Turn outcome already recorded in a task's event log.
#[derive(Clone, Debug, PartialEq, Eq)]
enum RecordedOutcome {
    Succeeded,
    Failed(String),
}

/// Reads the tail of `agent-events/<task>.jsonl` and returns the last
/// turn-boundary signal the client had already received.
///
/// The event log is appended by the SSE pump independently of task state, so it
/// still tells the truth when the client dies right after a turn finished.
/// Signals are only trusted after a turn actually started, which filters
/// history replayed by the server on reconnect.
fn last_recorded_outcome(events_dir: &Path, task_id: &str) -> Option<RecordedOutcome> {
    let path = events_dir.join(format!("{task_id}.jsonl"));
    let bytes = std::fs::read(&path).ok()?;
    let slice = if bytes.len() > MAX_LOG_TAIL_BYTES {
        &bytes[bytes.len() - MAX_LOG_TAIL_BYTES..]
    } else {
        &bytes[..]
    };
    let text = String::from_utf8_lossy(slice);

    let mut turn_started = false;
    let mut outcome = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let event_type = opencode::event_type(&event);
        if matches!(
            event_type.as_str(),
            "session.created" | "session.execution.started" | "session.inbox.delivered"
        ) {
            turn_started = true;
            outcome = None;
            continue;
        }
        if !turn_started {
            continue;
        }
        match opencode::turn_signal(&event_type, &event) {
            Some(opencode::TurnSignal::Succeeded) => outcome = Some(RecordedOutcome::Succeeded),
            Some(opencode::TurnSignal::Failed(message)) => {
                outcome = Some(RecordedOutcome::Failed(message));
            }
            Some(opencode::TurnSignal::Busy) | None => {}
        }
    }
    outcome
}

/// Marks tasks that were mid-flight when the client exited as finished, so the
/// queue can make progress after a restart. Returns how many were recovered.
///
/// A task that already recorded a turn outcome before the exit keeps that
/// outcome; everything else is reported as interrupted.
fn recover_incomplete(tasks: &mut [AgentTask], events_dir: &Path, now: &str) -> Vec<AgentTask> {
    let mut recovered = Vec::new();
    for task in tasks.iter_mut() {
        if !task.status.is_active() {
            continue;
        }
        match last_recorded_outcome(events_dir, &task.id) {
            Some(RecordedOutcome::Succeeded) => {
                task.status = TaskStatus::Succeeded;
                task.error = None;
                task.exit_code = Some(0);
            }
            Some(RecordedOutcome::Failed(message)) => {
                task.status = TaskStatus::Failed;
                task.error = Some(message);
                task.exit_code = None;
            }
            None => {
                task.status = TaskStatus::Failed;
                task.error = Some("客户端重启".to_string());
                task.exit_code = None;
            }
        }
        task.finished_at = Some(now.to_string());
        task.review = None;
        recovered.push(task.clone());
    }
    recovered
}

// ---------------------------------------------------------------------------
// PTY plumbing
// ---------------------------------------------------------------------------

struct PtyHandles {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    reader: Box<dyn Read + Send>,
    child: Box<dyn Child + Send + Sync>,
}

fn open_pty(
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

struct AgentRuntime {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// The TUI is started with `setsid`, so its pid is also the process-group
    /// id used to kill the whole TUI tree.
    pid: Option<u32>,
    canceled: Arc<AtomicBool>,
}

impl AgentRuntime {
    /// Signals the TUI process group and the direct child.
    fn kill(&mut self) {
        if let Some(pid) = self.pid {
            opencode::kill_process_group(pid, opencode::SIGTERM);
        }
        // portable-pty sends SIGHUP to the direct child on Unix.
        let _ = self.killer.kill();
        if let Some(pid) = self.pid {
            // The TUI is in its own session, so this also reaps grandchildren
            // (MCP servers, tool subprocesses) that ignore SIGHUP/SIGTERM.
            opencode::kill_process_group(pid, opencode::SIGKILL);
        }
    }
}

#[derive(Debug, Default)]
struct PtyOutcome {
    exit_code: Option<i32>,
    canceled: bool,
    /// Turn completion was observed through the server event stream; the TUI
    /// was torn down by the worker instead of exiting on its own.
    completed: bool,
    warning: Option<String>,
    error: Option<String>,
}

/// Tracks whether the initial prompt has been injected and when. Completion
/// events are ignored until the grace period has elapsed.
#[derive(Debug, Default)]
struct PromptGuard {
    injected: AtomicBool,
    injected_at: Mutex<Option<Instant>>,
    /// Set as soon as an event carries a session id, i.e. the injected prompt
    /// actually reached the agent. A TUI that is not ready yet silently drops
    /// the input, which leaves the task running with no session behind it.
    session_seen: AtomicBool,
}

impl PromptGuard {
    fn mark_injected(&self) {
        *self.injected_at.lock().expect("prompt guard lock") = Some(Instant::now());
        self.injected.store(true, Ordering::SeqCst);
    }

    fn injected(&self) -> bool {
        self.injected.load(Ordering::SeqCst)
    }

    fn mark_session_seen(&self) {
        self.session_seen.store(true, Ordering::SeqCst);
    }

    fn session_seen(&self) -> bool {
        self.session_seen.load(Ordering::SeqCst)
    }

    /// Time since the prompt was injected, `None` before injection.
    fn injected_elapsed(&self) -> Option<Duration> {
        self.injected_at
            .lock()
            .ok()
            .and_then(|at| at.map(|at| at.elapsed()))
    }

    fn completion_allowed(&self) -> bool {
        if !self.injected() {
            return false;
        }
        self.injected_at
            .lock()
            .expect("prompt guard lock")
            .map(|at| at.elapsed() >= COMPLETION_GRACE)
            .unwrap_or(false)
    }
}

/// Takes the longest complete UTF-8 prefix out of `buffer` and keeps an
/// incomplete trailing sequence for the next batch.
///
/// PTY reads are chunked, so a multi-byte character (e.g. Chinese text in the
/// TUI) can be split in half. Decoding such a batch used to surface as U+FFFD
/// in the terminal, which looked like corrupted output.
fn take_utf8_prefix(buffer: &mut Vec<u8>) -> Vec<u8> {
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

fn flush_output(
    app: &AppHandle,
    task_id: &str,
    log: &mut Option<std::fs::File>,
    pending: &mut Vec<u8>,
) {
    if pending.is_empty() {
        return;
    }
    let bytes = take_utf8_prefix(pending);
    if bytes.is_empty() {
        return;
    }
    if let Some(file) = log.as_mut() {
        let _ = file.write_all(&bytes);
        let _ = file.flush();
    }

    let text = String::from_utf8_lossy(&bytes).to_string();
    if text.is_empty() {
        return;
    }
    let _ = app.emit("agent://output", json!({ "taskId": task_id, "data": text }));
}

// ---------------------------------------------------------------------------
// Runtime core
// ---------------------------------------------------------------------------

/// Per-task server state. The process is kept even when the SSE subscription
/// failed so cancel can still abort the turn over HTTP.
struct ActiveServer {
    process: Arc<ServerProcess>,
    pump: Option<tauri::async_runtime::JoinHandle<()>>,
    consumer: Option<tauri::async_runtime::JoinHandle<()>>,
    session_id: Option<String>,
}

pub struct AgentCore {
    app: AppHandle,
    state: SharedState,
    config: Mutex<AgentConfig>,
    tasks: Mutex<Vec<AgentTask>>,
    /// External AI claims, keyed by workspace + bug (see `ExternalClaim`).
    external: Mutex<Vec<ExternalClaim>>,
    runtimes: Mutex<HashMap<String, Arc<Mutex<AgentRuntime>>>>,
    servers: Mutex<HashMap<String, ActiveServer>>,
    /// ACP clients keyed by task id (new protocol transports).
    acp_clients: Mutex<HashMap<String, Arc<crate::acp::Client>>>,
    /// Per-task cancel flag; created when the worker takes a queued task so a
    /// cancel can interrupt server startup before the PTY exists.
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Terminal size the UI asked for. The console can be opened before the
    /// PTY exists, so the size is remembered and applied when it starts.
    sizes: Mutex<HashMap<String, (u16, u16)>>,
    /// Set when the user stops a review. Persisted in `agent_queue_state` so a
    /// restart does not silently resume a queue the user halted.
    paused: AtomicBool,
    /// Snapshots of tasks changed since the last write. Cloning at the
    /// mutation point keeps persistence O(changed) even with a large history.
    pending_tasks: Mutex<HashMap<String, AgentTask>>,
    /// Task ids removed from memory that must be deleted from SQLite. A
    /// removal must also drop any pending snapshot for the id.
    removed_tasks: Mutex<HashSet<String>>,
    /// Serializes writers so an older snapshot can never overwrite a newer one.
    persist_lock: Mutex<()>,
    /// The queue-paused flag needs a write.
    paused_dirty: AtomicBool,
    /// Unix seconds of the last artifact scan (pruning is throttled).
    last_prune_secs: AtomicU64,
    wake: tokio::sync::Notify,
}

impl AgentCore {
    fn new(app: AppHandle, state: SharedState) -> Self {
        Self {
            app,
            state,
            config: Mutex::new(AgentConfig::default()),
            tasks: Mutex::new(Vec::new()),
            external: Mutex::new(Vec::new()),
            runtimes: Mutex::new(HashMap::new()),
            servers: Mutex::new(HashMap::new()),
            acp_clients: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            sizes: Mutex::new(HashMap::new()),
            paused: AtomicBool::new(false),
            pending_tasks: Mutex::new(HashMap::new()),
            removed_tasks: Mutex::new(HashSet::new()),
            persist_lock: Mutex::new(()),
            paused_dirty: AtomicBool::new(false),
            last_prune_secs: AtomicU64::new(0),
            wake: tokio::sync::Notify::new(),
        }
    }

    fn config_path(&self) -> PathBuf {
        self.state.paths.data_dir.join(CONFIG_FILE)
    }

    fn logs_dir(&self) -> PathBuf {
        self.state.paths.data_dir.join(LOG_DIR)
    }

    fn events_dir(&self) -> PathBuf {
        self.state.paths.data_dir.join(EVENTS_DIR)
    }

    fn load(&self) {
        let loaded = read_json::<AgentConfig>(&self.config_path())
            .unwrap_or_default()
            .sanitized();
        if let Err(error) = write_json_atomic(&self.config_path(), &loaded) {
            tracing::warn!(%error, "failed to persist agent config");
        }
        *self.config.lock().expect("agent config lock") = loaded;

        // SQLite is the only task store.
        let (mut tasks, paused) = self.state.cache.load_agent_tasks().unwrap_or_default();
        self.paused.store(paused, Ordering::SeqCst);
        self.paused_dirty.store(false, Ordering::SeqCst);

        let recovered = recover_incomplete(&mut tasks, &self.events_dir(), &now());
        if !recovered.is_empty() {
            tracing::warn!(
                recovered = recovered.len(),
                "recovered interrupted agent tasks"
            );
        }
        *self.tasks.lock().expect("agent tasks lock") = tasks;
        self.mark_tasks_dirty(recovered);

        let claims = self
            .state
            .cache
            .get_snapshot::<Vec<ExternalClaim>>(EXTERNAL_CLAIMS_CACHE_KIND, "latest")
            .map(|(claims, _)| claims)
            .unwrap_or_default();
        *self.external.lock().expect("external claims lock") = claims;

        let _ = std::fs::create_dir_all(self.logs_dir());
        let _ = std::fs::create_dir_all(self.events_dir());
        self.persist_tasks();
    }

    fn config_snapshot(&self) -> AgentConfig {
        self.config.lock().expect("agent config lock").clone()
    }

    // -----------------------------------------------------------------------
    // External AI claims
    // -----------------------------------------------------------------------

    fn persist_external_claims(&self) {
        let claims = self.external.lock().expect("external claims lock").clone();
        self.state
            .cache
            .put_snapshot(EXTERNAL_CLAIMS_CACHE_KIND, "latest", &claims);
    }

    /// Fresh claims only; stale rows are dropped and persisted away.
    fn external_claims_snapshot(&self) -> Vec<ExternalClaim> {
        let now = chrono::Utc::now().timestamp();
        let (claims, dropped) = {
            let mut claims = self.external.lock().expect("external claims lock");
            let before = claims.len();
            claims.retain(|claim| external_claim_fresh_at(claim, now));
            (claims.clone(), claims.len() != before)
        };
        if dropped {
            self.persist_external_claims();
        }
        claims
    }

    fn fresh_external_claim(&self, workspace_id: &str, bug_id: &str) -> Option<ExternalClaim> {
        let now = chrono::Utc::now().timestamp();
        external_claim_blocking(
            &self.external.lock().expect("external claims lock"),
            workspace_id,
            bug_id,
            now,
        )
        .cloned()
    }

    /// Registers an external AI claim. A queued desktop task yields to it, a
    /// running one wins, and another fresh external claim blocks it.
    async fn claim_external(
        &self,
        request: ExternalClaimRequest,
    ) -> Result<ExternalClaimOutcome, String> {
        let workspace_id = request.workspace_id.trim().to_string();
        let bug_id = request.bug_id.trim().to_string();
        if workspace_id.is_empty() || bug_id.is_empty() {
            return Err("缺少 workspaceId 或 bugId".to_string());
        }

        let client = {
            let value = request.client.trim();
            if value.is_empty() {
                "外部 AI".to_string()
            } else {
                truncate_text(value, 60)
            }
        };
        let model = truncate_text(request.model.trim(), 60);
        let status = match request.status.trim() {
            "queued" => "queued",
            _ => "running",
        }
        .to_string();
        let title = truncate_text(request.title.trim(), 200);
        let note = truncate_text(request.note.trim(), 500);
        let now = now();

        // Our own queue owns the bug: a queued task yields, a live one wins.
        let live = {
            let tasks = self.tasks.lock().expect("agent tasks lock");
            tasks
                .iter()
                .rev()
                .find(|task| {
                    task.workspace_id == workspace_id
                        && task.bug_id == bug_id
                        && !task.status.is_terminal()
                })
                .cloned()
        };
        if let Some(task) = live {
            let label = if title.is_empty() {
                task.title.clone()
            } else {
                title.clone()
            };
            if task.status == TaskStatus::Queued {
                // The task can finish between the snapshot and the cancel; a
                // terminal task must not block the external claim.
                if let Err(error) = self.cancel(&task.id).await {
                    let still_live = self
                        .task_snapshot(&task.id)
                        .is_some_and(|current| !current.status.is_terminal());
                    if still_live {
                        return Err(error);
                    }
                }
                let _ = crate::notification::raise_system_note(
                    "外部 AI 接管任务",
                    crate::notification::AiTone::Warning,
                    &format!("“{client}”接管了「{label}」，队列中的 Agent 任务已取消"),
                    Some(&format!("external-claim:{workspace_id}:{bug_id}:takeover")),
                );
            } else {
                let _ = crate::notification::raise_system_note(
                    "外部 AI 接管被拒绝",
                    crate::notification::AiTone::Warning,
                    &format!("“{client}”想接管「{label}」，桌面 Agent 正在处理，已拒绝"),
                    Some(&format!("external-claim:{workspace_id}:{bug_id}:rejected")),
                );
                return Ok(ExternalClaimOutcome {
                    claimed: false,
                    claim: None,
                    conflict: Some(ExternalClaimConflict {
                        kind: "desktop_agent".to_string(),
                        client: "TAPD Client".to_string(),
                        model: String::new(),
                        status: task_status_key(task.status).to_string(),
                        claimed_at: task
                            .started_at
                            .clone()
                            .unwrap_or_else(|| task.created_at.clone()),
                        message: "桌面 Agent 正在处理该缺陷，请勿修改；完成后会自动回写 TAPD"
                            .to_string(),
                    }),
                    message: "桌面 Agent 正在处理该缺陷，已拒绝外部占用".to_string(),
                });
            }
        }

        // Another external client may already own it.
        let now_secs = chrono::Utc::now().timestamp();
        let blocked = {
            let claims = self.external.lock().expect("external claims lock");
            claims
                .iter()
                .find(|claim| {
                    claim.workspace_id == workspace_id
                        && claim.bug_id == bug_id
                        && external_claim_fresh_at(claim, now_secs)
                        && claim.client != client
                })
                .cloned()
        };
        if let Some(existing) = blocked {
            return Ok(ExternalClaimOutcome {
                claimed: false,
                claim: None,
                conflict: Some(ExternalClaimConflict {
                    kind: "external".to_string(),
                    client: existing.client.clone(),
                    model: existing.model.clone(),
                    status: existing.status.clone(),
                    claimed_at: existing.claimed_at.clone(),
                    message: format!("该缺陷当前由{}处理", external_claim_phrase(&existing)),
                }),
                message: format!("该缺陷已被{}占用", external_claim_phrase(&existing)),
            });
        }

        // Insert a new claim, or refresh this client's heartbeat in place.
        let claim = {
            let mut claims = self.external.lock().expect("external claims lock");
            claims.retain(|claim| external_claim_fresh_at(claim, now_secs));
            if let Some(existing) = claims
                .iter_mut()
                .find(|claim| claim.workspace_id == workspace_id && claim.bug_id == bug_id)
            {
                if !title.is_empty() {
                    existing.title = title;
                }
                // A heartbeat may omit model/note; keep the last known values
                // instead of blanking the row.
                if !model.is_empty() {
                    existing.model = model;
                }
                if !note.is_empty() {
                    existing.note = note;
                }
                existing.status = status;
                existing.last_seen_at = now;
                existing.clone()
            } else {
                let claim = ExternalClaim {
                    workspace_id,
                    bug_id,
                    title,
                    client,
                    model,
                    status,
                    note,
                    claimed_at: now.clone(),
                    last_seen_at: now,
                };
                claims.push(claim.clone());
                // Oldest claims are dropped first if a client floods us.
                if claims.len() > MAX_EXTERNAL_CLAIMS {
                    claims.sort_by(|left, right| left.claimed_at.cmp(&right.claimed_at));
                    let extra = claims.len() - MAX_EXTERNAL_CLAIMS;
                    claims.drain(0..extra);
                }
                claim
            }
        };
        self.persist_external_claims();
        self.emit_state();

        Ok(ExternalClaimOutcome {
            claimed: true,
            claim: Some(claim),
            conflict: None,
            message: "已登记占用；请每 15 分钟内再次调用 tapd_claim_bug 续约，完成后调用 tapd_release_bug"
                .to_string(),
        })
    }

    /// Removes a claim. `client` is `Some` for MCP callers (they may only
    /// release their own claim) and `None` for the user's 取消 button.
    fn release_external(
        &self,
        workspace_id: &str,
        bug_id: &str,
        client: Option<&str>,
    ) -> Result<bool, String> {
        let now_secs = chrono::Utc::now().timestamp();
        let mut blocked_by: Option<String> = None;
        let removed = {
            let mut claims = self.external.lock().expect("external claims lock");
            let before = claims.len();
            claims.retain(|claim| {
                if claim.workspace_id != workspace_id || claim.bug_id != bug_id {
                    return true;
                }
                if !external_claim_fresh_at(claim, now_secs) {
                    return false;
                }
                if let Some(client) = client {
                    if claim.client != client {
                        blocked_by = Some(claim.client.clone());
                        return true;
                    }
                }
                false
            });
            before != claims.len()
        };
        if let Some(client) = blocked_by {
            return Err(format!("该缺陷当前由“{client}”占用"));
        }
        if removed {
            self.persist_external_claims();
            self.emit_state();
        }
        Ok(removed)
    }

    fn mark_task_dirty(&self, task: AgentTask) {
        self.pending_tasks
            .lock()
            .expect("agent pending lock")
            .insert(task.id.clone(), task);
    }

    fn mark_tasks_dirty<I>(&self, tasks: I)
    where
        I: IntoIterator<Item = AgentTask>,
    {
        let mut pending = self.pending_tasks.lock().expect("agent pending lock");
        for task in tasks {
            pending.insert(task.id.clone(), task);
        }
    }

    /// Updates the queue flag and marks it for persistence when it changes.
    fn set_paused(&self, paused: bool) {
        if self.paused.swap(paused, Ordering::SeqCst) != paused {
            self.paused_dirty.store(true, Ordering::SeqCst);
        }
    }

    fn persist_tasks(&self) {
        // One writer at a time: a drained older snapshot must not be written
        // after a newer one.
        let _writer = self.persist_lock.lock().expect("agent persist lock");

        // Drain the pending snapshots first: only tasks touched since the last
        // write are serialized, so persistence is O(changed).
        let tasks: Vec<AgentTask> = {
            let mut pending = self.pending_tasks.lock().expect("agent pending lock");
            if pending.is_empty() {
                Vec::new()
            } else {
                pending.drain().map(|(_, task)| task).collect()
            }
        };
        let removed: Vec<String> = {
            let mut removed = self.removed_tasks.lock().expect("agent removed lock");
            if removed.is_empty() {
                Vec::new()
            } else {
                removed.drain().collect()
            }
        };
        let paused_dirty = self.paused_dirty.swap(false, Ordering::SeqCst);
        if tasks.is_empty() && removed.is_empty() && !paused_dirty {
            return;
        }

        let paused = self.paused.load(Ordering::SeqCst);
        let persisted = self.state.cache.save_agent_tasks(&tasks, paused, &removed);
        if !persisted {
            // SQLite is unavailable. Re-read the latest in-memory state (a
            // mutation may have landed while the write was failing) so the
            // retry never resurrects an older snapshot.
            let failed: HashSet<&str> = tasks.iter().map(|task| task.id.as_str()).collect();
            let latest: Vec<AgentTask> = {
                let current = self.tasks.lock().expect("agent tasks lock");
                current
                    .iter()
                    .filter(|task| failed.contains(task.id.as_str()))
                    .cloned()
                    .collect()
            };
            let found: HashSet<&str> = latest.iter().map(|task| task.id.as_str()).collect();
            let missing: Vec<String> = failed
                .into_iter()
                .filter(|id| !found.contains(id))
                .map(str::to_string)
                .collect();

            self.mark_tasks_dirty(latest);
            if !missing.is_empty() {
                self.removed_tasks
                    .lock()
                    .expect("agent removed lock")
                    .extend(missing);
            }
            if !removed.is_empty() {
                self.removed_tasks
                    .lock()
                    .expect("agent removed lock")
                    .extend(removed);
            }
            if paused_dirty {
                self.paused_dirty.store(true, Ordering::SeqCst);
            }
            return;
        }

        self.maybe_prune_artifacts();
    }

    /// Prunes per-task logs/events at most once per `ARTIFACT_PRUNE_INTERVAL_SECS`.
    fn maybe_prune_artifacts(&self) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let last = self.last_prune_secs.load(Ordering::Relaxed);
        if now.saturating_sub(last) < ARTIFACT_PRUNE_INTERVAL_SECS {
            return;
        }
        self.last_prune_secs.store(now, Ordering::Relaxed);

        let keep: HashSet<String> = {
            let tasks = self.tasks.lock().expect("agent tasks lock");
            tasks
                .iter()
                .rev()
                .take(ARTIFACT_TASK_LIMIT)
                .map(|task| task.id.clone())
                .collect()
        };
        if keep.is_empty() {
            return;
        }
        prune_agent_artifacts(&self.logs_dir(), &self.events_dir(), &keep);
    }

    fn tasks_state(&self) -> AgentTasksState {
        let external_claims = self.external_claims_snapshot();
        let tasks = self.tasks.lock().expect("agent tasks lock");
        let counts = task_counts(tasks.as_slice());
        let live: Vec<AgentTask> = tasks
            .iter()
            .filter(|task| !task.status.is_terminal())
            .cloned()
            .collect();
        AgentTasksState {
            active_task_id: active_task_id(tasks.as_slice()),
            queued_count: counts.queued,
            waiting_review_count: counts.waiting_review,
            awaiting_approval_count: counts.awaiting_approval,
            queue_paused: self.paused.load(Ordering::SeqCst),
            tasks: live,
            external_claims,
        }
    }

    /// One page of terminal tasks, newest first. Filtering and paging happen
    /// here so the frontend never receives the whole history.
    fn history_page(&self, query: HistoryQuery) -> AgentTasksPage {
        let tasks = self.tasks.lock().expect("agent tasks lock");
        build_history_page(&tasks, query)
    }

    fn summary(&self) -> AgentSummary {
        agent_summary(&self.tasks.lock().expect("agent tasks lock"))
    }

    fn emit_state(&self) {
        let state = self.tasks_state();
        let summary = agent_summary(&state.tasks);
        let _ = self.app.emit("agent://state", state);
        let _ = self.app.emit("agent://summary", summary);
    }

    /// Runs `mutate` under the tasks lock and only persists/broadcasts when it
    /// reports changed task snapshots.
    fn mutate_tasks<F>(&self, mutate: F) -> bool
    where
        F: FnOnce(&mut Vec<AgentTask>) -> Vec<AgentTask>,
    {
        let changed = {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            mutate(&mut tasks)
        };
        if changed.is_empty() {
            return false;
        }
        self.mark_tasks_dirty(changed);
        self.persist_tasks();
        self.emit_state();
        true
    }

    fn update_task<F>(&self, task_id: &str, mutate: F) -> Option<AgentTask>
    where
        F: FnOnce(&mut AgentTask),
    {
        let snapshot = {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            let task = tasks.iter_mut().find(|task| task.id == task_id)?;
            mutate(task);
            task.clone()
        };
        self.mark_task_dirty(snapshot.clone());
        self.persist_tasks();
        self.emit_state();
        Some(snapshot)
    }

    fn task_snapshot(&self, task_id: &str) -> Option<AgentTask> {
        self.tasks
            .lock()
            .expect("agent tasks lock")
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
    }

    fn current_status(&self, task_id: &str) -> Option<TaskStatus> {
        self.task_snapshot(task_id).map(|task| task.status)
    }

    fn fail_task(&self, task_id: &str, message: String) {
        let changed = self.update_task(task_id, |task| {
            // Never downgrade a task that already reached a terminal state
            // (e.g. event-driven `succeeded` followed by a late teardown), and
            // never destroy a task that is waiting for the user's review.
            if task.status.is_terminal() || task.status == TaskStatus::AwaitingApproval {
                return;
            }
            task.status = TaskStatus::Failed;
            task.error = Some(message);
            task.finished_at = Some(now());
            task.review = None;
        });
        if changed.is_none() {
            tracing::warn!(task_id, "agent task disappeared while failing");
        }
    }

    fn update_config(&self, patch: AgentConfigPatch) -> AgentConfig {
        let next = {
            let mut config = self.config.lock().expect("agent config lock");
            if let Some(runtime_id) = patch.runtime_id {
                config.runtime_id = runtime_id;
            }
            if let Some(transport) = patch.transport {
                config.transport = transport;
            }
            if let Some(path) = patch.binary_path {
                config.binary_path = path;
            }
            if let Some(mappings) = patch.repo_mappings {
                config.repo_mappings = mappings;
            }
            if let Some(projects) = patch.projects {
                config.projects = projects;
            }
            if let Some(template) = patch.prompt_template {
                config.prompt_template = template;
            }
            if let Some(value) = patch.ready_quiet_ms {
                config.ready_quiet_ms = value;
            }
            if let Some(value) = patch.ready_timeout_ms {
                config.ready_timeout_ms = value;
            }
            config.clone().sanitized()
        };

        *self.config.lock().expect("agent config lock") = next.clone();
        if let Err(error) = write_json_atomic(&self.config_path(), &next) {
            tracing::warn!(%error, "failed to persist agent config");
        }
        next
    }

    fn enqueue(&self, request: &EnqueueRequest, source: &str) -> Result<AgentTask, String> {
        let workspace_id = request.workspace_id.trim();
        let bug_id = request.bug_id.trim();
        if workspace_id.is_empty() || bug_id.is_empty() {
            return Err("缺少 workspaceId 或 bugId".to_string());
        }

        let id = uuid::Uuid::new_v4().simple().to_string();
        let log_path = self.logs_dir().join(format!("{id}.log"));
        let _ = std::fs::create_dir_all(self.logs_dir());

        let config = self.config_snapshot();
        let workspace_name = request
            .workspace_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| workspace_id.to_string());
        let title = request
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("缺陷 {bug_id}"));
        let severity = request.severity.clone().unwrap_or_default();
        let priority = request.priority.clone().unwrap_or_default();
        let repo_path = config.repo_path_for(workspace_id);
        let extra_prompt = request
            .extra_prompt
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        let mut seen = std::collections::HashSet::new();
        let attachments: Vec<String> = request
            .attachments
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty() && seen.insert(path.clone()))
            .collect();

        let task = AgentTask {
            id,
            workspace_id: workspace_id.to_string(),
            workspace_name,
            bug_id: bug_id.to_string(),
            title,
            severity: severity.trim().to_string(),
            priority: priority.trim().to_string(),
            md_path: String::new(),
            repo_path,
            status: TaskStatus::Queued,
            created_at: now(),
            started_at: None,
            finished_at: None,
            exit_code: None,
            log_path: log_path.to_string_lossy().to_string(),
            error: None,
            prompt: String::new(),
            source: source.to_string(),
            runtime_id: config.runtime_id.clone(),
            transport: config.transport.clone(),
            session_id: None,
            review: None,
            approval: None,
            commit_only: false,
            baseline_dirty: Vec::new(),
            baseline_head: None,
            extra_prompt,
            attachments,
        };

        // An external AI already owns the bug: do not duplicate work.
        if let Some(claim) = self.fresh_external_claim(workspace_id, bug_id) {
            return Err(format!(
                "{}，请稍后再试或先在列表中取消外部占用",
                external_claim_phrase(&claim)
            ));
        }

        // One bug owns at most one live task. A double click, the notification
        // flow and a manual enqueue can race; checking and pushing under the
        // same lock makes the operation idempotent.
        {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            if let Some(existing) = live_task_for_bug(&tasks, workspace_id, bug_id) {
                return Ok(existing.clone());
            }
            tasks.push(task.clone());
        }
        self.mark_task_dirty(task.clone());
        self.persist_tasks();
        self.emit_state();
        self.wake.notify_one();

        tracing::info!(task_id = %task.id, bug_id = %task.bug_id, source, "agent task queued");
        Ok(task)
    }

    /// Cancels a task: aborts the active turn over HTTP (best effort), kills
    /// the TUI process group and, later, the per-task server.
    async fn cancel(&self, task_id: &str) -> Result<AgentTask, String> {
        let (snapshot, server, session_id) = {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            let task = tasks
                .iter_mut()
                .find(|task| task.id == task_id)
                .ok_or_else(|| "任务不存在".to_string())?;

            if task.status.is_terminal() {
                return Err("任务已经结束，无需取消".to_string());
            }
            let review_session = task.review.as_ref().map(|review| review.session_id.clone());
            task.status = TaskStatus::Canceled;
            task.finished_at = Some(now());
            task.review = None;
            if task.error.is_none() {
                task.error = Some("已取消".to_string());
            }
            let snapshot = task.clone();

            let (server, session_id) = self
                .servers
                .lock()
                .expect("agent servers lock")
                .get(task_id)
                .map(|state| {
                    (
                        Some(state.process.clone()),
                        state.session_id.clone().or(review_session),
                    )
                })
                .unwrap_or((None, None));

            (snapshot, server, session_id)
        };

        if let Some(flag) = self
            .cancels
            .lock()
            .expect("agent cancels lock")
            .get(task_id)
            .cloned()
        {
            flag.store(true, Ordering::SeqCst);
        }

        if let (Some(server), Some(session_id)) = (server, session_id) {
            match tokio::time::timeout(Duration::from_secs(3), server.abort_session(&session_id))
                .await
            {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!(task_id, %error, "failed to abort opencode session");
                }
                Err(_) => tracing::warn!(task_id, "opencode abort timed out"),
            }
        }

        // ACP: send the protocol cancel notification, then kill the process.
        let acp_client = self
            .acp_clients
            .lock()
            .expect("agent acp lock")
            .get(task_id)
            .cloned();
        if let Some(client) = acp_client {
            if let Some(session_id) = snapshot.session_id.clone() {
                let _ =
                    tokio::time::timeout(Duration::from_secs(3), client.cancel(&session_id)).await;
            }
        }

        self.stop_runtime(task_id);
        self.mark_task_dirty(snapshot.clone());
        self.persist_tasks();
        self.emit_state();
        Ok(snapshot)
    }

    /// Kills the TUI process group and closes its PTY handles. Idempotent.
    fn stop_runtime(&self, task_id: &str) {
        if let Some(client) = self
            .acp_clients
            .lock()
            .expect("agent acp lock")
            .remove(task_id)
        {
            client.kill();
        }
        let runtime = self
            .runtimes
            .lock()
            .expect("agent runtimes lock")
            .remove(task_id);
        if let Some(runtime) = runtime {
            let mut runtime = runtime.lock().expect("agent runtime lock");
            runtime.canceled.store(true, Ordering::SeqCst);
            runtime.kill();
        }
    }

    /// Full teardown for a task: cancel flag, TUI process group, server process
    /// group and the background SSE tasks. Safe to call repeatedly.
    fn teardown_task(&self, task_id: &str) {
        if let Some(flag) = self
            .cancels
            .lock()
            .expect("agent cancels lock")
            .remove(task_id)
        {
            flag.store(true, Ordering::SeqCst);
        }

        self.stop_runtime(task_id);
        self.sizes.lock().expect("agent sizes lock").remove(task_id);

        let server = self
            .servers
            .lock()
            .expect("agent servers lock")
            .remove(task_id);
        if let Some(state) = server {
            if let Some(pump) = state.pump {
                pump.abort();
            }
            if let Some(consumer) = state.consumer {
                consumer.abort();
            }
            state.process.stop();
        }
    }

    fn server_for(&self, task_id: &str) -> Option<Arc<ServerProcess>> {
        self.servers
            .lock()
            .expect("agent servers lock")
            .get(task_id)
            .map(|state| state.process.clone())
    }

    /// Persists a session id discovered from server events.
    fn remember_session(&self, task_id: &str, session_id: &str) {
        if session_id.is_empty() {
            return;
        }
        if let Some(state) = self
            .servers
            .lock()
            .expect("agent servers lock")
            .get_mut(task_id)
        {
            state.session_id = Some(session_id.to_string());
        }

        // Persist the relation on the task so history can reopen the session.
        let recorded = self.mutate_tasks(|tasks| {
            let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                return Vec::new();
            };
            if task.session_id.as_deref() == Some(session_id) {
                return Vec::new();
            }
            task.session_id = Some(session_id.to_string());
            vec![task.clone()]
        });
        if recorded {
            tracing::debug!(task_id, session_id, "agent session id recorded");
        }
    }

    /// Kills every TUI and `opencode serve` this process started.
    ///
    /// Both are started in their own session, so a plain process exit leaves
    /// them running: the turn keeps going after the window is gone and keeps
    /// writing back to TAPD while the task already looks abandoned.
    fn shutdown(&self) {
        let task_ids: Vec<String> = match self.tasks.lock() {
            Ok(tasks) => tasks.iter().map(|task| task.id.clone()).collect(),
            Err(error) => {
                tracing::warn!(%error, "agent tasks lock poisoned during shutdown");
                Vec::new()
            }
        };
        for task_id in &task_ids {
            self.teardown_task(task_id);
        }
        tracing::info!(tasks = task_ids.len(), "agent processes stopped");
    }

    /// Marks a task succeeded from a turn-boundary event. Returns whether the
    /// status changed; terminal tasks are never touched.
    fn mark_succeeded(&self, task_id: &str) -> bool {
        // A turn that ends with uncommitted changes is treated as a review,
        // even when the model forgot to call `tapd_request_review`. This is the
        // safety net that keeps a forgotten diff from being lost. The approved
        // commit phase is exempt: it is supposed to commit, not ask again.
        let review_files = match self.task_snapshot(task_id) {
            Some(task)
                if !task.commit_only
                    && !task.status.is_terminal()
                    && !committed_since_baseline(&task) =>
            {
                uncommitted_files(&task.repo_path)
                    .into_iter()
                    .filter(|file| !task.baseline_dirty.contains(file))
                    .collect()
            }
            _ => Vec::new(),
        };
        let at = now();

        self.mutate_tasks(|tasks| {
            let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                return Vec::new();
            };
            if task.status.is_terminal() || task.status == TaskStatus::AwaitingApproval {
                return Vec::new();
            }
            // A permission prompt keeps the turn alive; an idle event that
            // races with it must not silently complete the task.
            if task.status == TaskStatus::WaitingReview {
                return Vec::new();
            }
            if !review_files.is_empty() {
                return if set_awaiting_approval(
                    task,
                    "Agent 已完成修改但未提交，等待确认后提交。".to_string(),
                    review_files,
                    Some("存在未提交的改动".to_string()),
                    &at,
                ) {
                    vec![task.clone()]
                } else {
                    Vec::new()
                };
            }
            task.status = TaskStatus::Succeeded;
            task.finished_at = Some(at);
            task.exit_code = Some(0);
            task.error = None;
            task.review = None;
            vec![task.clone()]
        })
    }

    /// Fails a task from a turn-boundary event (guarded like `fail_task`).
    fn fail_from_event(&self, task_id: &str, message: String) -> bool {
        self.mutate_tasks(|tasks| {
            let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                return Vec::new();
            };
            if task.status.is_terminal() || task.status == TaskStatus::AwaitingApproval {
                return Vec::new();
            }
            task.status = TaskStatus::Failed;
            task.finished_at = Some(now());
            task.error = Some(message);
            task.review = None;
            vec![task.clone()]
        })
    }

    fn set_review(&self, task_id: &str, review: PermissionReview) {
        self.mutate_tasks(|tasks| {
            let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                return Vec::new();
            };
            if task.status.is_terminal() {
                return Vec::new();
            }
            let unchanged =
                task.review.as_ref() == Some(&review) && task.status == TaskStatus::WaitingReview;
            if unchanged {
                return Vec::new();
            }
            task.review = Some(review);
            task.status = TaskStatus::WaitingReview;
            vec![task.clone()]
        });
    }

    fn clear_review(&self, task_id: &str, permission_id: Option<&str>) {
        self.mutate_tasks(|tasks| {
            let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                return Vec::new();
            };
            let Some(current) = task.review.as_ref() else {
                return Vec::new();
            };
            if let Some(permission_id) = permission_id {
                if current.id != permission_id {
                    return Vec::new();
                }
            }
            task.review = None;
            if task.status == TaskStatus::WaitingReview {
                task.status = TaskStatus::Running;
            }
            vec![task.clone()]
        });
    }

    /// Replies to the pending permission ask and resumes the task.
    async fn reply_permission(
        &self,
        task_id: &str,
        response: PermissionReply,
        remember: bool,
    ) -> Result<AgentTask, String> {
        let task = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status.is_terminal() {
            return Err("任务已经结束".to_string());
        }
        let review = task
            .review
            .clone()
            .ok_or_else(|| "没有待处理的权限请求".to_string())?;

        // ACP: the agent already told us which options it accepts; answer
        // through the protocol instead of the legacy opencode HTTP surface.
        if review.transport == "acp" {
            let option_id = match response {
                PermissionReply::Once => {
                    find_option(&review.options, &["allow_once", "allow_always"]).or_else(|| {
                        review
                            .options
                            .first()
                            .map(|option| option.option_id.clone())
                    })
                }
                PermissionReply::Always => {
                    find_option(&review.options, &["allow_always", "allow_once"]).or_else(|| {
                        review
                            .options
                            .first()
                            .map(|option| option.option_id.clone())
                    })
                }
                PermissionReply::Reject => {
                    find_option(&review.options, &["reject_once", "reject_always"])
                }
            }
            .ok_or_else(|| "该权限请求没有可用的拒绝选项".to_string())?;
            let client = self
                .acp_clients
                .lock()
                .expect("agent acp lock")
                .get(task_id)
                .cloned()
                .ok_or_else(|| "ACP 进程未运行，无法回复权限请求".to_string())?;
            client.respond_permission(&review.id, Some(option_id))?;
            return self.clear_permission_review(task_id);
        }

        let server = self
            .server_for(task_id)
            .ok_or_else(|| "Agent 服务未运行，无法回复权限请求".to_string())?;

        tokio::time::timeout(
            Duration::from_secs(10),
            server.reply_permission(&review.session_id, &review.id, response.as_str(), remember),
        )
        .await
        .map_err(|_| "回复权限请求超时".to_string())?
        .map_err(|error| format!("回复权限请求失败：{error}"))?;

        self.clear_permission_review(task_id)
    }

    /// Answers an ACP permission request with one of the exact option ids the
    /// agent offered. This is what the ACP review card uses.
    async fn reply_permission_option(
        &self,
        task_id: &str,
        option_id: &str,
    ) -> Result<AgentTask, String> {
        let task = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status.is_terminal() {
            return Err("任务已经结束".to_string());
        }
        let review = task
            .review
            .clone()
            .ok_or_else(|| "没有待处理的权限请求".to_string())?;
        if review.transport != "acp" {
            return Err("该任务不是 ACP 权限请求".to_string());
        }
        if !review
            .options
            .iter()
            .any(|option| option.option_id == option_id)
        {
            return Err("未知的权限选项".to_string());
        }
        let client = self
            .acp_clients
            .lock()
            .expect("agent acp lock")
            .get(task_id)
            .cloned()
            .ok_or_else(|| "ACP 进程未运行，无法回复权限请求".to_string())?;
        client.respond_permission(&review.id, Some(option_id.to_string()))?;
        self.clear_permission_review(task_id)
    }

    fn clear_permission_review(&self, task_id: &str) -> Result<AgentTask, String> {
        let updated = self.mutate_tasks(|tasks| {
            let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                return Vec::new();
            };
            task.review = None;
            if !task.status.is_terminal() {
                task.status = TaskStatus::Running;
            }
            vec![task.clone()]
        });
        if !updated {
            return Err("任务不存在".to_string());
        }
        self.task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())
    }

    // -- post-work review ---------------------------------------------------

    /// True while any task waits for a commit decision; the worker must not
    /// start the next queued task.
    fn has_awaiting_approval(&self) -> bool {
        self.tasks
            .lock()
            .expect("agent tasks lock")
            .iter()
            .any(|task| task.status == TaskStatus::AwaitingApproval)
    }

    /// Marks the active task as awaiting the user's commit decision and stops
    /// the turn so the agent cannot keep editing after asking for review.
    async fn request_review(
        &self,
        task_id: &str,
        summary: String,
        files: Vec<String>,
        risk: Option<String>,
    ) -> Result<Value, String> {
        let task = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if !matches!(
            task.status,
            TaskStatus::Preparing | TaskStatus::Running | TaskStatus::WaitingReview
        ) {
            return Err("任务不在运行中，无法请求审核".to_string());
        }

        let at = now();
        let updated = self
            .update_task(task_id, |task| {
                if !matches!(
                    task.status,
                    TaskStatus::Preparing | TaskStatus::Running | TaskStatus::WaitingReview
                ) {
                    return;
                }
                set_awaiting_approval(task, summary, files, risk, &at);
            })
            .ok_or_else(|| "任务不存在".to_string())?;
        if updated.status != TaskStatus::AwaitingApproval {
            return Err("任务状态已变化，无法请求审核".to_string());
        }

        // Best effort abort of the model turn, then kill the TUI. The working
        // tree is deliberately left untouched so approval can commit it.
        let server_session = self
            .servers
            .lock()
            .expect("agent servers lock")
            .get(task_id)
            .and_then(|state| {
                state
                    .session_id
                    .as_ref()
                    .map(|session_id| (state.process.clone(), session_id.clone()))
            });
        if let Some((server, session_id)) = server_session {
            let _ = tokio::time::timeout(Duration::from_secs(3), server.abort_session(&session_id))
                .await;
        }
        let acp_client = self
            .acp_clients
            .lock()
            .expect("agent acp lock")
            .get(task_id)
            .cloned();
        if let Some(client) = acp_client {
            if let Some(session_id) = updated.session_id.clone() {
                let _ =
                    tokio::time::timeout(Duration::from_secs(3), client.cancel(&session_id)).await;
            }
        }
        self.stop_runtime(task_id);
        self.persist_tasks();
        self.emit_state();

        tracing::info!(task_id, "agent task awaiting commit approval");
        Ok(json!({ "status": "pending_review", "taskId": task_id }))
    }

    /// Approves a paused change: the task re-enters the queue and the next run
    /// only verifies, commits and writes back to TAPD.
    fn approve_review(&self, task_id: &str) -> Result<AgentTask, String> {
        let task = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != TaskStatus::AwaitingApproval {
            return Err("任务不在待审核状态".to_string());
        }
        if !Path::new(task.repo_path.trim()).is_dir() {
            return Err(format!("本地仓库路径不存在：{}", task.repo_path));
        }

        // Approving is an explicit "continue" signal, so a queue paused by an
        // earlier stop resumes unless another review still blocks it.
        self.set_paused(false);
        let at = now();
        let updated = self
            .update_task(task_id, |task| {
                task.status = TaskStatus::Queued;
                task.commit_only = true;
                task.finished_at = None;
                task.error = None;
                task.review = None;
                if let Some(approval) = task.approval.as_mut() {
                    approval.approved_at = Some(at);
                }
            })
            .ok_or_else(|| "任务不存在".to_string())?;

        tracing::info!(task_id, "agent review approved and requeued");
        self.wake.notify_one();
        Ok(updated)
    }

    /// Stops a paused review: the uncommitted diff is stashed (including
    /// untracked files) so nothing is lost, the task is canceled and the queue
    /// stays paused until the user resumes it.
    async fn stop_review(&self, task_id: &str) -> Result<AgentTask, String> {
        let task = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != TaskStatus::AwaitingApproval {
            return Err("任务不在待审核状态".to_string());
        }
        let repo = task.repo_path.trim().to_string();
        if repo.is_empty() || !Path::new(&repo).is_dir() {
            return Err(format!("本地仓库路径不存在：{}", task.repo_path));
        }

        let label = format!("tapd-agent {} #{}", task.bug_id, task.id);
        let reviewed = task
            .approval
            .as_ref()
            .map(|approval| approval.files.clone())
            .unwrap_or_default();
        let files = if reviewed.is_empty() {
            // No file list (e.g. model omitted it): use the run's own new
            // changes, excluding files that were already dirty before it.
            uncommitted_files(&repo)
                .into_iter()
                .filter(|file| !task.baseline_dirty.contains(file))
                .collect()
        } else {
            reviewed
        };
        let repo_for_check = repo.clone();
        let stash = tokio::task::spawn_blocking(move || stash_changes(&repo, &label, &files))
            .await
            .map_err(|error| format!("储藏改动失败：{error}"))?
            .map_err(|error| format!("储藏改动失败：{error}"))?;

        self.teardown_task(task_id);
        self.set_paused(true);
        let mut message = if stash.contains("无未提交改动") {
            format!("已停止：{stash}")
        } else {
            format!("已停止，改动已储藏：{stash}")
        };
        // Files the model did not list stay in the worktree; say so instead of
        // claiming the whole change was stashed.
        let remaining = uncommitted_files(&repo_for_check)
            .into_iter()
            .filter(|file| !task.baseline_dirty.contains(file))
            .count();
        if remaining > 0 {
            message.push_str(&format!(
                "；另有 {remaining} 个文件未列入本次审核，仍保留在工作区"
            ));
        }
        let updated = self
            .update_task(task_id, |task| {
                task.status = TaskStatus::Canceled;
                task.finished_at = Some(now());
                task.exit_code = None;
                task.error = Some(message.clone());
                task.review = None;
                if let Some(approval) = task.approval.as_mut() {
                    approval.stash = Some(stash.clone());
                }
            })
            .ok_or_else(|| "任务不存在".to_string())?;

        tracing::info!(task_id, stash = %stash, "agent review stopped and changes stashed");
        Ok(updated)
    }

    /// Unified diff of the reviewed change (`git diff HEAD`). Read-only; the
    /// review card uses it so the user can inspect the diff before approving.
    fn review_diff(&self, task_id: &str) -> Result<String, String> {
        let task = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != TaskStatus::AwaitingApproval {
            return Err("任务不在待审核状态".to_string());
        }
        if !Path::new(task.repo_path.trim()).is_dir() {
            return Err(format!("本地仓库路径不存在：{}", task.repo_path));
        }
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(task.repo_path.trim())
            .args(["diff", "--no-color", "HEAD"])
            .output()
            .map_err(|error| format!("无法执行 git：{error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "git diff 失败".to_string()
            } else {
                stderr
            });
        }

        let text = String::from_utf8_lossy(&output.stdout);
        if text.trim().is_empty() {
            return Ok("没有未提交的差异（可能已提交，或只有未跟踪文件）。".to_string());
        }
        let count = text.chars().count();
        if count > MAX_REVIEW_DIFF_CHARS {
            let prefix: String = text.chars().take(MAX_REVIEW_DIFF_CHARS).collect();
            return Ok(format!("{prefix}\n\n… diff 共 {count} 字符，已截断"));
        }
        Ok(text.into_owned())
    }

    /// Clears the queue pause. Tasks still awaiting review keep blocking the
    /// worker until the user decides them.
    fn resume_queue(&self) -> AgentTasksState {
        self.set_paused(false);
        self.persist_tasks();
        self.emit_state();
        self.wake.notify_one();
        self.tasks_state()
    }

    /// Handles one decoded opencode event for a task.
    fn handle_server_event(
        &self,
        task_id: &str,
        event: &Value,
        guard: &PromptGuard,
        done: &tokio::sync::Notify,
    ) {
        let event_type = opencode::event_type(event);
        if event_type.is_empty() {
            return;
        }

        if let Some(session_id) = opencode::event_session_id(event) {
            // Only events after our prompt was injected belong to this task;
            // the server replays older sessions when a stream reconnects.
            if guard.injected() {
                guard.mark_session_seen();
                self.remember_session(task_id, &session_id);
            }
        }

        if event_type.contains("permission") {
            // A permission ask can only belong to our turn once the prompt was
            // injected. This also filters asks replayed by the server on
            // connect (from a previous session in the same project).
            if !guard.injected() {
                return;
            }
            if opencode::is_permission_resolution(&event_type) {
                let permission_id = opencode::parse_review(event).map(|review| review.id);
                self.clear_review(task_id, permission_id.as_deref());
            } else if let Some(review) = opencode::parse_review(event) {
                self.set_review(task_id, review);
            }
            return;
        }

        match opencode::turn_signal(&event_type, event) {
            Some(opencode::TurnSignal::Succeeded) => {
                if !guard.completion_allowed() {
                    tracing::debug!(
                        task_id,
                        event_type = %event_type,
                        "ignoring completion before the prompt grace period"
                    );
                    return;
                }
                if self.mark_succeeded(task_id) {
                    // Tear down the TUI so the worker immediately takes the
                    // next queued task.
                    self.stop_runtime(task_id);
                    done.notify_one();
                }
            }
            Some(opencode::TurnSignal::Failed(message)) => {
                if !guard.completion_allowed() {
                    return;
                }
                if self.fail_from_event(task_id, message) {
                    self.stop_runtime(task_id);
                    done.notify_one();
                }
            }
            Some(opencode::TurnSignal::Busy) | None => {}
        }
    }

    fn spawn_event_consumer(
        self: &Arc<Self>,
        task_id: &str,
        mut receiver: tokio_mpsc::UnboundedReceiver<Value>,
        guard: Arc<PromptGuard>,
        done: Arc<tokio::sync::Notify>,
    ) -> tauri::async_runtime::JoinHandle<()> {
        let core = self.clone();
        let task_id = task_id.to_string();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = receiver.recv().await {
                core.handle_server_event(&task_id, &event, &guard, &done);
            }
        })
    }

    /// Makes sure the injected prompt actually reached the agent.
    ///
    /// The TUI can start slower than the "output + quiet" readiness check, in
    /// which case it discards the written text and never creates a session —
    /// the task then sat in `running` until the client exited. Re-inject once,
    /// then fail the task with a clear error instead of hanging.
    fn spawn_injection_watchdog(
        self: &Arc<Self>,
        task_id: &str,
        prompt: &str,
        guard: Arc<PromptGuard>,
        done: Arc<tokio::sync::Notify>,
    ) -> tauri::async_runtime::JoinHandle<()> {
        let core = self.clone();
        let task_id = task_id.to_string();
        let prompt = prompt.to_string();
        tauri::async_runtime::spawn(async move {
            let mut reinjected = false;
            loop {
                tokio::time::sleep(PROMPT_WATCHDOG_TICK).await;

                // Terminal (canceled/finished) or a session already exists:
                // nothing left to verify.
                if core
                    .current_status(&task_id)
                    .map(TaskStatus::is_terminal)
                    .unwrap_or(true)
                {
                    return;
                }
                if guard.session_seen() {
                    return;
                }
                // The PTY thread may still be waiting for the TUI to settle;
                // keep watching until the prompt is actually written.
                if !guard.injected() {
                    continue;
                }

                let elapsed = guard.injected_elapsed().unwrap_or_default();
                if !reinjected && elapsed >= PROMPT_RETRY_AFTER {
                    reinjected = true;
                    tracing::warn!(
                        task_id = %task_id,
                        "no agent session after prompt injection, re-injecting"
                    );
                    // 先回车清掉可能残留的输入，再重新注入，并重置计时。
                    let _ = core.write_input(&task_id, "\r");
                    let _ = core.write_input(&task_id, &format!("{prompt}\r"));
                    guard.mark_injected();
                    continue;
                }

                if elapsed >= PROMPT_VERIFY_TIMEOUT {
                    tracing::warn!(
                        task_id = %task_id,
                        "agent session never started, failing the task"
                    );
                    core.fail_task(
                        &task_id,
                        "Agent 会话未启动：提示词没有送达终端，请重试".to_string(),
                    );
                    core.stop_runtime(&task_id);
                    done.notify_one();
                    return;
                }
            }
        })
    }

    fn retry(&self, task_id: &str) -> Result<AgentTask, String> {
        let original = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if !original.status.is_terminal() {
            return Err("任务仍在队列或运行中，不能重试".to_string());
        }

        let id = uuid::Uuid::new_v4().simple().to_string();
        let _ = std::fs::create_dir_all(self.logs_dir());
        let mut task = original;
        task.id = id.clone();
        task.status = TaskStatus::Queued;
        task.created_at = now();
        task.started_at = None;
        task.finished_at = None;
        task.exit_code = None;
        task.error = None;
        task.review = None;
        task.approval = None;
        task.session_id = None;
        task.log_path = self
            .logs_dir()
            .join(format!("{id}.log"))
            .to_string_lossy()
            .to_string();

        self.tasks
            .lock()
            .expect("agent tasks lock")
            .push(task.clone());
        self.mark_task_dirty(task.clone());
        self.persist_tasks();
        self.emit_state();
        self.wake.notify_one();
        Ok(task)
    }

    fn read_log(&self, task_id: &str) -> Result<String, String> {
        let task = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        let bytes = std::fs::read(&task.log_path).map_err(|error| error.to_string())?;
        let slice = if bytes.len() > MAX_LOG_TAIL_BYTES {
            let tail = &bytes[bytes.len() - MAX_LOG_TAIL_BYTES..];
            // 从下一行开始：否则终端会先收到半条转义序列/半个字符。
            match tail.iter().position(|byte| *byte == b'\n') {
                Some(index) => &tail[index + 1..],
                None => tail,
            }
        } else {
            &bytes[..]
        };
        Ok(String::from_utf8_lossy(slice).to_string())
    }

    /// Opens the task's opencode session in Terminal.app, in its repository.
    fn open_session(&self, task_id: &str) -> Result<(), String> {
        let task = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        let session_id = task
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "该任务还没有 opencode 会话 ID，无法恢复".to_string())?;
        if !Path::new(&task.repo_path).is_dir() {
            return Err(format!("仓库路径不存在：{}", task.repo_path));
        }
        let configured = self.config_snapshot().binary_path;
        // Terminal.app already has the login shell PATH; an absolute path is
        // still more exact than a bare name.
        let binary =
            validate_binary(&configured).unwrap_or_else(|_| PathBuf::from(configured.trim()));
        open_terminal_session(&binary.to_string_lossy(), &task.repo_path, session_id)
    }

    fn write_input(&self, task_id: &str, data: &str) -> Result<(), String> {
        let runtime = self
            .runtimes
            .lock()
            .expect("agent runtimes lock")
            .get(task_id)
            .cloned()
            .ok_or_else(|| "任务未在运行".to_string())?;
        let mut runtime = runtime.lock().expect("agent runtime lock");
        runtime
            .writer
            .write_all(data.as_bytes())
            .and_then(|_| runtime.writer.flush())
            .map_err(|error| error.to_string())
    }

    fn resize(&self, task_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let size = (cols.max(1), rows.max(1));
        // 控制台可能在 PTY 起来之前就打开了：先记下尺寸，等 run_pty 创建后套用。
        self.sizes
            .lock()
            .expect("agent sizes lock")
            .insert(task_id.to_string(), size);

        let runtime = self
            .runtimes
            .lock()
            .expect("agent runtimes lock")
            .get(task_id)
            .cloned();
        let Some(runtime) = runtime else {
            return Ok(());
        };
        let runtime = runtime.lock().expect("agent runtime lock");
        runtime
            .master
            .resize(PtySize {
                rows: size.1,
                cols: size.0,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())
    }

    // -- queue worker --------------------------------------------------------

    fn spawn_worker(self: &Arc<Self>) {
        let core = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                // A user-stopped queue stays idle; a pending review blocks the
                // single worker so no new task touches the repo before the
                // reviewed diff is committed or stashed.
                if core.paused.load(Ordering::SeqCst) || core.has_awaiting_approval() {
                    core.wake.notified().await;
                    continue;
                }

                let Some(task) = core.take_next_queued() else {
                    core.wake.notified().await;
                    continue;
                };
                let task_id = task.id.clone();

                // Each task body runs in its own tokio task: a panic inside
                // `run_task` must not kill the single worker loop.
                let runner = core.clone();
                let handle = tauri::async_runtime::spawn(async move {
                    runner.run_task(task).await;
                });

                if let Err(error) = handle.await {
                    tracing::error!(task_id, %error, "agent task runner failed");
                    core.fail_task(&task_id, format!("Agent 任务执行异常：{error}"));
                }

                core.teardown_task(&task_id);
                // Belt and braces: no task may stay active after its runner
                // returned, otherwise the queue would never advance.
                core.recover_active_tasks("任务意外中断");
            }
        });

        // Resume work left over from a previous session.
        if next_queued_index(&self.tasks.lock().expect("agent tasks lock")).is_some() {
            self.wake.notify_one();
        }
    }

    /// Fails any task still marked active. Called after each worker iteration.
    fn recover_active_tasks(&self, reason: &str) {
        self.mutate_tasks(|tasks| {
            let mut changed = Vec::new();
            for task in tasks.iter_mut() {
                if task.status.is_active() {
                    task.status = TaskStatus::Failed;
                    task.error = Some(reason.to_string());
                    task.finished_at = Some(now());
                    task.review = None;
                    changed.push(task.clone());
                }
            }
            changed
        });
    }

    fn take_next_queued(&self) -> Option<AgentTask> {
        let task = {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            let index = next_queued_index(&tasks)?;
            let task = tasks.get_mut(index)?;
            if task.status != TaskStatus::Queued {
                return None;
            }
            task.status = TaskStatus::Preparing;
            task.started_at = Some(now());
            task.clone()
        };
        self.cancels
            .lock()
            .expect("agent cancels lock")
            .insert(task.id.clone(), Arc::new(AtomicBool::new(false)));
        self.mark_task_dirty(task.clone());
        self.persist_tasks();
        self.emit_state();
        Some(task)
    }

    async fn run_task(self: &Arc<Self>, mut task: AgentTask) {
        let mut config = self.config_snapshot();

        // 1. Export the bug package (bug.md + assets).
        let export = crate::export::run_export(
            &self.app,
            &self.state.paths,
            &task.workspace_id,
            &task.bug_id,
            Some(task.workspace_name.clone()).filter(|name| !name.trim().is_empty()),
        )
        .await;

        if self.current_status(&task.id) == Some(TaskStatus::Canceled) {
            return;
        }

        let export = match export {
            Ok(export) => export,
            Err(error) => {
                self.fail_task(&task.id, format!("导出缺陷失败：{error}"));
                return;
            }
        };
        task.md_path = export.markdown_path.clone();
        // Persist the export path early so failed tasks still expose their
        // generated bug package (e.g. when no repository is configured).
        let Some(prepared) = self.update_task(&task.id, |current| {
            if current.status != TaskStatus::Canceled {
                current.md_path = task.md_path.clone();
            }
        }) else {
            return;
        };
        if prepared.status == TaskStatus::Canceled {
            return;
        }

        // 2. Resolve the repository path. The task carries the path resolved at
        // enqueue time; `repo_mappings` is only a legacy fallback.
        let repo_path = match resolve_repo_path(&task, &config) {
            Ok(repo_path) => repo_path,
            Err(error) => {
                self.fail_task(&task.id, error);
                return;
            }
        };

        if !Path::new(&repo_path).is_dir() {
            self.fail_task(
                &task.id,
                format!("本地仓库路径不存在或不是目录：{repo_path}"),
            );
            return;
        }
        task.repo_path = repo_path;

        // 3. Resolve the agent binary. `opencode` is usually a bare name, so it
        //    is looked up on the user's shell PATH and the absolute path is used
        //    from here on: every spawn (serve / ACP / PTY) then works even when
        //    the app was launched from Finder with a minimal PATH.
        match validate_binary(&config.binary_path) {
            Ok(binary) => config.binary_path = binary.to_string_lossy().into_owned(),
            Err(error) => {
                self.fail_task(&task.id, error);
                return;
            }
        }

        // 3b. Make sure the opencode global config exposes the tapd MCP server.
        //     Only for the opencode binary, idempotent and best effort: a failure
        //     only warns and never blocks the task.
        if is_opencode_binary(&config.binary_path) {
            let sidecar = crate::commands::sidecar_command_path();
            match tokio::task::spawn_blocking(move || {
                crate::mcp_import::ensure_opencode_mcp(&sidecar)
            })
            .await
            {
                Ok(Ok(result)) => {
                    tracing::info!(task_id = %task.id, result = %result, "opencode MCP injection checked");
                }
                Ok(Err(error)) => {
                    tracing::warn!(task_id = %task.id, %error, "failed to inject tapd MCP into opencode");
                }
                Err(error) => {
                    tracing::warn!(task_id = %task.id, %error, "MCP injection task panicked");
                }
            }
        }

        let mut vars = PromptVars::from_task(&task);
        vars.project_rule = config.rule_for(&task.workspace_id);
        // Approved reviews re-enter the queue with a commit-only prompt; the
        // reviewed diff is still in the working tree.
        let template = if task.commit_only {
            // The commit phase only finishes the reviewed change; the original
            // compose instructions must not run a second time.
            vars.user_prompt.clear();
            vars.attachments.clear();
            DEFAULT_COMMIT_PROMPT_TEMPLATE
        } else {
            config.prompt_template.as_str()
        };
        task.prompt = render_prompt(template, &vars);

        // 4. Move to `running` with the resolved paths. Snapshot pre-existing
        //    dirty files so the uncommitted-change safety net only reacts to
        //    files this run touched.
        let (baseline_dirty, baseline_head) = if task.commit_only {
            // Keep the pre-task snapshots so unrelated local files stay
            // excluded from the write guard during the commit phase.
            (task.baseline_dirty.clone(), task.baseline_head.clone())
        } else {
            (
                uncommitted_files(&task.repo_path),
                git_head(&task.repo_path),
            )
        };
        let Some(running_task) = self.update_task(&task.id, |current| {
            if current.status == TaskStatus::Canceled {
                return;
            }
            current.md_path = task.md_path.clone();
            current.repo_path = task.repo_path.clone();
            current.prompt = task.prompt.clone();
            current.baseline_dirty = baseline_dirty.clone();
            current.baseline_head = baseline_head.clone();
            current.status = TaskStatus::Running;
            if current.started_at.is_none() {
                current.started_at = Some(now());
            }
        }) else {
            self.fail_task(&task.id, "任务在准备阶段丢失".to_string());
            return;
        };

        if running_task.status == TaskStatus::Canceled {
            return;
        }

        // ACP transport: one bidirectional JSON-RPC session (prompt + streamed
        // updates + permission requests). It replaces the private opencode
        // server, the PTY and the prompt-injection watchdog.
        if running_task.transport == "acp" {
            let outcome = self.run_acp(&running_task, &config).await;
            self.teardown_task(&task.id);
            self.finish_task(&task.id, outcome);
            return;
        }

        // 5. Start a private opencode server and subscribe to its event stream.
        //    Failures fall back to the TUI-only path instead of hanging.
        let cancel = self
            .cancels
            .lock()
            .expect("agent cancels lock")
            .get(&task.id)
            .cloned()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        let done = Arc::new(tokio::sync::Notify::new());
        let guard = Arc::new(PromptGuard::default());
        let mut warnings: Vec<String> = Vec::new();

        let server_log = self.logs_dir().join(format!("{}-server.log", task.id));
        let server = match ServerProcess::spawn(
            &config.binary_path,
            Path::new(&task.repo_path),
            &server_log,
        ) {
            Ok(server) => Some(Arc::new(server)),
            Err(error) => {
                let message = format!("无法启动 opencode 服务（{error}），回退为仅终端模式");
                warnings.push(message.clone());
                self.log_server_warning(&task.id, &message);
                None
            }
        };

        let mut server_active = false;
        // Whether the event stream is live: the injection watchdog relies on
        // session events, so it only makes sense in this mode.
        let mut events_live = false;
        if let Some(server) = server {
            match server.wait_ready(opencode::READY_TIMEOUT, &cancel).await {
                Ok(()) => {
                    server_active = true;
                    let events_path = self.events_dir().join(format!("{}.jsonl", task.id));
                    let (sink, receiver) = tokio_mpsc::unbounded_channel();
                    match server
                        .subscribe_events(sink, events_path, cancel.clone())
                        .await
                    {
                        Ok((pump, flavor)) => {
                            events_live = true;
                            tracing::info!(
                                task_id = %task.id,
                                base = server.base_url(),
                                ?flavor,
                                "subscribed to opencode events"
                            );
                            let consumer = self.spawn_event_consumer(
                                &task.id,
                                receiver,
                                guard.clone(),
                                done.clone(),
                            );
                            self.servers.lock().expect("agent servers lock").insert(
                                task.id.clone(),
                                ActiveServer {
                                    process: server.clone(),
                                    pump: Some(pump),
                                    consumer: Some(consumer),
                                    session_id: None,
                                },
                            );
                        }
                        Err(error) => {
                            let message =
                                format!("无法订阅 opencode 事件流（{error}），回退为终端退出判定");
                            warnings.push(message.clone());
                            self.log_server_warning(&task.id, &message);
                            // The TUI still uses the server; keep it for abort.
                            self.servers.lock().expect("agent servers lock").insert(
                                task.id.clone(),
                                ActiveServer {
                                    process: server.clone(),
                                    pump: None,
                                    consumer: None,
                                    session_id: None,
                                },
                            );
                        }
                    }
                }
                Err(error) => {
                    let message = format!("opencode 服务未就绪（{error}），回退为仅终端模式");
                    warnings.push(message.clone());
                    self.log_server_warning(&task.id, &message);
                    server.stop();
                }
            }
        }

        if cancel.load(Ordering::SeqCst)
            || self.current_status(&task.id) == Some(TaskStatus::Canceled)
        {
            self.teardown_task(&task.id);
            return;
        }

        // 6. Run the TUI in the PTY, connected to the server when available.
        let (tui_args, tui_envs) = if server_active {
            match self.server_for(&task.id) {
                Some(server) => (
                    vec!["--server".to_string(), server.base_url().to_string()],
                    vec![(
                        opencode::SERVER_PASSWORD_ENV.to_string(),
                        server.password().to_string(),
                    )],
                ),
                None => (Vec::new(), Vec::new()),
            }
        } else {
            (Vec::new(), Vec::new())
        };

        let (sender, mut receiver) = tokio::sync::oneshot::channel::<PtyOutcome>();
        let core = self.clone();
        let pty_task = running_task.clone();
        let pty_config = config.clone();
        let pty_guard = guard.clone();
        std::thread::Builder::new()
            .name(format!("agent-pty-{}", pty_task.id))
            .spawn(move || {
                let outcome = core.run_pty(&pty_task, &pty_config, tui_args, tui_envs, pty_guard);
                let _ = sender.send(outcome);
            })
            .map_err(|error| tracing::warn!(%error, "failed to spawn agent pty thread"))
            .ok();

        // Watch the prompt injection: a TUI that was not ready yet drops the
        // text, and without a session the task would run forever. Only possible
        // when session events are actually flowing.
        let watchdog = if events_live {
            Some(self.spawn_injection_watchdog(&task.id, &task.prompt, guard.clone(), done.clone()))
        } else {
            None
        };

        // Wait for the TUI to exit or for a server event to close the turn.
        let mut outcome = tokio::select! {
            result = &mut receiver => match result {
                Ok(outcome) => outcome,
                Err(_) => PtyOutcome {
                    error: Some("Agent 终端线程意外结束".to_string()),
                    ..PtyOutcome::default()
                },
            },
            _ = done.notified() => {
                // The turn already reached a terminal state. Kill the TUI so
                // the queue advances immediately, then collect its exit code.
                self.stop_runtime(&task.id);
                match tokio::time::timeout(PTY_TEARDOWN_TIMEOUT, &mut receiver).await {
                    Ok(Ok(mut outcome)) => {
                        outcome.completed = true;
                        outcome
                    }
                    _ => PtyOutcome {
                        completed: true,
                        ..PtyOutcome::default()
                    },
                }
            }
        };

        if let Some(watchdog) = watchdog {
            watchdog.abort();
        }

        if !warnings.is_empty() {
            let message = warnings.join("；");
            self.append_task_log(&task.log_path, &message);
            outcome.warning = Some(match outcome.warning.take() {
                Some(existing) => format!("{existing}；{message}"),
                None => message,
            });
        }

        // Always tear down the TUI + server before the worker takes the next
        // task, even when the task panicked further up.
        self.teardown_task(&task.id);
        self.finish_task(&task.id, outcome);
    }

    /// Runs one task through ACP: initialize, create a session, send the prompt,
    /// and consume streamed updates + permission requests until the prompt
    /// response arrives. No PTY, no private server, no custom task-response
    /// protocol: completion and permissions are ACP's own messages.
    async fn run_acp(&self, task: &AgentTask, config: &AgentConfig) -> PtyOutcome {
        let mut outcome = PtyOutcome::default();
        let raw_log = self.logs_dir().join(format!("{}-acp.ndjson", task.id));
        let (client, mut events) = match crate::acp::Client::start(
            &config.binary_path,
            Path::new(&task.repo_path),
            raw_log,
        )
        .await
        {
            Ok(value) => value,
            Err(error) => {
                outcome.error = Some(error);
                return outcome;
            }
        };
        self.acp_clients
            .lock()
            .expect("agent acp lock")
            .insert(task.id.clone(), client.clone());

        if let Err(error) = client.initialize().await {
            outcome.error = Some(format!("ACP 初始化失败：{error}"));
            self.append_task_log(&task.log_path, outcome.error.as_deref().unwrap_or(""));
            self.stop_runtime(&task.id);
            return outcome;
        }

        // The app's TAPD MCP sidecar is handed to the agent per session. This
        // is the same server the MCP settings page writes to other clients.
        let mcp_servers = json!([{
            "name": "tapd",
            "command": crate::commands::sidecar_command_path(),
            "args": [],
            "env": []
        }]);

        let session = match client.new_session(&task.repo_path, mcp_servers).await {
            Ok(session) => session,
            Err(error) => {
                outcome.error = Some(format!("ACP 创建会话失败：{error}"));
                self.append_task_log(&task.log_path, outcome.error.as_deref().unwrap_or(""));
                self.stop_runtime(&task.id);
                return outcome;
            }
        };
        let session_id = session
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if session_id.is_empty() {
            outcome.error = Some("ACP 未返回 sessionId".to_string());
            self.stop_runtime(&task.id);
            return outcome;
        }
        self.remember_session(&task.id, &session_id);
        self.append_task_log(&task.log_path, &format!("ACP 会话：{session_id}"));

        let prompt = task.prompt.clone();
        let prompt_session = session_id.clone();
        let prompt_client = client.clone();
        let prompt_future = async move { prompt_client.prompt(&prompt_session, &prompt).await };
        tokio::pin!(prompt_future);

        loop {
            tokio::select! {
                result = &mut prompt_future => {
                    match result {
                        Ok(value) => {
                            let stop = value
                                .get("stopReason")
                                .and_then(Value::as_str)
                                .unwrap_or("end_turn");
                            self.append_task_log(&task.log_path, &format!("ACP 回合结束：{stop}"));
                            match stop {
                                "end_turn" => outcome.completed = true,
                                "cancelled" => outcome.canceled = true,
                                other => {
                                    outcome.error = Some(format!("Agent 停止原因：{other}"));
                                }
                            }
                        }
                        Err(error) => outcome.error = Some(format!("ACP 回合失败：{error}")),
                    }
                    break;
                }
                event = events.recv() => {
                    match event {
                        Some(crate::acp::Event::Update(params)) => {
                            self.handle_acp_update(task, &params);
                        }
                        Some(crate::acp::Event::Permission(request)) => {
                            self.handle_acp_permission(task, request);
                        }
                        Some(crate::acp::Event::Stderr(line)) => {
                            self.append_stream_output(
                                &task.id,
                                &task.log_path,
                                &format!("\r\n[stderr] {line}\r\n"),
                            );
                        }
                        Some(crate::acp::Event::ProtocolError(error)) => {
                            outcome.error = Some(error);
                            break;
                        }
                        Some(crate::acp::Event::Exited(code)) => {
                            outcome.exit_code = code;
                            if outcome.error.is_none()
                                && !outcome.completed
                                && !outcome.canceled
                            {
                                outcome.error = Some(match code {
                                    Some(code) => format!("ACP 进程退出码 {code}"),
                                    None => "ACP 进程异常结束".to_string(),
                                });
                            }
                            break;
                        }
                        None => {
                            if outcome.error.is_none()
                                && !outcome.completed
                                && !outcome.canceled
                            {
                                outcome.error = Some("ACP 事件流已结束".to_string());
                            }
                            break;
                        }
                    }
                }
            }
        }

        if self.current_status(&task.id) == Some(TaskStatus::Canceled) {
            outcome.canceled = true;
            outcome.error = None;
        }

        let _ = tokio::time::timeout(Duration::from_secs(3), client.close(&session_id)).await;
        self.stop_runtime(&task.id);
        outcome
    }

    fn handle_acp_update(&self, task: &AgentTask, params: &Value) {
        let update = params.get("update").unwrap_or(&Value::Null);
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "agent_message_chunk" => {
                if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                    self.append_stream_output(&task.id, &task.log_path, text);
                }
            }
            "agent_thought_chunk" => {
                if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                    self.append_stream_output(
                        &task.id,
                        &task.log_path,
                        &format!("\r\n[thinking] {text}"),
                    );
                }
            }
            "tool_call" | "tool_call_update" => {
                let title = update
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("工具调用");
                let status = update
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending");
                let tool = update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.append_stream_output(
                    &task.id,
                    &task.log_path,
                    &format!("\r\n[tool {tool}] {title} · {status}\r\n"),
                );
            }
            "plan" => {
                if let Some(entries) = update.get("entries").and_then(Value::as_array) {
                    let text = entries
                        .iter()
                        .map(|entry| {
                            let content = entry
                                .get("content")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            let status = entry
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("pending");
                            format!("- [{status}] {content}")
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !text.is_empty() {
                        self.append_stream_output(
                            &task.id,
                            &task.log_path,
                            &format!("\r\n[plan]\r\n{text}\r\n"),
                        );
                    }
                }
            }
            _ => {}
        }
    }

    fn handle_acp_permission(&self, task: &AgentTask, request: crate::acp::PermissionRequest) {
        let options = request
            .options
            .iter()
            .map(|option| option.name.as_str())
            .collect::<Vec<_>>()
            .join(" / ");
        self.append_task_log(
            &task.log_path,
            &format!(
                "Agent 请求权限：{}（{}）",
                request.title,
                if options.is_empty() {
                    "无选项"
                } else {
                    &options
                }
            ),
        );
        let review = PermissionReview {
            id: request.request_id,
            session_id: request.session_id,
            action: request.kind.unwrap_or_else(|| "tool".to_string()),
            resource: request.tool_call_id,
            title: request.title,
            options: request.options,
            transport: "acp".to_string(),
        };
        self.set_review(&task.id, review);
    }

    fn append_stream_output(&self, task_id: &str, log_path: &str, data: &str) {
        if data.is_empty() {
            return;
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
        {
            let _ = file.write_all(data.as_bytes());
        }
        let _ = self
            .app
            .emit("agent://output", json!({ "taskId": task_id, "data": data }));
    }

    fn append_task_log(&self, log_path: &str, message: &str) {
        let line = format!("\r\n[tapd-client] {message}\r\n");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
        {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }
    }

    fn log_server_warning(&self, task_id: &str, message: &str) {
        tracing::warn!(task_id, %message, "agent server fallback");
        let path = self.logs_dir().join(format!("{task_id}-server.log"));
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "[tapd-client] {message}");
            let _ = file.flush();
        }
    }

    fn run_pty(
        &self,
        task: &AgentTask,
        config: &AgentConfig,
        args: Vec<String>,
        envs: Vec<(String, String)>,
        guard: Arc<PromptGuard>,
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
            Path::new(&task.repo_path),
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

        // Batcher: coalesces chunks (20-40 ms window) then emits + writes log.
        let batch_app = self.app.clone();
        let batch_task_id = task.id.clone();
        let log_path = task.log_path.clone();
        let batcher_handle = std::thread::Builder::new()
            .name(format!("agent-batch-{}", task.id))
            .spawn(move || {
                let mut log = std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&log_path)
                    .ok();
                let mut pending: Vec<u8> = Vec::new();

                loop {
                    match chunk_rx.recv_timeout(Duration::from_millis(30)) {
                        Ok(chunk) => {
                            pending.extend_from_slice(&chunk);
                            if pending.len() >= 256 * 1024 {
                                flush_output(&batch_app, &batch_task_id, &mut log, &mut pending);
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            flush_output(&batch_app, &batch_task_id, &mut log, &mut pending);
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            flush_output(&batch_app, &batch_task_id, &mut log, &mut pending);
                            break;
                        }
                    }
                }
            })
            .ok();

        // Wait for the TUI to settle before injecting the prompt.
        let mut warning: Option<String> = None;
        let ready_quiet = Duration::from_millis(config.ready_quiet_ms.clamp(100, 10_000));
        let ready_timeout = Duration::from_millis(config.ready_timeout_ms.clamp(1_000, 120_000));
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

            let injected = {
                let mut runtime = runtime.lock().expect("agent runtime lock");
                runtime
                    .writer
                    .write_all(task.prompt.as_bytes())
                    .and_then(|_| runtime.writer.write_all(b"\r"))
                    .and_then(|_| runtime.writer.flush())
            };
            match injected {
                Ok(()) => guard.mark_injected(),
                Err(error) => {
                    warning = Some(match warning {
                        Some(existing) => format!("{existing}；注入任务失败：{error}"),
                        None => format!("注入任务失败：{error}"),
                    });
                }
            }
        }

        // Wait for the agent process to exit (blocks this thread only).
        let mut outcome = PtyOutcome {
            canceled: canceled.load(Ordering::SeqCst),
            warning,
            ..PtyOutcome::default()
        };
        match child.wait() {
            Ok(status) => {
                outcome.exit_code = Some(status.exit_code() as i32);
                if let Some(signal) = status.signal() {
                    outcome.error = Some(format!("Agent 进程被信号终止：{signal}"));
                }
            }
            Err(error) => {
                outcome.error = Some(format!("等待 Agent 进程失败：{error}"));
            }
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

    fn finish_task(&self, task_id: &str, outcome: PtyOutcome) {
        let warning = outcome.warning.clone();
        let review_files = match self.task_snapshot(task_id) {
            Some(task)
                if !task.commit_only
                    && !task.status.is_terminal()
                    && task.status != TaskStatus::AwaitingApproval
                    && !committed_since_baseline(&task) =>
            {
                uncommitted_files(&task.repo_path)
                    .into_iter()
                    .filter(|file| !task.baseline_dirty.contains(file))
                    .collect()
            }
            _ => Vec::new(),
        };
        let snapshot = self.update_task(task_id, |task| {
            let at = now();
            apply_finish(task, &outcome, &at);
            if task.status == TaskStatus::Succeeded && !review_files.is_empty() {
                set_awaiting_approval(
                    task,
                    "Agent 已完成修改但未提交，等待确认后提交。".to_string(),
                    review_files,
                    Some("存在未提交的改动".to_string()),
                    &at,
                );
            }
        });

        if let Some(task) = &snapshot {
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

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn task_status_key(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Queued => "queued",
        TaskStatus::Preparing => "preparing",
        TaskStatus::Running => "running",
        TaskStatus::WaitingReview => "waiting_review",
        TaskStatus::AwaitingApproval => "awaiting_approval",
        TaskStatus::Succeeded => "succeeded",
        TaskStatus::Failed => "failed",
        TaskStatus::Canceled => "canceled",
    }
}

fn parse_rfc3339_secs(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|time| time.timestamp())
}

/// A claim is valid for `EXTERNAL_CLAIM_TTL_SECS` after its last heartbeat.
fn external_claim_fresh_at(claim: &ExternalClaim, now_secs: i64) -> bool {
    parse_rfc3339_secs(&claim.last_seen_at)
        .is_some_and(|seen| now_secs.saturating_sub(seen) <= EXTERNAL_CLAIM_TTL_SECS)
}

/// Human phrase for lists and error messages: `“Zcode”正在使用“Deepseek”处理该缺陷`.
fn external_claim_phrase(claim: &ExternalClaim) -> String {
    let client = claim.client.trim();
    let client = if client.is_empty() {
        "外部 AI"
    } else {
        client
    };
    let model = claim.model.trim();
    if model.is_empty() {
        format!("“{client}”正在处理该缺陷")
    } else {
        format!("“{client}”正在使用“{model}”处理该缺陷")
    }
}

/// Fresh claim that owns this bug, used to refuse enqueue / claim duplicates.
fn external_claim_blocking<'a>(
    claims: &'a [ExternalClaim],
    workspace_id: &str,
    bug_id: &str,
    now_secs: i64,
) -> Option<&'a ExternalClaim> {
    claims.iter().find(|claim| {
        claim.workspace_id == workspace_id
            && claim.bug_id == bug_id
            && external_claim_fresh_at(claim, now_secs)
    })
}

/// Filters and paginates terminal tasks. Kept free-standing so the paging
/// contract is unit-testable without an `AppHandle`.
fn build_history_page(tasks: &[AgentTask], query: HistoryQuery) -> AgentTasksPage {
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let status: Option<TaskStatus> = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|status| !status.is_empty())
        .and_then(|status| serde_json::from_value(Value::String(status.to_string())).ok());
    let workspace_id = query
        .workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let task_id = query
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let keyword = query.keyword.unwrap_or_default().trim().to_lowercase();

    let mut workspaces = BTreeMap::new();
    let mut matched: Vec<&AgentTask> = Vec::new();
    for task in tasks {
        if !task.status.is_terminal() {
            continue;
        }
        workspaces
            .entry(task.workspace_id.clone())
            .or_insert_with(|| task.workspace_name.clone());
        if let Some(task_id) = task_id {
            if task.id != task_id {
                continue;
            }
        }
        if let Some(workspace_id) = workspace_id {
            if task.workspace_id != workspace_id {
                continue;
            }
        }
        if let Some(status) = status {
            if task.status != status {
                continue;
            }
        }
        if !keyword.is_empty()
            && !task.title.to_lowercase().contains(&keyword)
            && !task.bug_id.to_lowercase().contains(&keyword)
        {
            continue;
        }
        matched.push(task);
    }
    matched.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    let total = matched.len();
    let page: Vec<AgentTask> = matched
        .into_iter()
        .skip(offset)
        .take(limit)
        .cloned()
        .collect();
    let has_more = offset + page.len() < total;

    AgentTasksPage {
        tasks: page,
        total,
        has_more,
        workspaces: workspaces
            .into_iter()
            .map(|(id, name)| AgentWorkspaceRef { id, name })
            .collect(),
    }
}

/// Deletes logs/events that belong to tasks outside the newest
/// `ARTIFACT_TASK_LIMIT`. Only files matching the task-artifact naming scheme
/// are touched, so user exports or unrelated files survive.
fn prune_agent_artifacts(logs_dir: &Path, events_dir: &Path, keep: &HashSet<String>) {
    prune_artifact_dir(logs_dir, keep, task_log_id);
    prune_artifact_dir(events_dir, keep, task_event_id);
}

fn prune_artifact_dir(dir: &Path, keep: &HashSet<String>, task_id_of: fn(&str) -> Option<&str>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(id) = task_id_of(name) else {
            continue;
        };
        if keep.contains(id) {
            continue;
        }
        if let Err(error) = std::fs::remove_file(entry.path()) {
            tracing::warn!(
                %error,
                path = %entry.path().display(),
                "failed to prune agent artifact"
            );
        }
    }
}

/// `<id>.log`, `<id>-server.log`, `<id>-acp.ndjson` -> task id.
fn task_log_id(name: &str) -> Option<&str> {
    let stem = name
        .strip_suffix(".log")
        .or_else(|| name.strip_suffix(".ndjson"))?;
    let id = stem
        .strip_suffix("-server")
        .or_else(|| stem.strip_suffix("-acp"))
        .unwrap_or(stem);
    is_task_id(id).then_some(id)
}

/// `<id>.jsonl` -> task id.
fn task_event_id(name: &str) -> Option<&str> {
    let id = name.strip_suffix(".jsonl")?;
    is_task_id(id).then_some(id)
}

/// Task ids are simple UUIDs (32 hex characters).
fn is_task_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn truncate_text(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
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

/// Accepts either an absolute/relative path or a bare command name resolved
/// through the user's shell `PATH` (the default `opencode` is normally installed
/// by a package manager and only reachable through `PATH`).
///
/// Returns the resolved path so callers do not depend on the minimal `PATH` a
/// Finder-launched app inherits.
fn validate_binary(binary: &str) -> Result<PathBuf, String> {
    let binary = binary.trim();
    if binary.is_empty() {
        return Err("未配置 Agent 可执行文件路径".to_string());
    }

    let path = Path::new(binary);
    let looks_like_path = path.is_absolute() || binary.contains('/') || binary.contains('\\');
    if looks_like_path {
        if !path.is_file() {
            return Err(format!("Agent 可执行文件不存在：{binary}"));
        }
        if !shell_path::is_executable(path) {
            return Err(format!("Agent 可执行文件没有执行权限：{binary}"));
        }
        return Ok(path.to_path_buf());
    }

    // Not the inherited `PATH`: a bundled macOS app started from Finder only
    // sees `/usr/bin:/bin:/usr/sbin:/sbin`, so `opencode` installed by Homebrew
    // or npm would never be found there.
    for dir in std::env::split_paths(shell_path::user_path()) {
        let candidate = dir.join(binary);
        if shell_path::is_executable(&candidate) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "在 PATH 中找不到 Agent 可执行文件：{binary}（可在 Agent 设置里填写绝对路径）"
    ))
}

/// True when the configured agent is opencode (MCP injection only applies to it).
fn is_opencode_binary(binary: &str) -> bool {
    Path::new(binary)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(binary)
        .to_ascii_lowercase()
        .contains("opencode")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Opens Terminal.app on `opencode -s <session>` inside the task repository.
#[cfg(target_os = "macos")]
fn open_terminal_session(binary: &str, repo_path: &str, session_id: &str) -> Result<(), String> {
    let command = format!(
        "cd {} && {} -s {}",
        shell_quote(repo_path),
        shell_quote(binary),
        shell_quote(session_id)
    );
    let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");
    let script =
        format!("tell application \"Terminal\"\nactivate\ndo script \"{escaped}\"\nend tell");
    let status = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status()
        .map_err(|error| format!("无法启动 Terminal：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Terminal 拒绝了恢复会话的请求".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn open_terminal_session(_binary: &str, _repo_path: &str, _session_id: &str) -> Result<(), String> {
    Err("终端恢复目前仅支持 macOS".to_string())
}

fn detect_version(binary: &str) -> Result<String, String> {
    let binary = binary.trim();
    if binary.is_empty() {
        return Err("未配置 Agent 可执行文件路径".to_string());
    }

    // Resolve through the user's shell PATH instead of the minimal one a
    // Finder-launched app inherits.
    let resolved = validate_binary(binary)?;
    let mut child = std::process::Command::new(&resolved)
        .env("PATH", shell_path::user_path())
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 {binary}：{error}"))?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() >= Duration::from_secs(5) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{binary} --version 超时（5 秒）"));
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(error) => return Err(format!("等待 {binary} --version 失败：{error}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let version = if !stdout.is_empty() { stdout } else { stderr };

    if version.is_empty() {
        return Err(format!("{binary} --version 没有输出"));
    }
    Ok(version
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string())
}

/// Persists a pasted resource and returns its absolute path. The agent only
/// ever receives paths, never inline base64 or webview URLs.
fn save_resource(data_dir: &Path, name: &str, data: &str) -> Result<String, String> {
    use base64::Engine as _;

    let encoded = data
        .split_once(',')
        .filter(|(head, _)| head.starts_with("data:"))
        .map(|(_, body)| body)
        .unwrap_or(data)
        .trim();
    if encoded.is_empty() {
        return Err("资源内容为空".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("资源解码失败：{error}"))?;
    if bytes.is_empty() {
        return Err("资源内容为空".to_string());
    }

    let dir = data_dir.join(RESOURCE_DIR);
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建资源目录失败：{error}"))?;

    let stem: String = Path::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .chars()
        .filter(|ch| ch.is_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        .take(48)
        .collect();
    let stem = if stem.is_empty() {
        "resource".to_string()
    } else {
        stem
    };
    let extension: String = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();

    let id = uuid::Uuid::new_v4().simple().to_string();
    let file_name = if extension.is_empty() {
        format!("{id}-{stem}")
    } else {
        format!("{id}-{stem}.{extension}")
    };
    let path = dir.join(file_name);
    std::fs::write(&path, bytes).map_err(|error| format!("写入资源失败：{error}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// ---------------------------------------------------------------------------
// Tauri integration
// ---------------------------------------------------------------------------

pub fn init(app: &AppHandle, state: SharedState) {
    let core = Arc::new(AgentCore::new(app.clone(), state));
    core.load();
    app.manage(core.clone());
    core.spawn_worker();

    let listener_core = core.clone();
    app.listen("agent://enqueue", move |event| {
        match serde_json::from_str::<EnqueueRequest>(event.payload()) {
            Ok(request) => {
                if let Err(error) = listener_core.enqueue(&request, "notification") {
                    tracing::warn!(%error, "failed to enqueue agent task from notification");
                }
            }
            Err(error) => {
                tracing::warn!(%error, payload = event.payload(), "invalid agent://enqueue payload");
            }
        }
    });
}

/// Stops every agent process on app exit. Called from `RunEvent::Exit`, which
/// is the only place a normal quit can still reap the children.
pub fn shutdown(app: &AppHandle) {
    if let Some(core) = app.try_state::<Arc<AgentCore>>() {
        core.shutdown();
    }
}

/// Snapshot of the Agent settings for the MCP bridge: per-project repo paths /
/// rules (used to match a caller's working directory) and the global prompt
/// template. Falls back to defaults before the module is initialized.
pub fn mcp_agent_config(app: &AppHandle) -> AgentConfig {
    app.try_state::<Arc<AgentCore>>()
        .map(|core| core.config_snapshot())
        .unwrap_or_default()
}

/// Fresh external claim for one bug, for MCP read tools.
pub fn external_claim_for_bug(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Option<ExternalClaim> {
    app.try_state::<Arc<AgentCore>>()?
        .fresh_external_claim(workspace_id, bug_id)
}

/// All fresh external claims, for list responses.
pub fn external_claims(app: &AppHandle) -> Vec<ExternalClaim> {
    app.try_state::<Arc<AgentCore>>()
        .map(|core| core.external_claims_snapshot())
        .unwrap_or_default()
}

/// MCP `tapd_claim_bug`: registers (or heartbeats) an external AI claim.
pub async fn claim_external_from_mcp(
    app: &AppHandle,
    request: ExternalClaimRequest,
) -> Result<Value, String> {
    let core = app
        .try_state::<Arc<AgentCore>>()
        .ok_or_else(|| "Agent 模块尚未初始化".to_string())?;
    let outcome = core.claim_external(request).await?;
    Ok(json!({
        "claimed": outcome.claimed,
        "claim": outcome.claim,
        "conflict": outcome.conflict,
        "message": outcome.message,
    }))
}

/// MCP `tapd_release_bug`: releases the caller's own claim.
pub fn release_external_from_mcp(
    app: &AppHandle,
    request: ExternalReleaseRequest,
) -> Result<Value, String> {
    let core = app
        .try_state::<Arc<AgentCore>>()
        .ok_or_else(|| "Agent 模块尚未初始化".to_string())?;
    let client = request.client.unwrap_or_default();
    let client = client.trim();
    let released = core.release_external(
        request.workspace_id.trim(),
        request.bug_id.trim(),
        (!client.is_empty()).then_some(client),
    )?;
    Ok(json!({
        "released": released,
        "message": if released { "已释放占用" } else { "没有找到可释放的占用" },
    }))
}

/// Blocks TAPD comment/status writes from the local agent while its worktree
/// still has files changed by this run. This enforces "commit first, then write
/// back" even if the model ignores the prompt. Unrelated dirty files recorded
/// in `baseline_dirty` are ignored.
pub fn tapd_write_block_reason(app: &AppHandle, arguments: &Value) -> Option<String> {
    let core = app.try_state::<Arc<AgentCore>>()?;
    let bug_id = arguments
        .get("bug_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())?;
    let workspace_id = arguments
        .get("workspace_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty());

    let task = core
        .tasks
        .lock()
        .ok()?
        .iter()
        .rev()
        .find(|task| {
            task.bug_id == bug_id
                && workspace_id.map_or(true, |workspace| task.workspace_id == workspace)
                && !task.status.is_terminal()
        })
        .cloned()?;
    if task.repo_path.trim().is_empty() {
        return None;
    }

    let pending: Vec<String> = uncommitted_files(&task.repo_path)
        .into_iter()
        .filter(|file| !task.baseline_dirty.contains(file))
        .collect();
    if pending.is_empty() {
        return None;
    }
    Some(format!(
        "Agent 任务尚未提交（{} 个文件有未提交改动），请先 git commit，再评论或更新 TAPD 状态",
        pending.len()
    ))
}

/// MCP `tapd_request_review`: the local agent pauses a complex change and asks
/// the user to approve the commit. Other MCP clients have no active task and
/// are rejected, so they cannot pause the desktop queue.
pub async fn request_review_from_mcp(app: &AppHandle, arguments: &Value) -> Result<Value, String> {
    let core = app
        .try_state::<Arc<AgentCore>>()
        .ok_or_else(|| "Agent 模块尚未初始化".to_string())?;
    let task_id = arguments
        .get("taskId")
        .or_else(|| arguments.get("task_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "缺少参数 taskId".to_string())?
        .to_string();

    let summary = arguments
        .get("summary")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .map(|summary| truncate_text(summary, 2_000))
        .ok_or_else(|| "summary 不能为空".to_string())?;

    let files = match arguments.get("files") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(|path| truncate_text(path, 300))
            .take(50)
            .collect(),
        Some(_) => return Err("files 必须是字符串数组".to_string()),
    };

    let risk = arguments
        .get("risk")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|risk| !risk.is_empty())
        .map(|risk| truncate_text(risk, 500));

    core.request_review(&task_id, summary, files, risk).await
}

/// MCP `agent_task_report`: explicit lifecycle report for runtimes without ACP.
/// This is the fallback that lets a non-ACP agent say "completed / failed /
/// needs review" instead of us reverse-engineering its transcript.
pub async fn task_report_from_mcp(app: &AppHandle, arguments: &Value) -> Result<Value, String> {
    let core = app
        .try_state::<Arc<AgentCore>>()
        .ok_or_else(|| "Agent 模块尚未初始化".to_string())?;
    let task_id = arguments
        .get("taskId")
        .or_else(|| arguments.get("task_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "缺少参数 taskId".to_string())?
        .to_string();
    let status = arguments
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let message = arguments
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(|message| truncate_text(message, 2_000));

    match status.as_str() {
        "completed" => {
            core.finish_task(
                &task_id,
                PtyOutcome {
                    exit_code: Some(0),
                    completed: true,
                    ..PtyOutcome::default()
                },
            );
            core.stop_runtime(&task_id);
            Ok(json!({ "status": "completed", "taskId": task_id }))
        }
        "failed" => {
            core.fail_task(
                &task_id,
                message.unwrap_or_else(|| "Agent 报告任务失败".to_string()),
            );
            core.stop_runtime(&task_id);
            Ok(json!({ "status": "failed", "taskId": task_id }))
        }
        "needs_review" => {
            let summary = message.unwrap_or_else(|| "Agent 请求人工审核".to_string());
            let files = match arguments.get("files") {
                None => Vec::new(),
                Some(Value::Array(items)) => items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .map(|path| truncate_text(path, 300))
                    .take(50)
                    .collect(),
                Some(_) => return Err("files 必须是字符串数组".to_string()),
            };
            let risk = arguments
                .get("risk")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|risk| !risk.is_empty())
                .map(|risk| truncate_text(risk, 500));
            core.request_review(&task_id, summary, files, risk).await
        }
        "progress" => {
            if let Some(task) = core.task_snapshot(&task_id) {
                core.append_task_log(
                    &task.log_path,
                    message.as_deref().unwrap_or("Agent 进度更新"),
                );
            }
            Ok(json!({ "status": "progress", "taskId": task_id }))
        }
        other => Err(format!("未知 status：{other}")),
    }
}

pub async fn command(
    app: &AppHandle,
    state: &SharedState,
    name: &str,
    payload: Value,
) -> Result<Value, String> {
    let core = app
        .try_state::<Arc<AgentCore>>()
        .ok_or_else(|| "Agent 模块尚未初始化".to_string())?;

    match name {
        "agent_runtimes" => Ok(json!({ "runtimes": runtime_catalog() })),
        "agent_config_get" => {
            let config = core.config_snapshot();
            Ok(json!({ "config": config }))
        }
        "agent_config_set" => {
            let patch: AgentConfigPatch = serde_json::from_value(payload)
                .map_err(|error| format!("无效的 Agent 配置：{error}"))?;
            let config = core.update_config(patch);
            Ok(json!({ "config": config }))
        }
        "agent_enqueue_bug" => {
            let request: EnqueueRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的入队参数：{error}"))?;
            let task = core.enqueue(&request, request.source.as_deref().unwrap_or("manual"))?;
            Ok(json!({ "task": task }))
        }
        "agent_save_resource" => {
            let request: SaveResourceRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的资源参数：{error}"))?;
            let path = save_resource(&state.paths.data_dir, &request.name, &request.data)?;
            Ok(json!({ "path": path }))
        }
        "agent_tasks_list" => Ok(json!(core.tasks_state())),
        "agent_tasks_history" => {
            let query: HistoryQuery = serde_json::from_value(payload).unwrap_or_default();
            Ok(json!(core.history_page(query)))
        }
        "agent_summary" => Ok(json!(core.summary())),
        "agent_open_task" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的任务参数：{error}"))?;
            let task_id = request.task_id.trim();
            if task_id.is_empty() {
                return Err("缺少 taskId".to_string());
            }
            if core.task_snapshot(task_id).is_none() {
                return Err("任务不存在".to_string());
            }
            focus_main_window(app);
            let _ = app.emit("agent://focus", json!({ "taskId": task_id }));
            Ok(json!({ "opened": true }))
        }
        "agent_permission_reply" => {
            let request: PermissionReplyRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的权限回复参数：{error}"))?;
            let task_id = request.task_id.trim();
            if task_id.is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task = core
                .reply_permission(task_id, request.response, request.remember)
                .await?;
            Ok(json!({ "task": task }))
        }
        "agent_permission_option" => {
            let request: PermissionOptionRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的权限选项参数：{error}"))?;
            let task_id = request.task_id.trim();
            if task_id.is_empty() {
                return Err("缺少 taskId".to_string());
            }
            if request.option_id.trim().is_empty() {
                return Err("缺少 optionId".to_string());
            }
            let task = core
                .reply_permission_option(task_id, request.option_id.trim())
                .await?;
            Ok(json!({ "task": task }))
        }
        "agent_task_cancel" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的取消参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task = core.cancel(request.task_id.trim()).await?;
            Ok(json!({ "task": task }))
        }
        "agent_external_release" => {
            let request: ExternalReleaseRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的释放参数：{error}"))?;
            if request.bug_id.trim().is_empty() {
                return Err("缺少 bugId".to_string());
            }
            // The user's 取消 button may close any claim.
            let released =
                core.release_external(request.workspace_id.trim(), request.bug_id.trim(), None)?;
            Ok(json!({ "released": released }))
        }
        "agent_task_retry" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的重试参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task = core.retry(request.task_id.trim())?;
            Ok(json!({ "task": task }))
        }
        "agent_review_approve" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的审核参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task = core.approve_review(request.task_id.trim())?;
            Ok(json!({ "task": task }))
        }
        "agent_review_stop" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的停止参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task = core.stop_review(request.task_id.trim()).await?;
            Ok(json!({ "task": task }))
        }
        "agent_queue_resume" => Ok(json!(core.resume_queue())),
        "agent_review_diff" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的差异参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task_id = request.task_id.trim().to_string();
            let core = core.inner().clone();
            let diff = tokio::task::spawn_blocking(move || core.review_diff(&task_id))
                .await
                .map_err(|error| format!("读取差异失败：{error}"))??;
            Ok(json!({ "diff": diff }))
        }
        "agent_task_log" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的日志参数：{error}"))?;
            let data = core.read_log(request.task_id.trim())?;
            Ok(json!({ "data": data }))
        }
        "agent_open_session" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的恢复参数：{error}"))?;
            core.open_session(request.task_id.trim())?;
            Ok(json!({ "opened": true }))
        }
        "agent_input" => {
            let request: TaskInputRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的输入参数：{error}"))?;
            core.write_input(request.task_id.trim(), &request.data)?;
            Ok(json!({ "ok": true }))
        }
        "agent_resize" => {
            let request: TaskResizeRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的尺寸参数：{error}"))?;
            core.resize(request.task_id.trim(), request.cols, request.rows)?;
            Ok(json!({ "ok": true }))
        }
        "agent_detect" => {
            let request: DetectRequest = serde_json::from_value(payload).unwrap_or_default();
            let path = request
                .path
                .map(|path| path.trim().to_string())
                .filter(|path| !path.is_empty())
                .unwrap_or_else(|| core.config_snapshot().binary_path);
            let version = detect_version(&path)?;
            Ok(json!({ "version": version, "path": path }))
        }
        other => Err(format!("unknown agent command: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_claim(last_seen_at: &str) -> ExternalClaim {
        ExternalClaim {
            workspace_id: "45336192".to_string(),
            bug_id: "1145336192001234567".to_string(),
            title: "示例缺陷".to_string(),
            client: "Zcode".to_string(),
            model: "Deepseek".to_string(),
            status: "running".to_string(),
            note: String::new(),
            claimed_at: "2026-11-11T08:00:00Z".to_string(),
            last_seen_at: last_seen_at.to_string(),
        }
    }

    #[test]
    fn external_claims_expire_without_a_heartbeat() {
        let seen = parse_rfc3339_secs("2026-11-11T08:00:00Z").expect("timestamp");
        let claim = sample_claim("2026-11-11T08:00:00Z");
        assert!(external_claim_fresh_at(
            &claim,
            seen + EXTERNAL_CLAIM_TTL_SECS
        ));
        assert!(!external_claim_fresh_at(
            &claim,
            seen + EXTERNAL_CLAIM_TTL_SECS + 1
        ));
        // A malformed timestamp must never pin a bug forever.
        assert!(!external_claim_fresh_at(&sample_claim("not-a-time"), seen));
    }

    #[test]
    fn fresh_claim_blocks_enqueue_until_it_expires() {
        let seen = parse_rfc3339_secs("2026-11-11T08:00:00Z").expect("timestamp");
        let claim = sample_claim("2026-11-11T08:00:00Z");
        let claims = vec![claim];

        assert!(
            external_claim_blocking(&claims, "45336192", "1145336192001234567", seen + 60)
                .is_some()
        );
        // Other bugs and workspaces are unaffected.
        assert!(external_claim_blocking(&claims, "45336192", "999", seen + 60).is_none());
        assert!(
            external_claim_blocking(&claims, "999", "1145336192001234567", seen + 60).is_none()
        );
        // Stale claims stop blocking.
        assert!(external_claim_blocking(
            &claims,
            "45336192",
            "1145336192001234567",
            seen + EXTERNAL_CLAIM_TTL_SECS + 1
        )
        .is_none());
    }

    #[test]
    fn external_claim_phrase_names_client_and_model() {
        assert_eq!(
            external_claim_phrase(&sample_claim("2026-11-11T08:00:00Z")),
            "“Zcode”正在使用“Deepseek”处理该缺陷"
        );
        let mut claim = sample_claim("2026-11-11T08:00:00Z");
        claim.model.clear();
        assert_eq!(external_claim_phrase(&claim), "“Zcode”正在处理该缺陷");
        claim.client.clear();
        assert_eq!(external_claim_phrase(&claim), "“外部 AI”正在处理该缺陷");
    }

    fn sample_task(id: &str, status: TaskStatus) -> AgentTask {
        AgentTask {
            id: id.to_string(),
            workspace_id: "45336192".to_string(),
            workspace_name: "UU".to_string(),
            bug_id: "1145336192001234567".to_string(),
            title: "示例缺陷".to_string(),
            severity: "严重".to_string(),
            priority: "高".to_string(),
            md_path: "/tmp/bug.md".to_string(),
            repo_path: "/tmp/repo".to_string(),
            status,
            created_at: "2026-11-10T00:00:00Z".to_string(),
            started_at: None,
            finished_at: None,
            exit_code: None,
            log_path: "/tmp/agent.log".to_string(),
            error: None,
            prompt: "prompt".to_string(),
            source: "manual".to_string(),
            runtime_id: DEFAULT_RUNTIME_ID.to_string(),
            transport: "pty".to_string(),
            session_id: None,
            review: None,
            approval: None,
            commit_only: false,
            baseline_dirty: Vec::new(),
            baseline_head: None,
            extra_prompt: String::new(),
            attachments: Vec::new(),
        }
    }

    #[test]
    fn config_defaults_match_spec() {
        let config = AgentConfig::default();
        assert_eq!(config.runtime_id, "opencode");
        assert_eq!(config.transport, "acp");
        assert_eq!(config.binary_path, "opencode");
        assert!(config.repo_mappings.is_empty());
        assert_eq!(config.ready_quiet_ms, 900);
        assert_eq!(config.ready_timeout_ms, 15_000);
        assert!(config.prompt_template.contains("{{md_path}}"));
        assert!(config.prompt_template.contains("{{title}}"));
    }

    #[test]
    fn old_default_prompt_migrates_to_the_review_flow() {
        let config = AgentConfig {
            prompt_template: LEGACY_PROMPT_TEMPLATES[0].to_string(),
            ..AgentConfig::default()
        }
        .sanitized();
        assert_eq!(config.prompt_template, DEFAULT_PROMPT_TEMPLATE);
        assert!(config.prompt_template.contains("tapd_request_review"));
        assert!(config.prompt_template.contains("{{task_id}}"));
    }

    #[test]
    fn config_is_sanitized() {
        let config = AgentConfig {
            runtime_id: "  ".to_string(),
            transport: "bogus".to_string(),
            binary_path: "   ".to_string(),
            repo_mappings: BTreeMap::from([
                ("1".to_string(), "  /repo  ".to_string()),
                ("2".to_string(), "   ".to_string()),
            ]),
            projects: BTreeMap::new(),
            prompt_template: "  ".to_string(),
            ready_quiet_ms: 1,
            ready_timeout_ms: 999_999,
        }
        .sanitized();

        assert_eq!(config.binary_path, "opencode");
        assert_eq!(config.runtime_id, "opencode");
        assert_eq!(config.transport, "acp");
        assert_eq!(config.ready_quiet_ms, 100);
        assert_eq!(config.ready_timeout_ms, 120_000);
        assert_eq!(config.repo_mappings.len(), 0);
        assert_eq!(
            config
                .projects
                .get("1")
                .map(|project| project.repo_path.as_str()),
            Some("/repo")
        );
        assert_eq!(config.prompt_template, DEFAULT_PROMPT_TEMPLATE);
    }

    #[test]
    fn runtime_catalog_declares_lifecycle_and_capabilities() {
        let catalog = runtime_catalog();
        let opencode = catalog
            .iter()
            .find(|runtime| runtime.id == "opencode")
            .expect("opencode runtime");

        assert!(opencode.available);
        assert!(opencode.capabilities.interactive_terminal);
        assert!(opencode.capabilities.external_decision);

        let keys: Vec<&str> = opencode.lifecycle.iter().map(|stage| stage.key).collect();
        for expected in [
            "queued",
            "preparing",
            "running",
            "waiting_review",
            "awaiting_approval",
            "succeeded",
            "failed",
            "canceled",
        ] {
            assert!(keys.contains(&expected), "missing stage {expected}");
        }
        assert!(opencode
            .lifecycle
            .iter()
            .any(|stage| stage.needs_human && !stage.terminal));
        assert!(!opencode.limitations.is_empty());
        assert!(!opencode.fallback.is_empty());
        assert!(runtime_descriptor("unknown").is_none());
    }

    #[test]
    fn renders_prompt_placeholders() {
        let vars = PromptVars {
            task_id: "task-42".to_string(),
            title: "标题".to_string(),
            md_path: "/exports/bug.md".to_string(),
            repo_path: "/repo".to_string(),
            workspace_name: "UU".to_string(),
            bug_id: "42".to_string(),
            severity: "严重".to_string(),
            priority: "高".to_string(),
            project_rule: "只用 Rust 写".to_string(),
            user_prompt: String::new(),
            attachments: Vec::new(),
        };

        let rendered = render_prompt(
            "{{title}}|{{md_path}}|{{repo_path}}|{{workspace_name}}|{{bug_id}}|{{severity}}|{{priority}}|{{unknown}}",
            &vars,
        );
        assert_eq!(
            rendered,
            "标题|/exports/bug.md|/repo|UU|42|严重|高|{{unknown}}\n\n项目规则：\n只用 Rust 写"
        );
    }

    #[test]
    fn project_rule_uses_the_explicit_slot() {
        let vars = PromptVars {
            task_id: "task-1".to_string(),
            title: "t".to_string(),
            md_path: "m".to_string(),
            repo_path: "r".to_string(),
            workspace_name: "w".to_string(),
            bug_id: "1".to_string(),
            severity: "s".to_string(),
            priority: "p".to_string(),
            project_rule: "先跑 cargo test".to_string(),
            user_prompt: String::new(),
            attachments: Vec::new(),
        };

        assert_eq!(
            render_prompt("规则：{{project_rule}}", &vars),
            "规则：先跑 cargo test"
        );
    }

    #[test]
    fn empty_project_rule_adds_nothing() {
        let vars = PromptVars {
            task_id: "task-1".to_string(),
            title: "t".to_string(),
            md_path: "m".to_string(),
            repo_path: "r".to_string(),
            workspace_name: "w".to_string(),
            bug_id: "1".to_string(),
            severity: "s".to_string(),
            priority: "p".to_string(),
            project_rule: String::new(),
            user_prompt: String::new(),
            attachments: Vec::new(),
        };

        assert_eq!(render_prompt("{{title}}", &vars), "t");
    }

    #[test]
    fn compose_sections_append_when_template_has_no_slot() {
        let vars = PromptVars {
            task_id: "task-1".to_string(),
            title: "t".to_string(),
            md_path: "m".to_string(),
            repo_path: "r".to_string(),
            workspace_name: "w".to_string(),
            bug_id: "1".to_string(),
            severity: "s".to_string(),
            priority: "p".to_string(),
            project_rule: String::new(),
            user_prompt: "只改登录页".to_string(),
            attachments: vec![
                "/tmp/shot.png".to_string(),
                "/tmp/demo.mp4".to_string(),
                "/tmp/log.txt".to_string(),
            ],
        };

        let rendered = render_prompt("修 {{title}}", &vars);
        assert!(rendered.contains("用户补充说明：\n只改登录页"));
        assert!(rendered.contains("- 图片：/tmp/shot.png"));
        assert!(rendered.contains("- 视频：/tmp/demo.mp4"));
        assert!(rendered.contains("- 文件：/tmp/log.txt"));
    }

    #[test]
    fn pasted_resources_are_saved_as_paths() {
        let dir = std::env::temp_dir().join(format!(
            "tapd-agent-resource-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let path = save_resource(&dir, "截图 1.PNG", "aGVsbG8=").expect("save resource");
        assert!(path.ends_with(".png"), "unexpected path: {path}");
        assert_eq!(std::fs::read(&path).expect("read resource"), b"hello");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compose_sections_use_explicit_slots() {
        let vars = PromptVars {
            task_id: "task-1".to_string(),
            title: "t".to_string(),
            md_path: "m".to_string(),
            repo_path: "r".to_string(),
            workspace_name: "w".to_string(),
            bug_id: "1".to_string(),
            severity: "s".to_string(),
            priority: "p".to_string(),
            project_rule: String::new(),
            user_prompt: "只改登录页".to_string(),
            attachments: vec!["/tmp/shot.png".to_string()],
        };

        assert_eq!(
            render_prompt("说明：{{user_prompt}}｜资源：{{attachments}}", &vars),
            "说明：只改登录页｜资源：- 图片：/tmp/shot.png"
        );
    }

    #[test]
    fn queue_helpers_follow_insertion_order() {
        let tasks = vec![
            sample_task("a", TaskStatus::Succeeded),
            sample_task("b", TaskStatus::Queued),
            sample_task("c", TaskStatus::Queued),
        ];
        assert_eq!(next_queued_index(&tasks), Some(1));
        let counts = task_counts(&tasks);
        assert_eq!(counts.queued, 2);
        assert_eq!(counts.active, 0);
        assert_eq!(counts.waiting_review, 0);
        assert_eq!(active_task_id(&tasks).as_deref(), Some("b"));

        let mut running = tasks.clone();
        running[0].status = TaskStatus::Running;
        assert_eq!(active_task_id(&running).as_deref(), Some("a"));

        let mut preparing = tasks.clone();
        preparing[2].status = TaskStatus::Preparing;
        assert_eq!(active_task_id(&preparing).as_deref(), Some("c"));
    }

    #[test]
    fn active_task_falls_back_to_latest_finished() {
        let tasks = vec![
            sample_task("old", TaskStatus::Failed),
            sample_task("new", TaskStatus::Succeeded),
        ];
        assert_eq!(active_task_id(&tasks).as_deref(), Some("new"));
        assert_eq!(next_queued_index(&tasks), None);
        assert_eq!(active_task_id(&[]), None);
    }

    #[test]
    fn live_task_lookup_ignores_finished_tasks() {
        let mut live = sample_task("live", TaskStatus::Queued);
        live.workspace_id = "100".to_string();
        live.bug_id = "1".to_string();

        let mut finished = sample_task("finished", TaskStatus::Succeeded);
        finished.workspace_id = "100".to_string();
        finished.bug_id = "2".to_string();

        let tasks = vec![live, finished];
        assert_eq!(
            live_task_for_bug(&tasks, "100", "1").map(|task| task.id.as_str()),
            Some("live")
        );
        assert!(live_task_for_bug(&tasks, "100", "2").is_none());
        assert!(live_task_for_bug(&tasks, "100", "3").is_none());
        assert!(live_task_for_bug(&tasks, "200", "1").is_none());
    }

    #[test]
    fn finish_status_maps_exit_codes() {
        assert_eq!(finish_status(false, Some(0)), TaskStatus::Succeeded);
        assert_eq!(finish_status(false, Some(2)), TaskStatus::Failed);
        assert_eq!(finish_status(false, None), TaskStatus::Failed);
        assert_eq!(finish_status(true, Some(0)), TaskStatus::Canceled);
    }

    #[test]
    fn statuses_serialize_as_snake_case() {
        let cases = [
            (TaskStatus::Queued, "\"queued\""),
            (TaskStatus::Preparing, "\"preparing\""),
            (TaskStatus::Running, "\"running\""),
            (TaskStatus::WaitingReview, "\"waiting_review\""),
            (TaskStatus::AwaitingApproval, "\"awaiting_approval\""),
            (TaskStatus::Succeeded, "\"succeeded\""),
            (TaskStatus::Failed, "\"failed\""),
            (TaskStatus::Canceled, "\"canceled\""),
        ];
        for (status, expected) in cases {
            assert_eq!(serde_json::to_string(&status).unwrap(), expected);
            let parsed: TaskStatus = serde_json::from_str(expected).unwrap();
            assert_eq!(parsed, status);
        }
    }

    #[test]
    fn task_review_defaults_to_none_for_old_files() {
        let mut value = serde_json::to_value(sample_task("a", TaskStatus::Running)).unwrap();
        let object = value.as_object_mut().unwrap();
        for key in [
            "review",
            "approval",
            "commitOnly",
            "baselineDirty",
            "baselineHead",
        ] {
            object.remove(key);
        }
        let parsed: AgentTask = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.review, None);
        assert_eq!(parsed.approval, None);
        assert!(!parsed.commit_only);
        assert!(parsed.baseline_dirty.is_empty());
        assert_eq!(parsed.baseline_head, None);
    }

    #[test]
    fn porcelain_status_lists_changed_files() {
        let files =
            parse_porcelain_files(" M src/a.rs\n?? src/new.rs\nR  src/old.rs -> src/newer.rs\n");
        assert_eq!(files, vec!["src/a.rs", "src/new.rs", "src/newer.rs"]);
        assert!(parse_porcelain_files("").is_empty());
    }

    #[test]
    fn stash_limits_to_reviewed_files() {
        let dir = std::env::temp_dir().join(format!(
            "tapd-agent-stash-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(["-c", "user.email=test@example.com", "-c", "user.name=Test"])
                .args(args)
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?}");
        };

        git(&["init", "-q"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.join("b.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
        std::fs::write(dir.join("b.txt"), "changed\n").unwrap();
        std::fs::write(dir.join("new.txt"), "new file\n").unwrap();

        let stash = stash_changes(
            dir.to_str().unwrap(),
            "review",
            &["a.txt".to_string(), "new.txt".to_string()],
        )
        .expect("stash");
        assert!(stash.starts_with("stash@"));
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
        assert!(!dir.join("new.txt").exists());
        // Unrelated local work stays in the working tree.
        assert_eq!(
            std::fs::read_to_string(dir.join("b.txt")).unwrap(),
            "changed\n"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn awaiting_approval_is_not_downgraded_by_finish() {
        let mut task = sample_task("a", TaskStatus::Running);
        assert!(set_awaiting_approval(
            &mut task,
            "改了 3 个文件".to_string(),
            vec!["src/a.rs".to_string()],
            Some("公共接口变化".to_string()),
            "2026-11-10T01:00:00Z",
        ));
        assert_eq!(task.status, TaskStatus::AwaitingApproval);
        assert_eq!(
            task.approval.as_ref().map(|approval| approval.files.len()),
            Some(1)
        );
        assert!(task.finished_at.is_none());

        let outcome = PtyOutcome {
            exit_code: Some(0),
            ..PtyOutcome::default()
        };
        assert!(!apply_finish(&mut task, &outcome, "2026-11-10T01:01:00Z"));
        assert_eq!(task.status, TaskStatus::AwaitingApproval);
    }

    #[test]
    fn repo_path_uses_the_task_value_before_config() {
        let config = AgentConfig::default();
        assert!(config.repo_mappings.is_empty());

        let mut task = sample_task("a", TaskStatus::Queued);
        task.repo_path = "/tmp/repo".to_string();
        assert_eq!(
            resolve_repo_path(&task, &config),
            Ok("/tmp/repo".to_string())
        );

        // A blank task path falls back to the per-project setting.
        let config = AgentConfig {
            projects: BTreeMap::from([(
                "45336192".to_string(),
                ProjectAgentConfig {
                    repo_path: "/configured/repo".to_string(),
                    rule: String::new(),
                },
            )]),
            ..AgentConfig::default()
        };
        let mut task = sample_task("b", TaskStatus::Queued);
        task.repo_path = "  ".to_string();
        assert_eq!(
            resolve_repo_path(&task, &config),
            Ok("/configured/repo".to_string())
        );

        let missing = AgentConfig::default();
        let mut blank = sample_task("c", TaskStatus::Queued);
        blank.repo_path = String::new();
        assert!(resolve_repo_path(&blank, &missing).is_err());
    }

    #[test]
    fn state_and_summary_serialize_camel_case() {
        let tasks = vec![sample_task("a", TaskStatus::WaitingReview)];
        let state = AgentTasksState {
            tasks: tasks.clone(),
            active_task_id: Some("a".to_string()),
            queued_count: 0,
            waiting_review_count: 1,
            awaiting_approval_count: 0,
            queue_paused: false,
            external_claims: vec![sample_claim("2026-11-11T08:00:00Z")],
        };
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["queuedCount"], 0);
        assert_eq!(value["waitingReviewCount"], 1);
        assert_eq!(value["externalClaims"][0]["client"], "Zcode");
        assert_eq!(value["activeTaskId"], "a");

        let summary = serde_json::to_value(agent_summary(&tasks)).unwrap();
        assert_eq!(summary["running"], true);
        assert_eq!(summary["waitingReview"], true);
        assert_eq!(summary["activeTaskId"], "a");
        assert_eq!(summary["workspaceName"], "UU");
        assert_eq!(summary["bugId"], "1145336192001234567");
    }

    #[test]
    fn counts_and_summary_track_review_tasks() {
        let mut tasks = vec![
            sample_task("done", TaskStatus::Succeeded),
            sample_task("running", TaskStatus::Running),
            sample_task("waiting", TaskStatus::WaitingReview),
            sample_task("queued", TaskStatus::Queued),
            sample_task("approval", TaskStatus::AwaitingApproval),
        ];
        tasks[2].review = Some(PermissionReview {
            id: "per_1".to_string(),
            session_id: "ses_1".to_string(),
            action: "edit".to_string(),
            resource: "src/main.rs".to_string(),
            title: "允许编辑".to_string(),
            options: Vec::new(),
            transport: "opencode".to_string(),
        });
        tasks[4].approval = Some(TaskApproval {
            summary: "改了 2 个文件".to_string(),
            files: vec!["src/a.rs".to_string()],
            risk: None,
            requested_at: "2026-11-10T01:00:00Z".to_string(),
            approved_at: None,
            stash: None,
        });

        let counts = task_counts(&tasks);
        assert_eq!(counts.queued, 1);
        assert_eq!(counts.active, 2);
        assert_eq!(counts.waiting_review, 1);
        assert_eq!(counts.awaiting_approval, 1);

        let summary = agent_summary(&tasks);
        assert!(summary.running);
        assert!(summary.waiting_review);
        assert_eq!(summary.awaiting_approval, 1);
        // The first active task in list order is the running one.
        assert_eq!(summary.active_task_id.as_deref(), Some("running"));

        // Without a live turn, an awaiting task is the thing to open.
        let only_approval = vec![
            sample_task("approval", TaskStatus::AwaitingApproval),
            sample_task("queued", TaskStatus::Queued),
        ];
        assert_eq!(active_task_id(&only_approval).as_deref(), Some("approval"));
        assert_eq!(summary.title.as_deref(), Some("示例缺陷"));
        assert_eq!(summary.workspace_name.as_deref(), Some("UU"));
        assert_eq!(summary.bug_id.as_deref(), Some("1145336192001234567"));

        let mut only_waiting = vec![sample_task("waiting", TaskStatus::WaitingReview)];
        assert_eq!(
            agent_summary(&only_waiting).active_task_id.as_deref(),
            Some("waiting")
        );
        only_waiting.clear();
        assert_eq!(agent_summary(&only_waiting), AgentSummary::default());
    }

    #[test]
    fn finish_never_downgrades_a_terminal_task() {
        let mut task = sample_task("a", TaskStatus::Running);
        let outcome = PtyOutcome {
            exit_code: Some(0),
            ..PtyOutcome::default()
        };
        assert!(apply_finish(&mut task, &outcome, "2026-11-10T01:00:00Z"));
        assert_eq!(task.status, TaskStatus::Succeeded);

        // A later PTY exit with a non-zero code must not downgrade it.
        let late = PtyOutcome {
            exit_code: Some(2),
            error: Some("late".to_string()),
            ..PtyOutcome::default()
        };
        assert!(!apply_finish(&mut task, &late, "2026-11-10T01:00:01Z"));
        assert_eq!(task.status, TaskStatus::Succeeded);
        assert_eq!(task.error, None);
    }

    #[test]
    fn completion_marks_success_without_an_exit_code() {
        let mut task = sample_task("a", TaskStatus::Running);
        let outcome = PtyOutcome {
            completed: true,
            ..PtyOutcome::default()
        };
        assert!(apply_finish(&mut task, &outcome, "2026-11-10T01:00:00Z"));
        assert_eq!(task.status, TaskStatus::Succeeded);
        assert_eq!(task.exit_code, None);
        assert_eq!(task.finished_at.as_deref(), Some("2026-11-10T01:00:00Z"));
    }

    #[test]
    fn cancellation_and_failure_are_applied() {
        let mut task = sample_task("a", TaskStatus::WaitingReview);
        let outcome = PtyOutcome {
            canceled: true,
            ..PtyOutcome::default()
        };
        assert!(apply_finish(&mut task, &outcome, "2026-11-10T01:00:00Z"));
        assert_eq!(task.status, TaskStatus::Canceled);

        let mut task = sample_task("b", TaskStatus::Running);
        let outcome = PtyOutcome {
            exit_code: Some(1),
            ..PtyOutcome::default()
        };
        assert!(apply_finish(&mut task, &outcome, "2026-11-10T01:00:00Z"));
        assert_eq!(task.status, TaskStatus::Failed);
        assert_eq!(task.error.as_deref(), Some("Agent 进程退出码 1"));
    }

    #[test]
    fn recovery_marks_only_in_flight_tasks() {
        let mut tasks = vec![
            sample_task("queued", TaskStatus::Queued),
            sample_task("preparing", TaskStatus::Preparing),
            sample_task("running", TaskStatus::Running),
            sample_task("waiting", TaskStatus::WaitingReview),
            sample_task("done", TaskStatus::Succeeded),
        ];
        let events_dir = temp_events_dir();

        let recovered = recover_incomplete(&mut tasks, &events_dir, "2026-11-10T01:00:00Z");
        let ids: Vec<&str> = recovered.iter().map(|task| task.id.as_str()).collect();
        assert_eq!(ids, vec!["preparing", "running", "waiting"]);
        assert_eq!(tasks[0].status, TaskStatus::Queued);
        assert_eq!(tasks[1].status, TaskStatus::Failed);
        assert_eq!(tasks[1].error.as_deref(), Some("客户端重启"));
        assert_eq!(
            tasks[1].finished_at.as_deref(),
            Some("2026-11-10T01:00:00Z")
        );
        assert_eq!(tasks[2].status, TaskStatus::Failed);
        assert_eq!(tasks[3].status, TaskStatus::Failed);
        assert_eq!(tasks[4].status, TaskStatus::Succeeded);

        let _ = std::fs::remove_dir_all(&events_dir);
    }

    fn temp_events_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tapd-agent-events-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("events dir");
        dir
    }

    fn write_events(dir: &Path, task_id: &str, events: &[Value]) {
        let mut raw = String::new();
        for event in events {
            raw.push_str(&serde_json::to_string(event).expect("event json"));
            raw.push('\n');
        }
        std::fs::write(dir.join(format!("{task_id}.jsonl")), raw).expect("write events");
    }

    #[test]
    fn recorded_turn_outcome_ignores_events_before_the_turn() {
        let dir = temp_events_dir();
        // A replayed idle from history must not count as our turn finishing.
        write_events(
            &dir,
            "task-a",
            &[
                json!({ "type": "session.idle", "data": { "sessionID": "ses_old" } }),
                json!({ "type": "session.created", "data": { "sessionID": "ses_new" } }),
                json!({ "type": "session.step.started", "data": { "sessionID": "ses_new" } }),
            ],
        );
        assert_eq!(last_recorded_outcome(&dir, "task-a"), None);

        // A real turn boundary after the session started is trusted.
        write_events(
            &dir,
            "task-b",
            &[
                json!({ "type": "session.created", "data": { "sessionID": "ses_new" } }),
                json!({ "type": "session.execution.succeeded", "data": { "sessionID": "ses_new" } }),
            ],
        );
        assert_eq!(
            last_recorded_outcome(&dir, "task-b"),
            Some(RecordedOutcome::Succeeded)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recovery_keeps_a_finished_turn_successful() {
        let dir = temp_events_dir();
        write_events(
            &dir,
            "running",
            &[
                json!({ "type": "session.created", "data": { "sessionID": "ses_1" } }),
                json!({ "type": "session.execution.succeeded", "data": { "sessionID": "ses_1" } }),
            ],
        );
        write_events(
            &dir,
            "waiting",
            &[
                json!({ "type": "session.created", "data": { "sessionID": "ses_2" } }),
                json!({
                    "type": "session.execution.failed",
                    "data": { "sessionID": "ses_2", "message": "模型额度用尽" }
                }),
            ],
        );

        let mut tasks = vec![
            sample_task("running", TaskStatus::Running),
            sample_task("waiting", TaskStatus::WaitingReview),
        ];
        let recovered = recover_incomplete(&mut tasks, &dir, "2026-11-10T01:00:00Z");

        let ids: Vec<&str> = recovered.iter().map(|task| task.id.as_str()).collect();
        assert_eq!(ids, vec!["running", "waiting"]);
        assert_eq!(tasks[0].status, TaskStatus::Succeeded);
        assert_eq!(tasks[0].error, None);
        assert_eq!(tasks[0].exit_code, Some(0));
        assert_eq!(tasks[1].status, TaskStatus::Failed);
        assert_eq!(tasks[1].error.as_deref(), Some("模型额度用尽"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn utf8_prefix_keeps_split_characters_for_the_next_batch() {
        // "中" is E4 B8 AD; a batch that ends after two bytes must not emit
        // U+FFFD and must keep the tail for the next flush.
        let mut pending = vec![b'a', 0xE4, 0xB8];
        assert_eq!(take_utf8_prefix(&mut pending), b"a".to_vec());
        assert_eq!(pending, vec![0xE4, 0xB8]);

        pending.extend_from_slice(&[0xAD, b'b']);
        assert_eq!(take_utf8_prefix(&mut pending), "中b".as_bytes().to_vec());
        assert!(pending.is_empty());

        // Invalid bytes are emitted instead of stalling the buffer.
        let mut invalid = vec![0xFF, b'c'];
        assert_eq!(take_utf8_prefix(&mut invalid), vec![0xFF]);
        assert_eq!(invalid, b"c".to_vec());
    }

    #[test]
    fn validates_bare_command_names() {
        assert!(validate_binary("").is_err());
        assert!(validate_binary("/definitely/not/a/binary").is_err());
        assert!(validate_binary("definitely-not-a-real-command-xyz").is_err());
    }

    #[test]
    fn history_pages_terminal_tasks_newest_first() {
        let mut tasks = vec![
            sample_task("old", TaskStatus::Succeeded),
            sample_task("live", TaskStatus::Running),
            sample_task("new", TaskStatus::Failed),
            sample_task("mid", TaskStatus::Canceled),
        ];
        tasks[0].created_at = "2026-01-01T00:00:00Z".to_string();
        tasks[1].created_at = "2026-01-02T00:00:00Z".to_string();
        tasks[2].created_at = "2026-01-03T00:00:00Z".to_string();
        tasks[3].created_at = "2026-01-02T12:00:00Z".to_string();

        let page = build_history_page(
            &tasks,
            HistoryQuery {
                limit: Some(2),
                ..HistoryQuery::default()
            },
        );
        assert_eq!(page.total, 3);
        assert!(page.has_more);
        let ids: Vec<&str> = page.tasks.iter().map(|task| task.id.as_str()).collect();
        assert_eq!(ids, vec!["new", "mid"]);

        let next = build_history_page(
            &tasks,
            HistoryQuery {
                offset: Some(2),
                limit: Some(2),
                ..HistoryQuery::default()
            },
        );
        assert_eq!(next.total, 3);
        assert!(!next.has_more);
        assert_eq!(next.tasks.len(), 1);
        assert_eq!(next.tasks[0].id, "old");

        let failed = build_history_page(
            &tasks,
            HistoryQuery {
                status: Some("failed".to_string()),
                ..HistoryQuery::default()
            },
        );
        assert_eq!(failed.total, 1);
        assert_eq!(failed.tasks[0].id, "new");
    }

    #[test]
    fn prunes_artifacts_outside_the_newest_tasks() {
        let dir = std::env::temp_dir().join(format!(
            "tapd-agent-artifacts-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let logs = dir.join("logs");
        let events = dir.join("events");
        std::fs::create_dir_all(&logs).expect("logs");
        std::fs::create_dir_all(&events).expect("events");

        let keep = "a".repeat(32);
        let drop = "b".repeat(32);
        for id in [&keep, &drop] {
            std::fs::write(logs.join(format!("{id}.log")), "log").expect("log");
            std::fs::write(logs.join(format!("{id}-server.log")), "log").expect("server log");
            std::fs::write(logs.join(format!("{id}-acp.ndjson")), "log").expect("acp log");
            std::fs::write(events.join(format!("{id}.jsonl")), "event").expect("event");
        }
        std::fs::write(logs.join("notes.txt"), "keep me").expect("unrelated");

        let keep_ids: HashSet<String> = [keep.clone()].into_iter().collect();
        prune_agent_artifacts(&logs, &events, &keep_ids);

        for suffix in [".log", "-server.log", "-acp.ndjson"] {
            assert!(logs.join(format!("{keep}{suffix}")).exists());
            assert!(!logs.join(format!("{drop}{suffix}")).exists());
        }
        assert!(events.join(format!("{keep}.jsonl")).exists());
        assert!(!events.join(format!("{drop}.jsonl")).exists());
        assert!(logs.join("notes.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn pty_smoke_test_with_shell_script() {
        use std::os::unix::fs::PermissionsExt;

        let dir =
            std::env::temp_dir().join(format!("tapd-agent-pty-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let script = dir.join("fake-agent.sh");
        std::fs::write(&script, "#!/bin/sh\nprintf 'pty-smoke-ok\\n'\nsleep 0.1\n")
            .expect("write script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        let handles = open_pty(script.to_str().unwrap(), &[], &[], &dir, 80, 24).expect("open pty");
        let PtyHandles {
            master,
            writer,
            mut reader,
            mut child,
        } = handles;

        let reader_handle = std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = reader.read_to_end(&mut buffer);
            String::from_utf8_lossy(&buffer).to_string()
        });

        let status = child.wait().expect("wait child");
        let output = reader_handle.join().expect("join reader");
        drop((master, writer));

        assert!(status.success(), "exit status: {status}");
        assert!(output.contains("pty-smoke-ok"), "output: {output:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
