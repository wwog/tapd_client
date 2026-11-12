//! Agent queue: one serial worker that runs a coding agent's TUI in a PTY.
//!
//! Exposed through `feature_command` names starting with `agent_`.
//!
//! Design notes:
//! - The queue is strictly serial: one tokio worker picks `queued` tasks and
//!   runs them one at a time. Commands never start tasks directly. Every task
//!   body runs inside its own `tokio::spawn` so a panic cannot kill the worker.
//! - Every runtime is a CLI started in a PTY (see `runtime_catalog`). The prompt
//!   is delivered as argv, as a flag, or by bracketed paste on stdin once the
//!   TUI has been quiet for `ready_quiet_ms`.
//! - A turn ends on MCP `agent_task_report`, on process exit, or when output has
//!   been silent for `idle_complete_ms`; the uncommitted-work safety net can
//!   still force a review afterwards.
//! - PTY work happens on dedicated std threads (reader, batcher, wait) so the
//!   async worker only awaits a oneshot result (or an event-driven completion
//!   notification).
//! - All task state changes are persisted atomically and broadcast through
//!   `agent://state` plus the lightweight `agent://summary`. Terminal output is
//!   batched and sent via `agent://output`.

mod git;
mod pty;
mod persist;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::RecvTimeoutError,
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tapd_core::store::{read_json, write_json_atomic};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::{shell_path, state::SharedState};
use git::{
    committed_since_baseline, git_head, stash_changes, uncommitted_files,
};
use pty::{AgentRuntime, PromptGuard, PtyOutcome};

pub const MAIN_LABEL: &str = "main";

const CONFIG_FILE: &str = "agent.json";
/// Pasted screenshots/videos; only their paths are handed to the agent.
const RESOURCE_DIR: &str = "agent-resources";

const DEFAULT_BINARY: &str = "opencode";
const DEFAULT_RUNTIME_ID: &str = "opencode";
/// TUI 运行时在提示词注入后，输出静默多久视为本轮结束。
/// MCP 的 `agent_task_report` 是主信号，这里只是防止 Agent 忘记回报时任务永远卡住。
const DEFAULT_IDLE_COMPLETE_MS: u64 = 180_000;
/// Cap the diff preview so a huge refactor cannot freeze the review panel.
const MAX_REVIEW_DIFF_CHARS: usize = 120_000;

pub const DEFAULT_PROMPT_TEMPLATE: &str = "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n项目规则：\n{{project_rule}}\n\n{{coworker}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频，定位根因，做最小必要修改，并遵循团队代码规范。\n2. 修改后运行相关测试或构建。\n3. 判断改动复杂度：\n   - 简单缺陷（单文件或少量文件、局部改动，不涉及公共接口/数据模型/依赖/构建配置，测试通过）：直接 git commit（不要 push），提交成功后再在 TAPD 中评论并更新状态。\n   - 复杂缺陷（多文件、跨模块、涉及公共接口/数据模型/依赖/构建配置、风险较高或测试失败）：不要 commit，也不要修改 TAPD。调用 TAPD MCP 中名称包含 tapd_request_review 的工具，taskId 使用 {{task_id}}，summary 说明根因、方案与影响范围，files 列出改动文件，risk 说明风险点，然后结束本轮等待用户审核。\n4. 本轮结束时必须调用 TAPD MCP 中名称包含 agent_task_report 的工具回报结果：taskId 使用 {{task_id}}；成功提交并回写 TAPD 后 status=completed，无法完成时 status=failed 并在 message 说明原因。\n5. 任何情况下都不要在提交成功前评论或更新 TAPD 状态。";

/// Follow-up prompt injected after the user approves a paused review. The
/// working tree still holds the reviewed changes, so the agent only commits
/// and writes back to TAPD instead of redoing the fix.
pub const DEFAULT_COMMIT_PROMPT_TEMPLATE: &str = "审核已通过，请继续完成 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n项目规则：\n{{project_rule}}\n\n要求：\n1. 当前工作区保留了上一轮审核过的修改。先运行 git status / git diff 核对改动，不要重做或扩大范围。\n2. 运行必要的测试或构建，确认改动与缺陷相关。\n3. 提交代码（git commit，不要 push）。\n4. 提交成功后，再在 TAPD 中追加评论并更新缺陷状态；评论说明原由、解决方案与影响范围。\n5. 如果工作区已经没有未提交改动，说明上一轮已提交：核对提交记录后直接更新 TAPD，不要重复提交。\n6. 完成后调用 TAPD MCP 中名称包含 agent_task_report 的工具，taskId 使用 {{task_id}}，status=completed；失败时 status=failed 并说明原因。\n7. 绝对不要在提交成功前评论或更新 TAPD 状态。";

