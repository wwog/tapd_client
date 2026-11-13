//! Agent workflow host: runs coding agents in PTYs on behalf of
//! `tapd_workflow::Workflow`.
//!
//! Exposed through `feature_command` names starting with `agent_`.
//!
//! Design notes:
//! - `AgentCore` owns no task state of its own. Commands, UI events and host
//!   facts become `tapd_workflow::Input`; the workflow returns `Effect`s
//!   (worktree, PTY, merge, persistence, UI) that this module executes. Every
//!   platform result travels back as another `Input`.
//! - The workflow schedules up to `effective_execution_units()` tasks in
//!   parallel (one when worktree isolation is off). Commands never start tasks
//!   directly.
//! - Every runtime is a CLI started in a PTY (see `runtime_catalog`). The prompt
//!   is delivered as argv, as a flag, or by bracketed paste on stdin once the
//!   TUI has been quiet for `ready_quiet_ms`.
//! - A turn ends on process exit, on a session hook `settled` event, or when
//!   output has been silent for `idle_complete_ms`; the uncommitted-work safety
//!   net is reported to the workflow as a `RunOutcome`.
//! - PTY work happens on dedicated std threads (reader, batcher, wait) so the
//!   async effect runners only await a oneshot result (or an event-driven
//!   completion notification).
//! - Persistence is effect-driven and broadcast through `agent://state` plus
//!   the lightweight `agent://summary`. Terminal output is batched and sent via
//!   `agent://output`.

mod git;
mod hooks;
mod persist;
mod prompt;
mod pty;
mod status;
mod transcript;
mod workflow_bridge;
mod worktree;

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
use tapd_workflow::{
    Effect, HistoryRecord, Input, Snapshot, Task as WorkflowTask, TaskId, TaskSpec,
    TaskStatus as WorkflowStatus, Workflow,
};
use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::{shell_path, state::SharedState};
use git::{
    branch_merged, changed_files_since, committed_since_baseline, git_head, stash_changes,
    uncommitted_files,
};
use hooks::SessionHookKind;
use pty::{AgentRuntime, PromptGuard, PtyOutcome};

pub const MAIN_LABEL: &str = "main";

const CONFIG_FILE: &str = "agent.json";
/// Pasted screenshots/videos; only their paths are handed to the agent.
const RESOURCE_DIR: &str = "agent-resources";
/// 启动时临时挂载的运行时扩展目录。
const EXTENSION_DIR: &str = "agent-extensions";

/// OMP 会话监控 hook：把 pi 的会话、回合、工具与 settle 事件 POST 到桌面端。
///
/// `agent_end` 之后 pi 可能自动重试、压缩或继续处理，真正结束用
/// `agent_settled`；旧版本没有该事件时用 1.5s 兜底定时器补发。
///
/// 通过 `--extension` 传入，只在当前任务生效，不写用户配置。
const OMP_SESSION_HOOK: &str = r#"import { request } from "node:http";

export default function tapdSessionMonitor(pi) {
  const clip = (value, limit) => {
    if (value == null) return "";
    let text = value;
    if (typeof text !== "string") {
      try {
        text = JSON.stringify(text);
      } catch {
        return "";
      }
    }
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  };

  const contentText = (content, limit) => {
    if (typeof content === "string") return clip(content, limit);
    if (Array.isArray(content)) {
      return clip(
        content.filter((block) => block && typeof block.text === "string").map((block) => block.text).join(" "),
        limit,
      );
    }
    return "";
  };

  const assistantText = (message, limit) => {
    if (!message) return "";
    return contentText(message.content, limit);
  };

  const lastAssistantText = (messages, limit) => {
    if (!Array.isArray(messages)) return "";
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const text = assistantText(messages[index], limit);
      if (text) return text;
    }
    return "";
  };

  const post = (ctx, event, payload = {}, flags = {}) => {
    const rawUrl = process.env.TAPD_AGENT_HOOK_URL;
    const token = process.env.TAPD_AGENT_HOOK_TOKEN;
    const taskId = process.env.TAPD_AGENT_TASK_ID;
    if (!rawUrl || !token || !taskId) return;

    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return;
    }

    let sessionId = "";
    try {
      sessionId = ctx?.sessionManager?.getSessionId() || "";
    } catch {
      sessionId = "";
    }

    const body = new URLSearchParams({
      taskId,
      event,
      runtime: process.env.TAPD_AGENT_RUNTIME || "omp",
      sessionId,
      willContinue: String(Boolean(flags.willContinue)),
      awaitingAsyncWork: String(Boolean(flags.awaitingAsyncWork)),
      payload: JSON.stringify({ ...payload, sessionId: sessionId || null }),
    }).toString();

    try {
      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(body),
            "X-Tapd-Hook-Token": token,
          },
        },
        (res) => res.resume(),
      );
      req.on("error", () => {});
      req.write(body);
      req.end();
    } catch {
      // Best effort: the desktop still has the idle timeout as a last resort.
    }
  };

  let settleTimer = null;
  let lastError = "";
  const clearSettle = () => {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  };
  // 重试耗尽 / 网络中断时 assistant 消息带 errorMessage；用户中断是 aborted。
  const assistantError = (messages) => {
    if (!Array.isArray(messages)) return "";
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || message.role !== "assistant") continue;
      if (message.errorMessage) return clip(message.errorMessage, 400);
      const reason = message.stopReason;
      if (reason && !["stop", "toolUse", "length", "aborted", "end_turn"].includes(reason)) {
        return clip(`Agent 结束：${reason}`, 200);
      }
    }
    return "";
  };
  const eventError = (event) => {
    const value = event?.error;
    if (typeof value === "string") return clip(value, 400);
    if (value && typeof value.message === "string") return clip(value.message, 400);
    return "";
  };
  const settle = (ctx, error) => {
    clearSettle();
    if (error) post(ctx, "StopFailure", { error });
    else post(ctx, "agent_end", { message: "回合结束" });
  };

  pi.on("session_start", (event, ctx) =>
    post(ctx, "SessionStart", { message: "会话已启动", reason: event?.reason }),
  );
  pi.on("before_agent_start", (event, ctx) => {
    clearSettle();
    lastError = "";
    post(ctx, "UserPromptSubmit", { prompt: clip(event?.prompt, 200) });
  });
  pi.on("agent_start", (_event, ctx) => {
    clearSettle();
    lastError = "";
    post(ctx, "AgentStart", {});
  });
  pi.on("turn_start", (_event, ctx) => {
    clearSettle();
    lastError = "";
    post(ctx, "TurnStart", {});
  });
  pi.on("tool_call", (event, ctx) =>
    post(ctx, "PreToolUse", { tool_name: event?.toolName, tool_input: event?.input }),
  );
  pi.on("tool_result", (event, ctx) => {
    if (event?.isError) {
      post(ctx, "PostToolUseFailure", {
        tool_name: event?.toolName,
        error: contentText(event?.content, 200),
      });
    } else {
      post(ctx, "PostToolUse", {
        tool_name: event?.toolName,
        tool_response: contentText(event?.content, 200),
      });
    }
  });
  pi.on("turn_end", (event, ctx) =>
    post(ctx, "TurnEnd", { message: assistantText(event?.message, 400) }),
  );
  pi.on("agent_end", (event, ctx) => {
    // pi 可能继续重试/压缩/跟进，不能把 agent_end 当最终结束。
    clearSettle();
    lastError = assistantError(event?.messages) || eventError(event);
    post(ctx, "AgentTurnEnd", {
      message: lastAssistantText(event?.messages, 400),
      error: lastError || null,
    }, { willContinue: Boolean(event?.willRetry) });
    if (event?.willRetry) return;
    settleTimer = setTimeout(() => settle(ctx, lastError), 5000);
    if (settleTimer && typeof settleTimer.unref === "function") settleTimer.unref();
  });
  pi.on("agent_settled", (event, ctx) => settle(ctx, lastError || eventError(event)));
  pi.on("session_shutdown", () => clearSettle());
}
"#;

const DEFAULT_BINARY: &str = "opencode";
const DEFAULT_RUNTIME_ID: &str = "opencode";
/// TUI 运行时在提示词注入后，输出静默多久视为本轮结束。
/// 进程退出与会话 hook 是主信号，这里只是防止 Agent 长时间无输出时任务永远卡住。
const DEFAULT_IDLE_COMPLETE_MS: u64 = 180_000;
/// Cap the diff preview so a huge refactor cannot freeze the review panel.
const MAX_REVIEW_DIFF_CHARS: usize = 120_000;

pub const DEFAULT_PROMPT_TEMPLATE: &str = "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情：{{json_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n{{coworker}}\n\n要求：\n1. 先完整阅读 bug.json 和 assets/ 下的截图、视频。\n2. 定位根因，做最小必要修改，并遵循团队代码规范。\n3. 修改后运行相关测试或构建。\n4. 判断改动复杂度：\n   - 简单任务：单文件或少量文件、局部改动，不涉及公共接口 / 数据模型 / 依赖 / 构建配置，且测试通过。直接 git commit（不要 push），然后用 tapd_add_bug_comment 说明原因、方案与影响范围，并用 tapd_update_bug_status 更新状态；可先调用 tapd_get_bug_transitions 查看允许的下一步。\n   - 复杂任务：多文件、跨模块、涉及公共接口 / 数据模型 / 依赖 / 构建配置，或风险较高、测试失败。不要 commit，也不要评论或更新 TAPD；说明根因、方案、影响范围与风险，然后结束本轮。客户端会把未提交改动放进待审核列表，等待用户操作。\n5. 任何情况下都不要在提交成功前评论或更新 TAPD 状态。";

/// Follow-up prompt injected after the user approves a paused review. The
/// working tree still holds the reviewed changes, so the agent only commits
/// and writes back to TAPD instead of redoing the fix.
pub const DEFAULT_COMMIT_PROMPT_TEMPLATE: &str = "审核已通过，请继续完成 TAPD 缺陷：{{title}}\n\n缺陷详情：{{json_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n要求：\n1. 当前工作区保留了上一轮审核过的修改。先运行 git status / git diff 核对改动，不要重做或扩大范围。\n2. 运行必要的测试或构建，确认改动与缺陷相关。\n3. 提交代码（git commit，不要 push）。\n4. 提交成功后，用 tapd_add_bug_comment 追加评论并说明原因、方案与影响范围，再用 tapd_update_bug_status 更新缺陷状态。\n5. 如果工作区已经没有未提交改动，说明上一轮已提交：核对提交记录后直接更新 TAPD，不要重复提交。\n6. 绝对不要在提交成功前评论或更新 TAPD 状态。";

/// Worktree 任务审核通过后的提交阶段。TAPD 回写统一留到合并阶段，避免任务
/// 还没并入主仓库就把缺陷标记为已解决。
pub const DEFAULT_WORKTREE_COMMIT_PROMPT_TEMPLATE: &str = "审核已通过，请在当前 worktree 提交上一轮审核过的修改。\n缺陷详情：{{json_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n要求：\n1. 先运行 git status / git diff 核对改动，不要重做或扩大范围。\n2. 运行必要的测试或构建。\n3. 提交代码（git commit，不要 push）。\n4. 不要评论或更新 TAPD；合并阶段会统一回写。\n5. 如果工作区已经没有未提交改动，说明已提交，直接结束。";

/// 追加到 Worktree 修复阶段的交付说明：修复轮不写 TAPD。
const WORKTREE_FIX_NOTE: &str = "本轮在独立 worktree 中运行：不要评论或更新 TAPD。简单任务只提交；复杂任务保留未提交改动。审核与合并完成后，由合并阶段统一写回 TAPD。";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Per-project agent settings, edited from the project card.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectAgentConfig {
    /// Absolute local repository path used as the agent's working directory.
    pub repo_path: String,
    /// Project-specific rules. Not part of the built-in prompt: `tapd_get_bug`
    /// returns them as its own `projectRule` field for external agents.
    pub rule: String,
}

/// 每个运行时的默认模型与访问权限；任务入队时可单独覆盖。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentRuntimeOptions {
    /// 空字符串表示交给 CLI 自己决定。
    pub model: String,
    /// 权限选项 id；见 `AgentPermissionOption`。
    pub permission_mode: String,
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
    /// 0 表示关闭兜底，只依赖进程退出与会话 hook。
    pub idle_complete_ms: u64,
    /// 每个任务在独立的 git worktree 中运行。关闭时并发固定为 1。
    #[serde(default)]
    pub worktree_enabled: bool,
    /// 同时运行的任务数；仅在开启 worktree 时生效。
    #[serde(default = "default_execution_units")]
    pub execution_units: u32,
    /// 客户端重启后，之前排队（Queued）的任务自动继续执行。关闭时队列仍然
    /// 保留，但保持暂停，等用户手动继续，不丢任务。
    #[serde(default = "default_restore_queued_tasks")]
    pub restore_queued_tasks: bool,
    /// 每个运行时的默认模型与权限；任务入队时作为默认值。
    #[serde(default)]
    pub runtime_options: BTreeMap<String, AgentRuntimeOptions>,
}

/// Worktree 开启后默认并行两个任务：再多会让 TUI 抢占交互终端，也不利于排查。
fn default_execution_units() -> u32 {
    2
}

/// 恢复排队默认开启：用户重启客户端时期待队列继续跑下去。
fn default_restore_queued_tasks() -> bool {
    true
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
            worktree_enabled: false,
            execution_units: default_execution_units(),
            restore_queued_tasks: default_restore_queued_tasks(),
            runtime_options: BTreeMap::new(),
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
            || template_uses_removed_contract(&self.prompt_template)
        {
            self.prompt_template = DEFAULT_PROMPT_TEMPLATE.to_string();
        }

        self.coworker_ids = normalize_coworker_ids(std::mem::take(&mut self.coworker_ids));

        self.ready_quiet_ms = self.ready_quiet_ms.clamp(100, 10_000);
        self.ready_timeout_ms = self.ready_timeout_ms.clamp(1_000, 120_000);
        self.idle_complete_ms = self.idle_complete_ms.min(3_600_000);
        self.execution_units = self.execution_units.clamp(1, 8);

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

        // 只保留已知运行时；空选项直接丢弃，避免配置文件堆积垃圾。
        self.runtime_options = self
            .runtime_options
            .into_iter()
            .filter(|(runtime_id, _)| runtime_descriptor(runtime_id).is_some())
            .map(|(runtime_id, options)| {
                (
                    runtime_id,
                    AgentRuntimeOptions {
                        model: options.model.trim().to_string(),
                        permission_mode: options.permission_mode.trim().to_string(),
                    },
                )
            })
            .filter(|(_, options)| !options.model.is_empty() || !options.permission_mode.is_empty())
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

    /// How many tasks may run in parallel. Without worktree isolation the
    /// tasks would share one working tree, so the queue stays serial.
    pub(crate) fn effective_execution_units(&self) -> usize {
        if self.worktree_enabled {
            self.execution_units.clamp(1, 8) as usize
        } else {
            1
        }
    }
}

// ---------------------------------------------------------------------------
// Runtime catalog
// ---------------------------------------------------------------------------

/// A lifecycle stage every runtime must declare. `needs_human` stages block the
/// queue until the user acts; `terminal` stages are final states.
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

/// 可以传给运行时的访问权限选项；第一项通常是「默认」。
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPermissionOption {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

/// 只声明「默认」的运行时：不追加任何权限参数。
fn default_permissions() -> Vec<AgentPermissionOption> {
    vec![AgentPermissionOption {
        id: "default",
        label: "默认权限",
        description: "沿用 CLI 自己的权限与沙箱配置。",
    }]
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
    /// 同一 CLI 的其他可执行名，只用于安装检测（例如 `auggie` / `kimi-code`）。
    pub aliases: Vec<&'static str>,
    /// 启动参数（不含提示词）。
    pub args: Vec<&'static str>,
    /// 常用模型名，仅用于下拉建议；允许自由输入。
    pub models: Vec<&'static str>,
    /// 可选访问权限；总是至少包含 `default`。
    pub permissions: Vec<AgentPermissionOption>,
    pub prompt_injection: PromptInjection,
    /// Flag 模式下承载提示词的参数名，例如 `-i` / `--prompt`。
    pub prompt_flag: Option<&'static str>,
    /// Argv 模式下放在提示词前的参数终止符，避免 `--help` 之类被当成 CLI 选项。
    pub argv_separator: Option<&'static str>,
    /// 该运行时支持会话 hook：启动时挂一个只上报回合事件的 hook，用于监控
    /// 回合结束与捕获会话 id。
    pub session_hook: bool,
    /// `session_hook` 的具体接入方式，只在后端使用。
    #[serde(skip)]
    pub(crate) hook_kind: SessionHookKind,
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
            description: "Worktree 任务改动或非 Worktree 复杂改动暂停，等待通过或停止。",
            needs_human: true,
            terminal: false,
        },
        AgentLifecycleStage {
            key: "awaiting_merge",
            label: "待合并",
            description: "审核已通过，等待确认用原 Agent 或手动把任务分支合并到主仓库。",
            needs_human: true,
            terminal: false,
        },
        AgentLifecycleStage {
            key: "merging",
            label: "合并中",
            description: "原 Agent 正在主仓库合并任务分支，并校验分支是否已并入 HEAD。",
            needs_human: false,
            terminal: false,
        },
        AgentLifecycleStage {
            key: "succeeded",
            label: "任务完成",
            description: "合并校验通过（或非 Worktree 提交）并完成 TAPD 回写。",
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
        "本轮结束以进程退出为准；未退出时按会话 hook 或输出静默兜底。",
        mcp,
    ]
}

/// 目录里只有少数运行时需要别名、子命令或参数终止符，其余用空扩展。
#[derive(Default)]
struct TuiRuntimeExtra {
    /// 只用于安装检测的其他可执行名。
    aliases: Vec<&'static str>,
    /// 固定启动参数（子命令、信任跳过等）。
    args: Vec<&'static str>,
    /// 常用模型名（datalist 建议）。
    models: Vec<&'static str>,
    /// 可选的访问权限；为空时只有「默认权限」。
    permissions: Vec<AgentPermissionOption>,
    /// Argv 注入时提示词前面的参数终止符。
    argv_separator: Option<&'static str>,
    /// 启动时挂会话监控 hook（见 `agent/hooks.rs`）。
    session_hook: SessionHookKind,
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
    tui_runtime_with(
        id,
        name,
        vendor,
        description,
        binary,
        TuiRuntimeExtra {
            args,
            ..TuiRuntimeExtra::default()
        },
        prompt_injection,
        prompt_flag,
        mcp_auto,
    )
}

/// 需要别名或参数终止符的运行时用这个入口。
fn tui_runtime_with(
    id: &'static str,
    name: &'static str,
    vendor: &'static str,
    description: &'static str,
    binary: &'static str,
    extra: TuiRuntimeExtra,
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
        aliases: extra.aliases,
        args: extra.args,
        models: extra.models,
        permissions: if extra.permissions.is_empty() {
            default_permissions()
        } else {
            extra.permissions
        },
        prompt_injection,
        prompt_flag,
        argv_separator: extra.argv_separator,
        session_hook: extra.session_hook.is_some(),
        hook_kind: extra.session_hook,
        available: true,
        capabilities: tui_capabilities(),
        lifecycle: runtime_lifecycle(),
        limitations: tui_limitations(mcp_auto),
        fallback: "权限确认和交互操作都在嵌入式终端内完成；桌面只在任务结束后收集状态。",
    }
}