/// Previous defaults; untouched installs are migrated to the current default
/// (which also carries the `{{project_rule}}` slot).
const LEGACY_PROMPT_TEMPLATES: &[&str] = &[
    "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频。\n2. 定位根因，做最小必要修改。\n3.修复时请遵循团队代码规范，确保代码可读、可维护。\n4. 修复完成后，提交代码并在 TAPD 中更新缺陷状态并简要评论原由以及解决方案和修复影响范围。",
    "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频。\n2. 定位根因，做最小必要修改。\n3. 修改后运行相关测试或构建。\n4. 不要自行 git commit / push，完成后说明改了哪些文件。",
    // 引入同事技能之前的默认模板；未改动过的安装自动升级。
    "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n项目规则：\n{{project_rule}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频，定位根因，做最小必要修改，并遵循团队代码规范。\n2. 修改后运行相关测试或构建。\n3. 判断改动复杂度：\n   - 简单缺陷（单文件或少量文件、局部改动，不涉及公共接口/数据模型/依赖/构建配置，测试通过）：直接 git commit（不要 push），提交成功后再在 TAPD 中评论并更新状态。\n   - 复杂缺陷（多文件、跨模块、涉及公共接口/数据模型/依赖/构建配置、风险较高或测试失败）：不要 commit，也不要修改 TAPD。调用 TAPD MCP 中名称包含 tapd_request_review 的工具，taskId 使用 {{task_id}}，summary 说明根因、方案与影响范围，files 列出改动文件，risk 说明风险点，然后结束本轮等待用户审核。\n4. 本轮结束时必须调用 TAPD MCP 中名称包含 agent_task_report 的工具回报结果：taskId 使用 {{task_id}}；成功提交并回写 TAPD 后 status=completed，无法完成时 status=failed 并在 message 说明原因。\n5. 任何情况下都不要在提交成功前评论或更新 TAPD 状态。",
    // 引入 agent_task_report 之前的默认模板；未改动过的安装自动升级。
    "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n项目规则：\n{{project_rule}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频，定位根因，做最小必要修改，并遵循团队代码规范。\n2. 修改后运行相关测试或构建。\n3. 判断改动复杂度：\n   - 简单缺陷（单文件或少量文件、局部改动，不涉及公共接口/数据模型/依赖/构建配置，测试通过）：直接 git commit（不要 push），提交成功后再在 TAPD 中评论并更新状态。\n   - 复杂缺陷（多文件、跨模块、涉及公共接口/数据模型/依赖/构建配置、风险较高或测试失败）：不要 commit，也不要修改 TAPD。调用 tapd_request_review 工具，taskId 使用 {{task_id}}，summary 说明根因、方案与影响范围，files 列出改动文件，risk 说明风险点，然后结束本轮等待用户审核。\n4. 任何情况下都不要在提交成功前评论或更新 TAPD 状态。",
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
    /// Selected agent runtime id. The runtime catalog is the single source of
    /// truth for this list.
    pub runtime_id: String,
    pub binary_path: String,
    /// Legacy map kept only for migration; use `projects` instead.
    pub repo_mappings: BTreeMap<String, String>,
    /// TAPD workspace id -> repository path + project rules.
    pub projects: BTreeMap<String, ProjectAgentConfig>,
    pub prompt_template: String,
    /// Enabled coworkers from the bundled registry, in selection order. Their
    /// roles and skill packages are appended to every task prompt.
    pub coworker_ids: Vec<String>,
    /// How long the TUI must stay quiet (after producing output) before we
    /// consider it ready and inject the task.
    pub ready_quiet_ms: u64,
    /// Upper bound for readiness detection; on expiry we inject anyway.
    pub ready_timeout_ms: u64,
    /// TUI 运行时本轮结束的兜底：提示词注入后输出静默达到该时长即视为完成。
    /// 0 表示关闭兜底，只依赖 `agent_task_report` 或进程退出。
    pub idle_complete_ms: u64,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            runtime_id: DEFAULT_RUNTIME_ID.to_string(),
            binary_path: DEFAULT_BINARY.to_string(),
            repo_mappings: BTreeMap::new(),
            projects: BTreeMap::new(),
            prompt_template: DEFAULT_PROMPT_TEMPLATE.to_string(),
            coworker_ids: Vec::new(),
            ready_quiet_ms: 900,
            ready_timeout_ms: 15_000,
            idle_complete_ms: DEFAULT_IDLE_COMPLETE_MS,
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

        let binary = self.binary_path.trim();
        self.binary_path = if binary.is_empty() {
            runtime_descriptor(&self.runtime_id)
                .map(|descriptor| descriptor.binary.to_string())
                .unwrap_or_else(|| DEFAULT_BINARY.to_string())
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

        self.coworker_ids = normalize_coworker_ids(std::mem::take(&mut self.coworker_ids));

        self.ready_quiet_ms = self.ready_quiet_ms.clamp(100, 10_000);
        self.ready_timeout_ms = self.ready_timeout_ms.clamp(1_000, 120_000);
        self.idle_complete_ms = self.idle_complete_ms.min(3_600_000);

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
    /// Runtime can pause before committing for a human commit decision.
    pub commit_review: bool,
}

/// How the task prompt reaches the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptInjection {
    /// 作为位置参数随启动命令传入，TUI 启动即开始执行。
    Argv,
    /// 通过固定 flag 随启动命令传入。
    Flag,
    /// 启动后等待 TUI 就绪，再写入终端。
    Stdin,
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
    /// 启动参数（不含提示词）。
    pub args: Vec<&'static str>,
    pub prompt_injection: PromptInjection,
    /// Flag 模式下承载提示词的参数名，例如 `-i` / `--prompt`。
    pub prompt_flag: Option<&'static str>,
    /// False for future runtimes that are listed but not executable yet.
    pub available: bool,
    pub capabilities: AgentRuntimeCapabilities,
    pub lifecycle: Vec<AgentLifecycleStage>,
    /// Declared interoperability gaps, rendered verbatim in the management UI.
    pub limitations: Vec<&'static str>,
    /// What the UI does when an external decision cannot be applied.
    pub fallback: &'static str,
}

/// Lifecycle is shared by every runtime; only the launch command and prompt
/// delivery differ.
fn runtime_lifecycle() -> Vec<AgentLifecycleStage> {
    vec![
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
    ]
}

/// 通用 TUI 没有协议回执：权限确认在终端里完成。
fn tui_capabilities() -> AgentRuntimeCapabilities {
    AgentRuntimeCapabilities {
        interactive_terminal: true,
        permission_prompt: true,
        external_decision: false,
        commit_review: true,
    }
}

/// 通用 TUI 的互通限制；`mcp_auto` 表示该客户端是否已有自动注入支持。
fn tui_limitations(mcp_auto: bool) -> Vec<&'static str> {
    let mcp = if mcp_auto {
        "启动前会尝试把 tapd MCP 写入该客户端的用户级配置。"
    } else {
        "尚未自动注入 tapd MCP，需要手动配置后才能回写 TAPD。"
    };
    vec![
        "权限确认在右侧嵌入式终端内完成，桌面不会代为回执。",
        "本轮结束以 agent_task_report 为准；未调用时按输出静默兜底。",
        mcp,
    ]
}

/// 一条通用 TUI 运行时描述。参数与注入方式参考 orca 的 TUI agent 适配表。
fn tui_runtime(
    id: &'static str,
    name: &'static str,
    vendor: &'static str,
    description: &'static str,
    binary: &'static str,
    args: Vec<&'static str>,
    prompt_injection: PromptInjection,
    prompt_flag: Option<&'static str>,
    mcp_auto: bool,
) -> AgentRuntimeDescriptor {
    AgentRuntimeDescriptor {
        id,
        name,
        vendor,
        description,
        binary,
        args,
        prompt_injection,
        prompt_flag,
        available: true,
        capabilities: tui_capabilities(),
        lifecycle: runtime_lifecycle(),
        limitations: tui_limitations(mcp_auto),
        fallback: "权限确认和交互操作都在嵌入式终端内完成；桌面只在任务结束后收集状态。",
    }
}

/// Single source of truth for the runtime list. Adding an agent means adding one
/// descriptor here, not branching the queue or the UI.
pub fn runtime_catalog() -> Vec<AgentRuntimeDescriptor> {
    vec![
        tui_runtime(
            "opencode",
            "OpenCode",
            "SST",
            "OpenCode 交互式终端，启动后写入提示词。",
            DEFAULT_BINARY,
            Vec::new(),
            PromptInjection::Stdin,
            None,
            true,
        ),
        tui_runtime(
            "claude",
            "Claude Code",
            "Anthropic",
            "Claude Code 交互式终端，提示词作为启动参数传入。",
            "claude",
            Vec::new(),
            PromptInjection::Argv,
            None,
            true,
        ),
        tui_runtime(
            "codex",
            "Codex",
            "OpenAI",
            "Codex CLI 交互式终端，提示词作为启动参数传入。",
            "codex",
            Vec::new(),
            PromptInjection::Argv,
            None,
            true,
        ),
        tui_runtime(
            "cursor",
            "Cursor Agent",
            "Anysphere",
            "Cursor 命令行 Agent，提示词作为启动参数传入。",
            "cursor-agent",
            Vec::new(),
            PromptInjection::Argv,
            None,
            true,
        ),
        tui_runtime(
            "zcode",
            "ZCode",
            "ZCode",
            "ZCode 终端 Agent，启动后写入提示词。",
            "zcode",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            true,
        ),
        tui_runtime(
            "gemini",
            "Gemini CLI",
            "Google",
            "Gemini CLI 交互式终端，使用 -i 传入提示词。",
            "gemini",
            Vec::new(),
            PromptInjection::Flag,
            Some("-i"),
            false,
        ),
        tui_runtime(
            "qwen",
            "Qwen Code",
            "Alibaba",
            "Qwen Code 终端 Agent，启动后写入提示词。",
            "qwen",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "copilot",
            "GitHub Copilot",
            "GitHub",
            "Copilot CLI 交互式终端，使用 -i 传入提示词。",
            "copilot",
            Vec::new(),
            PromptInjection::Flag,
            Some("-i"),
            false,
        ),
        tui_runtime(
            "cline",
            "Cline",
            "Cline",
            "Cline CLI 终端 Agent，启动后写入提示词。",
            "cline",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "aider",
            "Aider",
            "Aider",
            "Aider 交互式终端，启动后写入提示词。",
            "aider",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "goose",
            "Goose",
            "Block",
            "Goose 交互式终端，启动后写入提示词。",
            "goose",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "custom",
            "自定义命令",
            "本地",
            "任意 TUI Agent：把可执行路径改成你的命令，启动后写入提示词。",
            "my-agent",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
    ]
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
    binary_path: Option<String>,
    repo_mappings: Option<BTreeMap<String, String>>,
    projects: Option<BTreeMap<String, ProjectAgentConfig>>,
    prompt_template: Option<String>,
    coworker_ids: Option<Vec<String>>,
    ready_quiet_ms: Option<u64>,
    ready_timeout_ms: Option<u64>,
    idle_complete_ms: Option<u64>,
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
    /// The agent finished a complex change and is waiting for the user to
    /// approve the commit. The working tree keeps the diff; the queue is
    /// blocked until the user approves or stops the task.
    AwaitingApproval,
    Succeeded,
    Failed,
    Canceled,
}

impl TaskStatus {
    /// A task occupying the single worker slot. `AwaitingApproval` blocks the
    /// queue through the explicit awaiting-review check, not through this.
    fn is_active(self) -> bool {
        matches!(self, Self::Preparing | Self::Running)
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Canceled)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub prompt: String,
    pub source: String,
    /// Runtime selected when the task was enqueued, so switching settings later
    /// cannot change how an existing/queued task runs.
    #[serde(default = "default_task_runtime")]
    pub runtime_id: String,
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
    awaiting_approval_count: usize,
    /// True after the user stopped a review; the worker stays idle until
    /// `agent_queue_resume`.
    queue_paused: bool,
    /// Last persistence failure, cleared by the next successful write.
    storage_error: Option<String>,
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
    awaiting_approval: usize,
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
    /// Enabled coworkers and their skill package paths; empty when none is on.
    pub coworker: String,
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
            coworker: String::new(),
        }
    }
}