/// Single source of truth for the runtime list. Adding an agent means adding one
/// descriptor here, not branching the queue or the UI.
///
/// The list mirrors orca's TUI agent table, minus its private `claude-teams`
/// wrapper (that one launches Orca's own CLI, not a standalone agent).
pub fn runtime_catalog() -> Vec<AgentRuntimeDescriptor> {
    vec![
        tui_runtime_with(
            "opencode",
            "OpenCode",
            "SST",
            "OpenCode 交互式终端，启动后写入提示词。",
            DEFAULT_BINARY,
            TuiRuntimeExtra {
                session_hook: SessionHookKind::OpenCode,
                permissions: vec![
                    AgentPermissionOption {
                        id: "default",
                        label: "默认权限",
                        description: "沿用 OpenCode 自己的权限配置。",
                    },
                    AgentPermissionOption {
                        id: "auto",
                        label: "自动批准",
                        description: "自动批准未被显式拒绝的权限请求。",
                    },
                ],
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            true,
        ),
        tui_runtime_with(
            "claude",
            "Claude Code",
            "Anthropic",
            "Claude Code 交互式终端，提示词作为启动参数传入。",
            "claude",
            TuiRuntimeExtra {
                models: vec!["sonnet", "opus", "haiku", "fable"],
                permissions: vec![
                    AgentPermissionOption {
                        id: "default",
                        label: "默认权限",
                        description: "按 Claude 自己的设置询问。",
                    },
                    AgentPermissionOption {
                        id: "accept_edits",
                        label: "自动接受编辑",
                        description: "文件编辑不再逐次确认，命令仍按默认策略询问。",
                    },
                    AgentPermissionOption {
                        id: "full_access",
                        label: "完全访问",
                        description: "跳过所有权限检查，仅建议在可信仓库使用。",
                    },
                    AgentPermissionOption {
                        id: "plan",
                        label: "只读计划",
                        description: "只读分析并给出计划，不修改文件。",
                    },
                ],
                session_hook: SessionHookKind::ClaudeSettings {
                    dir: ".claude",
                    env: Some("CLAUDE_CONFIG_DIR"),
                    events: hooks::CLAUDE_EVENTS,
                },
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Argv,
            None,
            true,
        ),
        tui_runtime_with(
            "codex",
            "Codex",
            "OpenAI",
            "Codex CLI 交互式终端，提示词作为启动参数传入。",
            "codex",
            TuiRuntimeExtra {
                models: vec!["gpt-5-codex", "gpt-5", "o3", "o4-mini"],
                permissions: vec![
                    AgentPermissionOption {
                        id: "default",
                        label: "默认权限",
                        description: "沿用 Codex 自己的审批与沙箱配置。",
                    },
                    AgentPermissionOption {
                        id: "full_auto",
                        label: "自动执行",
                        description: "在工作区内自动执行，不逐条确认。",
                    },
                    AgentPermissionOption {
                        id: "full_access",
                        label: "完全访问",
                        description: "跳过审批与沙箱，仅建议在可信仓库使用。",
                    },
                ],
                session_hook: SessionHookKind::Codex,
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Argv,
            None,
            true,
        ),
        tui_runtime_with(
            "cursor",
            "Cursor Agent",
            "Anysphere",
            "Cursor 命令行 Agent，提示词作为启动参数传入。",
            "cursor-agent",
            TuiRuntimeExtra {
                session_hook: SessionHookKind::Cursor,
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Argv,
            None,
            true,
        ),
        tui_runtime_with(
            "zcode",
            "ZCode",
            "ZCode",
            "ZCode 终端 Agent，启动后写入提示词。",
            "zcode",
            TuiRuntimeExtra {
                session_hook: SessionHookKind::Zcode,
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            true,
        ),
        tui_runtime_with(
            "gemini",
            "Gemini CLI",
            "Google",
            "Gemini CLI 交互式终端，使用 -i 传入提示词。",
            "gemini",
            TuiRuntimeExtra {
                session_hook: SessionHookKind::Gemini,
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Flag,
            Some("-i"),
            true,
        ),
        tui_runtime_with(
            "qwen",
            "Qwen Code",
            "Alibaba",
            "Qwen Code 终端 Agent，启动后写入提示词。",
            "qwen",
            TuiRuntimeExtra {
                session_hook: SessionHookKind::ClaudeSettings {
                    dir: ".qwen",
                    env: None,
                    events: hooks::QWEN_EVENTS,
                },
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            true,
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
            "amp",
            "Amp",
            "Sourcegraph",
            "Amp 终端 Agent，启动后写入提示词。",
            "amp",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "antigravity",
            "Antigravity",
            "Google",
            "Antigravity CLI（agy），启动后写入提示词。",
            "agy",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "aug",
            "Auggie",
            "Augment Code",
            "Augment 的 auggie CLI，启动后写入提示词。",
            "auggie",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "autohand",
            "Autohand Code",
            "Autohand",
            "Autohand Code 终端 Agent，启动后写入提示词。",
            "autohand",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime_with(
            "codebuddy",
            "CodeBuddy",
            "Tencent",
            "CodeBuddy CLI，提示词作为启动参数传入。",
            "codebuddy",
            TuiRuntimeExtra {
                aliases: vec!["cbc"],
                session_hook: SessionHookKind::ClaudeSettings {
                    dir: ".codebuddy",
                    env: None,
                    events: hooks::QWEN_EVENTS,
                },
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Argv,
            None,
            false,
        ),
        tui_runtime(
            "codebuff",
            "Codebuff",
            "Codebuff",
            "Codebuff 终端 Agent，启动后写入提示词。",
            "codebuff",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime_with(
            "command-code",
            "Command Code",
            "Command Code",
            "Command Code 终端 Agent，跳过首次信任提示后写入提示词。",
            "command-code",
            TuiRuntimeExtra {
                args: vec!["--trust"],
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "continue",
            "Continue",
            "Continue",
            "Continue CLI（cn），启动后写入提示词。",
            "cn",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "crush",
            "Charm",
            "Charm",
            "Charm 的 crush 终端 Agent，启动后写入提示词。",
            "crush",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime_with(
            "devin",
            "Devin",
            "Cognition",
            "Devin CLI，提示词作为启动参数传入。",
            "devin",
            TuiRuntimeExtra {
                argv_separator: Some("--"),
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Argv,
            None,
            false,
        ),
        tui_runtime(
            "droid",
            "Droid",
            "Factory",
            "Factory Droid 终端 Agent，提示词作为启动参数传入。",
            "droid",
            Vec::new(),
            PromptInjection::Argv,
            None,
            false,
        ),
        tui_runtime(
            "freebuff",
            "Freebuff",
            "Freebuff",
            "Freebuff 终端 Agent，启动后写入提示词。",
            "freebuff",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime_with(
            "grok",
            "Grok",
            "xAI",
            "Grok CLI，提示词作为启动参数传入。",
            "grok",
            TuiRuntimeExtra {
                argv_separator: Some("--"),
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Argv,
            None,
            false,
        ),
        tui_runtime_with(
            "hermes",
            "Hermes",
            "Nous Research",
            "Hermes 全屏 TUI，启动后写入提示词。",
            "hermes",
            TuiRuntimeExtra {
                args: vec!["--tui"],
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "jcode",
            "Jcode",
            "Jcode",
            "Jcode 终端 Agent，启动后写入提示词。",
            "jcode",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "kilo",
            "Kilocode",
            "Kilocode",
            "Kilocode 终端 Agent，启动后写入提示词。",
            "kilo",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime_with(
            "kimi",
            "Kimi",
            "Moonshot",
            "Kimi CLI，启动后写入提示词。",
            "kimi",
            TuiRuntimeExtra {
                aliases: vec!["kimi-code"],
                session_hook: SessionHookKind::Kimi,
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            true,
        ),
        tui_runtime_with(
            "kiro",
            "Kiro",
            "AWS",
            "Kiro CLI 的 chat TUI，启动后写入提示词。",
            "kiro-cli",
            TuiRuntimeExtra {
                args: vec!["chat", "--tui"],
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "mimo-code",
            "MiMo Code",
            "Xiaomi",
            "MiMo Code 终端 Agent，启动后写入提示词。",
            "mimo",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime_with(
            "mistral-vibe",
            "Mistral Vibe",
            "Mistral",
            "Mistral Vibe CLI（vibe），启动后写入提示词。",
            "vibe",
            TuiRuntimeExtra {
                aliases: vec!["mistral-vibe"],
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime_with(
            "muse",
            "Muse",
            "Meta",
            "Muse CLI，跳过工作区信任后写入提示词。",
            "muse",
            TuiRuntimeExtra {
                args: vec!["--trust-workspace"],
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime_with(
            "omp",
            "OMP",
            "OMP",
            "OMP 终端 Agent，提示词作为启动参数传入。",
            "omp",
            TuiRuntimeExtra {
                // TUI 会持续重绘，静默兜底无法触发；用会话 hook 收尾并记录 session id。
                session_hook: SessionHookKind::Omp,
                permissions: vec![
                    AgentPermissionOption {
                        id: "default",
                        label: "默认权限",
                        description: "沿用 OMP 自己的审批配置。",
                    },
                    AgentPermissionOption {
                        id: "write",
                        label: "自动执行写操作",
                        description: "自动批准写文件等操作，危险命令仍会询问。",
                    },
                    AgentPermissionOption {
                        id: "full_access",
                        label: "完全访问",
                        description: "跳过所有工具批准（yolo），仅建议在可信仓库使用。",
                    },
                ],
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Argv,
            None,
            true,
        ),
        tui_runtime_with(
            "openclaude",
            "OpenClaude",
            "OpenClaude",
            "OpenClaude 终端 Agent，提示词作为启动参数传入。",
            "openclaude",
            TuiRuntimeExtra {
                models: vec!["sonnet", "opus", "haiku", "fable"],
                permissions: vec![
                    AgentPermissionOption {
                        id: "default",
                        label: "默认权限",
                        description: "按 OpenClaude 自己的设置询问。",
                    },
                    AgentPermissionOption {
                        id: "accept_edits",
                        label: "自动接受编辑",
                        description: "文件编辑不再逐次确认。",
                    },
                    AgentPermissionOption {
                        id: "full_access",
                        label: "完全访问",
                        description: "跳过所有权限检查，仅建议在可信仓库使用。",
                    },
                ],
                session_hook: SessionHookKind::ClaudeSettings {
                    dir: ".openclaude",
                    env: None,
                    events: hooks::CLAUDE_EVENTS,
                },
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Argv,
            None,
            false,
        ),
        tui_runtime(
            "openclaw",
            "OpenClaw",
            "OpenClaw",
            "OpenClaw 终端 Agent，启动后写入提示词。",
            "openclaw",
            Vec::new(),
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime_with(
            "opencode2",
            "OpenCode 2",
            "SST",
            "OpenCode 2 独立 TUI，启动后写入提示词。",
            "opencode2",
            TuiRuntimeExtra {
                args: vec!["--standalone"],
                permissions: vec![
                    AgentPermissionOption {
                        id: "default",
                        label: "默认权限",
                        description: "沿用 OpenCode 2 自己的权限配置。",
                    },
                    AgentPermissionOption {
                        id: "auto",
                        label: "自动批准",
                        description: "自动批准未被显式拒绝的权限请求。",
                    },
                ],
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime(
            "pi",
            "Pi",
            "Pi",
            "Pi 终端 Agent，提示词作为启动参数传入。",
            "pi",
            Vec::new(),
            PromptInjection::Argv,
            None,
            false,
        ),
        tui_runtime_with(
            "prime-agent",
            "Prime Agent",
            "Prime Intellect",
            "Prime Agent，提示词作为启动参数传入。",
            "prime-agent",
            TuiRuntimeExtra {
                argv_separator: Some("--"),
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Argv,
            None,
            false,
        ),
        tui_runtime_with(
            "qoder",
            "Qoder CLI",
            "Alibaba",
            "Qoder CLI，启动后写入提示词。",
            "qodercli",
            TuiRuntimeExtra {
                aliases: vec!["qoder"],
                session_hook: SessionHookKind::ClaudeSettings {
                    dir: ".qoder",
                    env: None,
                    events: hooks::QWEN_EVENTS,
                },
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime_with(
            "qoder-cn",
            "Qoder CLI China",
            "Alibaba",
            "Qoder 国内版 CLI，启动后写入提示词。",
            "qoderclicn",
            TuiRuntimeExtra {
                aliases: vec!["qodercn"],
                session_hook: SessionHookKind::ClaudeSettings {
                    dir: ".qoder-cn",
                    env: None,
                    events: hooks::QWEN_EVENTS,
                },
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime_with(
            "rovo",
            "Rovo Dev",
            "Atlassian",
            "Rovo Dev（acli rovodev run），启动后写入提示词。",
            "acli",
            TuiRuntimeExtra {
                args: vec!["rovodev", "run"],
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Stdin,
            None,
            false,
        ),
        tui_runtime_with(
            "trae",
            "Trae",
            "ByteDance",
            "Trae CLI（traecli），提示词作为启动参数传入。",
            "traecli",
            TuiRuntimeExtra {
                argv_separator: Some("--"),
                ..TuiRuntimeExtra::default()
            },
            PromptInjection::Argv,
            None,
            false,
        ),
        tui_runtime_with(
            "dsh",
            "DeepSeek Harness",
            "DeepSeek",
            "DeepSeek Harness TUI，启动后写入提示词。",
            "dsh-tui",
            TuiRuntimeExtra {
                aliases: vec!["dst"],
                args: vec!["."],
                ..TuiRuntimeExtra::default()
            },
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

/// Human-facing runtime name for the island capsule ("Claude Code 修复中").
fn runtime_display_name(id: &str) -> String {
    let id = id.trim();
    runtime_descriptor(id)
        .map(|runtime| runtime.name.to_string())
        .unwrap_or_else(|| id.to_string())
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
    worktree_enabled: Option<bool>,
    execution_units: Option<u32>,
    restore_queued_tasks: Option<bool>,
    runtime_options: Option<BTreeMap<String, AgentRuntimeOptions>>,
}

impl AgentConfigPatch {
    /// Applies the given fields; omitted ones keep their current value.
    fn apply(self, config: &mut AgentConfig) {
        if let Some(runtime_id) = self.runtime_id {
            config.runtime_id = runtime_id;
        }
        if let Some(path) = self.binary_path {
            config.binary_path = path;
        }
        if let Some(mappings) = self.repo_mappings {
            config.repo_mappings = mappings;
        }
        if let Some(projects) = self.projects {
            config.projects = projects;
        }
        if let Some(template) = self.prompt_template {
            config.prompt_template = template;
        }
        if let Some(ids) = self.coworker_ids {
            config.coworker_ids = ids;
        }
        if let Some(value) = self.ready_quiet_ms {
            config.ready_quiet_ms = value;
        }
        if let Some(value) = self.ready_timeout_ms {
            config.ready_timeout_ms = value;
        }
        if let Some(value) = self.idle_complete_ms {
            config.idle_complete_ms = value;
        }
        if let Some(value) = self.worktree_enabled {
            config.worktree_enabled = value;
        }
        if let Some(value) = self.execution_units {
            config.execution_units = value;
        }
        if let Some(value) = self.restore_queued_tasks {
            config.restore_queued_tasks = value;
        }
        if let Some(options) = self.runtime_options {
            config.runtime_options = options;
        }
    }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/// hook 端点可能返回的错误，由 HTTP 层映射成状态码。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HookError {
    Unauthorized,
    UnknownTask,
    Internal,
}

/// loopback hook 收到的一次上报，字段与 HTTP 表单一一对应。
pub(crate) struct HookReport {
    pub(crate) token: String,
    pub(crate) task_id: String,
    pub(crate) event: String,
    pub(crate) session_id: Option<String>,
    pub(crate) payload: Option<Value>,
    pub(crate) will_continue: bool,
    pub(crate) awaiting_async_work: bool,
}

/// loopback hook 上报的回合事件。字段与 Orca 的状态事件对齐，但当前只用于
/// 结束本轮；session id 在收到事件时已经直接写回任务。
#[derive(Clone, Debug, Default)]
pub(super) struct HookEvent {
    pub(super) phase: String,
    /// 本次 agent_end 之后还会自动继续（不算本轮结束）。
    pub(super) will_continue: bool,
    /// 还在等后台任务回报（不算本轮结束）。
    pub(super) awaiting_async_work: bool,
    /// StopFailure 等错误结束；有值时任务按失败收尾。
    pub(super) error: Option<String>,
}

/// Agent 运行中状态，只存在于内存，用于 UI 展示当前动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimePhase {
    Idle,
    Working,
    WaitingPermission,
    WaitingQuestion,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeStatus {
    pub phase: AgentRuntimePhase,
    /// 供 UI 直接展示的中文摘要。
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 正在运行的子 Agent 数量。
    pub subagents: u32,
    /// 当前 phase / 工具的开始时间，用于 Working 条的已用时长。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// 最近一条 assistant 文本；transcript 尚未落盘时作为预览。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    /// 阻塞中的权限确认 / 提问；有值时 Chat 与胶囊共用同一张卡片。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<AgentPendingPrompt>,
    pub updated_at: String,
}

/// 提问 / 权限卡片上的一个可回执选项；`id` 由后端翻译成运行时按键。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// 权限确认或 AskUserQuestion 的归一化结果。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPendingPrompt {
    /// `taskId + 事件时间`；旧卡片带着过期 id，点击时会被拒绝。
    pub prompt_id: String,
    /// approval | question
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// 权限请求摘要。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 提问正文。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub options: Vec<AgentPromptOption>,
    /// 当前运行时是否支持用按键回答。
    pub can_answer: bool,
    /// 「发送 1 / Esc」「在终端中回答」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_hint: Option<String>,
}

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
    /// 审核已通过，等待用户确认把任务分支合并回主仓库。Worktree 目录保留。
    AwaitingMerge,
    /// 合并 Agent 正在主仓库执行合并。
    Merging,
    Succeeded,
    Failed,
    Canceled,
}

impl TaskStatus {
    /// A task occupying one worker slot (or a merge runner). `AwaitingApproval`
    /// blocks the queue through the explicit awaiting-review check, not here.
    fn is_active(self) -> bool {
        matches!(self, Self::Preparing | Self::Running | Self::Merging)
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
    /// Exported `bug.json` (details + assets) handed to the agent. Older
    /// records only had `mdPath`; they load with an empty path instead of being
    /// dropped (no migration chain by design).
    #[serde(default)]
    pub json_path: String,
    /// Main repository from the project settings. With worktree isolation this
    /// stays the `git -C` repository while `worktree_path` is the working dir.
    pub repo_path: String,
    /// Per-task git worktree checked out for this run. Removed on success;
    /// kept for failed/canceled/awaiting-review tasks so they can be inspected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
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
    /// 本次运行使用的模型；空字符串表示运行时默认。
    #[serde(default)]
    pub model: String,
    /// 本次运行的访问权限选项 id；空字符串表示运行时默认。
    #[serde(default)]
    pub permission_mode: String,
    /// 会话 hook 捕获的运行时 session id，用于「打开系统终端」精确续接对应
    /// 会话；缺失时退回各 CLI 的「继续最近会话」参数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    /// Post-work review (complex change) shown in the 待审核 tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<TaskApproval>,
    /// 审核通过后的合并进度：错误、手动步骤与时间戳。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge: Option<TaskMerge>,
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
    /// Number of automatic retries already spent after interruptions.
    /// `serde(default)` keeps pre-workflow records readable.
    #[serde(default)]
    pub attempt: u32,
    /// The previous run was interrupted by a client restart/suspend.
    #[serde(default)]
    pub interrupted: bool,
    /// Host-computed change summary for the last run. Filled from the core
    /// model so recovery keeps the durable shape aligned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<tapd_workflow::ChangeSet>,
}

impl AgentTask {
    /// Directory the agent actually works in: the worktree when one exists,
    /// otherwise the configured repository.
    pub(super) fn work_dir(&self) -> &str {
        self.worktree_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .unwrap_or(&self.repo_path)
    }
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

/// Merge stage state for a worktree task approved for merge.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskMerge {
    /// 自动合并失败的原因；用户可据此改用下方手动步骤。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 手动合并步骤（含 TAPD 回写）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

/// Result of `agent_merge_start`: either the merge runner was started
/// (`mode=agent`) or the user must merge by hand using `instructions`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStart {
    pub mode: &'static str,
    pub task: AgentTask,
    pub instructions: String,
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
    /// 本次任务指定运行时；为空或未知时回退到设置里的默认运行时。
    #[serde(default)]
    pub runtime_id: Option<String>,
    /// 本次任务指定模型；为空时使用该运行时的默认模型。
    #[serde(default)]
    pub model: Option<String>,
    /// 本次任务指定访问权限；为空时使用该运行时的默认权限。
    #[serde(default)]
    pub permission_mode: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTasksState {
    /// Live tasks only (`queued` .. `awaiting_merge` / `merging`). Terminal
    /// history is fetched page by page through `agent_tasks_history`.
    tasks: Vec<AgentTask>,
    active_task_id: Option<String>,
    queued_count: usize,
    awaiting_approval_count: usize,
    awaiting_merge_count: usize,
    /// True after the user stopped a review; the workflow queue stays paused
    /// until `agent_queue_resume`.
    queue_paused: bool,
    /// Last persistence failure, cleared by the next successful write.
    storage_error: Option<String>,
    /// 运行中 Agent 的当前状态，key 是 task id。
    runtime_status: HashMap<String, AgentRuntimeStatus>,
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
    /// Number of tasks waiting for a merge decision.
    awaiting_merge: usize,
    active_task_id: Option<String>,
    workspace_id: Option<String>,
    title: Option<String>,
    workspace_name: Option<String>,
    bug_id: Option<String>,
    severity: Option<String>,
    priority: Option<String>,
    /// 当前运行时的品牌信息，胶囊折叠态与 peek 使用。
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<AgentRuntimePhase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_message: Option<String>,
    /// 有值时胶囊可以直接回答权限 / 提问。
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt: Option<AgentPendingPrompt>,
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

/// `agent_scan`: 安装检测缓存读取 / 强制刷新。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ScanRequest {
    /// 设置页「刷新检测」；false 且缓存未过期时直接返回缓存。
    force: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SaveResourceRequest {
    /// Original file name, used only for the extension.
    name: String,
    /// Base64 bytes (a `data:` prefix is accepted).
    data: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SendMessageRequest {
    task_id: String,
    text: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PromptAnswerRequest {
    task_id: String,
    prompt_id: String,
    option_id: String,
}

/// `agent_chat` 的响应；找不到 transcript 时 `messages` 为空并给出可读原因。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentChatPayload {
    task_id: String,
    runtime_id: String,
    session_id: String,
    messages: Vec<transcript::ChatMessage>,
    truncated: bool,
    source: String,
    /// 内容指纹；前端据此跳过未变化的一次轮询，避免整页重绘。
    fingerprint: String,
    /// transcript 里实际使用的模型；设置页/任务里没有显式模型时展示。
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    /// 前端带来的指纹与当前一致：`messages` 为空，无需替换 UI。
    unchanged: bool,
    error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ChatRequest {
    task_id: String,
    /// 前端上一次拿到的指纹；命中时走轻量响应。
    fingerprint: Option<String>,
}

/// 一个任务的 transcript 解析缓存；指纹不变时直接复用。
struct ChatCache {
    session_id: String,
    /// 已解析的 transcript 路径；避免每秒重新扫目录。
    path: PathBuf,
    fingerprint: String,
    payload: AgentChatPayload,
}

/// transcript 缓存的任务数量上限；超出后整体清空，避免长期运行无限增长。
const CHAT_CACHE_LIMIT: usize = 32;

/// 空 Chat 响应：`error` 给用户可读原因，终端始终可用。
fn chat_empty(
    task_id: &str,
    runtime_id: &str,
    session_id: &str,
    error: Option<String>,
) -> AgentChatPayload {
    AgentChatPayload {
        task_id: task_id.to_string(),
        runtime_id: runtime_id.to_string(),
        session_id: session_id.to_string(),
        messages: Vec::new(),
        truncated: false,
        source: String::new(),
        fingerprint: String::new(),
        model: None,
        unchanged: false,
        error,
    }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptVars {
    /// Agent task id, kept for templates that want to mention it.
    pub task_id: String,
    pub title: String,
    pub json_path: String,
    pub repo_path: String,
    pub workspace_name: String,
    pub bug_id: String,
    pub severity: String,
    pub priority: String,
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
            json_path: task.json_path.clone(),
            repo_path: task.work_dir().to_string(),
            workspace_name: task.workspace_name.clone(),
            bug_id: task.bug_id.clone(),
            severity: task.severity.clone(),
            priority: task.priority.clone(),
            user_prompt: task.extra_prompt.clone(),
            attachments: task.attachments.clone(),
            coworker: String::new(),
        }
    }
}

/// Replaces `{{variable}}` placeholders; unknown placeholders are left intact.
///
/// Coworker skills (`{{coworker}}`) use a slot-or-append policy: an explicit
/// placeholder keeps placement under the template's control, otherwise the whole
/// section is appended.
pub fn render_prompt(template: &str, vars: &PromptVars) -> String {
    let attachments = render_attachments(&vars.attachments);
    let pairs = [
        ("task_id", vars.task_id.as_str()),
        ("title", vars.title.as_str()),
        ("json_path", vars.json_path.as_str()),
        ("repo_path", vars.repo_path.as_str()),
        ("workspace_name", vars.workspace_name.as_str()),
        ("bug_id", vars.bug_id.as_str()),
        ("severity", vars.severity.as_str()),
        ("priority", vars.priority.as_str()),
        ("user_prompt", vars.user_prompt.as_str()),
        ("attachments", attachments.as_str()),
        ("coworker", vars.coworker.as_str()),
    ];

    let has_prompt_slot = template.contains("{{user_prompt}}");
    let has_attachments_slot = template.contains("{{attachments}}");
    let has_coworker_slot = template.contains("{{coworker}}");
    let mut rendered = template.to_string();
    for (key, value) in pairs {
        rendered = rendered.replace(&format!("{{{{{key}}}}}"), value);
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

/// Templates that still point at removed tools or placeholders cannot work.
/// Replacing them is validation, not a migration: no old template text is kept.
fn template_uses_removed_contract(template: &str) -> bool {
    [
        "{{md_path}}",
        "{{project_rule}}",
        "tapd_request_review",
        "agent_task_report",
        "tapd_claim_bug",
        "tapd_release_bug",
        "tapd_export_bug_md",
    ]
    .iter()
    .any(|marker| template.contains(marker))
}

/// Builds the enqueue facts from a request. Runtime overrides fall back to the
/// configured default when empty or unknown, so a bad payload cannot stall the
/// queue.
fn task_spec_from_request(
    request: &EnqueueRequest,
    config: &AgentConfig,
    source: &str,
) -> Result<TaskSpec, String> {
    let workspace_id = request.workspace_id.trim();
    let bug_id = request.bug_id.trim();
    if workspace_id.is_empty() || bug_id.is_empty() {
        return Err("缺少 workspaceId 或 bugId".to_string());
    }

    let runtime_id = request
        .runtime_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .filter(|id| runtime_descriptor(id).is_some())
        .map(str::to_string)
        .unwrap_or_else(|| config.runtime_id.clone());
    // 任务级选择优先；未指定时沿用该运行时的默认模型 / 权限。
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
    let extra_prompt = request
        .extra_prompt
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let mut seen = HashSet::new();
    let attachments: Vec<String> = request
        .attachments
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty() && seen.insert(path.clone()))
        .collect();

    Ok(TaskSpec {
        workspace_id: workspace_id.to_string(),
        workspace_name,
        bug_id: bug_id.to_string(),
        title,
        severity: request
            .severity
            .clone()
            .unwrap_or_default()
            .trim()
            .to_string(),
        priority: request
            .priority
            .clone()
            .unwrap_or_default()
            .trim()
            .to_string(),
        repo_path: config.repo_path_for(workspace_id),
        runtime_id,
        model,
        permission_mode,
        source: source.trim().to_string(),
        extra_prompt,
        attachments,
    })
}

/// Host-side repository facts for the workflow: files changed by this run,
/// whether uncommitted work remains, and whether a commit was produced.
/// `baseline_dirty` files belong to the user and are excluded.
fn inspect_changes(task: &AgentTask, work_dir: &str) -> Result<tapd_workflow::ChangeSet, String> {
    let dirty: Vec<String> = uncommitted_files(work_dir)?
        .into_iter()
        .filter(|file| !task.baseline_dirty.contains(file))
        .collect();
    let committed = committed_since_baseline(task)?;
    let mut files = if committed {
        changed_files_since(work_dir, task.baseline_head.as_deref())?
    } else {
        dirty.clone()
    };
    for file in &dirty {
        if !files.contains(file) {
            files.push(file.clone());
        }
    }
    Ok(tapd_workflow::ChangeSet {
        files,
        dirty: !dirty.is_empty(),
        committed,
    })
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

/// Prompt for the merge runner: merge the reviewed branch and then (and only
/// then) write back to TAPD.
fn merge_prompt(repo: &str, branch: &str) -> String {
    tapd_workflow::merge_prompt(repo, branch)
}

/// Manual fallback shown in the merge card when the agent cannot merge (or the
/// user prefers to do it themselves).
fn manual_merge_instructions(repo: &str, branch: &str) -> String {
    tapd_workflow::manual_merge_instructions(repo, branch)
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
    /// Single owner of task state, queue, review/merge decisions and recovery.
    /// The host never mutates task state directly; it feeds facts in and
    /// executes the effects the workflow returns.
    workflow: Mutex<Workflow>,
    runtimes: Mutex<HashMap<String, Arc<Mutex<AgentRuntime>>>>,
    /// Serializes `git worktree add/remove`: parallel tasks in one repository
    /// would otherwise race on git's worktree metadata.
    worktree_lock: tokio::sync::Mutex<()>,
    /// Terminal size the UI asked for. The console can be opened before the
    /// PTY exists, so the size is remembered and applied when it starts.
    sizes: Mutex<HashMap<String, (u16, u16)>>,
    /// Serializes persistence writers so an older batch can never overwrite a
    /// newer one.
    persist_lock: Mutex<()>,
    /// Last SQLite failure. Surfaced in the Agent header so a broken store is
    /// visible instead of looking like a queue that simply lost history.
    storage_error: Mutex<Option<String>>,
    /// 本机安装检测结果（`agent-scan.json`）；每日自动检测一次。
    scan: Mutex<Option<crate::agent_scan::AgentScanSnapshot>>,
    /// Serializes scans so the startup scan and an opening settings card cannot
    /// probe every CLI twice at the same time.
    scan_lock: Mutex<()>,
    /// 任务启动时下发的 hook token -> task id。
    hook_tokens: Mutex<HashMap<String, String>>,
    /// loopback hook 端点收到的最新事件；PTY 线程取出后即删除。
    hook_events: Mutex<HashMap<String, HookEvent>>,
    /// 运行中的 Agent 状态（当前工具、等待类型、消息），只存在于内存。
    runtime_status: Mutex<HashMap<String, AgentRuntimeStatus>>,
    /// 按任务缓存的 transcript 解析结果，key 是 task id。
    transcript_cache: Mutex<HashMap<String, ChatCache>>,
}

impl AgentCore {
    fn new(app: AppHandle, state: SharedState) -> Self {
        Self {
            app,
            state,
            config: Mutex::new(AgentConfig::default()),
            workflow: Mutex::new(Workflow::with_config(workflow_bridge::workflow_config(
                &AgentConfig::default(),
            ))),
            runtimes: Mutex::new(HashMap::new()),
            worktree_lock: tokio::sync::Mutex::new(()),
            sizes: Mutex::new(HashMap::new()),
            persist_lock: Mutex::new(()),
            storage_error: Mutex::new(None),
            scan: Mutex::new(None),
            scan_lock: Mutex::new(()),
            hook_tokens: Mutex::new(HashMap::new()),
            hook_events: Mutex::new(HashMap::new()),
            runtime_status: Mutex::new(HashMap::new()),
            transcript_cache: Mutex::new(HashMap::new()),
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
        *self.config.lock().expect("agent config lock") = loaded.clone();
        // Keep the workflow configuration in step with the host settings. The
        // snapshot loaded on system entry carries it again; applying it here
        // lets config commands issued before entry work.
        {
            let mut workflow = self.workflow.lock().expect("agent workflow lock");
            let _ = workflow.apply(Input::SetConfig {
                config: workflow_bridge::workflow_config(&loaded),
            });
        }
        // Cached install scan; stale or missing results are refreshed by the
        // background daily scan started in `init`.
        *self.scan.lock().expect("agent scan lock") =
            crate::agent_scan::load(&self.state.paths.data_dir);

        // Tasks are loaded from SQLite on system entry, not here: the login /
        // onboarding screens must not resurrect or start a queue.
        remove_legacy_logs(&self.state.paths.data_dir);
    }

    /// Initializes the workflow once the user actually entered the system
    /// (valid login + onboarding complete): `SystemEntered` asks for the
    /// durable snapshot, `SnapshotLoaded` runs the core's recovery rules,
    /// persists what changed and reports the outcome. Idempotent: a second call
    /// while already entered is a no-op.
    pub(crate) async fn enter_system(
        self: &Arc<Self>,
    ) -> Result<Option<tapd_workflow::RecoveryReport>, String> {
        let effects = self.apply_input(Input::SystemEntered { now: now() })?;
        if !effects
            .iter()
            .any(|effect| matches!(effect, Effect::LoadSnapshot))
        {
            return Ok(None);
        }

        let config = self.config_snapshot();
        let (views, paused) = match self.state.cache.load_agent_tasks() {
            Some(loaded) => loaded,
            None => {
                tracing::error!(
                    "failed to load agent tasks from SQLite; refusing to fake an empty queue"
                );
                self.set_storage_error(Some(
                    "本地任务存储不可用，队列未恢复；请检查本地数据后重试".to_string(),
                ));
                let _ = self.apply_input(Input::Suspend { now: now() });
                return Err("无法读取本地任务存储，队列未恢复".to_string());
            }
        };
        let mut tasks = Vec::with_capacity(views.len());
        for view in &views {
            match workflow_bridge::to_workflow_task(view) {
                Ok(task) => tasks.push(task),
                Err(error) => {
                    tracing::error!(%error, task_id = %view.id, "failed to load a persisted agent task");
                    self.set_storage_error(Some(format!("任务记录无法解析：{error}")));
                    let _ = self.apply_input(Input::Suspend { now: now() });
                    return Err(format!("恢复任务失败：{error}"));
                }
            }
        }
        let snapshot = Snapshot {
            schema_version: tapd_workflow::SCHEMA_VERSION,
            config: workflow_bridge::workflow_config(&config),
            paused,
            tasks,
            generation: 0,
        };

        let effects = match self.apply_input(Input::SnapshotLoaded { snapshot }) {
            Ok(effects) => effects,
            Err(error) => {
                // Never leave the workflow half-entered: reset it so a later
                // login can retry the recovery instead of waiting forever.
                let _ = self.apply_input(Input::Suspend { now: now() });
                tracing::error!(%error, "failed to recover agent tasks on system entry");
                return Err(format!("恢复任务失败：{error}"));
            }
        };

        let mut report = None;
        let mut rest = Vec::with_capacity(effects.len());
        for effect in effects {
            match effect {
                Effect::EmitRecoveryReport { report: value } => report = Some(value),
                other => rest.push(other),
            }
        }
        if let Some(value) = report.as_ref() {
            tracing::info!(
                queued = value.queued,
                retried = value.retried,
                awaiting_approval = value.awaiting_approval,
                awaiting_merge = value.awaiting_merge,
                failed = value.failed,
                queue_paused = value.queue_paused,
                "agent workflow recovery completed"
            );
            if !workflow_bridge::report_is_empty(value) {
                let _ = self.app.emit("agent://recovery", value);
            }
        }
        self.dispatch_effects(rest).await;
        if report.as_ref().is_some_and(|value| value.queue_paused) {
            // Recovery parks the queue in memory. Persist the flag even when
            // no task changed, so a crash before shutdown cannot resume it.
            let paused = self.workflow_paused();
            self.persist_views(&[], paused, &[]);
        }
        // Queued-only snapshots may have no changed tasks, so no PersistChanged
        // effect fired; push the loaded list explicitly before returning.
        self.emit_state();
        Ok(report.filter(|value| !workflow_bridge::report_is_empty(value)))
    }

    pub(crate) fn config_snapshot(&self) -> AgentConfig {
        self.config.lock().expect("agent config lock").clone()
    }

    // -- workflow protocol ---------------------------------------------------

    /// Feeds one fact into the workflow. A rejection is returned as an error so
    /// command paths can surface it; any other effect list is handed back for
    /// the caller to dispatch.
    fn apply_input(self: &Arc<Self>, input: Input) -> Result<Vec<Effect>, String> {
        let effects = {
            let mut workflow = self.workflow.lock().expect("agent workflow lock");
            workflow.apply(input)
        };
        if let Some(Effect::Rejected { message }) = effects
            .iter()
            .find(|effect| matches!(effect, Effect::Rejected { .. }))
        {
            let message = if message == "system not entered" {
                workflow_bridge::NOT_ENTERED.to_string()
            } else {
                message.clone()
            };
            // The scheduler runs after every input, so a rejected command can
            // still carry effects for other tasks (a freed execution unit).
            // Dispatch them instead of dropping them with the error.
            let rest: Vec<Effect> = effects
                .into_iter()
                .filter(|effect| !matches!(effect, Effect::Rejected { .. }))
                .collect();
            if !rest.is_empty() {
                let core = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    core.dispatch_effects(rest).await;
                });
            }
            return Err(message);
        }
        Ok(effects)
    }

    /// Executes the workflow's effects. Never called while holding the workflow
    /// lock: persistence, git and the PTY all run outside it.
    async fn dispatch_effects(self: &Arc<Self>, effects: Vec<Effect>) {
        for effect in effects {
            self.dispatch_effect(effect);
        }
    }

    fn dispatch_effect(self: &Arc<Self>, effect: Effect) {
        match effect {
            Effect::Rejected { message } => {
                tracing::warn!(%message, "agent workflow rejected an input");
            }
            Effect::LoadSnapshot => {
                tracing::warn!("unexpected LoadSnapshot effect outside system entry");
            }
            Effect::StateChanged => self.emit_state(),
            Effect::PersistChanged { tasks } => {
                let views = self.views_for(&tasks);
                let paused = self.workflow_paused();
                self.persist_views(&views, paused, &[]);
                self.emit_state();
            }
            Effect::PersistDeleted { task_id } => {
                let paused = self.workflow_paused();
                self.persist_views(&[], paused, &[task_id.0.clone()]);
                self.emit_state();
            }
            Effect::PersistPaused { paused } => {
                self.persist_views(&[], paused, &[]);
                self.emit_state();
            }
            Effect::PersistConfig { config } => {
                // `agent_config_set` already wrote agent.json before applying
                // SetConfig; the workflow copy is persisted as part of the
                // task snapshot on the next write.
                tracing::debug!(
                    worktree = config.worktree_enabled,
                    units = config.execution_units,
                    "agent workflow config updated"
                );
            }
            Effect::AppendHistory { record } => self.append_history(record),
            Effect::EmitRecoveryReport { report } => {
                let _ = self.app.emit("agent://recovery", report);
            }
            Effect::EmitNotice { level, message } => {
                let _ = self.app.emit(
                    "agent://notice",
                    json!({ "level": level, "message": message }),
                );
            }
            Effect::CreateWorktree {
                task_id,
                repo_path,
                bug_id,
                ..
            } => {
                let core = self.clone();
                tauri::async_runtime::spawn(async move {
                    core.run_create_worktree(task_id, repo_path, bug_id).await;
                });
            }
            Effect::InspectWorkspace { task_id, path, .. } => {
                let core = self.clone();
                tauri::async_runtime::spawn(async move {
                    match core.inspect_workspace(&task_id, &path).await {
                        Ok(changes) => core.feed(Input::WorkspaceInspected { task_id, changes }),
                        Err(error) => {
                            tracing::warn!(task_id = %task_id, %error, "failed to inspect the workspace");
                        }
                    }
                });
            }
            Effect::RemoveWorktree {
                task_id,
                repo_path,
                path,
                ..
            } => {
                let core = self.clone();
                tauri::async_runtime::spawn(async move {
                    core.run_remove_worktree(task_id, repo_path, path).await;
                });
            }
            Effect::StartFixAgent {
                task_id,
                runtime_id,
                cwd,
                ..
            } => {
                let core = self.clone();
                tauri::async_runtime::spawn(async move {
                    core.start_fix_agent(task_id, runtime_id, cwd).await;
                });
            }
            Effect::CancelAgent { task_id } => self.stop_runtime(&task_id.0),
            Effect::CheckMergePreconditions {
                task_id,
                repo_path,
                branch,
                ..
            } => {
                let core = self.clone();
                tauri::async_runtime::spawn(async move {
                    let result = core
                        .check_merge_preconditions(&task_id, &repo_path, &branch)
                        .await;
                    core.feed(Input::MergePreconditionsChecked { task_id, result });
                });
            }
            Effect::StartMergeAgent {
                task_id,
                repo_path,
                branch,
                ..
            } => {
                let core = self.clone();
                tauri::async_runtime::spawn(async move {
                    core.start_merge_agent(task_id, repo_path, branch).await;
                });
            }
            Effect::VerifyBranchMerged {
                task_id,
                repo_path,
                branch,
                ..
            } => {
                let core = self.clone();
                tauri::async_runtime::spawn(async move {
                    core.run_verify_branch_merged(task_id, repo_path, branch)
                        .await;
                });
            }
        }
    }

    /// Applies a host receipt and dispatches whatever it produced. Used by
    /// background effect runners; command paths apply and dispatch inline so
    /// they can return the final view.
    fn feed(self: &Arc<Self>, input: Input) {
        let core = self.clone();
        tauri::async_runtime::spawn(async move {
            match core.apply_input(input) {
                Ok(effects) => core.dispatch_effects(effects).await,
                Err(error) => {
                    tracing::warn!(%error, "agent workflow ignored a host receipt");
                }
            }
        });
    }

    // -- workflow read helpers ----------------------------------------------

    fn workflow_task(&self, task_id: &str) -> Option<WorkflowTask> {
        let id = TaskId::new(task_id);
        self.workflow.lock().ok()?.task(&id).cloned()
    }

    fn workflow_view(&self, task_id: &str) -> Option<AgentTask> {
        let task = self.workflow_task(task_id)?;
        match workflow_bridge::from_workflow_task(&task) {
            Ok(view) => Some(view),
            Err(error) => {
                tracing::warn!(%error, task_id, "failed to map a workflow task to its view");
                None
            }
        }
    }

    fn workflow_status(&self, task_id: &str) -> Option<WorkflowStatus> {
        let id = TaskId::new(task_id);
        self.workflow.lock().ok()?.task(&id).map(|task| task.status)
    }

    fn workflow_paused(&self) -> bool {
        self.workflow
            .lock()
            .map(|workflow| workflow.paused())
            .unwrap_or(false)
    }

    fn views_for(&self, tasks: &[WorkflowTask]) -> Vec<AgentTask> {
        tasks
            .iter()
            .filter_map(|task| match workflow_bridge::from_workflow_task(task) {
                Ok(view) => Some(view),
                Err(error) => {
                    tracing::warn!(
                        %error,
                        task_id = %task.id,
                        "failed to map a workflow task to its view"
                    );
                    None
                }
            })
            .collect()
    }

    fn append_history(&self, record: HistoryRecord) {
        let Some(task) = self.workflow_task(&record.task_id) else {
            tracing::warn!(
                task_id = %record.task_id,
                "history record has no live task; nothing to upsert"
            );
            return;
        };
        let Ok(view) = workflow_bridge::from_workflow_task(&task) else {
            tracing::warn!(task_id = %record.task_id, "failed to map the history task");
            return;
        };
        let paused = self.workflow_paused();
        self.persist_views(&[view], paused, &[]);
        tracing::info!(
            task_id = %record.task_id,
            status = ?record.status,
            finished_at = %record.finished_at,
            "agent task history appended"
        );
    }

    fn scan_snapshot(&self) -> Option<crate::agent_scan::AgentScanSnapshot> {
        self.scan.lock().expect("agent scan lock").clone()
    }

    /// 为支持会话 hook 的运行时安装/刷新客户端 hook，并下发本次任务专用的
    /// loopback 地址与 token。
    ///
    /// token 按任务随机生成并只保存在内存里：Agent 即使读到了它，也只能上报
    /// 自己任务的回合事件，拿不到主 API 的 bearer token。
    fn prepare_session_hook(
        &self,
        task: &AgentTask,
        kind: SessionHookKind,
    ) -> Option<hooks::HookLaunch> {
        let runtime = match self.state.runtime_info() {
            Some(runtime) => runtime,
            None => {
                tracing::warn!(task_id = %task.id, "loopback API is not ready; session hook skipped");
                return None;
            }
        };

        let args = match hooks::prepare(&self.state.paths.data_dir, kind) {
            Ok(args) => args,
            Err(error) => {
                tracing::warn!(task_id = %task.id, %error, "failed to prepare the agent session hook");
                return None;
            }
        };

        let token = uuid::Uuid::new_v4().simple().to_string();
        {
            let mut tokens = match self.hook_tokens.lock() {
                Ok(tokens) => tokens,
                Err(_) => {
                    tracing::warn!(task_id = %task.id, "hook token lock poisoned");
                    return None;
                }
            };
            // 同一任务重试时旧 token 立刻失效。
            tokens.retain(|_, task_id| task_id != &task.id);
            tokens.insert(token.clone(), task.id.clone());
        }
        if let Ok(mut events) = self.hook_events.lock() {
            events.remove(&task.id);
        }

        Some(hooks::HookLaunch {
            args,
            envs: vec![
                (
                    "TAPD_AGENT_HOOK_URL".to_string(),
                    format!("http://127.0.0.1:{}/agent/hook", runtime.port),
                ),
                ("TAPD_AGENT_HOOK_TOKEN".to_string(), token),
                ("TAPD_AGENT_TASK_ID".to_string(), task.id.clone()),
                ("TAPD_AGENT_RUNTIME".to_string(), task.runtime_id.clone()),
            ],
        })
    }

    /// 校验 hook token 并记录事件。只有该任务仍在准备/运行时才接受，
    /// 避免任务结束后迟到的 hook 把状态改回去。
    fn record_session_hook(self: &Arc<Self>, report: &HookReport) -> Result<(), HookError> {
        let HookReport {
            token,
            task_id,
            event,
            session_id,
            payload,
            will_continue,
            awaiting_async_work,
        } = report;
        let token_task = self
            .hook_tokens
            .lock()
            .map_err(|_| HookError::Internal)?
            .get(token.as_str())
            .cloned();
        if token_task.as_deref() != Some(task_id.as_str()) {
            return Err(HookError::Unauthorized);
        }
        match self.workflow_status(task_id) {
            Some(WorkflowStatus::Preparing | WorkflowStatus::Running | WorkflowStatus::Merging) => {
            }
            Some(_) => return Ok(()),
            None => return Err(HookError::UnknownTask),
        }

        if let Some(session_id) = session_id
            .as_deref()
            .map(str::trim)
            .filter(|id| valid_session_id(id))
        {
            if self.stored_session_id(task_id).as_deref() != Some(session_id) {
                // 先落 session id：任务可能马上被 MCP 回报结束，PTY 不一定还有
                // 下一次轮询机会。Apply synchronously so the state is visible
                // before this hook returns; only persistence is deferred.
                match self.apply_input(Input::SessionObserved {
                    task_id: TaskId::new(task_id.clone()),
                    session_id: session_id.to_string(),
                }) {
                    Ok(effects) => {
                        let core = Arc::clone(self);
                        tauri::async_runtime::spawn(async move {
                            core.dispatch_effects(effects).await;
                        });
                    }
                    Err(error) => {
                        tracing::debug!(task_id, %error, "ignored session observation");
                    }
                }
            }
        }

        let previous = self
            .runtime_status
            .lock()
            .ok()
            .and_then(|status| status.get(task_id).cloned());
        let at = now();
        let activity = status::normalize(
            previous.as_ref(),
            event,
            payload.as_ref(),
            session_id.as_deref(),
            &at,
            *will_continue,
            *awaiting_async_work,
        );
        if let Some(mut next) = activity.status {
            if let Some(prompt) = next.prompt.as_mut() {
                // prompt id 绑定任务与本次 hook 事件：旧卡片不会误操作新请求。
                let runtime_id = self.stored_runtime_id(task_id).unwrap_or_default();
                prompt.prompt_id = format!("{task_id}:{at}");
                prompt.can_answer = prompt::can_answer(&runtime_id, prompt);
                prompt.answer_hint = prompt::answer_hint(&runtime_id, prompt);
            }
            self.set_runtime_status(task_id, next);
        }
        if !activity.complete && activity.error.is_none() {
            return Ok(());
        }

        let mut events = self.hook_events.lock().map_err(|_| HookError::Internal)?;
        // agent_end 已经入队后，任何迟到事件都不能覆盖它。
        if events
            .get(task_id)
            .is_some_and(|existing| existing.phase == "agent_end")
        {
            return Ok(());
        }
        events.insert(
            task_id.to_string(),
            HookEvent {
                phase: "agent_end".to_string(),
                will_continue: *will_continue,
                awaiting_async_work: *awaiting_async_work,
                error: activity.error,
            },
        );
        Ok(())
    }

    /// 更新内存里的运行时状态并广播；状态没变化时不推送。
    fn set_runtime_status(&self, task_id: &str, status: AgentRuntimeStatus) {
        let changed = match self.runtime_status.lock() {
            Ok(mut statuses) => {
                if statuses.get(task_id) == Some(&status) {
                    false
                } else {
                    statuses.insert(task_id.to_string(), status.clone());
                    true
                }
            }
            Err(_) => false,
        };
        if changed {
            let _ = self.app.emit(
                "agent://runtime",
                json!({ "taskId": task_id, "status": status }),
            );
            // 胶囊的审批按钮依赖摘要里的 prompt / 当前动作，随状态一起推送。
            let _ = self.app.emit("agent://summary", self.summary());
        }
    }

    /// 清除运行时状态；任务结束时 UI 立即回到任务级状态。
    fn clear_runtime_status(&self, task_id: &str) {
        let removed = self
            .runtime_status
            .lock()
            .map(|mut statuses| statuses.remove(task_id).is_some())
            .unwrap_or(false);
        if removed {
            let _ = self.app.emit(
                "agent://runtime",
                json!({ "taskId": task_id, "status": Value::Null }),
            );
        }
    }

    /// 取出并清空任务的最新 hook 事件。
    pub(super) fn take_hook_event(&self, task_id: &str) -> Option<HookEvent> {
        self.hook_events.lock().ok()?.remove(task_id)
    }

    /// 读取缓存，必要时重新扫描并广播结果。`force` 对应设置页的「刷新检测」。
    fn ensure_scan(&self, force: bool) -> crate::agent_scan::AgentScanSnapshot {
        if !force {
            if let Some(snapshot) = self.scan_snapshot() {
                if snapshot.fresh() {
                    return snapshot;
                }
            }
        }
        // 启动扫描和前端首次读取可能同时到达，串行化后第二次直接复用结果。
        let _guard = self.scan_lock.lock().expect("agent scan lock");
        if !force {
            if let Some(snapshot) = self.scan_snapshot() {
                if snapshot.fresh() {
                    return snapshot;
                }
            }
        }
        let snapshot = crate::agent_scan::scan(&self.state.paths.data_dir);
        *self.scan.lock().expect("agent scan lock") = Some(snapshot.clone());
        if let Err(error) = self.app.emit("agent://scan", &snapshot) {
            tracing::warn!(%error, "failed to emit agent scan results");
        }
        snapshot
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
        write_json_atomic(&self.config_path(), &next).map_err(|error| {
            tracing::warn!(%error, "failed to persist agent config");
            format!("保存 Agent 配置失败：{error}")
        })?;
        *self.config.lock().expect("agent config lock") = next.clone();
        Ok(next)
    }

    fn tasks_state(&self) -> AgentTasksState {
        let (tasks, counts, active_task_id, queue_paused) = {
            let workflow = self.workflow.lock().expect("agent workflow lock");
            let counts = workflow.counts();
            let active_task_id = workflow.active_task_id().map(|id| id.0.clone());
            let live: Vec<WorkflowTask> = workflow
                .tasks()
                .iter()
                .filter(|task| !task.status.is_terminal())
                .cloned()
                .collect();
            (live, counts, active_task_id, workflow.paused())
        };
        AgentTasksState {
            active_task_id,
            queued_count: counts.queued,
            awaiting_approval_count: counts.awaiting_approval,
            awaiting_merge_count: counts.awaiting_merge,
            queue_paused,
            storage_error: self
                .storage_error
                .lock()
                .expect("agent storage error lock")
                .clone(),
            tasks: self.views_for(&tasks),
            runtime_status: self
                .runtime_status
                .lock()
                .map(|status| status.clone())
                .unwrap_or_default(),
        }
    }

    /// One page of terminal tasks, newest first. Filtering and paging happen
    /// here so the frontend never receives the whole history.
    fn history_page(&self, query: HistoryQuery) -> AgentTasksPage {
        let tasks = {
            let workflow = self.workflow.lock().expect("agent workflow lock");
            workflow.history()
        };
        let views = self.views_for(&tasks);
        build_history_page(&views, query)
    }

    fn summary(&self) -> AgentSummary {
        let workflow = self.workflow.lock().expect("agent workflow lock");
        let counts = workflow.counts();
        let active = workflow
            .active_task_id()
            .and_then(|task_id| workflow.task(task_id));
        // 运行时状态是胶囊审批的数据源；任务切换后旧状态不能串到新任务。
        let runtime_status = active.map(|task| task.id.0.as_str()).and_then(|task_id| {
            self.runtime_status
                .lock()
                .ok()
                .and_then(|status| status.get(task_id).cloned())
        });
        AgentSummary {
            running: counts.active > 0,
            awaiting_approval: counts.awaiting_approval,
            awaiting_merge: counts.awaiting_merge,
            active_task_id: active.map(|task| task.id.0.clone()),
            workspace_id: active.map(|task| task.spec.workspace_id.clone()),
            title: active.map(|task| task.spec.title.clone()),
            workspace_name: active.map(|task| task.spec.workspace_name.clone()),
            bug_id: active.map(|task| task.spec.bug_id.clone()),
            severity: active.map(|task| task.spec.severity.clone()),
            priority: active.map(|task| task.spec.priority.clone()),
            runtime_id: active.map(|task| task.spec.runtime_id.clone()),
            runtime_name: active.map(|task| runtime_display_name(&task.spec.runtime_id)),
            phase: runtime_status.as_ref().map(|status| status.phase),
            status_label: runtime_status.as_ref().map(|status| status.label.clone()),
            tool: runtime_status
                .as_ref()
                .and_then(|status| status.tool.clone()),
            detail: runtime_status
                .as_ref()
                .and_then(|status| status.detail.clone()),
            started_at: runtime_status
                .as_ref()
                .and_then(|status| status.started_at.clone()),
            last_message: runtime_status
                .as_ref()
                .and_then(|status| status.last_message.clone()),
            prompt: runtime_status.and_then(|status| status.prompt),
        }
    }

    fn emit_state(&self) {
        let state = self.tasks_state();
        // Same source as the `agent_summary` command: the workflow snapshot,
        // not the live-only slice carried by `state.tasks`.
        let summary = self.summary();
        let _ = self.app.emit("agent://state", state);
        let _ = self.app.emit("agent://summary", summary);
    }

    /// 只读 session id，避免 hook 高频事件触发整份任务克隆。
    fn stored_session_id(&self, task_id: &str) -> Option<String> {
        let id = TaskId::new(task_id);
        self.workflow
            .lock()
            .ok()?
            .task(&id)
            .and_then(|task| task.agent_session_id.clone())
    }

    /// 任务入队时快照的运行时 id；权限按键映射需要它。
    fn stored_runtime_id(&self, task_id: &str) -> Option<String> {
        let id = TaskId::new(task_id);
        self.workflow
            .lock()
            .ok()?
            .task(&id)
            .map(|task| task.spec.runtime_id.clone())
    }

    async fn update_config(
        self: &Arc<Self>,
        patch: AgentConfigPatch,
    ) -> Result<AgentConfig, String> {
        // Work on a clone: a rejected workflow config must not be published.
        let next = {
            let config = self.config.lock().expect("agent config lock");
            let mut candidate = config.clone();
            patch.apply(&mut candidate);
            candidate.sanitized()
        };
        // The workflow owns the worktree toggle lock; a rejection leaves the
        // host config untouched and agent.json is not rewritten.
        let effects = self.apply_input(Input::SetConfig {
            config: workflow_bridge::workflow_config(&next),
        })?;
        let stored = self.store_config(next)?;
        self.dispatch_effects(effects).await;
        Ok(stored)
    }

    async fn enqueue(
        self: &Arc<Self>,
        request: &EnqueueRequest,
        source: &str,
    ) -> Result<AgentTask, String> {
        let config = self.config_snapshot();
        let spec = task_spec_from_request(request, &config, source)?;

        // One bug owns at most one live task. A double click, the notification
        // flow and a manual enqueue can race; returning the existing record
        // keeps the operation idempotent. The workflow enforces the same rule.
        if let Some(existing) = self.live_task_for_bug(&spec.workspace_id, &spec.bug_id) {
            return workflow_bridge::from_workflow_task(&existing);
        }

        let task_id = TaskId::new(uuid::Uuid::new_v4().simple().to_string());
        let effects = self.apply_input(Input::Enqueue {
            task_id: task_id.clone(),
            spec,
            now: now(),
        })?;
        self.dispatch_effects(effects).await;

        tracing::info!(task_id = %task_id, source, "agent task queued");
        self.workflow_view(task_id.as_str())
            .ok_or_else(|| "任务不存在".to_string())
    }

    /// The live workflow task that already owns a bug, if any.
    fn live_task_for_bug(&self, workspace_id: &str, bug_id: &str) -> Option<WorkflowTask> {
        let workflow = self.workflow.lock().ok()?;
        workflow
            .tasks()
            .iter()
            .find(|task| {
                !task.status.is_terminal()
                    && task.spec.workspace_id == workspace_id
                    && task.spec.bug_id == bug_id
            })
            .cloned()
    }

    /// Cancels a task through the workflow; the core stops the runner and
    /// records the terminal state. A pending review keeps the old stash
    /// behavior by delegating to `stop_review`.
    async fn cancel(self: &Arc<Self>, task_id: &str) -> Result<AgentTask, String> {
        if self
            .workflow_view(task_id)
            .is_some_and(|view| view.status == TaskStatus::AwaitingApproval)
        {
            return self.stop_review(task_id).await;
        }
        let effects = self.apply_input(Input::Cancel {
            task_id: TaskId::new(task_id),
            now: now(),
        })?;
        self.dispatch_effects(effects).await;
        self.workflow_view(task_id)
            .ok_or_else(|| "任务不存在".to_string())
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
        // hook 只在任务运行期间有效；结束后清掉 token 和未消费的事件。
        if let Ok(mut tokens) = self.hook_tokens.lock() {
            tokens.retain(|_, id| id != task_id);
        }
        if let Ok(mut events) = self.hook_events.lock() {
            events.remove(task_id);
        }
        self.clear_runtime_status(task_id);
    }

    /// Kills every TUI this process started.
    ///
    /// The TUI runs in its own session, so a plain process exit leaves it
    /// running: the turn keeps going after the window is gone and keeps
    /// writing back to TAPD while the task already looks abandoned.
    fn shutdown(self: &Arc<Self>) {
        // Nothing was loaded before system entry, so writing a suspend
        // snapshot would overwrite the durable paused flag with its default.
        let entered = self
            .workflow
            .lock()
            .map(|workflow| workflow.entered())
            .unwrap_or(false);
        if !entered {
            tracing::info!("agent shutdown before system entry; durable queue untouched");
            return;
        }

        // Park the queue before the processes are killed: a fresh start then
        // resumes them (`Queued` + interrupted) instead of finding `Running`
        // records whose agent no longer exists.
        let effects = match self.apply_input(Input::Suspend { now: now() }) {
            Ok(effects) => effects,
            Err(error) => {
                tracing::error!(%error, "failed to suspend agent tasks during shutdown");
                Vec::new()
            }
        };
        // Shutdown is the last chance to persist the parked queue, so the
        // suspend effects run inline instead of through the async dispatcher.
        for effect in effects {
            match effect {
                Effect::PersistChanged { tasks } => {
                    let views = self.views_for(&tasks);
                    let paused = self.workflow_paused();
                    if !views.is_empty() {
                        tracing::info!(tasks = views.len(), "agent tasks suspended for shutdown");
                    }
                    self.persist_views(&views, paused, &[]);
                }
                Effect::PersistPaused { paused } => {
                    self.persist_views(&[], paused, &[]);
                }
                other => tracing::debug!(effect = ?other, "agent effect skipped during shutdown"),
            }
        }

        let task_ids: Vec<String> = {
            let workflow = self.workflow.lock().expect("agent workflow lock");
            workflow
                .tasks()
                .iter()
                .map(|task| task.id.0.clone())
                .collect()
        };
        for task_id in &task_ids {
            self.teardown_task(task_id);
        }
        tracing::info!(tasks = task_ids.len(), "agent processes stopped");
    }

    // -- post-work review ---------------------------------------------------

    /// Approves a paused change. The core decides between the commit-only
    /// requeue and a direct merge once it knows whether the working tree still
    /// has uncommitted files; a missing inspection runs inline so the command
    /// returns the final view.
    async fn approve_review(self: &Arc<Self>, task_id: &str) -> Result<AgentTask, String> {
        let task = self
            .workflow_view(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != TaskStatus::AwaitingApproval {
            return Err("任务不在待审核状态".to_string());
        }
        if !Path::new(task.work_dir().trim()).is_dir() {
            return Err(format!("工作目录不存在：{}", task.work_dir()));
        }

        let mut effects = self.apply_input(Input::ApproveReview {
            task_id: TaskId::new(task_id),
            now: now(),
        })?;
        let inspections: Vec<(TaskId, String)> = effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::InspectWorkspace { task_id, path, .. } => {
                    Some((task_id.clone(), path.clone()))
                }
                _ => None,
            })
            .collect();
        if !inspections.is_empty() {
            effects.retain(|effect| !matches!(effect, Effect::InspectWorkspace { .. }));
            for (inspect_id, path) in inspections {
                let changes = self
                    .inspect_workspace(&inspect_id, &path)
                    .await
                    .map_err(|error| format!("检查工作区失败：{error}"))?;
                let receipts = self.apply_input(Input::WorkspaceInspected {
                    task_id: inspect_id,
                    changes,
                })?;
                effects.extend(receipts);
            }
        }
        self.dispatch_effects(effects).await;

        tracing::info!(task_id, "agent review approved");
        self.workflow_view(task_id)
            .ok_or_else(|| "任务不存在".to_string())
    }

    /// Stops a paused review: the uncommitted diff is stashed (including
    /// untracked files) so nothing is lost, the task is canceled and the queue
    /// stays paused until the user resumes it.
    async fn stop_review(self: &Arc<Self>, task_id: &str) -> Result<AgentTask, String> {
        let task = self
            .workflow_view(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != TaskStatus::AwaitingApproval {
            return Err("任务不在待审核状态".to_string());
        }
        let repo = task.work_dir().trim().to_string();
        let dir_exists = !repo.is_empty() && Path::new(&repo).is_dir();

        let label = format!("tapd-agent {} #{}", task.bug_id, task.id);
        let reviewed = task
            .approval
            .as_ref()
            .map(|approval| approval.files.clone())
            .unwrap_or_default();
        let files = if !dir_exists {
            Vec::new()
        } else if reviewed.is_empty() {
            // No file list (e.g. model omitted it): use the run's own new
            // changes, excluding files that were already dirty before it.
            let repo = repo.clone();
            let baseline = task.baseline_dirty.clone();
            tokio::task::spawn_blocking(move || {
                uncommitted_files(&repo).map(|files| {
                    files
                        .into_iter()
                        .filter(|file| !baseline.contains(file))
                        .collect::<Vec<_>>()
                })
            })
            .await
            .map_err(|error| format!("检查工作区失败：{error}"))?
            .map_err(|error| format!("检查工作区失败：{error}"))?
        } else {
            reviewed
        };
        let stash = if dir_exists {
            let repo = repo.clone();
            let label = label.clone();
            let files = files.clone();
            tokio::task::spawn_blocking(move || stash_changes(&repo, &label, &files))
                .await
                .map_err(|error| format!("储藏改动失败：{error}"))?
                .map_err(|error| format!("储藏改动失败：{error}"))?
        } else {
            "工作目录不存在，未储藏改动".to_string()
        };

        self.teardown_task(task_id);
        let mut message = if !dir_exists || stash.contains("无未提交改动") {
            format!("已停止：{stash}")
        } else {
            format!("已停止，改动已储藏：{stash}")
        };
        // Files the model did not list stay in the worktree; say so instead of
        // claiming the whole change was stashed.
        let remaining = if dir_exists {
            let repo = repo.clone();
            let baseline = task.baseline_dirty.clone();
            tokio::task::spawn_blocking(move || {
                uncommitted_files(&repo).map(|files| {
                    files
                        .into_iter()
                        .filter(|file| !baseline.contains(file))
                        .count()
                })
            })
            .await
            .unwrap_or_else(|error| Err(format!("检查工作区失败：{error}")))
        } else {
            Ok(0)
        };
        match remaining {
            Ok(count) if count > 0 => message.push_str(&format!(
                "；另有 {count} 个文件未列入本次审核，仍保留在工作区"
            )),
            Ok(_) => {}
            Err(error) => message.push_str(&format!("；无法检查剩余文件：{error}")),
        }
        let effects = self.apply_input(Input::StopReview {
            task_id: TaskId::new(task_id),
            now: now(),
            stash: Some(stash.clone()),
            error: Some(message.clone()),
        })?;
        self.dispatch_effects(effects).await;

        tracing::info!(task_id, stash = %stash, "agent review stopped and changes stashed");
        self.workflow_view(task_id)
            .ok_or_else(|| "任务不存在".to_string())
    }

    /// Unified diff of the reviewed change. Uses the run's `baseline_head` when
    /// present so committed changes remain visible; otherwise falls back to
    /// `git diff HEAD`. Read-only; the review card uses it so the user can
    /// inspect the diff before approving.
    fn review_diff(&self, task_id: &str) -> Result<String, String> {
        let task = self
            .workflow_view(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != TaskStatus::AwaitingApproval {
            return Err("任务不在待审核状态".to_string());
        }
        if !Path::new(task.work_dir().trim()).is_dir() {
            return Err(format!("工作目录不存在：{}", task.work_dir()));
        }
        let baseline = task
            .baseline_head
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(git::EMPTY_TREE);
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(task.work_dir().trim())
            .args(["diff", "--no-color", baseline])
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
    /// serial queue until the user decides them.
    async fn resume_queue(self: &Arc<Self>) -> AgentTasksState {
        if let Ok(effects) = self.apply_input(Input::ResumeQueue { now: now() }) {
            self.dispatch_effects(effects).await;
        }
        self.tasks_state()
    }

    /// Deletes one finished history record. Only the local record goes away;
    /// the export directory, the bug and any committed code are untouched.
    async fn delete_task(self: &Arc<Self>, task_id: &str) -> Result<(), String> {
        let effects = self.apply_input(Input::DeleteTerminal {
            task_id: TaskId::new(task_id),
        })?;
        self.dispatch_effects(effects).await;
        Ok(())
    }

    async fn retry(self: &Arc<Self>, task_id: &str) -> Result<AgentTask, String> {
        let new_id = TaskId::new(uuid::Uuid::new_v4().simple().to_string());
        let effects = self.apply_input(Input::Retry {
            task_id: TaskId::new(task_id),
            new_id: new_id.clone(),
            now: now(),
        })?;
        self.dispatch_effects(effects).await;
        self.workflow_view(new_id.as_str())
            .ok_or_else(|| "任务不存在".to_string())
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

    /// 读取 transcript 中 provider 记录的错误。任务启动时克隆的 view 可能还没有
    /// 会话 id，这里以 workflow 里的实时 session id 为准。
    fn transcript_error(&self, task: &AgentTask) -> Option<String> {
        let session_id = self
            .stored_session_id(&task.id)
            .or_else(|| task.agent_session_id.clone())?;
        // hook 可能比最后一条 transcript 记录更早到达，留一点落盘时间。
        std::thread::sleep(Duration::from_millis(120));
        let source =
            transcript::resolve_source(&task.runtime_id, &session_id, task.work_dir()).ok()?;
        transcript::read(&source).ok()?.error
    }

    /// 读取 transcript 并按任务缓存。文件未变化时不重复解析。
    fn chat_payload(&self, task_id: &str, known_fingerprint: Option<&str>) -> AgentChatPayload {
        let Some(task) = self.workflow_view(task_id) else {
            return chat_empty(task_id, "", "", Some("任务不存在".to_string()));
        };
        let runtime_id = task.runtime_id.clone();
        let session_id = task.agent_session_id.clone().unwrap_or_default();
        let Some(agent) = transcript::TranscriptAgent::from_runtime_id(&runtime_id) else {
            return chat_empty(
                task_id,
                &runtime_id,
                &session_id,
                Some("该运行时暂不支持对话视图，请使用终端".to_string()),
            );
        };
        if session_id.trim().is_empty() {
            return chat_empty(
                task_id,
                &runtime_id,
                &session_id,
                Some("等待会话 id".to_string()),
            );
        }

        // 已解析过且会话没变时复用缓存路径：目录扫描只在首次 / 换会话时发生。
        let cached = self.transcript_cache.lock().ok().and_then(|cache| {
            cache.get(task_id).map(|entry| {
                (
                    entry.session_id.clone(),
                    entry.path.clone(),
                    entry.fingerprint.clone(),
                    entry.payload.model.clone(),
                )
            })
        });
        let mut source = match &cached {
            Some((cached_session, path, _, _)) if cached_session == &session_id => {
                transcript::TranscriptSource {
                    agent,
                    path: path.clone(),
                    session_id: session_id.clone(),
                }
            }
            _ => match transcript::resolve_source(&runtime_id, &session_id, task.work_dir()) {
                Ok(source) => source,
                Err(error) => {
                    return chat_empty(task_id, &runtime_id, &session_id, Some(error.message()))
                }
            },
        };
        let fingerprint = match transcript::fingerprint(&source) {
            Ok(fingerprint) => fingerprint,
            Err(first_error) => {
                // 缓存的文件可能被轮转 / 删除；重新定位一次再判断。
                match transcript::resolve_source(&runtime_id, &session_id, task.work_dir()) {
                    Ok(next) => match transcript::fingerprint(&next) {
                        Ok(fingerprint) => {
                            source = next;
                            fingerprint
                        }
                        Err(_) => {
                            return chat_empty(
                                task_id,
                                &runtime_id,
                                &session_id,
                                Some(first_error.message()),
                            )
                        }
                    },
                    Err(_) => {
                        return chat_empty(
                            task_id,
                            &runtime_id,
                            &session_id,
                            Some(first_error.message()),
                        )
                    }
                }
            }
        };
        if let Some((_, _, cached_fingerprint, cached_model)) = &cached {
            if cached_fingerprint == &fingerprint {
                if known_fingerprint == Some(fingerprint.as_str()) {
                    // 前端已有同一份内容：只回指纹，不序列化 2000 条消息。
                    return AgentChatPayload {
                        task_id: task_id.to_string(),
                        runtime_id,
                        session_id,
                        messages: Vec::new(),
                        truncated: false,
                        source: agent.source_label().to_string(),
                        fingerprint,
                        model: cached_model.clone(),
                        unchanged: true,
                        error: None,
                    };
                }
                if let Ok(cache) = self.transcript_cache.lock() {
                    if let Some(entry) = cache.get(task_id) {
                        return entry.payload.clone();
                    }
                }
            }
        }
        let read = match transcript::read(&source) {
            Ok(read) => read,
            Err(error) => {
                return chat_empty(task_id, &runtime_id, &session_id, Some(error.message()))
            }
        };
        // 解析时重新算出的指纹与探测结果一致；以解析结果为准写缓存。
        let fingerprint = read.fingerprint.clone();
        let model = read.model.clone();
        let path = source.path;
        let payload = AgentChatPayload {
            task_id: task_id.to_string(),
            runtime_id,
            session_id: session_id.clone(),
            messages: read.messages,
            truncated: read.truncated,
            source: read.source,
            fingerprint: fingerprint.clone(),
            model,
            unchanged: false,
            error: None,
        };
        if let Ok(mut cache) = self.transcript_cache.lock() {
            if cache.len() >= CHAT_CACHE_LIMIT && !cache.contains_key(task_id) {
                cache.clear();
            }
            cache.insert(
                task_id.to_string(),
                ChatCache {
                    session_id,
                    path,
                    fingerprint,
                    payload: payload.clone(),
                },
            );
        }
        payload
    }

    /// 从 Chat 发送一条消息：写入当前 PTY，由各 CLI 自己排队/打断。
    fn send_message(&self, task_id: &str, text: &str) -> Result<(), String> {
        if text.trim().is_empty() {
            return Err("消息为空".to_string());
        }
        let task = self
            .workflow_view(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if !matches!(task.status, TaskStatus::Running | TaskStatus::Merging) {
            return Err("任务未在运行".to_string());
        }
        let waiting = self
            .runtime_status
            .lock()
            .ok()
            .and_then(|status| status.get(task_id).cloned())
            .and_then(|status| status.prompt)
            .is_some_and(|prompt| prompt.can_answer);
        if waiting {
            return Err("请先处理当前的权限确认或提问".to_string());
        }
        // bracketed paste 保证多行文本不会在第一个换行处提交。
        let payload = format!("\x1b[200~{text}\x1b[201~\r");
        self.write_input(task_id, &payload)
    }

    /// 回答权限 / 提问。按键映射是 best-effort：协议变化时返回错误让用户回终端。
    async fn prompt_answer(
        &self,
        task_id: &str,
        prompt_id: &str,
        option_id: &str,
    ) -> Result<String, String> {
        let current = self
            .runtime_status
            .lock()
            .ok()
            .and_then(|status| status.get(task_id).cloned())
            .and_then(|status| status.prompt)
            .ok_or_else(|| "当前没有待处理的请求".to_string())?;
        if current.prompt_id != prompt_id {
            return Err("该请求已处理，请刷新后重试".to_string());
        }
        if !current.can_answer {
            return Err("请在 Agent 终端中回答".to_string());
        }
        let runtime_id = self
            .stored_runtime_id(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        let keys = prompt::answer_keys(&runtime_id, &current.kind, option_id)
            .ok_or_else(|| "该选项无法自动回答，请在终端中操作".to_string())?;
        for (index, key) in keys.iter().enumerate() {
            if index > 0 {
                // 连续按键之间留出间隔，避免被 TUI 识别成组合键。
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            self.write_input(task_id, key)?;
        }
        Ok(format!("已发送 {}", keys.join(" ")))
    }

    /// 在系统终端里接着跑这个任务的 Agent（尽量续接上次会话），用来在任务
    /// 结束后继续处理同一个缺陷。运行中的任务不允许：内嵌 PTY 还占着同一
    /// 会话，两个客户端会互相打架。
    fn open_system_terminal(&self, task_id: &str) -> Result<(), String> {
        let task = self
            .workflow_view(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status.is_active() {
            return Err("任务仍在运行，请先在嵌入式终端里操作".to_string());
        }
        if task.work_dir().trim().is_empty() {
            return Err("该任务没有本地仓库".to_string());
        }
        let repo = Path::new(task.work_dir());
        if !repo.is_dir() {
            return Err(format!("本地仓库不存在：{}", task.work_dir()));
        }

        let config = self.config_snapshot();
        let scan = self.scan_snapshot();
        let binary = validate_binary(&binary_for_task(&config, &task.runtime_id, scan.as_ref()))?;
        let mut args: Vec<String> = runtime_descriptor(&task.runtime_id)
            .map(|descriptor| descriptor.args.iter().map(|arg| arg.to_string()).collect())
            .unwrap_or_default();
        // 续接会话时保持任务选定的模型与权限。
        args.extend(runtime_launch_options(
            &task.runtime_id,
            &task.model,
            &task.permission_mode,
        ));
        args.extend(resume_args(
            &task.runtime_id,
            task.agent_session_id.as_deref(),
        ));
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        launch_system_terminal(repo, &binary.to_string_lossy(), &arg_refs)
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

    // -- runtime execution ---------------------------------------------------

    /// Makes sure the runtime's user-level config exposes the tapd MCP server.
    /// Idempotent and best effort: a failure only warns and never blocks the
    /// task. Runtimes without an injector are expected to be configured
    /// manually (the management UI says so). Shared by the fix run and the
    /// merge runner so the merge agent can write back to TAPD.
    async fn ensure_runtime_mcp(&self, runtime_id: &str, task_id: &str) {
        let Some(client) = mcp_client_for_runtime(runtime_id) else {
            return;
        };
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
                tracing::info!(task_id, %result, "tapd MCP injection checked");
            }
            Ok(Err(error)) => {
                tracing::warn!(task_id, %error, "failed to inject tapd MCP");
            }
            Err(error) => {
                tracing::warn!(task_id, %error, "MCP injection task panicked");
            }
        }
    }

    // -- effect runners ------------------------------------------------------

    /// Creates the per-task worktree and reports the receipt back. The core
    /// only accepts the receipt while the task is still `Preparing`.
    async fn run_create_worktree(
        self: &Arc<Self>,
        task_id: TaskId,
        repo_path: String,
        bug_id: String,
    ) {
        let Some(task) = self.workflow_task(task_id.as_str()) else {
            tracing::debug!(task_id = %task_id, "worktree create ignored: task is gone");
            return;
        };
        if task.status != WorkflowStatus::Preparing {
            tracing::debug!(task_id = %task_id, "worktree create ignored: task no longer preparing");
            return;
        }
        let worktrees_dir = self.state.paths.worktrees_dir.clone();
        let repo = if repo_path.trim().is_empty() {
            task.spec.repo_path.trim().to_string()
        } else {
            repo_path.trim().to_string()
        };
        let repo_for_cleanup = repo.clone();
        let workspace_id = task.spec.workspace_id.clone();
        let bug_id = if bug_id.trim().is_empty() {
            task.spec.bug_id.clone()
        } else {
            bug_id
        };
        let task_text = task_id.0.clone();

        let _guard = self.worktree_lock.lock().await;
        let created = tokio::task::spawn_blocking(move || {
            worktree::create(&worktrees_dir, &repo, &workspace_id, &bug_id, &task_text)
        })
        .await;
        match created {
            Ok(Ok(created)) => {
                // The task may have been cancelled/suspended while git ran;
                // never leave an unreferenced worktree behind.
                if self.workflow_status(task_id.as_str()) != Some(WorkflowStatus::Preparing) {
                    let path = created.path.to_string_lossy().to_string();
                    let _ = tokio::task::spawn_blocking(move || {
                        worktree::remove(&repo_for_cleanup, &path)
                    })
                    .await;
                    return;
                }
                tracing::info!(
                    task_id = %task_id,
                    branch = %created.branch,
                    "agent worktree created"
                );
                self.feed(Input::WorktreeCreated {
                    task_id,
                    worktree: tapd_workflow::WorktreeRef {
                        path: created.path.to_string_lossy().to_string(),
                        branch: created.branch,
                    },
                });
            }
            Ok(Err(error)) => {
                tracing::warn!(task_id = %task_id, %error, "failed to create agent worktree");
                self.feed(Input::WorktreeCreateFailed {
                    task_id,
                    error: format!("创建任务 worktree 失败：{error}"),
                });
            }
            Err(error) => {
                tracing::warn!(task_id = %task_id, %error, "worktree create task failed");
                self.feed(Input::WorktreeCreateFailed {
                    task_id,
                    error: format!("创建任务 worktree 失败：{error}"),
                });
            }
        }
    }

    /// Removes a worktree directory; the branch is always kept.
    ///
    /// A terminal task that is still in the workflow may have uncommitted work
    /// in its directory (failed fix, commit phase with leftovers): keep it so
    /// the user can inspect or recover it. A deleted record is removed
    /// unconditionally.
    async fn run_remove_worktree(
        self: &Arc<Self>,
        task_id: TaskId,
        repo_path: String,
        path: String,
    ) {
        let _guard = self.worktree_lock.lock().await;

        if self.workflow_task(task_id.as_str()).is_some() {
            let dir = path.clone();
            let status = tokio::task::spawn_blocking(move || uncommitted_files(&dir)).await;
            match status {
                Ok(Ok(files)) if !files.is_empty() => {
                    tracing::warn!(
                        task_id = %task_id,
                        files = files.len(),
                        "worktree kept: uncommitted files remain"
                    );
                    self.feed(Input::WorktreeRemoved {
                        task_id,
                        error: Some("worktree 仍有未提交改动，已保留".to_string()),
                    });
                    return;
                }
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    tracing::warn!(task_id = %task_id, %error, "worktree status check failed; keeping it");
                    self.feed(Input::WorktreeRemoved {
                        task_id,
                        error: Some(format!("无法检查 worktree 状态：{error}")),
                    });
                    return;
                }
                Err(error) => {
                    tracing::warn!(task_id = %task_id, %error, "worktree status task failed; keeping it");
                    self.feed(Input::WorktreeRemoved {
                        task_id,
                        error: Some(format!("无法检查 worktree 状态：{error}")),
                    });
                    return;
                }
            }
        }

        let error =
            match tokio::task::spawn_blocking(move || worktree::remove(&repo_path, &path)).await {
                Ok(Ok(())) => None,
                Ok(Err(error)) => {
                    tracing::warn!(task_id = %task_id, %error, "failed to remove agent worktree");
                    Some(error)
                }
                Err(error) => {
                    tracing::warn!(task_id = %task_id, %error, "worktree cleanup task failed");
                    Some(format!("worktree cleanup task failed: {error}"))
                }
            };
        self.feed(Input::WorktreeRemoved { task_id, error });
    }

    /// Computes the dirty/committed change set for a task's working directory.
    async fn inspect_workspace(
        &self,
        task_id: &TaskId,
        path: &str,
    ) -> Result<tapd_workflow::ChangeSet, String> {
        let task = self
            .workflow_view(task_id.as_str())
            .ok_or_else(|| "任务不存在".to_string())?;
        let work_dir = if path.trim().is_empty() {
            task.work_dir().to_string()
        } else {
            path.to_string()
        };
        tokio::task::spawn_blocking(move || inspect_changes(&task, &work_dir))
            .await
            .map_err(|error| format!("检查工作区失败：{error}"))?
    }

    /// Refuses a merge when the repository is busy, dirty or the runtime is
    /// unavailable. Every check is a fact the core cannot observe itself.
    async fn check_merge_preconditions(
        &self,
        task_id: &TaskId,
        repo_path: &str,
        branch: &str,
    ) -> Result<(), tapd_workflow::MergeBlock> {
        let Some(task) = self.workflow_task(task_id.as_str()) else {
            return Err(tapd_workflow::MergeBlock::WorktreeMissing);
        };
        let repo = if repo_path.trim().is_empty() {
            task.spec.repo_path.trim().to_string()
        } else {
            repo_path.trim().to_string()
        };
        if repo.is_empty() || branch.trim().is_empty() {
            return Err(tapd_workflow::MergeBlock::WorktreeMissing);
        }

        let busy = {
            let workflow = self.workflow.lock().expect("agent workflow lock");
            workflow.tasks().iter().any(|other| {
                other.id != *task_id
                    && other.status == WorkflowStatus::Merging
                    && other.spec.repo_path.trim() == repo
            })
        };
        if busy {
            return Err(tapd_workflow::MergeBlock::RepositoryBusy);
        }

        let check_repo = repo.clone();
        let dirty = tokio::task::spawn_blocking(move || uncommitted_files(&check_repo)).await;
        match dirty {
            Ok(Ok(files)) if files.is_empty() => {}
            Ok(Ok(files)) => {
                return Err(tapd_workflow::MergeBlock::DirtyRepository { files: files.len() })
            }
            Ok(Err(error)) => {
                return Err(tapd_workflow::MergeBlock::RuntimeUnavailable {
                    error: format!("无法检查主仓库状态：{error}"),
                })
            }
            Err(error) => {
                return Err(tapd_workflow::MergeBlock::RuntimeUnavailable {
                    error: format!("无法检查主仓库状态：{error}"),
                })
            }
        }

        let config = self.config_snapshot();
        let binary = binary_for_task(
            &config,
            &task.spec.runtime_id,
            self.scan_snapshot().as_ref(),
        );
        if let Err(error) = validate_binary(&binary) {
            return Err(tapd_workflow::MergeBlock::RuntimeUnavailable { error });
        }
        Ok(())
    }

    /// Full fix-run preparation and execution. State changes happen only
    /// through inputs (`TaskPrepared`, `AgentStarted`, `RunFinished`).
    async fn start_fix_agent(self: &Arc<Self>, task_id: TaskId, runtime_id: String, cwd: String) {
        let Some(task) = self.workflow_view(task_id.as_str()) else {
            return;
        };
        if task.status != TaskStatus::Preparing {
            return;
        }
        let mut config = self.config_snapshot();
        let runtime_id = if runtime_id.trim().is_empty() {
            task.runtime_id.clone()
        } else {
            runtime_id
        };

        // 1. Export the bug package (bug.json + assets).
        let export = crate::export::run_export(
            &self.app,
            &self.state.paths,
            &task.workspace_id,
            &task.bug_id,
            Some(task.workspace_name.clone()).filter(|name| !name.trim().is_empty()),
        )
        .await;
        let export = match export {
            Ok(export) => export,
            Err(error) => {
                self.feed(Input::AgentStartFailed {
                    task_id,
                    error: format!("导出缺陷失败：{error}"),
                });
                return;
            }
        };
        for warning in &export.warnings {
            tracing::warn!(task_id = %task_id, %warning, "bug export warning");
        }
        if self.workflow_status(task_id.as_str()) != Some(WorkflowStatus::Preparing) {
            // Cancelled while exporting.
            return;
        }

        // 2. Validate the working directory.
        let work_dir = if cwd.trim().is_empty() {
            task.work_dir().to_string()
        } else {
            cwd
        };
        if work_dir.trim().is_empty() {
            self.feed(Input::AgentStartFailed {
                task_id,
                error: "未配置项目仓库路径，请在 设置 → Agent 修复 中配置".to_string(),
            });
            return;
        }
        if !Path::new(work_dir.trim()).is_dir() {
            self.feed(Input::AgentStartFailed {
                task_id,
                error: format!("工作目录不存在或不是目录：{work_dir}"),
            });
            return;
        }

        // 3. Resolve the agent binary.
        let task_binary = binary_for_task(&config, &runtime_id, self.scan_snapshot().as_ref());
        match validate_binary(&task_binary) {
            Ok(binary) => config.binary_path = binary.to_string_lossy().into_owned(),
            Err(error) => {
                self.feed(Input::AgentStartFailed { task_id, error });
                return;
            }
        }

        // 4. Make sure the runtime's user-level config exposes the tapd MCP.
        self.ensure_runtime_mcp(&runtime_id, task_id.as_str()).await;

        // 5. Render the prompt.
        let mut view = task.clone();
        view.runtime_id = runtime_id;
        view.json_path = export.bug_json.clone();
        let mut vars = PromptVars::from_task(&view);
        vars.coworker = crate::coworker::prompt_section(&self.app, &config.coworker_ids);
        let is_worktree = view.worktree_branch.is_some();
        let template = if view.commit_only {
            // The commit phase only finishes the reviewed change; the original
            // compose instructions must not run a second time.
            vars.user_prompt.clear();
            vars.attachments.clear();
            if is_worktree {
                DEFAULT_WORKTREE_COMMIT_PROMPT_TEMPLATE
            } else {
                DEFAULT_COMMIT_PROMPT_TEMPLATE
            }
        } else {
            config.prompt_template.as_str()
        };
        let mut prompt = render_prompt(template, &vars);
        if is_worktree && !view.commit_only {
            prompt.push_str("\n\n");
            prompt.push_str(WORKTREE_FIX_NOTE);
        }
        view.prompt = prompt.clone();

        // 6. Capture the baseline so the change safety net only reacts to files
        //    this run touched. A commit-only run keeps the review baseline.
        let baseline = if view.commit_only {
            Ok((view.baseline_dirty.clone(), view.baseline_head.clone()))
        } else {
            let dir = work_dir.clone();
            tokio::task::spawn_blocking(move || {
                Ok::<_, String>((uncommitted_files(&dir)?, git_head(&dir)?))
            })
            .await
            .unwrap_or_else(|error| Err(format!("检查工作区失败：{error}")))
        };
        let (baseline_dirty, baseline_head) = match baseline {
            Ok(values) => values,
            Err(error) => {
                self.feed(Input::AgentStartFailed {
                    task_id,
                    error: format!("无法读取工作区状态：{error}"),
                });
                return;
            }
        };

        // 7. Record the preparation facts, then start the run.
        match self.apply_input(Input::TaskPrepared {
            task_id: task_id.clone(),
            prompt,
            json_path: export.bug_json,
            baseline_dirty,
            baseline_head,
        }) {
            Ok(effects) => self.dispatch_effects(effects).await,
            Err(error) => {
                tracing::info!(
                    task_id = %task_id,
                    %error,
                    "agent start abandoned during preparation"
                );
                return;
            }
        }
        if self.workflow_status(task_id.as_str()) != Some(WorkflowStatus::Preparing) {
            return;
        }
        match self.apply_input(Input::AgentStarted {
            task_id: task_id.clone(),
        }) {
            Ok(effects) => self.dispatch_effects(effects).await,
            Err(error) => {
                tracing::warn!(task_id = %task_id, %error, "failed to record agent start");
                return;
            }
        }

        let Some(running) = self.workflow_view(task_id.as_str()) else {
            return;
        };
        if running.status != TaskStatus::Running {
            return;
        }
        let descriptor = runtime_descriptor(&running.runtime_id)
            .unwrap_or_else(|| runtime_descriptor(DEFAULT_RUNTIME_ID).expect("default runtime"));
        let outcome = self.run_tui_task(&running, &config, &descriptor).await;
        if let Some(warning) = outcome.warning.as_deref() {
            tracing::warn!(task_id = %task_id, warning, "agent finished with a warning");
        }
        self.teardown_task(task_id.as_str());

        let run = self.run_outcome(task_id.as_str(), &outcome).await;
        self.feed(Input::RunFinished {
            task_id,
            outcome: run,
            now: now(),
        });
    }

    /// Turns a PTY outcome plus the repository facts into the workflow's
    /// [`tapd_workflow::RunOutcome`]. It never decides review/merge: only the
    /// facts travel back.
    async fn run_outcome(&self, task_id: &str, outcome: &PtyOutcome) -> tapd_workflow::RunOutcome {
        let canceled = outcome.canceled;
        let changes = if canceled {
            None
        } else {
            match self.workflow_view(task_id) {
                Some(view) => {
                    let dir = view.work_dir().to_string();
                    match tokio::task::spawn_blocking(move || inspect_changes(&view, &dir)).await {
                        Ok(Ok(changes)) => Some(changes),
                        Ok(Err(error)) => {
                            return tapd_workflow::RunOutcome {
                                canceled,
                                success: false,
                                error: Some(format!("无法检查工作区状态：{error}")),
                                changes: None,
                                exit_code: outcome.exit_code,
                            }
                        }
                        Err(error) => {
                            return tapd_workflow::RunOutcome {
                                canceled,
                                success: false,
                                error: Some(format!("无法检查工作区状态：{error}")),
                                changes: None,
                                exit_code: outcome.exit_code,
                            }
                        }
                    }
                }
                None => None,
            }
        };
        let success = !canceled
            && (outcome.completed || outcome.exit_code == Some(0))
            && outcome.error.is_none();
        tapd_workflow::RunOutcome {
            canceled,
            success,
            error: outcome.error.clone(),
            changes,
            exit_code: outcome.exit_code,
        }
    }

    /// Runs the merge turn in the main repository, then lets the core verify
    /// the branch. The merge runner's exit code never decides the outcome.
    async fn start_merge_agent(
        self: &Arc<Self>,
        task_id: TaskId,
        repo_path: String,
        branch: String,
    ) {
        let Some(task) = self.workflow_view(task_id.as_str()) else {
            return;
        };
        if task.status != TaskStatus::Merging {
            return;
        }
        let repo = if repo_path.trim().is_empty() {
            task.repo_path.trim().to_string()
        } else {
            repo_path.trim().to_string()
        };
        let branch = if branch.trim().is_empty() {
            task.worktree_branch.clone().unwrap_or_default()
        } else {
            branch
        };
        if repo.is_empty() || branch.trim().is_empty() || !Path::new(&repo).is_dir() {
            self.feed(Input::MergeAgentFinished {
                task_id,
                outcome: tapd_workflow::RunOutcome::failure(
                    format!("主仓库路径不存在或不是目录：{repo}"),
                    None,
                ),
                now: now(),
            });
            return;
        }

        let mut config = self.config_snapshot();
        let binary = binary_for_task(&config, &task.runtime_id, self.scan_snapshot().as_ref());
        match validate_binary(&binary) {
            Ok(binary) => config.binary_path = binary.to_string_lossy().into_owned(),
            Err(error) => {
                self.feed(Input::MergeAgentFinished {
                    task_id,
                    outcome: tapd_workflow::RunOutcome::failure(error, None),
                    now: now(),
                });
                return;
            }
        }
        self.ensure_runtime_mcp(&task.runtime_id, task_id.as_str())
            .await;

        // A cancel may have rolled the task back while MCP was being prepared;
        // never start a merge agent the workflow no longer waits for.
        if self.workflow_status(task_id.as_str()) != Some(WorkflowStatus::Merging) {
            return;
        }

        // Run in the main repository: clear the worktree path (so `work_dir()`
        // falls back to `repo_path`) but keep the branch name for the prompt.
        let mut merge_view = task.clone();
        merge_view.worktree_path = None;
        merge_view.commit_only = false;
        merge_view.prompt = merge_prompt(&repo, &branch);
        let descriptor = runtime_descriptor(&merge_view.runtime_id)
            .unwrap_or_else(|| runtime_descriptor(DEFAULT_RUNTIME_ID).expect("default runtime"));
        let outcome = self.run_tui_task(&merge_view, &config, &descriptor).await;
        self.teardown_task(task_id.as_str());

        let finished = tapd_workflow::RunOutcome {
            canceled: outcome.canceled,
            success: !outcome.canceled
                && (outcome.completed || outcome.exit_code == Some(0))
                && outcome.error.is_none(),
            error: outcome.error.clone(),
            changes: None,
            exit_code: outcome.exit_code,
        };
        self.feed(Input::MergeAgentFinished {
            task_id,
            outcome: finished,
            now: now(),
        });
    }

    /// Checks whether the branch really landed in the main repository.
    async fn run_verify_branch_merged(
        self: &Arc<Self>,
        task_id: TaskId,
        repo_path: String,
        branch: String,
    ) {
        let checked = tokio::task::spawn_blocking(move || branch_merged(&repo_path, &branch)).await;
        let (merged, error) = match checked {
            Ok(Ok(merged)) => (merged, None),
            Ok(Err(error)) => (false, Some(format!("校验合并结果失败：{error}"))),
            Err(error) => (false, Some(format!("校验合并结果失败：{error}"))),
        };
        self.feed(Input::BranchMergeVerified {
            task_id,
            merged,
            error,
        });
    }

    async fn run_tui_task(
        self: &Arc<Self>,
        task: &AgentTask,
        config: &AgentConfig,
        descriptor: &AgentRuntimeDescriptor,
    ) -> PtyOutcome {
        let mut args: Vec<String> = descriptor.args.iter().map(|arg| arg.to_string()).collect();
        args.extend(runtime_launch_options(
            &task.runtime_id,
            &task.model,
            &task.permission_mode,
        ));
        let mut envs: Vec<(String, String)> = Vec::new();
        let mut monitor_hook = false;
        if descriptor.session_hook {
            match self.prepare_session_hook(task, descriptor.hook_kind) {
                Some(launch) => {
                    args.extend(launch.args);
                    envs.extend(launch.envs);
                    monitor_hook = true;
                }
                None => tracing::warn!(
                    task_id = %task.id,
                    "agent session hook is unavailable; falling back to idle completion"
                ),
            }
        }

        let inject_prompt = match descriptor.prompt_injection {
            PromptInjection::Argv => {
                // `--` 终止参数解析，避免提示词以 `--foo` / 子命令开头时被 CLI 吃掉。
                if let Some(separator) = descriptor.argv_separator {
                    args.push(separator.to_string());
                }
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
                    envs,
                    guard,
                    inject_prompt,
                    idle_complete,
                    monitor_hook,
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

    // -- merge stage ---------------------------------------------------------

    /// Starts the merge through the workflow. The repository/binary checks are
    /// executed inline so the command can report `agent` or `manual` with the
    /// final task view (`Merging` vs. `AwaitingMerge` + instructions).
    async fn start_merge(self: &Arc<Self>, task_id: &str) -> Result<MergeStart, String> {
        let mut effects = self.apply_input(Input::StartMerge {
            task_id: TaskId::new(task_id),
            now: now(),
        })?;
        let checks: Vec<(TaskId, String, String)> = effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::CheckMergePreconditions {
                    task_id,
                    repo_path,
                    branch,
                    ..
                } => Some((task_id.clone(), repo_path.clone(), branch.clone())),
                _ => None,
            })
            .collect();
        if !checks.is_empty() {
            effects.retain(|effect| !matches!(effect, Effect::CheckMergePreconditions { .. }));
            for (check_id, repo_path, branch) in checks {
                let result = self
                    .check_merge_preconditions(&check_id, &repo_path, &branch)
                    .await;
                let receipts = self.apply_input(Input::MergePreconditionsChecked {
                    task_id: check_id,
                    result,
                })?;
                effects.extend(receipts);
            }
        }
        self.dispatch_effects(effects).await;

        let task = self
            .workflow_view(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        let mode = if task.status == TaskStatus::Merging {
            "agent"
        } else {
            "manual"
        };
        let instructions = if mode == "manual" {
            task.merge
                .as_ref()
                .and_then(|merge| merge.instructions.clone())
                .unwrap_or_else(|| {
                    manual_merge_instructions(
                        &task.repo_path,
                        task.worktree_branch.as_deref().unwrap_or(""),
                    )
                })
        } else {
            String::new()
        };
        if mode == "manual" {
            tracing::warn!(task_id, "agent merge unavailable; manual merge requested");
        } else {
            tracing::info!(task_id, "agent merge started");
        }
        Ok(MergeStart {
            mode,
            task,
            instructions,
        })
    }

    /// Verifies a manual merge: the branch must already be an ancestor of the
    /// main repository's HEAD. The task view carries the resulting state.
    async fn verify_merge(self: &Arc<Self>, task_id: &str) -> Result<AgentTask, String> {
        let mut effects = self.apply_input(Input::VerifyMerge {
            task_id: TaskId::new(task_id),
            now: now(),
        })?;
        let verifications: Vec<(TaskId, String, String)> = effects
            .iter()
            .filter_map(|effect| match effect {
                Effect::VerifyBranchMerged {
                    task_id,
                    repo_path,
                    branch,
                    ..
                } => Some((task_id.clone(), repo_path.clone(), branch.clone())),
                _ => None,
            })
            .collect();
        effects.retain(|effect| !matches!(effect, Effect::VerifyBranchMerged { .. }));
        for (verify_id, repo_path, branch) in verifications {
            let checked =
                tokio::task::spawn_blocking(move || branch_merged(&repo_path, &branch)).await;
            let (merged, error) = match checked {
                Ok(Ok(merged)) => (merged, None),
                Ok(Err(error)) => (false, Some(format!("校验合并结果失败：{error}"))),
                Err(error) => (false, Some(format!("校验合并结果失败：{error}"))),
            };
            let receipts = self.apply_input(Input::BranchMergeVerified {
                task_id: verify_id,
                merged,
                error,
            })?;
            effects.extend(receipts);
        }
        self.dispatch_effects(effects).await;
        let task = self
            .workflow_view(task_id)
            .ok_or_else(|| "任务不存在".to_string())?;
        if task.status != TaskStatus::Succeeded {
            if let Some(error) = task.merge.as_ref().and_then(|merge| merge.error.clone()) {
                return Err(error);
            }
            return Err("分支尚未合并到主仓库当前 HEAD".to_string());
        }
        Ok(task)
    }
}

/// loopback `/agent/hook` 的入口：校验 token 后把事件交给 AgentCore。
pub(crate) fn handle_session_hook(app: &AppHandle, report: HookReport) -> Result<(), HookError> {
    let core = app
        .try_state::<Arc<AgentCore>>()
        .ok_or(HookError::Internal)?;
    core.record_session_hook(&report)
}

/// 各客户端的 session id 字段名不统一，按常见拼写依次查找。
pub(crate) fn extract_hook_session_id(payload: &Value) -> Option<String> {
    const KEYS: [&str; 8] = [
        "session_id",
        "sessionId",
        "sessionID",
        "conversation_id",
        "conversationId",
        "thread_id",
        "threadId",
        "session",
    ];
    for key in KEYS {
        if let Some(value) = payload.get(key) {
            if let Some(id) = hook_session_value(value).filter(|id| valid_session_id(id)) {
                return Some(id);
            }
        }
    }
    None
}

/// session id 来自不同客户端，过滤空值和未展开的模板变量（如 ZCode 的
/// `${CLAUDE_SESSION_ID}`），避免把模板文本当作会话 id 持久化。
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.contains('$') && !id.contains('{') && !id.contains('}')
}

fn hook_session_value(value: &Value) -> Option<String> {
    match value {
        // 有些客户端把 `session` 写成对象；只认 `id`，避免误取标题等字段。
        Value::Object(object) => object
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string),
        Value::String(id) => {
            let id = id.trim();
            (!id.is_empty()).then(|| id.to_string())
        }
        _ => None,
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
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
    resolve_on_user_path(binary).ok_or_else(|| {
        format!("在 PATH 中找不到 Agent 可执行文件：{binary}（可在 Agent 设置里填写绝对路径）")
    })
}

/// 在用户 shell 的 `PATH` 中查找裸命令名。
fn resolve_on_user_path(binary: &str) -> Option<PathBuf> {
    std::env::split_paths(shell_path::user_path())
        .map(|dir| dir.join(binary))
        .find(|candidate| shell_path::is_executable(candidate))
}

/// 安装检测用：路径或裸命令名都可以，找不到返回 `None`。
pub(crate) fn resolve_executable(binary: &str) -> Option<PathBuf> {
    let binary = binary.trim();
    if binary.is_empty() {
        return None;
    }
    let path = Path::new(binary);
    if path.is_absolute() || binary.contains('/') || binary.contains('\\') {
        return (path.is_file() && shell_path::is_executable(path)).then(|| path.to_path_buf());
    }
    resolve_on_user_path(binary)
}

/// CLI arguments that pick the previous session back up in the task's working
/// directory, used by the "打开系统终端" recovery path.
///
/// When a session hook captured the runtime's session id, resume that exact
/// session; otherwise fall back to the CLI's "continue the most recent"
/// command. Runtimes whose entry point is unknown open a plain terminal.
fn resume_args(runtime_id: &str, session_id: Option<&str>) -> Vec<String> {
    let session = session_id.map(str::trim).filter(|id| !id.is_empty());
    let continue_recent = || vec!["--continue".to_string()];
    match runtime_id {
        // 这几个 CLI 都支持用捕获到的 session id 精确恢复，缺省时继续最近会话。
        "omp" | "claude" | "cursor" => match session {
            Some(id) => vec!["--resume".to_string(), id.to_string()],
            None => continue_recent(),
        },
        "opencode" | "kimi" => match session {
            Some(id) => vec!["--session".to_string(), id.to_string()],
            None => continue_recent(),
        },
        "codex" => match session {
            Some(id) => vec!["resume".to_string(), id.to_string()],
            None => vec!["resume".to_string()],
        },
        "qwen" => continue_recent(),
        // Gemini 没有 --continue，捕获到 session id 时精确恢复，否则取 latest。
        "gemini" => match session {
            Some(id) => vec!["--resume".to_string(), id.to_string()],
            None => vec!["--resume".to_string(), "latest".to_string()],
        },
        _ => Vec::new(),
    }
}

/// 把任务选择的模型 / 权限翻译成各 CLI 的启动参数。
///
/// 权限 id 来自 `AgentPermissionOption`；未知组合直接忽略，让 CLI 用自己的默认值。
fn runtime_launch_options(runtime_id: &str, model: &str, permission: &str) -> Vec<String> {
    let mut args = Vec::new();
    let model = model.trim();
    if !model.is_empty()
        && matches!(
            runtime_id,
            "claude" | "openclaude" | "codex" | "opencode" | "opencode2" | "omp" | "pi"
        )
    {
        args.push("--model".to_string());
        args.push(model.to_string());
    }

    let mut push = |values: &[&str]| {
        args.extend(values.iter().map(|value| (*value).to_string()));
    };
    match permission.trim() {
        "" | "default" => {}
        "accept_edits" => match runtime_id {
            "claude" | "openclaude" => push(&["--permission-mode", "acceptEdits"]),
            "codex" => push(&["--full-auto"]),
            "opencode" | "opencode2" => push(&["--auto"]),
            "omp" | "pi" => push(&["--approval-mode", "write"]),
            _ => {}
        },
        "full_auto" if runtime_id == "codex" => push(&["--full-auto"]),
        "auto" if matches!(runtime_id, "opencode" | "opencode2") => push(&["--auto"]),
        "write" if matches!(runtime_id, "omp" | "pi") => push(&["--approval-mode", "write"]),
        "plan" if matches!(runtime_id, "claude" | "openclaude") => {
            push(&["--permission-mode", "plan"])
        }
        "full_access" => match runtime_id {
            "claude" | "openclaude" => push(&["--permission-mode", "bypassPermissions"]),
            "codex" => push(&["--dangerously-bypass-approvals-and-sandbox"]),
            "opencode" | "opencode2" => push(&["--auto"]),
            "omp" | "pi" => push(&["--approval-mode", "yolo"]),
            _ => {}
        },
        _ => {}
    }
    args
}

/// The command a task runs with: the configured path while it points at the
/// task's runtime, otherwise the detected path for that runtime, and finally
/// its default binary. Queued tasks keep the runtime they were enqueued with,
/// so switching settings later cannot change how an existing task (or its
/// recovery terminal) starts.
fn binary_for_task(
    config: &AgentConfig,
    runtime_id: &str,
    scan: Option<&crate::agent_scan::AgentScanSnapshot>,
) -> String {
    if config.runtime_id == runtime_id {
        return config.binary_path.clone();
    }
    if let Some(path) = scan
        .and_then(|snapshot| snapshot.result_for(runtime_id))
        .and_then(|result| result.resolved_path.as_deref())
        .filter(|path| !path.is_empty())
    {
        return path.to_string();
    }
    runtime_descriptor(runtime_id)
        .map(|descriptor| descriptor.binary.to_string())
        .unwrap_or_else(|| config.binary_path.clone())
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
        "omp" => Some(crate::mcp_import::CLIENT_OMP),
        "kimi" => Some(crate::mcp_import::CLIENT_KIMI),
        "gemini" => Some(crate::mcp_import::CLIENT_GEMINI),
        "qwen" => Some(crate::mcp_import::CLIENT_QWEN),
        _ => None,
    }
}

fn detect_version(binary: &str) -> Result<String, String> {
    let resolved = validate_binary(binary)?;
    crate::agent_scan::probe_version(&resolved)
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

    // 每天最多一次的本机 Agent 检测：缓存过期才在后台扫，避免阻塞启动和
    // 前端首帧。completed 后通过 `agent://scan` 推给设置页 / 配置页。
    let scan_core = core.clone();
    std::thread::Builder::new()
        .name("agent-scan".to_string())
        .spawn(move || {
            let fresh = scan_core
                .scan_snapshot()
                .map(|snapshot| snapshot.fresh())
                .unwrap_or(false);
            if !fresh {
                scan_core.ensure_scan(false);
            }
        })
        .map_err(|error| tracing::warn!(%error, "failed to spawn agent scan thread"))
        .ok();

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

/// Blocks TAPD comment/status writes from the local agent while its worktree
/// still has files changed by this run. This enforces "commit first, then write
/// back" even if the model ignores the prompt. Unrelated dirty files recorded
/// in `baseline_dirty` are ignored.
pub async fn tapd_write_block_reason(app: &AppHandle, arguments: &Value) -> Option<String> {
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
        .workflow
        .lock()
        .ok()?
        .tasks()
        .iter()
        .rev()
        .find(|task| {
            task.spec.bug_id == bug_id
                && workspace_id.map_or(true, |workspace| task.spec.workspace_id == workspace)
                && matches!(
                    task.status,
                    WorkflowStatus::Running | WorkflowStatus::Merging
                )
        })
        .cloned()
        .and_then(|task| workflow_bridge::from_workflow_task(&task).ok())?;

    // During the merge a worktree fix is not yet in the main repository: block
    // TAPD write-back until the branch is actually an ancestor of HEAD.
    if task.status == TaskStatus::Merging {
        let branch = task
            .worktree_branch
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .unwrap_or("")
            .to_string();
        let repo = task.repo_path.clone();
        let merged = tokio::task::spawn_blocking(move || branch_merged(&repo, &branch)).await;
        return match merged {
            Ok(Ok(true)) => None,
            _ => Some("合并尚未完成，请先完成合并再更新 TAPD".to_string()),
        };
    }

    if task.work_dir().trim().is_empty() {
        return None;
    }

    let work_dir = task.work_dir().to_string();
    let baseline = task.baseline_dirty.clone();
    let pending = tokio::task::spawn_blocking(move || {
        uncommitted_files(&work_dir).map(|files| {
            files
                .into_iter()
                .filter(|file| !baseline.contains(file))
                .collect::<Vec<_>>()
        })
    })
    .await;
    let pending = match pending {
        Ok(Ok(pending)) => pending,
        Ok(Err(error)) => return Some(format!("无法检查未提交改动，已阻止写回：{error}")),
        Err(error) => return Some(format!("无法检查未提交改动，已阻止写回：{error}")),
    };
    if pending.is_empty() {
        return None;
    }
    Some(format!(
        "Agent 任务尚未提交（{} 个文件有未提交改动），请先 git commit，再评论或更新 TAPD 状态",
        pending.len()
    ))
}

pub async fn command(
    app: &AppHandle,
    state: &SharedState,
    name: &str,
    payload: Value,
) -> Result<Value, String> {
    let registered = app
        .try_state::<Arc<AgentCore>>()
        .ok_or_else(|| "Agent 模块尚未初始化".to_string())?;
    let core = registered.inner().clone();

    match name {
        "agent_runtimes" => Ok(json!({ "runtimes": runtime_catalog() })),
        "agent_config_get" => {
            let config = core.config_snapshot();
            Ok(json!({ "config": config }))
        }
        "agent_config_set" => {
            let patch: AgentConfigPatch = serde_json::from_value(payload)
                .map_err(|error| format!("无效的 Agent 配置：{error}"))?;
            let config = core.update_config(patch).await?;
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
        // Entering the system (valid login + onboarding done) initializes the
        // workflow exactly once and reports what startup recovery changed.
        "agent_enter_system" => Ok(json!({ "report": core.enter_system().await? })),
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
            if core.workflow_view(task_id).is_none() {
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
            core.delete_task(request.task_id.trim()).await?;
            Ok(json!({ "deleted": true }))
        }
        "agent_review_approve" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的审核参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task = core.approve_review(request.task_id.trim()).await?;
            Ok(json!({ "task": task }))
        }
        "agent_merge_start" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的合并参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let core = core.clone();
            let result = core.start_merge(request.task_id.trim()).await?;
            Ok(json!({
                "mode": result.mode,
                "task": result.task,
                "instructions": result.instructions,
            }))
        }
        "agent_merge_verify" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的合并参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task = core.verify_merge(request.task_id.trim()).await?;
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
        "agent_queue_resume" => Ok(json!(core.resume_queue().await)),
        "agent_review_diff" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的差异参数：{error}"))?;
            if request.task_id.trim().is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let task_id = request.task_id.trim().to_string();
            let core = core.clone();
            let diff = tokio::task::spawn_blocking(move || core.review_diff(&task_id))
                .await
                .map_err(|error| format!("读取差异失败：{error}"))??;
            Ok(json!({ "diff": diff }))
        }
        "agent_open_terminal" => {
            let request: TaskIdRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的终端参数：{error}"))?;
            let core = core.clone();
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
        "agent_chat" => {
            let request: ChatRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的对话参数：{error}"))?;
            let task_id = request.task_id.trim().to_string();
            if task_id.is_empty() {
                return Err("缺少 taskId".to_string());
            }
            let known = request
                .fingerprint
                .filter(|fingerprint| !fingerprint.is_empty());
            // transcript 是同步文件 / SQLite 读取，放到阻塞线程池避免卡住 UI 命令。
            let core = core.clone();
            let payload =
                tokio::task::spawn_blocking(move || core.chat_payload(&task_id, known.as_deref()))
                    .await
                    .map_err(|error| format!("读取对话失败：{error}"))?;
            Ok(json!(payload))
        }
        "agent_send_message" => {
            let request: SendMessageRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的消息参数：{error}"))?;
            core.send_message(request.task_id.trim(), &request.text)?;
            Ok(json!({ "sent": true }))
        }
        "agent_prompt_answer" => {
            let request: PromptAnswerRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的回答参数：{error}"))?;
            let message = core
                .prompt_answer(
                    request.task_id.trim(),
                    request.prompt_id.trim(),
                    request.option_id.trim(),
                )
                .await?;
            Ok(json!({ "sent": true, "message": message }))
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
        "agent_scan" => {
            let request: ScanRequest = serde_json::from_value(payload).unwrap_or_default();
            let core = core.clone();
            let snapshot = tokio::task::spawn_blocking(move || core.ensure_scan(request.force))
                .await
                .map_err(|error| format!("Agent 检测失败：{error}"))?;
            Ok(json!(snapshot))
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

    fn sample_task(id: &str, status: TaskStatus) -> AgentTask {
        AgentTask {
            id: id.to_string(),
            workspace_id: "45336192".to_string(),
            workspace_name: "UU".to_string(),
            bug_id: "1145336192001234567".to_string(),
            title: "示例缺陷".to_string(),
            severity: "严重".to_string(),
            priority: "高".to_string(),
            json_path: "/tmp/bug.json".to_string(),
            repo_path: "/tmp/repo".to_string(),
            worktree_path: None,
            worktree_branch: None,
            status,
            created_at: "2026-11-10T00:00:00Z".to_string(),
            started_at: None,
            finished_at: None,
            exit_code: None,
            error: None,
            prompt: "prompt".to_string(),
            source: "manual".to_string(),
            runtime_id: DEFAULT_RUNTIME_ID.to_string(),
            model: String::new(),
            permission_mode: String::new(),
            agent_session_id: None,
            approval: None,
            merge: None,
            commit_only: false,
            baseline_dirty: Vec::new(),
            baseline_head: None,
            extra_prompt: String::new(),
            attachments: Vec::new(),
            attempt: 0,
            interrupted: false,
            changes: None,
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
        assert!(!config.worktree_enabled);
        assert_eq!(config.execution_units, 2);
        assert!(config.restore_queued_tasks);
        assert_eq!(config.effective_execution_units(), 1);
        assert!(config.prompt_template.contains("{{json_path}}"));
        assert!(config.prompt_template.contains("{{title}}"));
        assert!(config.prompt_template.contains("{{coworker}}"));
        assert!(!config.prompt_template.contains("{{project_rule}}"));
    }

    #[test]
    fn templates_referencing_removed_contract_reset() {
        for marker in [
            "{{md_path}}",
            "{{project_rule}}",
            "tapd_request_review",
            "agent_task_report",
            "tapd_claim_bug",
            "tapd_release_bug",
            "tapd_export_bug_md",
        ] {
            let config = AgentConfig {
                prompt_template: format!("旧模板 {marker}"),
                ..AgentConfig::default()
            }
            .sanitized();
            assert_eq!(config.prompt_template, DEFAULT_PROMPT_TEMPLATE, "{marker}");
        }

        let custom = AgentConfig {
            prompt_template: "自定义 {{title}} / {{json_path}}".to_string(),
            ..AgentConfig::default()
        }
        .sanitized();
        assert_eq!(custom.prompt_template, "自定义 {{title}} / {{json_path}}");
    }

    #[test]
    fn config_patch_updates_restore_queued_tasks() {
        let mut config = AgentConfig::default();
        assert!(config.restore_queued_tasks);

        AgentConfigPatch {
            restore_queued_tasks: Some(false),
            ..AgentConfigPatch::default()
        }
        .apply(&mut config);
        assert!(!config.restore_queued_tasks);

        // An omitted field keeps the current value.
        AgentConfigPatch {
            execution_units: Some(3),
            ..AgentConfigPatch::default()
        }
        .apply(&mut config);
        assert!(!config.restore_queued_tasks);
        assert_eq!(config.execution_units, 3);
    }

    #[test]
    fn legacy_config_json_defaults_restore_queued_tasks_to_true() {
        let legacy: AgentConfig =
            serde_json::from_str(r#"{"worktreeEnabled":true,"executionUnits":3}"#)
                .expect("legacy config loads");
        assert!(legacy.restore_queued_tasks);
        assert!(legacy.worktree_enabled);
        assert_eq!(legacy.execution_units, 3);

        let explicit: AgentConfig =
            serde_json::from_str(r#"{"restoreQueuedTasks":false}"#).expect("explicit config loads");
        assert!(!explicit.restore_queued_tasks);
    }

    #[test]
    fn bridge_maps_restore_queued_tasks_into_the_recovery_policy() {
        let mapped = workflow_bridge::workflow_config(&AgentConfig::default());
        assert!(mapped.recovery_policy.restore_queued);

        let config = AgentConfig {
            restore_queued_tasks: false,
            worktree_enabled: true,
            execution_units: 4,
            ..AgentConfig::default()
        };
        let mapped = workflow_bridge::workflow_config(&config);
        assert!(!mapped.recovery_policy.restore_queued);
        assert!(mapped.worktree_enabled);
        assert_eq!(mapped.execution_units, 4);
        // Unrelated recovery fields stay at the crate defaults.
        assert!(mapped.recovery_policy.auto_retry_interrupted);
        assert_eq!(
            mapped.recovery_policy.max_auto_retry,
            tapd_workflow::DEFAULT_MAX_AUTO_RETRY
        );
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
            worktree_enabled: true,
            execution_units: 99,
            restore_queued_tasks: true,
            runtime_options: BTreeMap::new(),
        }
        .sanitized();

        assert_eq!(config.binary_path, "opencode");
        assert_eq!(config.runtime_id, "opencode");
        assert_eq!(config.execution_units, 8);
        assert_eq!(config.effective_execution_units(), 8);
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
    fn execution_units_are_clamped_and_disabled_means_serial() {
        let mut config = AgentConfig {
            worktree_enabled: true,
            execution_units: 0,
            ..AgentConfig::default()
        }
        .sanitized();
        assert_eq!(config.execution_units, 1);
        assert_eq!(config.effective_execution_units(), 1);

        config.execution_units = 3;
        assert_eq!(config.effective_execution_units(), 3);

        // Without isolation every task shares one checkout, so it stays serial
        // even if the stored unit count is higher.
        config.worktree_enabled = false;
        assert_eq!(config.effective_execution_units(), 1);
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
            "awaiting_merge",
            "merging",
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
            assert!(
                !runtime.limitations.is_empty(),
                "{} limitations",
                runtime.id
            );
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
    fn catalog_ids_are_unique_and_include_the_extended_agents() {
        let catalog = runtime_catalog();
        let mut ids = HashSet::new();
        for runtime in &catalog {
            assert!(
                ids.insert(runtime.id),
                "duplicate runtime id {}",
                runtime.id
            );
            assert!(
                !runtime.aliases.contains(&runtime.binary),
                "{} lists its own binary as an alias",
                runtime.id
            );
        }
        for expected in [
            "opencode2",
            "grok",
            "hermes",
            "kiro",
            "qoder",
            "qoder-cn",
            "rovo",
            "droid",
            "jcode",
            "custom",
        ] {
            assert!(ids.contains(expected), "missing runtime {expected}");
        }
    }

    #[test]
    fn argv_separator_only_applies_to_argv_injection() {
        for runtime in runtime_catalog() {
            if runtime.argv_separator.is_some() {
                assert_eq!(
                    runtime.prompt_injection,
                    PromptInjection::Argv,
                    "{} declares a separator without argv injection",
                    runtime.id
                );
            }
        }
    }

    #[test]
    fn hook_payload_session_ids_cover_supported_clients() {
        assert_eq!(
            extract_hook_session_id(&json!({ "session_id": "claude-1" })),
            Some("claude-1".to_string())
        );
        assert_eq!(
            extract_hook_session_id(&json!({ "conversation_id": "cursor-1" })),
            Some("cursor-1".to_string())
        );
        assert_eq!(
            extract_hook_session_id(&json!({ "session": { "id": "nested-1" } })),
            Some("nested-1".to_string())
        );
        assert_eq!(
            extract_hook_session_id(&json!({ "session_id": "   " })),
            None
        );
        assert_eq!(
            extract_hook_session_id(&json!({ "properties": { "sessionID": "child" } })),
            None
        );
        assert_eq!(extract_hook_session_id(&json!("bad")), None);
        // ZCode 模板变量未展开时不能当作 session id。
        assert_eq!(
            extract_hook_session_id(&json!({ "session_id": "${CLAUDE_SESSION_ID}" })),
            None
        );
        assert!(!valid_session_id(""));
        assert!(valid_session_id("01a1ce52-93ab-756a-8e95-233cb9643e75"));
    }

    #[test]
    fn runtime_options_map_to_cli_flags() {
        assert_eq!(
            runtime_launch_options("claude", "sonnet", "accept_edits"),
            vec!["--model", "sonnet", "--permission-mode", "acceptEdits"]
        );
        assert_eq!(
            runtime_launch_options("claude", "", "full_access"),
            vec!["--permission-mode", "bypassPermissions"]
        );
        assert_eq!(
            runtime_launch_options("codex", "gpt-5-codex", "full_auto"),
            vec!["--model", "gpt-5-codex", "--full-auto"]
        );
        assert_eq!(
            runtime_launch_options("opencode", "opencode-go/x", "auto"),
            vec!["--model", "opencode-go/x", "--auto"]
        );
        assert_eq!(
            runtime_launch_options("omp", "glm-5.2", "full_access"),
            vec!["--model", "glm-5.2", "--approval-mode", "yolo"]
        );
        // 未知运行时 / 权限不追加参数，交给 CLI 默认值。
        assert!(runtime_launch_options("unknown", "m", "full_access").is_empty());
        assert!(runtime_launch_options("claude", "", "default").is_empty());
    }

    #[test]
    fn resume_args_prefer_the_captured_session() {
        assert_eq!(resume_args("opencode", None), vec!["--continue"]);
        assert_eq!(resume_args("omp", None), vec!["--continue"]);
        assert_eq!(
            resume_args("omp", Some("01a1ce52-93ab-756a-8e95-233cb9643e75")),
            vec!["--resume", "01a1ce52-93ab-756a-8e95-233cb9643e75"]
        );
        assert_eq!(
            resume_args("kimi", Some("abc123")),
            vec!["--session", "abc123"]
        );
        assert_eq!(resume_args("kimi", None), vec!["--continue"]);
        assert_eq!(
            resume_args("opencode", Some("ses_123")),
            vec!["--session", "ses_123"]
        );
        assert_eq!(
            resume_args("claude", Some("claude-session")),
            vec!["--resume", "claude-session"]
        );
        assert_eq!(
            resume_args("codex", Some("codex-session")),
            vec!["resume", "codex-session"]
        );
        assert_eq!(resume_args("codex", None), vec!["resume"]);
        assert_eq!(
            resume_args("cursor", Some("cursor-chat")),
            vec!["--resume", "cursor-chat"]
        );
        assert_eq!(resume_args("qwen", None), vec!["--continue"]);
        assert_eq!(resume_args("gemini", None), vec!["--resume", "latest"]);
        assert_eq!(
            resume_args("gemini", Some("gemini-session")),
            vec!["--resume", "gemini-session"]
        );
        // 空白 id 不能变成空的 --resume 参数。
        assert_eq!(resume_args("omp", Some("  ")), vec!["--continue"]);
        assert!(resume_args("unknown", None).is_empty());
    }

    #[test]
    fn session_hook_runtimes_match_the_installed_hooks() {
        // 这些运行时都有可写的原生 hook/插件；新增 hook 时同步更新断言。
        let expected = [
            "opencode",
            "claude",
            "codex",
            "cursor",
            "zcode",
            "gemini",
            "qwen",
            "kimi",
            "omp",
            "openclaude",
            "qoder",
            "qoder-cn",
            "codebuddy",
        ];
        for runtime in runtime_catalog() {
            assert_eq!(
                runtime.session_hook,
                expected.contains(&runtime.id),
                "{} session hook flag",
                runtime.id
            );
        }
    }

    #[test]
    fn per_task_runtime_prefers_the_detected_path() {
        let mut config = AgentConfig::default();
        let scan = crate::agent_scan::AgentScanSnapshot {
            checked_at: String::new(),
            results: vec![crate::agent_scan::AgentScanResult {
                runtime_id: "claude".to_string(),
                name: "Claude Code".to_string(),
                binary: "claude".to_string(),
                resolved_path: Some("/opt/bin/claude".to_string()),
                version: None,
                found: true,
                error: None,
            }],
        };

        // 非默认运行时：优先用检测到的绝对路径，避免依赖全局 binaryPath。
        assert_eq!(
            binary_for_task(&config, "claude", Some(&scan)),
            "/opt/bin/claude"
        );
        // 没有检测结果时退回描述符里的默认命令。
        assert_eq!(binary_for_task(&config, "claude", None), "claude");
        // 默认运行时仍以用户配置的路径为准。
        config.runtime_id = "claude".to_string();
        config.binary_path = "/custom/claude".to_string();
        assert_eq!(
            binary_for_task(&config, "claude", Some(&scan)),
            "/custom/claude"
        );
    }

    #[test]
    fn renders_prompt_placeholders() {
        let vars = PromptVars {
            task_id: "task-42".to_string(),
            title: "标题".to_string(),
            json_path: "/exports/bug.json".to_string(),
            repo_path: "/repo".to_string(),
            workspace_name: "UU".to_string(),
            bug_id: "42".to_string(),
            severity: "严重".to_string(),
            priority: "高".to_string(),
            user_prompt: String::new(),
            attachments: Vec::new(),
            coworker: String::new(),
        };

        let rendered = render_prompt(
            "{{title}}|{{json_path}}|{{repo_path}}|{{workspace_name}}|{{bug_id}}|{{severity}}|{{priority}}|{{unknown}}",
            &vars,
        );
        assert_eq!(
            rendered,
            "标题|/exports/bug.json|/repo|UU|42|严重|高|{{unknown}}"
        );
    }

    #[test]
    fn project_rule_placeholder_is_left_intact() {
        // 旧自定义模板里的 {{project_rule}} 不再有取值；原样保留而不是报错。
        let vars = PromptVars {
            task_id: "task-1".to_string(),
            title: "t".to_string(),
            json_path: "j".to_string(),
            repo_path: "r".to_string(),
            workspace_name: "w".to_string(),
            bug_id: "1".to_string(),
            severity: "s".to_string(),
            priority: "p".to_string(),
            user_prompt: String::new(),
            attachments: Vec::new(),
            coworker: String::new(),
        };

        assert_eq!(
            render_prompt("规则：{{project_rule}}", &vars),
            "规则：{{project_rule}}"
        );
    }

    #[test]
    fn compose_sections_append_when_template_has_no_slot() {
        let vars = PromptVars {
            task_id: "task-1".to_string(),
            title: "t".to_string(),
            json_path: "j".to_string(),
            repo_path: "r".to_string(),
            workspace_name: "w".to_string(),
            bug_id: "1".to_string(),
            severity: "s".to_string(),
            priority: "p".to_string(),
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
            json_path: "j".to_string(),
            repo_path: "r".to_string(),
            workspace_name: "w".to_string(),
            bug_id: "1".to_string(),
            severity: "s".to_string(),
            priority: "p".to_string(),
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
            json_path: "j".to_string(),
            repo_path: "r".to_string(),
            workspace_name: "w".to_string(),
            bug_id: "1".to_string(),
            severity: "s".to_string(),
            priority: "p".to_string(),
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
    fn statuses_serialize_as_snake_case() {
        let cases = [
            (TaskStatus::Queued, "\"queued\""),
            (TaskStatus::Preparing, "\"preparing\""),
            (TaskStatus::Running, "\"running\""),
            (TaskStatus::AwaitingApproval, "\"awaiting_approval\""),
            (TaskStatus::AwaitingMerge, "\"awaiting_merge\""),
            (TaskStatus::Merging, "\"merging\""),
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
        for key in [
            "approval",
            "merge",
            "commitOnly",
            "baselineDirty",
            "baselineHead",
            "worktreePath",
            "worktreeBranch",
            "attempt",
            "interrupted",
            "changes",
        ] {
            object.remove(key);
        }
        let parsed: AgentTask = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.approval, None);
        assert_eq!(parsed.merge, None);
        assert!(!parsed.commit_only);
        assert!(parsed.baseline_dirty.is_empty());
        assert_eq!(parsed.baseline_head, None);
        assert_eq!(parsed.worktree_path, None);
        assert_eq!(parsed.worktree_branch, None);
        // Records written before the workflow bridge existed still load.
        assert_eq!(parsed.attempt, 0);
        assert!(!parsed.interrupted);
        assert_eq!(parsed.changes, None);

        // 旧记录只有 mdPath：没有迁移链，字段为空但任务仍要能读出来。
        let mut legacy = serde_json::to_value(sample_task("b", TaskStatus::Succeeded)).unwrap();
        let object = legacy.as_object_mut().unwrap();
        object.remove("jsonPath");
        object.insert("mdPath".to_string(), json!("/exports/bug.md"));
        let parsed: AgentTask = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.json_path, "");
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
    fn work_dir_prefers_the_worktree_and_ignores_blanks() {
        let mut task = sample_task("a", TaskStatus::Running);
        task.repo_path = "/repo".to_string();
        assert_eq!(task.work_dir(), "/repo");

        // An empty/whitespace path must not become the PTY cwd.
        task.worktree_path = Some("   ".to_string());
        assert_eq!(task.work_dir(), "/repo");

        task.worktree_path = Some("/data/worktrees/ws/a".to_string());
        assert_eq!(task.work_dir(), "/data/worktrees/ws/a");
    }

    #[test]
    fn worktree_fields_serialize_camel_case_and_skip_none() {
        let mut task = sample_task("a", TaskStatus::Running);
        let value = serde_json::to_value(&task).unwrap();
        assert!(value.get("worktreePath").is_none());
        assert!(value.get("worktreeBranch").is_none());

        task.worktree_path = Some("/w".to_string());
        task.worktree_branch = Some("tapd/01234567-abcdef01".to_string());
        let value = serde_json::to_value(&task).unwrap();
        assert_eq!(value["worktreePath"], "/w");
        assert_eq!(value["worktreeBranch"], "tapd/01234567-abcdef01");

        let parsed: AgentTask = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.worktree_path.as_deref(), Some("/w"));
        assert_eq!(
            parsed.worktree_branch.as_deref(),
            Some("tapd/01234567-abcdef01")
        );
    }

    #[test]
    fn merge_field_serializes_camel_case_and_defaults() {
        let mut task = sample_task("a", TaskStatus::AwaitingMerge);
        assert!(serde_json::to_value(&task).unwrap().get("merge").is_none());

        task.merge = Some(TaskMerge {
            error: Some("主仓库有未提交改动".to_string()),
            instructions: Some("手动合并步骤".to_string()),
            started_at: Some("2026-11-10T01:00:00Z".to_string()),
            finished_at: None,
        });
        let value = serde_json::to_value(&task).unwrap();
        assert_eq!(value["merge"]["error"], "主仓库有未提交改动");
        assert_eq!(value["merge"]["instructions"], "手动合并步骤");
        assert_eq!(value["merge"]["startedAt"], "2026-11-10T01:00:00Z");
        assert!(value["merge"].get("finishedAt").is_none());

        let parsed: AgentTask = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.merge, task.merge);

        // Old records without `merge` still load.
        let mut legacy =
            serde_json::to_value(&sample_task("b", TaskStatus::AwaitingMerge)).unwrap();
        legacy.as_object_mut().unwrap().remove("merge");
        let parsed: AgentTask = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.merge, None);
    }

    #[test]
    fn manual_merge_steps_include_repo_and_branch() {
        let steps = manual_merge_instructions("/repo", "tapd/01234567-abcdef01");
        assert!(steps.contains("cd \"/repo\""), "{steps}");
        assert!(
            steps.contains("git merge \"tapd/01234567-abcdef01\""),
            "{steps}"
        );
        assert!(steps.contains("TAPD"), "{steps}");
        assert!(steps.contains("我已手动合并"), "{steps}");

        let prompt = merge_prompt("/repo", "tapd/01234567-abcdef01");
        assert!(prompt.contains("仓库：/repo"));
        assert!(prompt.contains("分支：tapd/01234567-abcdef01"));
        assert!(prompt.contains("tapd_update_bug_status"));
        assert!(!prompt.contains("{{"));
    }

    #[test]
    fn bridge_roundtrips_a_task_record() {
        let mut task = sample_task("task-1", TaskStatus::Running);
        task.attempt = 2;
        task.interrupted = true;
        task.changes = Some(tapd_workflow::ChangeSet {
            files: vec!["src/a.rs".to_string()],
            dirty: true,
            committed: false,
        });

        let workflow = workflow_bridge::to_workflow_task(&task).expect("to core");
        assert_eq!(workflow.id.as_str(), "task-1");
        assert_eq!(workflow.status, tapd_workflow::TaskStatus::Running);
        assert_eq!(workflow.attempt, 2);
        assert!(workflow.interrupted);

        let back = workflow_bridge::from_workflow_task(&workflow).expect("from core");
        assert_eq!(back, task);
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
        assert!(
            script.contains(r#"cd '/tmp/it'\''s repo' || exit 1"#),
            "{script}"
        );
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
    const NOW: &str = "2026-11-10T01:00:00Z";

    fn workflow_snapshot(tasks: Vec<AgentTask>, config: &AgentConfig, paused: bool) -> Snapshot {
        Snapshot {
            schema_version: tapd_workflow::SCHEMA_VERSION,
            config: workflow_bridge::workflow_config(config),
            paused,
            tasks: tasks
                .iter()
                .map(|task| workflow_bridge::to_workflow_task(task).expect("core task"))
                .collect(),
            generation: 0,
        }
    }

    /// Enters the workflow and loads a snapshot, mirroring `enter_system`.
    fn boot(tasks: Vec<AgentTask>, config: &AgentConfig) -> (Workflow, Vec<Effect>) {
        let mut workflow = Workflow::with_config(workflow_bridge::workflow_config(config));
        let effects = workflow.apply(Input::SystemEntered {
            now: NOW.to_string(),
        });
        assert!(
            effects
                .iter()
                .any(|effect| matches!(effect, Effect::LoadSnapshot)),
            "system entry must ask for the snapshot"
        );
        let effects = workflow.apply(Input::SnapshotLoaded {
            snapshot: workflow_snapshot(tasks, config, false),
        });
        (workflow, effects)
    }

    fn status_of(workflow: &Workflow, task_id: &str) -> Option<WorkflowStatus> {
        workflow.task(&TaskId::new(task_id)).map(|task| task.status)
    }

    fn persisted_status(effects: &[Effect], task_id: &str) -> Option<WorkflowStatus> {
        effects.iter().find_map(|effect| match effect {
            Effect::PersistChanged { tasks } => tasks
                .iter()
                .find(|task| task.id.as_str() == task_id)
                .map(|task| task.status),
            _ => None,
        })
    }

    #[test]
    fn enter_system_applies_recovery_rules() {
        let config = AgentConfig {
            // Restored queue stays parked until the user resumes it, so the
            // recovery statuses are observable without the scheduler starting.
            restore_queued_tasks: false,
            ..AgentConfig::default()
        };
        let tasks = vec![
            sample_task("queued", TaskStatus::Queued),
            sample_task("running", TaskStatus::Running),
            sample_task("merge", TaskStatus::Merging),
            sample_task("done", TaskStatus::Succeeded),
        ];
        let (workflow, effects) = boot(tasks, &config);

        assert!(workflow.paused(), "restore_queued=false parks the queue");
        assert_eq!(status_of(&workflow, "queued"), Some(WorkflowStatus::Queued));
        assert_eq!(
            status_of(&workflow, "running"),
            Some(WorkflowStatus::Queued)
        );
        assert_eq!(
            status_of(&workflow, "merge"),
            Some(WorkflowStatus::AwaitingMerge)
        );
        assert_eq!(
            status_of(&workflow, "done"),
            Some(WorkflowStatus::Succeeded)
        );

        let running = workflow.task(&TaskId::new("running")).expect("running");
        assert!(running.interrupted);
        assert_eq!(running.attempt, 1);
        assert!(running.error.is_none());
        let merged = workflow.task(&TaskId::new("merge")).expect("merge");
        assert_eq!(
            merged
                .merge
                .as_ref()
                .and_then(|merge| merge.error.as_deref()),
            Some(tapd_workflow::recovery::RESTARTED_MERGE_ERROR)
        );

        let report = workflow.recovery_report().expect("report");
        assert!(report.queue_paused);
        assert_eq!(report.queued, 1);
        assert_eq!(report.retried, 1);
        assert_eq!(report.awaiting_merge, 1);
        assert!(!effects
            .iter()
            .any(|effect| matches!(effect, Effect::StartFixAgent { .. })));
    }

    #[test]
    fn enter_system_schedules_the_restored_queue() {
        let config = AgentConfig::default();
        let (workflow, effects) = boot(vec![sample_task("queued", TaskStatus::Queued)], &config);
        assert!(!workflow.paused());
        assert_eq!(
            status_of(&workflow, "queued"),
            Some(WorkflowStatus::Preparing)
        );
        assert!(effects
            .iter()
            .any(|effect| matches!(effect, Effect::StartFixAgent { .. })));
    }

    #[test]
    fn system_entry_is_idempotent() {
        let (mut workflow, _) = boot(Vec::new(), &AgentConfig::default());
        let again = workflow.apply(Input::SystemEntered {
            now: NOW.to_string(),
        });
        assert!(again.is_empty());
        // Snapshots arriving after the first load are ignored.
        let ignored = workflow.apply(Input::SnapshotLoaded {
            snapshot: workflow_snapshot(Vec::new(), &AgentConfig::default(), false),
        });
        assert!(ignored.is_empty());
    }

    #[test]
    fn worktree_receipt_starts_the_fix_agent() {
        let config = AgentConfig {
            worktree_enabled: true,
            ..AgentConfig::default()
        };
        let (mut workflow, effects) = boot(vec![sample_task("t1", TaskStatus::Queued)], &config);
        let created = effects
            .iter()
            .find_map(|effect| match effect {
                Effect::CreateWorktree { task_id, .. } => Some(task_id.clone()),
                _ => None,
            })
            .expect("create worktree effect");
        assert_eq!(created.as_str(), "t1");

        let effects = workflow.apply(Input::WorktreeCreated {
            task_id: created.clone(),
            worktree: tapd_workflow::WorktreeRef {
                path: "/tmp/wt".to_string(),
                branch: "tapd/01234567-task0001".to_string(),
            },
        });
        let cwd = effects
            .iter()
            .find_map(|effect| match effect {
                Effect::StartFixAgent { cwd, .. } => Some(cwd.clone()),
                _ => None,
            })
            .expect("start fix effect");
        assert_eq!(cwd, "/tmp/wt");

        let effects = workflow.apply(Input::TaskPrepared {
            task_id: created.clone(),
            prompt: "prompt".to_string(),
            json_path: "/tmp/bug.json".to_string(),
            baseline_dirty: vec!["user.txt".to_string()],
            baseline_head: None,
        });
        assert_eq!(
            persisted_status(&effects, "t1"),
            Some(WorkflowStatus::Preparing)
        );
        let effects = workflow.apply(Input::AgentStarted {
            task_id: created.clone(),
        });
        assert_eq!(
            persisted_status(&effects, "t1"),
            Some(WorkflowStatus::Running)
        );
        let task = workflow.task(&created).expect("task");
        assert_eq!(task.prompt, "prompt");
        assert_eq!(task.json_path, "/tmp/bug.json");
        assert_eq!(task.baseline_dirty, vec!["user.txt".to_string()]);
    }

    #[test]
    fn runtime_display_name_uses_the_catalog_label() {
        assert_eq!(super::runtime_display_name("claude"), "Claude Code");
        // Unknown ids stay visible instead of disappearing from the capsule.
        assert_eq!(
            super::runtime_display_name(" custom-agent "),
            "custom-agent"
        );
    }

    #[test]
    fn enqueue_spec_falls_back_to_the_configured_runtime() {
        let config = AgentConfig {
            runtime_id: "claude".to_string(),
            projects: BTreeMap::from([(
                "45336192".to_string(),
                ProjectAgentConfig {
                    repo_path: "/configured/repo".to_string(),
                    rule: String::new(),
                },
            )]),
            ..AgentConfig::default()
        };
        let request = EnqueueRequest {
            workspace_id: " 45336192 ".to_string(),
            bug_id: " 42 ".to_string(),
            workspace_name: None,
            title: None,
            severity: Some(" 严重 ".to_string()),
            priority: Some(" 高 ".to_string()),
            source: Some("notification".to_string()),
            extra_prompt: Some("  只改登录页  ".to_string()),
            attachments: Some(vec![
                " /tmp/a.png ".to_string(),
                "/tmp/a.png".to_string(),
                "   ".to_string(),
            ]),
            runtime_id: Some("not-a-runtime".to_string()),
            model: None,
            permission_mode: None,
        };
        let spec = task_spec_from_request(&request, &config, "manual").expect("spec");
        assert_eq!(spec.workspace_id, "45336192");
        assert_eq!(spec.bug_id, "42");
        assert_eq!(spec.workspace_name, "45336192");
        assert_eq!(spec.title, "缺陷 42");
        assert_eq!(spec.severity, "严重");
        assert_eq!(spec.priority, "高");
        assert_eq!(spec.runtime_id, "claude");
        assert_eq!(spec.repo_path, "/configured/repo");
        assert_eq!(spec.extra_prompt, "只改登录页");
        assert_eq!(spec.attachments, vec!["/tmp/a.png".to_string()]);

        let blank = EnqueueRequest {
            workspace_id: "  ".to_string(),
            ..request.clone()
        };
        assert!(task_spec_from_request(&blank, &config, "manual").is_err());

        // An explicit runtime wins over the configured default.
        let explicit = EnqueueRequest {
            runtime_id: Some("opencode".to_string()),
            ..request
        };
        assert_eq!(
            task_spec_from_request(&explicit, &config, "manual")
                .expect("spec")
                .runtime_id,
            "opencode"
        );
    }

    #[test]
    fn command_inputs_drive_the_workflow() {
        let config = AgentConfig::default();
        let (mut workflow, _) = boot(Vec::new(), &config);

        let spec = TaskSpec {
            workspace_id: "45336192".to_string(),
            bug_id: "1145336192001234567".to_string(),
            title: "示例缺陷".to_string(),
            repo_path: "/tmp/repo".to_string(),
            runtime_id: DEFAULT_RUNTIME_ID.to_string(),
            ..TaskSpec::default()
        };
        let effects = workflow.apply(Input::Enqueue {
            task_id: TaskId::new("t1"),
            spec: spec.clone(),
            now: NOW.to_string(),
        });
        assert_eq!(status_of(&workflow, "t1"), Some(WorkflowStatus::Preparing));
        assert!(effects
            .iter()
            .any(|effect| matches!(effect, Effect::StartFixAgent { .. })));

        // A duplicate bug is rejected by the core, not the host.
        let duplicate = workflow.apply(Input::Enqueue {
            task_id: TaskId::new("t2"),
            spec,
            now: NOW.to_string(),
        });
        assert!(duplicate
            .iter()
            .any(|effect| matches!(effect, Effect::Rejected { .. })));

        let effects = workflow.apply(Input::Cancel {
            task_id: TaskId::new("t1"),
            now: NOW.to_string(),
        });
        assert!(effects
            .iter()
            .any(|effect| matches!(effect, Effect::CancelAgent { .. })));
        assert_eq!(status_of(&workflow, "t1"), Some(WorkflowStatus::Canceled));

        workflow.apply(Input::Retry {
            task_id: TaskId::new("t1"),
            new_id: TaskId::new("t2"),
            now: NOW.to_string(),
        });
        assert!(workflow.task(&TaskId::new("t2")).is_some());
        assert_eq!(status_of(&workflow, "t2"), Some(WorkflowStatus::Preparing));
    }

    #[test]
    fn review_and_merge_inputs_move_the_task() {
        let config = AgentConfig {
            worktree_enabled: true,
            ..AgentConfig::default()
        };
        let mut review = sample_task("review", TaskStatus::AwaitingApproval);
        review.worktree_path = Some("/tmp/wt".to_string());
        review.worktree_branch = Some("tapd/01234567-task0001".to_string());
        review.changes = Some(tapd_workflow::ChangeSet {
            files: Vec::new(),
            dirty: false,
            committed: true,
        });
        let (mut workflow, _) = boot(vec![review], &config);

        let effects = workflow.apply(Input::ApproveReview {
            task_id: TaskId::new("review"),
            now: NOW.to_string(),
        });
        assert_eq!(
            status_of(&workflow, "review"),
            Some(WorkflowStatus::AwaitingMerge)
        );
        assert_eq!(
            persisted_status(&effects, "review"),
            Some(WorkflowStatus::AwaitingMerge)
        );

        let effects = workflow.apply(Input::StartMerge {
            task_id: TaskId::new("review"),
            now: NOW.to_string(),
        });
        let check_id = effects
            .iter()
            .find_map(|effect| match effect {
                Effect::CheckMergePreconditions { task_id, .. } => Some(task_id.clone()),
                _ => None,
            })
            .expect("precondition check");
        let effects = workflow.apply(Input::MergePreconditionsChecked {
            task_id: check_id,
            result: Ok(()),
        });
        assert_eq!(
            status_of(&workflow, "review"),
            Some(WorkflowStatus::Merging)
        );
        assert!(effects
            .iter()
            .any(|effect| matches!(effect, Effect::StartMergeAgent { .. })));

        let effects = workflow.apply(Input::MergeAgentFinished {
            task_id: TaskId::new("review"),
            outcome: tapd_workflow::RunOutcome::success(None),
            now: NOW.to_string(),
        });
        assert!(effects
            .iter()
            .any(|effect| matches!(effect, Effect::VerifyBranchMerged { .. })));
        let effects = workflow.apply(Input::BranchMergeVerified {
            task_id: TaskId::new("review"),
            merged: true,
            error: None,
        });
        assert_eq!(
            status_of(&workflow, "review"),
            Some(WorkflowStatus::Succeeded)
        );
        assert_eq!(
            effects
                .iter()
                .filter(|effect| matches!(effect, Effect::AppendHistory { .. }))
                .count(),
            1,
            "history must be appended exactly once"
        );
        assert!(effects
            .iter()
            .any(|effect| matches!(effect, Effect::RemoveWorktree { .. })));

        // Deleting the terminal task removes the record and its directory.
        let effects = workflow.apply(Input::DeleteTerminal {
            task_id: TaskId::new("review"),
        });
        assert!(workflow.task(&TaskId::new("review")).is_none());
        assert!(effects
            .iter()
            .any(|effect| matches!(effect, Effect::PersistDeleted { .. })));
        assert!(effects
            .iter()
            .any(|effect| matches!(effect, Effect::RemoveWorktree { .. })));
    }

    #[test]
    fn stopping_a_review_cancels_and_pauses_the_queue() {
        let mut review = sample_task("review", TaskStatus::AwaitingApproval);
        review.worktree_path = Some("/tmp/wt".to_string());
        review.worktree_branch = Some("tapd/1-2".to_string());
        let (mut workflow, _) = boot(vec![review], &AgentConfig::default());

        let effects = workflow.apply(Input::StopReview {
            task_id: TaskId::new("review"),
            now: NOW.to_string(),
            stash: Some("stash@{0}".to_string()),
            error: Some("已停止，改动已储藏：stash@{0}".to_string()),
        });
        assert_eq!(
            status_of(&workflow, "review"),
            Some(WorkflowStatus::Canceled)
        );
        assert!(workflow.paused());
        assert!(effects
            .iter()
            .any(|effect| matches!(effect, Effect::PersistPaused { paused: true })));
        let approval = workflow
            .task(&TaskId::new("review"))
            .and_then(|task| task.approval.clone())
            .expect("approval");
        assert_eq!(approval.stash.as_deref(), Some("stash@{0}"));
    }

    #[test]
    fn workflow_counts_and_active_task_track_reviews_and_merges() {
        let tasks = vec![
            sample_task("approval", TaskStatus::AwaitingApproval),
            sample_task("merge", TaskStatus::AwaitingMerge),
            sample_task("queued", TaskStatus::Queued),
            sample_task("done", TaskStatus::Succeeded),
        ];
        let (workflow, _) = boot(tasks, &AgentConfig::default());
        let counts = workflow.counts();
        assert_eq!(counts.awaiting_approval, 1);
        assert_eq!(counts.awaiting_merge, 1);
        assert_eq!(counts.queued, 1);
        assert_eq!(counts.active, 0);
        // A pending review outranks the merge decision and the queue.
        assert_eq!(
            workflow.active_task_id().map(|id| id.as_str()),
            Some("approval")
        );

        // Entering the system rolls an in-flight merge back to AwaitingMerge.
        let merging = vec![sample_task("merging", TaskStatus::Merging)];
        let (workflow, _) = boot(merging, &AgentConfig::default());
        assert_eq!(workflow.counts().active, 0);
        assert_eq!(
            workflow.active_task_id().map(|id| id.as_str()),
            Some("merging")
        );

        let done = vec![
            sample_task("old", TaskStatus::Failed),
            sample_task("new", TaskStatus::Succeeded),
        ];
        let (workflow, _) = boot(done, &AgentConfig::default());
        assert_eq!(workflow.active_task_id().map(|id| id.as_str()), Some("new"));
    }

    #[test]
    fn crate_status_keys_cover_merge_states() {
        for (status, expected) in [
            (WorkflowStatus::Queued, "queued"),
            (WorkflowStatus::Preparing, "preparing"),
            (WorkflowStatus::Running, "running"),
            (WorkflowStatus::AwaitingApproval, "awaiting_approval"),
            (WorkflowStatus::AwaitingMerge, "awaiting_merge"),
            (WorkflowStatus::Merging, "merging"),
            (WorkflowStatus::Succeeded, "succeeded"),
            (WorkflowStatus::Failed, "failed"),
            (WorkflowStatus::Canceled, "canceled"),
        ] {
            assert_eq!(tapd_workflow::status_key(status), expected);
        }
    }

    #[test]
    fn worktree_switch_lock_blocks_only_real_switches_with_live_tasks() {
        assert!(tapd_workflow::worktree_toggle_locked(false, true, true));
        assert!(tapd_workflow::worktree_toggle_locked(true, false, true));
        assert!(!tapd_workflow::worktree_toggle_locked(true, true, true));
        assert!(!tapd_workflow::worktree_toggle_locked(false, false, true));
        assert!(!tapd_workflow::worktree_toggle_locked(false, true, false));
        assert!(!tapd_workflow::worktree_toggle_locked(true, false, false));
    }

    #[test]
    fn suspend_parks_live_tasks_and_keeps_waiting_ones() {
        let tasks = vec![
            sample_task("running", TaskStatus::Running),
            sample_task("preparing", TaskStatus::Preparing),
            sample_task("merge", TaskStatus::Merging),
            sample_task("queued", TaskStatus::Queued),
            sample_task("review", TaskStatus::AwaitingApproval),
            sample_task("approved", TaskStatus::AwaitingMerge),
        ];
        let (mut workflow, _) = boot(tasks, &AgentConfig::default());
        let effects = workflow.apply(Input::Suspend {
            now: NOW.to_string(),
        });

        assert_eq!(
            status_of(&workflow, "running"),
            Some(WorkflowStatus::Queued)
        );
        assert_eq!(
            status_of(&workflow, "preparing"),
            Some(WorkflowStatus::Queued)
        );
        let running = workflow.task(&TaskId::new("running")).expect("running");
        assert!(running.interrupted);
        // Recovery already spent this attempt before the suspend.
        assert_eq!(running.attempt, 1);
        assert_eq!(
            status_of(&workflow, "merge"),
            Some(WorkflowStatus::AwaitingMerge)
        );
        assert_eq!(status_of(&workflow, "queued"), Some(WorkflowStatus::Queued));
        assert_eq!(
            status_of(&workflow, "review"),
            Some(WorkflowStatus::AwaitingApproval)
        );
        assert_eq!(
            status_of(&workflow, "approved"),
            Some(WorkflowStatus::AwaitingMerge)
        );
        // Shutdown reports the paused flag even if it did not change.
        assert!(effects
            .iter()
            .any(|effect| matches!(effect, Effect::PersistPaused { .. })));
        assert!(!workflow.entered());
    }

    #[test]
    fn terminal_runs_append_history_once_and_late_receipts_are_ignored() {
        let config = AgentConfig::default();
        let (mut workflow, _) = boot(vec![sample_task("t1", TaskStatus::Queued)], &config);
        workflow.apply(Input::TaskPrepared {
            task_id: TaskId::new("t1"),
            prompt: "p".to_string(),
            json_path: "/tmp/bug.json".to_string(),
            baseline_dirty: Vec::new(),
            baseline_head: None,
        });
        workflow.apply(Input::AgentStarted {
            task_id: TaskId::new("t1"),
        });
        let effects = workflow.apply(Input::RunFinished {
            task_id: TaskId::new("t1"),
            outcome: tapd_workflow::RunOutcome {
                canceled: false,
                success: true,
                error: None,
                changes: Some(tapd_workflow::ChangeSet {
                    files: vec!["src/a.rs".to_string()],
                    dirty: false,
                    committed: true,
                }),
                exit_code: Some(0),
            },
            now: NOW.to_string(),
        });
        assert_eq!(status_of(&workflow, "t1"), Some(WorkflowStatus::Succeeded));
        assert_eq!(
            effects
                .iter()
                .filter(|effect| matches!(effect, Effect::AppendHistory { .. }))
                .count(),
            1
        );

        // A late run receipt must not rewrite the terminal state.
        let late = workflow.apply(Input::RunFinished {
            task_id: TaskId::new("t1"),
            outcome: tapd_workflow::RunOutcome::failure("late", None),
            now: NOW.to_string(),
        });
        assert!(late.is_empty());
        assert_eq!(status_of(&workflow, "t1"), Some(WorkflowStatus::Succeeded));
    }
}