/// Replaces `{{variable}}` placeholders; unknown placeholders are left intact.
///
/// The project rule is exposed as `{{project_rule}}` so a global template can
/// decide where it lands; when the template has no such placeholder the rule is
/// appended as its own section instead of being silently dropped. Coworker
/// skills (`{{coworker}}`) follow the same slot-or-append policy.
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
        ("coworker", vars.coworker.as_str()),
    ];

    let has_rule_slot = template.contains("{{project_rule}}");
    let has_prompt_slot = template.contains("{{user_prompt}}");
    let has_attachments_slot = template.contains("{{attachments}}");
    let has_coworker_slot = template.contains("{{coworker}}");
    let mut rendered = template.to_string();
    for (key, value) in pairs {
        rendered = rendered.replace(&format!("{{{{{key}}}}}"), value);
    }

    let rule = vars.project_rule.trim();
    if !has_rule_slot && !rule.is_empty() {
        rendered.push_str("\n\n项目规则：\n");
        rendered.push_str(rule);
    }

    // Coworker skills use the same policy: an explicit slot keeps placement
    // under the template's control, otherwise the whole section is appended.
    let coworker = vars.coworker.trim();
    if !has_coworker_slot && !coworker.is_empty() {
        rendered.push_str("\n\n");
        rendered.push_str(coworker);
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

/// Trims, de-duplicates and caps the enabled coworkers so a hand-edited
/// `agent.json` cannot grow every prompt without bound.
fn normalize_coworker_ids(values: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let id = value.trim();
        if id.is_empty() || out.iter().any(|item| item == id) {
            continue;
        }
        out.push(id.to_string());
        if out.len() >= crate::coworker::MAX_ENABLED_COWORKERS {
            break;
        }
    }
    out
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
        awaiting_approval: 0,
    };
    for task in tasks {
        match task.status {
            TaskStatus::Queued => counts.queued += 1,
            TaskStatus::Preparing | TaskStatus::Running => counts.active += 1,
            TaskStatus::AwaitingApproval => counts.awaiting_approval += 1,
            _ => {}
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

/// Moves a task into the post-work review state without touching the working
/// tree.
fn set_awaiting_approval(
    task: &mut AgentTask,
    summary: String,
    files: Vec<String>,
    risk: Option<String>,
    now: &str,
) {
    task.status = TaskStatus::AwaitingApproval;
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
}

/// Applies a PTY/event outcome to a task. Returns whether anything changed.
///
/// A task that already reached a terminal state is never downgraded: a late
/// `finish_task` must not turn an event-driven `succeeded` into `failed`.
fn apply_finish(task: &mut AgentTask, outcome: &PtyOutcome, now: &str) -> bool {
    if task.status.is_terminal() || task.status == TaskStatus::AwaitingApproval {
        return false;
    }

    if outcome.canceled {
        task.status = TaskStatus::Canceled;
        task.finished_at = Some(now.to_string());
        if task.error.is_none() {
            task.error = Some("已取消".to_string());
        }
        return true;
    }

    task.finished_at = Some(now.to_string());
    task.exit_code = outcome.exit_code;

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

/// Marks tasks that were mid-flight when the client exited as failed, so the
/// queue can make progress after a restart. Returns the recovered tasks.
fn recover_incomplete(tasks: &mut [AgentTask], now: &str) -> Vec<AgentTask> {
    let mut recovered = Vec::new();
    for task in tasks.iter_mut() {
        if !task.status.is_active() {
            continue;
        }
        task.status = TaskStatus::Failed;
        task.error = Some("客户端重启".to_string());
        task.exit_code = None;
        task.finished_at = Some(now.to_string());
        recovered.push(task.clone());
    }
    recovered
}

// ---------------------------------------------------------------------------
// PTY plumbing
// ---------------------------------------------------------------------------

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Launcher body: enter the repository, then exec the agent CLI.
fn terminal_script(cwd: &Path, binary: &str, args: &[&str]) -> String {
    let mut command = shell_quote(binary);
    for arg in args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    format!(
        "#!/bin/zsh\ncd {} || exit 1\nexec {command}\n",
        shell_quote(&cwd.to_string_lossy())
    )
}

/// Opens Terminal.app on a generated `.command` launcher that enters the
/// repository and runs the agent CLI. The launcher lives in the system temp
/// directory: it is a handle for one session, never a transcript, so nothing
/// about the agent's output is recorded.
fn launch_system_terminal(cwd: &Path, binary: &str, args: &[&str]) -> Result<(), String> {
    let script = terminal_script(cwd, binary, args);
    let path = std::env::temp_dir().join(format!(
        "tapd-agent-{}.command",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&path, script).map_err(|error| format!("写入终端启动脚本失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("设置终端启动脚本权限失败：{error}"))?;
    }

    let status = std::process::Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(&path)
        .status()
        .map_err(|error| format!("打开系统终端失败：{error}"))?;
    if !status.success() {
        return Err("打开系统终端失败".to_string());
    }
    Ok(())
}

/// Earlier versions kept per-task artifacts in the data directory
/// (`agent-logs/<id>.log` plus `agent-events/` from the removed ACP path).
/// Neither is written any more, so the leftovers are removed instead of
/// lingering.
fn remove_legacy_logs(data_dir: &Path) {
    for name in ["agent-logs", "agent-events"] {
        let dir = data_dir.join(name);
        if !dir.is_dir() {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            tracing::warn!(%error, path = %dir.display(), "failed to remove legacy agent artifacts");
        }
    }
}

// ---------------------------------------------------------------------------
// Runtime core
// ---------------------------------------------------------------------------

pub struct AgentCore {
    app: AppHandle,
    state: SharedState,
    config: Mutex<AgentConfig>,
    tasks: Mutex<Vec<AgentTask>>,
    /// External AI claims, keyed by workspace + bug (see `ExternalClaim`).
    external: Mutex<Vec<ExternalClaim>>,
    runtimes: Mutex<HashMap<String, Arc<Mutex<AgentRuntime>>>>,
    /// Serializes "who owns this bug" decisions. Enqueue, retry and an external
    /// claim all check the other side and then write; without one lock in front
    /// of that check-then-act, both sides can win and two agents edit the same
    /// repository.
    admission: tokio::sync::Mutex<()>,
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
    /// Last SQLite failure. Surfaced in the Agent header so a broken store is
    /// visible instead of looking like a queue that simply lost history.
    storage_error: Mutex<Option<String>>,
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
            admission: tokio::sync::Mutex::new(()),
            sizes: Mutex::new(HashMap::new()),
            paused: AtomicBool::new(false),
            pending_tasks: Mutex::new(HashMap::new()),
            removed_tasks: Mutex::new(HashSet::new()),
            persist_lock: Mutex::new(()),
            paused_dirty: AtomicBool::new(false),
            storage_error: Mutex::new(None),
            wake: tokio::sync::Notify::new(),
        }
    }

    fn config_path(&self) -> PathBuf {
        self.state.paths.data_dir.join(CONFIG_FILE)
    }

    fn load(&self) {
        let loaded = read_json::<AgentConfig>(&self.config_path())
            .unwrap_or_default()
            .sanitized();
        if let Err(error) = write_json_atomic(&self.config_path(), &loaded) {
            tracing::warn!(%error, "failed to persist agent config");
        }
        *self.config.lock().expect("agent config lock") = loaded;

        // SQLite is the only task store. A failed read is a startup error, not
        // an empty queue: log it loudly so the user can find the cause instead
        // of watching their history disappear.
        let mut load_failed = false;
        let (mut tasks, paused) = match self.state.cache.load_agent_tasks() {
            Some(loaded) => loaded,
            None => {
                tracing::error!(
                    "failed to load agent tasks from SQLite; starting with an empty queue"
                );
                load_failed = true;
                (Vec::new(), false)
            }
        };
        self.paused.store(paused, Ordering::SeqCst);
        self.paused_dirty.store(false, Ordering::SeqCst);

        let recovered = recover_incomplete(&mut tasks, &now());
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

        // The agent console no longer records per-task logs; drop what earlier
        // versions left behind instead of keeping unread files forever.
        remove_legacy_logs(&self.state.paths.data_dir);
        self.persist_tasks();
        if load_failed {
            // `persist_tasks` may have cleared a write error; a failed read is
            // still a real data-loss signal and must stay visible.
            self.set_storage_error(Some(
                "本地任务存储不可用，历史任务可能无法读取".to_string(),
            ));
        }
    }

    pub(crate) fn config_snapshot(&self) -> AgentConfig {
        self.config.lock().expect("agent config lock").clone()
    }

    /// Enabled coworker ids, in selection order.
    pub(crate) fn selected_coworker_ids(&self) -> Vec<String> {
        self.config_snapshot().coworker_ids
    }

    /// Replaces the enabled coworker list. Unknown ids are filtered by the
    /// caller; sanitizing here only trims, de-duplicates and caps. A failed
    /// write is returned so the page does not pretend the choice was saved.
    pub(crate) fn set_coworker_ids(&self, ids: Vec<String>) -> Result<AgentConfig, String> {
        let next = {
            let mut config = self.config.lock().expect("agent config lock");
            config.coworker_ids = ids;
            config.clone().sanitized()
        };
        self.store_config(next)
    }

    fn store_config(&self, next: AgentConfig) -> Result<AgentConfig, String> {
        // Persist before publishing: if the write fails, memory and the task
        // prompts must keep the old config instead of diverging from disk.
        write_json_atomic(&self.config_path(), &next)
            .map_err(|error| {
                tracing::warn!(%error, "failed to persist agent config");
                format!("保存 Agent 配置失败：{error}")
            })?;
        *self.config.lock().expect("agent config lock") = next.clone();
        Ok(next)
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

        // Serialized with enqueue/retry: the desktop queue and an external
        // claim cannot both pass their ownership check.
        let _admission = self.admission.lock().await;

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
                let _ = crate::notification::ai::raise_system_note(
                    "外部 AI 接管任务",
                    crate::notification::model::AiTone::Warning,
                    &format!("“{client}”接管了「{label}」，队列中的 Agent 任务已取消"),
                    Some(&format!("external-claim:{workspace_id}:{bug_id}:takeover")),
                );
            } else {
                let _ = crate::notification::ai::raise_system_note(
                    "外部 AI 接管被拒绝",
                    crate::notification::model::AiTone::Warning,
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

        // Decide before mutating. Removing first and then failing on a foreign
        // claim would leave memory ahead of SQLite: the claim reappears on the
        // next launch even though the caller saw an error.
        let blocked_by = {
            let claims = self.external.lock().expect("external claims lock");
            claims
                .iter()
                .find(|claim| {
                    claim.workspace_id == workspace_id
                        && claim.bug_id == bug_id
                        && external_claim_fresh_at(claim, now_secs)
                        && client.is_some_and(|caller| claim.client != caller)
                })
                .map(|claim| claim.client.clone())
        };
        if let Some(client) = blocked_by {
            return Err(format!("该缺陷当前由“{client}”占用"));
        }

        let removed = {
            let mut claims = self.external.lock().expect("external claims lock");
            let before = claims.len();
            // No fresh foreign claim is left at this point: drop every matching
            // row (stale or the caller's own). `client = None` is the user's
            // cancel button and may clear any claim.
            claims.retain(|claim| {
                claim.workspace_id != workspace_id || claim.bug_id != bug_id
            });
            before != claims.len()
        };
        if removed {
            self.persist_external_claims();
            self.emit_state();
        }
        Ok(removed)
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
            awaiting_approval_count: counts.awaiting_approval,
            queue_paused: self.paused.load(Ordering::SeqCst),
            storage_error: self
                .storage_error
                .lock()
                .expect("agent storage error lock")
                .clone(),
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
        // Same source as the `agent_summary` command: the full task list, not
        // the live-only slice carried by `state.tasks`.
        let summary = self.summary();
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
            let changed = mutate(&mut tasks);
            if !changed.is_empty() {
                // Mark dirty before releasing the tasks lock: two concurrent
                // mutations must not leave an older snapshot pending last.
                let mut pending = self.pending_tasks.lock().expect("agent pending lock");
                for task in &changed {
                    pending.insert(task.id.clone(), task.clone());
                }
            }
            changed
        };
        if changed.is_empty() {
            return false;
        }
        self.persist_tasks();
        self.emit_state();
        true
    }

    fn update_task<F>(&self, task_id: &str, mutate: F) -> Option<AgentTask>
    where
        F: FnOnce(&mut AgentTask),
    {
        let (snapshot, changed) = {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            let task = tasks.iter_mut().find(|task| task.id == task_id)?;
            let before = task.clone();
            mutate(task);
            let changed = *task != before;
            let snapshot = task.clone();
            if changed {
                self.pending_tasks
                    .lock()
                    .expect("agent pending lock")
                    .insert(snapshot.id.clone(), snapshot.clone());
            }
            (snapshot, changed)
        };
        if changed {
            self.persist_tasks();
            self.emit_state();
        }
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
        });
        if changed.is_none() {
            tracing::warn!(task_id, "agent task disappeared while failing");
        }
    }

    fn update_config(&self, patch: AgentConfigPatch) -> Result<AgentConfig, String> {
        let next = {
            let mut config = self.config.lock().expect("agent config lock");
            if let Some(runtime_id) = patch.runtime_id {
                config.runtime_id = runtime_id;
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
            if let Some(ids) = patch.coworker_ids {
                config.coworker_ids = ids;
            }
            if let Some(value) = patch.ready_quiet_ms {
                config.ready_quiet_ms = value;
            }
            if let Some(value) = patch.ready_timeout_ms {
                config.ready_timeout_ms = value;
            }
            if let Some(value) = patch.idle_complete_ms {
                config.idle_complete_ms = value;
            }
            config.clone().sanitized()
        };

        self.store_config(next)
    }

    async fn enqueue(&self, request: &EnqueueRequest, source: &str) -> Result<AgentTask, String> {
        let workspace_id = request.workspace_id.trim();
        let bug_id = request.bug_id.trim();
        if workspace_id.is_empty() || bug_id.is_empty() {
            return Err("缺少 workspaceId 或 bugId".to_string());
        }

        // Admission is serialized with retry and external claims so the
        // "external owns it?" / "a desktop task owns it?" checks cannot both
        // pass and start two agents on one repository.
        let _admission = self.admission.lock().await;

        let id = uuid::Uuid::new_v4().simple().to_string();

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
            error: None,
            prompt: String::new(),
            source: source.to_string(),
            runtime_id: config.runtime_id.clone(),
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

    /// Cancels a task: sets the cancel flag and kills the TUI process group.
    async fn cancel(&self, task_id: &str) -> Result<AgentTask, String> {
        let status = self
            .current_status(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if status == TaskStatus::AwaitingApproval {
            // A paused review owns an uncommitted diff. Cancelling it through
            // the generic path would drop that diff and leave the queue
            // unpaused; stop_review stashes it and keeps the queue halted.
            return self.stop_review(task_id).await;
        }
        if status.is_terminal() {
            return Err("任务已经结束，无需取消".to_string());
        }

        let snapshot = {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            let task = tasks
                .iter_mut()
                .find(|task| task.id == task_id)
                .ok_or_else(|| "任务不存在".to_string())?;

            if task.status.is_terminal() {
                return Err("任务已经结束，无需取消".to_string());
            }
            task.status = TaskStatus::Canceled;
            task.finished_at = Some(now());
            if task.error.is_none() {
                task.error = Some("已取消".to_string());
            }
            task.clone()
        };

        self.stop_runtime(task_id);
        self.mark_task_dirty(snapshot.clone());
        self.persist_tasks();
        self.emit_state();
        // If the worker was parked because this was the only task, let it
        // re-check the queue instead of sleeping until the next enqueue.
        self.wake.notify_one();
        Ok(snapshot)
    }

    /// Kills the TUI process group and closes its PTY handles. Idempotent.
    fn stop_runtime(&self, task_id: &str) {
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

    /// Full teardown for a task: TUI process group and remembered console size.
    /// Safe to call repeatedly.
    fn teardown_task(&self, task_id: &str) {
        self.stop_runtime(task_id);
        self.sizes.lock().expect("agent sizes lock").remove(task_id);
    }

    /// Kills every TUI this process started.
    ///
    /// The TUI runs in its own session, so a plain process exit leaves it
    /// running: the turn keeps going after the window is gone and keeps
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
            TaskStatus::Preparing | TaskStatus::Running
        ) {
            return Err("任务不在运行中，无法请求审核".to_string());
        }

        let at = now();
        let updated = self
            .update_task(task_id, |task| {
                if !matches!(
                    task.status,
                    TaskStatus::Preparing | TaskStatus::Running
                ) {
                    return;
                }
                set_awaiting_approval(task, summary, files, risk, &at);
            })
            .ok_or_else(|| "任务不存在".to_string())?;
        if updated.status != TaskStatus::AwaitingApproval {
            return Err("任务状态已变化，无法请求审核".to_string());
        }

        // Kill the TUI. The working tree is deliberately left untouched so
        // approval can commit it.
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

    /// Deletes one finished history record. Only the local record goes away;
    /// the export directory, the bug and any committed code are untouched.
    fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let removed = {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            take_terminal_task(&mut tasks, task_id)?
        };
        // Drop a queued snapshot first, otherwise the next persist could
        // resurrect the row before the delete statement runs.
        self.pending_tasks
            .lock()
            .expect("agent pending lock")
            .remove(&removed.id);
        self.removed_tasks
            .lock()
            .expect("agent removed lock")
            .insert(removed.id.clone());
        self.persist_tasks();
        self.emit_state();
        Ok(())
    }

    async fn retry(&self, task_id: &str) -> Result<AgentTask, String> {
        let original = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if !original.status.is_terminal() {
            return Err("任务仍在队列或运行中，不能重试".to_string());
        }

        let _admission = self.admission.lock().await;

        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut task = original;
        task.id = id.clone();
        task.status = TaskStatus::Queued;
        task.created_at = now();
        task.started_at = None;
        task.finished_at = None;
        task.exit_code = None;
        task.error = None;
        task.approval = None;

        // Retry is a new admission, not a bypass: the same bug may have been
        // claimed externally or re-queued while this task was terminal.
        if let Some(claim) = self.fresh_external_claim(&task.workspace_id, &task.bug_id) {
            return Err(format!(
                "{}，请稍后再试或先在列表中取消外部占用",
                external_claim_phrase(&claim)
            ));
        }
        {
            let mut tasks = self.tasks.lock().expect("agent tasks lock");
            if let Some(existing) =
                live_task_for_bug(&tasks, &task.workspace_id, &task.bug_id)
            {
                return Err(format!(
                    "该缺陷已有未结束的任务（{}），请先处理",
                    task_status_key(existing.status)
                ));
            }
            tasks.push(task.clone());
        }
        self.mark_task_dirty(task.clone());
        self.persist_tasks();
        self.emit_state();
        self.wake.notify_one();
        Ok(task)
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

    /// 在系统终端里接着跑这个任务的 Agent（尽量续接上次会话），用来在任务
    /// 结束后继续处理同一个缺陷。运行中的任务不允许：内嵌 PTY 还占着同一
    /// 会话，两个客户端会互相打架。
    fn open_system_terminal(&self, task_id: &str) -> Result<(), String> {
        let task = self
            .task_snapshot(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status.is_active() {
            return Err("任务仍在运行，请先在嵌入式终端里操作".to_string());
        }
        if task.repo_path.trim().is_empty() {
            return Err("该任务没有本地仓库".to_string());
        }
        let repo = Path::new(&task.repo_path);
        if !repo.is_dir() {
            return Err(format!("本地仓库不存在：{}", task.repo_path));
        }

        let config = self.config_snapshot();
        let binary = validate_binary(&binary_for_task(&config, &task.runtime_id))?;
        let mut args: Vec<&str> = runtime_descriptor(&task.runtime_id)
            .map(|descriptor| descriptor.args.clone())
            .unwrap_or_default();
        args.extend_from_slice(resume_args(&task.runtime_id));
        launch_system_terminal(repo, &binary.to_string_lossy(), &args)
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

        // 3. Resolve the agent binary. A queued task keeps the runtime it was
        //    enqueued with: `binary_path` only overrides the currently selected
        //    runtime, otherwise the descriptor's default command is used.
        let task_binary = binary_for_task(&config, &task.runtime_id);
        // Bare names are looked up on the user's shell PATH and replaced with
        // the absolute path, so every spawn (serve / TUI) works even when the
        // app was launched from Finder with a minimal PATH.
        match validate_binary(&task_binary) {
            Ok(binary) => config.binary_path = binary.to_string_lossy().into_owned(),
            Err(error) => {
                self.fail_task(&task.id, error);
                return;
            }
        }

        // 3b. Make sure the runtime's user-level config exposes the tapd MCP
        //     server. Idempotent and best effort: a failure only warns and never
        //     blocks the task. Runtimes without an injector are expected to be
        //     configured manually (the management UI says so).
        if let Some(client) = mcp_client_for_runtime(&task.runtime_id) {
            let sidecar = crate::commands::sidecar_command_path();
            match tokio::task::spawn_blocking(move || {
                if client == crate::mcp_import::CLIENT_OPENCODE {
                    crate::mcp_import::ensure_opencode_mcp(&sidecar)
                } else {
                    crate::mcp_import::ensure_client_mcp(client, &sidecar)
                }
            })
            .await
            {
                Ok(Ok(result)) => {
                    tracing::info!(task_id = %task.id, %result, "tapd MCP injection checked");
                }
                Ok(Err(error)) => {
                    tracing::warn!(task_id = %task.id, %error, "failed to inject tapd MCP");
                }
                Err(error) => {
                    tracing::warn!(task_id = %task.id, %error, "MCP injection task panicked");
                }
            }
        }

        let mut vars = PromptVars::from_task(&task);
        vars.project_rule = config.rule_for(&task.workspace_id);
        vars.coworker = crate::coworker::prompt_section(&self.app, &config.coworker_ids);
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
            // A late report or a review request may have finished/parked this
            // task while it was preparing; never restart it from a terminal or
            // awaiting state.
            if current.status.is_terminal() || current.status == TaskStatus::AwaitingApproval {
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

        if running_task.status != TaskStatus::Running {
            return;
        }

        let descriptor = runtime_descriptor(&running_task.runtime_id)
            .unwrap_or_else(|| runtime_descriptor(DEFAULT_RUNTIME_ID).expect("default runtime"));
        let outcome = self
            .run_tui_task(&running_task, &config, &descriptor)
            .await;
        self.teardown_task(&task.id);
        self.finish_task(&task.id, outcome).await;
    }

    /// Runs one task through the generic TUI adapter: launch the CLI with the
    /// prompt delivered per the descriptor, then wait for the PTY to exit or
    /// for the idle fallback. Completion normally arrives through the TAPD MCP
    /// `agent_task_report` tool, which kills the PTY and finishes the task.
    async fn run_tui_task(
        self: &Arc<Self>,
        task: &AgentTask,
        config: &AgentConfig,
        descriptor: &AgentRuntimeDescriptor,
    ) -> PtyOutcome {
        let mut args: Vec<String> = descriptor.args.iter().map(|arg| arg.to_string()).collect();
        let inject_prompt = match descriptor.prompt_injection {
            PromptInjection::Argv => {
                args.push(task.prompt.clone());
                false
            }
            PromptInjection::Flag => match descriptor.prompt_flag {
                Some(flag) => {
                    args.push(flag.to_string());
                    args.push(task.prompt.clone());
                    false
                }
                None => {
                    // Descriptor bug: fall back to typing the prompt instead of
                    // launching an agent that never receives it.
                    tracing::warn!(
                        task_id = %task.id,
                        "runtime declares no prompt flag, falling back to stdin"
                    );
                    true
                }
            },
            PromptInjection::Stdin => true,
        };

        tracing::info!(
            task_id = %task.id,
            runtime = descriptor.name,
            binary = %config.binary_path,
            args = %descriptor.args.join(" "),
            injection = match descriptor.prompt_injection {
                PromptInjection::Argv => "argv",
                PromptInjection::Flag => "flag",
                PromptInjection::Stdin => "stdin",
            },
            "starting agent tui"
        );

        let idle_complete = if config.idle_complete_ms == 0 {
            None
        } else {
            Some(Duration::from_millis(config.idle_complete_ms))
        };

        let guard = Arc::new(PromptGuard::default());
        let (sender, receiver) = tokio::sync::oneshot::channel::<PtyOutcome>();
        let core = self.clone();
        let pty_task = task.clone();
        let pty_config = config.clone();
        std::thread::Builder::new()
            .name(format!("agent-tui-{}", pty_task.id))
            .spawn(move || {
                let outcome = core.run_pty(
                    &pty_task,
                    &pty_config,
                    args,
                    Vec::new(),
                    guard,
                    inject_prompt,
                    idle_complete,
                );
                let _ = sender.send(outcome);
            })
            .map_err(|error| tracing::warn!(%error, "failed to spawn agent tui thread"))
            .ok();

        match receiver.await {
            Ok(outcome) => outcome,
            Err(_) => PtyOutcome {
                error: Some("Agent 终端线程意外结束".to_string()),
                ..PtyOutcome::default()
            },
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

/// Removes one finished task from the in-memory list. Active tasks are refused:
/// the worker and the PTY teardown still hold references to them.
fn take_terminal_task(tasks: &mut Vec<AgentTask>, task_id: &str) -> Result<AgentTask, String> {
    let index = tasks
        .iter()
        .position(|task| task.id == task_id)
        .ok_or_else(|| "任务不存在".to_string())?;
    if !tasks[index].status.is_terminal() {
        return Err("任务仍在队列或运行中，无法删除".to_string());
    }
    Ok(tasks.remove(index))
}

fn truncate_text(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
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

/// CLI arguments that pick the previous session back up in the task's working
/// directory, used by the "打开系统终端" recovery path. Only runtimes whose
/// resume entry point is known are listed; everything else opens a plain
/// terminal in the repository.
fn resume_args(runtime_id: &str) -> &'static [&'static str] {
    match runtime_id {
        "opencode" => &["--continue"],
        "claude" => &["--continue"],
        "codex" => &["resume"],
        _ => &[],
    }
}

/// The command a task runs with: the configured path while it points at the
/// task's runtime, otherwise that runtime's default binary. Queued tasks keep
/// the runtime they were enqueued with, so switching settings later cannot
/// change how an existing task (or its recovery terminal) starts.
fn binary_for_task(config: &AgentConfig, runtime_id: &str) -> String {
    if config.runtime_id == runtime_id {
        config.binary_path.clone()
    } else {
        runtime_descriptor(runtime_id)
            .map(|descriptor| descriptor.binary.to_string())
            .unwrap_or_else(|| config.binary_path.clone())
    }
}

/// True when the configured agent is opencode (MCP injection only applies to it).
/// MCP clients whose user-level config this build can write automatically.
/// Other runtimes keep the task but cannot write back to TAPD until the user
/// configures the tapd MCP server themselves.
fn mcp_client_for_runtime(runtime_id: &str) -> Option<&'static str> {
    match runtime_id {
        "opencode" => Some(crate::mcp_import::CLIENT_OPENCODE),
        "zcode" => Some(crate::mcp_import::CLIENT_ZCODE),
        "claude" => Some(crate::mcp_import::CLIENT_CLAUDE),
        "cursor" => Some(crate::mcp_import::CLIENT_CURSOR),
        "codex" => Some(crate::mcp_import::CLIENT_CODEX),
        _ => None,
    }
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
                let core = listener_core.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = core.enqueue(&request, "notification").await {
                        tracing::warn!(%error, "failed to enqueue agent task from notification");
                    }
                });
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

/// MCP `agent_task_report`: explicit lifecycle report for generic TUI runtimes.
/// This is the fallback that lets an agent say "completed / failed / needs
/// review" instead of us reverse-engineering its transcript.
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

    // A report for a missing or already-finished task must be visible as an
    // error, not silently accepted as if it changed something.
    if matches!(status.as_str(), "completed" | "failed" | "needs_review") {
        let current = core
            .task_snapshot(&task_id)
            .ok_or_else(|| format!("任务不存在：{task_id}"))?;
        if current.status.is_terminal() {
            return Err(format!(
                "任务已结束（{}），不能再次回报",
                task_status_key(current.status)
            ));
        }
    }

    match status.as_str() {
        "completed" => {
            core.finish_task(
                &task_id,
                PtyOutcome {
                    exit_code: Some(0),
                    completed: true,
                    ..PtyOutcome::default()
                },
            )
            .await;
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
            tracing::info!(
                task_id = %task_id,
                message = message.as_deref().unwrap_or("Agent 进度更新"),
                "agent progress"
            );
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
            let config = core.update_config(patch)?;
            Ok(json!({ "config": config }))
        }
        "agent_enqueue_bug" => {
            let request: EnqueueRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的入队参数：{error}"))?;
            let task = core
                .enqueue(&request, request.source.as_deref().unwrap_or("manual"))
                .await?;
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
            let task = core.retry(request.task_id.trim()).await?;
            Ok(json!({ "task": task }))
        }
        "agent_task_delete" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的删除参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            core.delete_task(request.task_id.trim())?;
            Ok(json!({ "deleted": true }))
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
        "agent_open_terminal" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的终端参数：{error}"))?;
            let core = core.inner().clone();
            let task_id = request.task_id.trim().to_string();
            tokio::task::spawn_blocking(move || core.open_system_terminal(&task_id))
                .await
                .map_err(|error| format!("打开终端失败：{error}"))??;
            Ok(json!({ "ok": true }))
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
    use super::git::parse_porcelain_files;
    use super::pty::{open_pty, take_utf8_prefix, PtyHandles};
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
            error: None,
            prompt: "prompt".to_string(),
            source: "manual".to_string(),
            runtime_id: DEFAULT_RUNTIME_ID.to_string(),
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
        assert_eq!(config.binary_path, "opencode");
        assert!(config.repo_mappings.is_empty());
        assert_eq!(config.ready_quiet_ms, 900);
        assert_eq!(config.ready_timeout_ms, 15_000);
        assert_eq!(config.idle_complete_ms, DEFAULT_IDLE_COMPLETE_MS);
        assert!(config.prompt_template.contains("{{md_path}}"));
        assert!(config.prompt_template.contains("{{title}}"));
        assert!(config.prompt_template.contains("{{coworker}}"));
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
            binary_path: "   ".to_string(),
            repo_mappings: BTreeMap::from([
                ("1".to_string(), "  /repo  ".to_string()),
                ("2".to_string(), "   ".to_string()),
            ]),
            projects: BTreeMap::new(),
            prompt_template: "  ".to_string(),
            coworker_ids: Vec::new(),
            ready_quiet_ms: 1,
            ready_timeout_ms: 999_999,
            idle_complete_ms: 9_999_999,
        }
        .sanitized();

        assert_eq!(config.binary_path, "opencode");
        assert_eq!(config.runtime_id, "opencode");
        assert_eq!(config.ready_quiet_ms, 100);
        assert_eq!(config.ready_timeout_ms, 120_000);
        assert_eq!(config.idle_complete_ms, 3_600_000);
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
        assert!(!opencode.capabilities.external_decision);

        let keys: Vec<&str> = opencode.lifecycle.iter().map(|stage| stage.key).collect();
        for expected in [
            "queued",
            "preparing",
            "running",
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
    fn tui_runtimes_declare_launch_and_injection() {
        for runtime in runtime_catalog() {
            assert!(!runtime.binary.trim().is_empty(), "{} binary", runtime.id);
            assert!(!runtime.lifecycle.is_empty(), "{} lifecycle", runtime.id);
            assert!(!runtime.limitations.is_empty(), "{} limitations", runtime.id);
            if runtime.prompt_injection == PromptInjection::Flag {
                assert!(
                    runtime.prompt_flag.is_some(),
                    "{} uses flag injection without prompt_flag",
                    runtime.id
                );
            }
            assert!(runtime.capabilities.interactive_terminal);
            assert!(!runtime.capabilities.external_decision);
        }
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
            coworker: String::new(),
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
            coworker: String::new(),
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
            coworker: String::new(),
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
            coworker: String::new(),
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
            coworker: String::new(),
        };

        assert_eq!(
            render_prompt("说明：{{user_prompt}}｜资源：{{attachments}}", &vars),
            "说明：只改登录页｜资源：- 图片：/tmp/shot.png"
        );
    }

    #[test]
    fn coworker_section_appends_or_uses_its_slot() {
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
            coworker: "协作同事（各司其职）：\n- 程序员｜Author：一起写".to_string(),
        };

        let appended = render_prompt("修 {{title}}", &vars);
        assert!(appended.ends_with("协作同事（各司其职）：\n- 程序员｜Author：一起写"));

        let slotted = render_prompt("{{coworker}}\n\n修 {{title}}", &vars);
        assert!(slotted.starts_with("协作同事（各司其职）："));
        assert!(!slotted.contains("{{coworker}}"));
    }

    #[test]
    fn coworker_ids_are_trimmed_deduped_and_capped() {
        let mut ids = vec![
            " author ".to_string(),
            "author".to_string(),
            String::new(),
            "designer".to_string(),
        ];
        ids.extend((0..20).map(|index| format!("extra-{index}")));
        let normalized = normalize_coworker_ids(ids);
        assert_eq!(normalized[0], "author");
        assert_eq!(normalized.len(), crate::coworker::MAX_ENABLED_COWORKERS);
        assert_eq!(normalized[1], "designer");
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
    fn task_optional_fields_default_for_old_files() {
        let mut value = serde_json::to_value(sample_task("a", TaskStatus::Running)).unwrap();
        let object = value.as_object_mut().unwrap();
        for key in ["approval", "commitOnly", "baselineDirty", "baselineHead"] {
            object.remove(key);
        }
        let parsed: AgentTask = serde_json::from_value(value).unwrap();
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
        set_awaiting_approval(
            &mut task,
            "改了 3 个文件".to_string(),
            vec!["src/a.rs".to_string()],
            Some("公共接口变化".to_string()),
            "2026-11-10T01:00:00Z",
        );
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
        let tasks = vec![sample_task("a", TaskStatus::Running)];
        let state = AgentTasksState {
            tasks: tasks.clone(),
            active_task_id: Some("a".to_string()),
            queued_count: 0,
            awaiting_approval_count: 0,
            queue_paused: false,
            storage_error: None,
            external_claims: vec![sample_claim("2026-11-11T08:00:00Z")],
        };
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["queuedCount"], 0);
        assert_eq!(value["externalClaims"][0]["client"], "Zcode");
        assert_eq!(value["activeTaskId"], "a");

        let summary = serde_json::to_value(agent_summary(&tasks)).unwrap();
        assert_eq!(summary["running"], true);
        assert_eq!(summary["activeTaskId"], "a");
        assert_eq!(summary["workspaceName"], "UU");
        assert_eq!(summary["bugId"], "1145336192001234567");
    }

    #[test]
    fn counts_and_summary_track_review_tasks() {
        let mut tasks = vec![
            sample_task("done", TaskStatus::Succeeded),
            sample_task("running", TaskStatus::Running),
            sample_task("queued", TaskStatus::Queued),
            sample_task("approval", TaskStatus::AwaitingApproval),
        ];
        tasks[3].approval = Some(TaskApproval {
            summary: "改了 2 个文件".to_string(),
            files: vec!["src/a.rs".to_string()],
            risk: None,
            requested_at: "2026-11-10T01:00:00Z".to_string(),
            approved_at: None,
            stash: None,
        });

        let counts = task_counts(&tasks);
        assert_eq!(counts.queued, 1);
        assert_eq!(counts.active, 1);
        assert_eq!(counts.awaiting_approval, 1);

        let summary = agent_summary(&tasks);
        assert!(summary.running);
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
        let mut task = sample_task("a", TaskStatus::Running);
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
            sample_task("done", TaskStatus::Succeeded),
        ];
        let recovered = recover_incomplete(&mut tasks, "2026-11-10T01:00:00Z");
        let ids: Vec<&str> = recovered.iter().map(|task| task.id.as_str()).collect();
        assert_eq!(ids, vec!["preparing", "running"]);
        assert_eq!(tasks[0].status, TaskStatus::Queued);
        assert_eq!(tasks[1].status, TaskStatus::Failed);
        assert_eq!(tasks[1].error.as_deref(), Some("客户端重启"));
        assert_eq!(
            tasks[1].finished_at.as_deref(),
            Some("2026-11-10T01:00:00Z")
        );
        assert_eq!(tasks[2].status, TaskStatus::Failed);
        assert_eq!(tasks[3].status, TaskStatus::Succeeded);
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
    fn terminal_script_quotes_repo_path_and_resume_args() {
        let script = terminal_script(Path::new("/tmp/it's repo"), "opencode", &["--continue"]);
        assert!(script.starts_with("#!/bin/zsh\n"), "{script}");
        assert!(script.contains(r#"cd '/tmp/it'\''s repo' || exit 1"#), "{script}");
        assert!(script.contains("exec 'opencode' '--continue'"), "{script}");
        // Runtimes without a resume entry point still open the repository.
        let plain = terminal_script(Path::new("/tmp/repo"), "/opt/bin/zcode", &[]);
        assert!(plain.contains("exec '/opt/bin/zcode'\n"), "{plain}");
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
    fn delete_takes_only_terminal_tasks() {
        let mut tasks = vec![
            sample_task("done", TaskStatus::Succeeded),
            sample_task("running", TaskStatus::Running),
        ];

        let err = take_terminal_task(&mut tasks, "running").expect_err("active task");
        assert!(err.contains("运行中"), "{err}");
        assert_eq!(tasks.len(), 2);

        let err = take_terminal_task(&mut tasks, "missing").expect_err("missing task");
        assert!(err.contains("不存在"), "{err}");

        let removed = take_terminal_task(&mut tasks, "done").expect("terminal task");
        assert_eq!(removed.id, "done");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "running");
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
