import { featureCommand } from "./feature";

export type AgentTaskStatus =
  | "queued"
  | "preparing"
  | "running"
  | "awaiting_approval"
  | "awaiting_merge"
  | "merging"
  | "succeeded"
  | "failed"
  | "canceled";

/** Per-project agent settings, edited from the project card in settings. */
export type ProjectAgentConfig = {
  repoPath: string;
  rule: string;
};

export type AgentConfig = {
  /** Selected runtime id from the catalog. */
  runtimeId: string;
  binaryPath: string;
  /** Legacy: migrated into `projects` on load. */
  repoMappings: Record<string, string>;
  projects: Record<string, ProjectAgentConfig>;
  promptTemplate: string;
  /** Enabled coworker ids (selection order); managed from the 同事 page. */
  coworkerIds: string[];
  readyQuietMs: number;
  readyTimeoutMs: number;
  /** TUI 运行时输出静默多久视为本轮结束；0 表示只依赖进程退出/会话 hook。 */
  idleCompleteMs: number;
  /** 每个任务在独立 git worktree 中运行。 */
  worktreeEnabled: boolean;
  /** 开启 worktree 后的并行任务数；关闭时固定为 1。 */
  executionUnits: number;
};

/** A stage every runtime declares in its catalog entry. */
export type AgentLifecycleStage = {
  key: string;
  label: string;
  description: string;
  /** The serial queue stays blocked until a human acts. */
  needsHuman: boolean;
  terminal: boolean;
};

/**
 * What the desktop may assume about a runtime. Anything false must degrade to
 * "send the user to review" instead of pretending the external action worked.
 */
export type AgentRuntimeCapabilities = {
  interactiveTerminal: boolean;
  permissionPrompt: boolean;
  /** Desktop can answer a blocking prompt and the runtime accepts it. */
  externalDecision: boolean;
  commitReview: boolean;
};

export type AgentRuntimeDescriptor = {
  id: string;
  name: string;
  vendor: string;
  description: string;
  /** Default executable, used as the form placeholder. */
  binary: string;
  /** 仅用于安装检测的其他可执行名。 */
  aliases: string[];
  /** 启动参数（不含提示词）。 */
  args: string[];
  /** 提示词交付方式。 */
  promptInjection: "argv" | "flag" | "stdin";
  /** flag 模式下承载提示词的参数名。 */
  promptFlag?: string | null;
  /** argv 注入时提示词前的参数终止符（通常为 `--`）。 */
  argvSeparator?: string | null;
  /** 启动时加载会话监控 hook（OpenCode / Claude / Cursor / Gemini / Qwen / Kimi / ZCode / OMP 等）。 */
  sessionHook?: boolean;
  available: boolean;
  capabilities: AgentRuntimeCapabilities;
  lifecycle: AgentLifecycleStage[];
  limitations: string[];
  /** What the UI does when an external decision cannot be applied. */
  fallback: string;
};

/** One runtime's local install state, refreshed at most once a day. */
export type AgentScanResult = {
  runtimeId: string;
  name: string;
  /** Default command declared by the catalog. */
  binary: string;
  /** Absolute path resolved through the user's shell PATH. */
  resolvedPath?: string | null;
  /** First line of `--version`. */
  version?: string | null;
  found: boolean;
  /** Why the version probe failed even though the binary exists. */
  error?: string | null;
};

export type AgentScanSnapshot = {
  /** RFC3339; empty when the app has never scanned. */
  checkedAt: string;
  results: AgentScanResult[];
};

/** A complex change paused for the user's commit decision. */
export type AgentApproval = {
  summary: string;
  files: string[];
  risk?: string;
  requestedAt: string;
  approvedAt?: string;
  /** Stash reference recorded when the user stops instead of approving. */
  stash?: string;
};

export type AgentTask = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  bugId: string;
  title: string;
  severity: string;
  priority: string;
  jsonPath: string;
  repoPath: string;
  /** Absolute path of the task's git worktree, when worktree isolation is on. */
  worktreePath?: string;
  /** Branch created for the worktree; kept after the directory is cleaned. */
  worktreeBranch?: string;
  status: AgentTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  prompt: string;
  source: string;
  /** Runtime snapshotted at enqueue time. */
  runtimeId?: string;
  /** 会话 hook 捕获的运行时 session id，用于精确续接会话。 */
  agentSessionId?: string | null;
  /** Present while the task waits for the commit decision. */
  approval?: AgentApproval | null;
  /** Merge phase state: agent failure text, manual steps and timing. */
  merge?: AgentMerge | null;
  /** The next run is the post-approval commit phase. */
  commitOnly?: boolean;
  /** Markdown instructions from the compose sheet. */
  extraPrompt?: string;
  /** Local resource paths supplied with the task. */
  attachments?: string[];
};

/**
 * Worktree tasks merge back into the main repo after review. `instructions`
 * holds the manual steps written when the merge agent is unavailable.
 */
export type AgentMerge = {
  error?: string | null;
  instructions?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

/** 运行中 Agent 的状态，只存在于内存；任务结束后清空。 */
export type AgentRuntimePhase =
  | "idle"
  | "working"
  | "waiting_permission"
  | "waiting_question"
  | "error";

export type AgentRuntimeStatus = {
  phase: AgentRuntimePhase;
  /** 后端生成的中文摘要，例如「等待权限确认」。 */
  label: string;
  /** 当前工具名，例如 Bash / Edit。 */
  tool?: string;
  /** 工具参数、错误信息等短摘要。 */
  detail?: string;
  /** 最近的提示词、回复或通知。 */
  message?: string;
  model?: string;
  sessionId?: string;
  /** 正在运行的子 Agent 数量。 */
  subagents: number;
  updatedAt: string;
};

export type AgentTasksState = {
  tasks: AgentTask[];
  activeTaskId: string | null;
  queuedCount?: number;
  awaitingApprovalCount?: number;
  /** Worktree tasks that passed review and wait for the merge decision. */
  awaitingMergeCount?: number;
  /** Set after the user stopped a review; resume from the Agent tab. */
  queuePaused?: boolean;
  /** SQLite is unavailable; task state may not survive a restart. */
  storageError?: string | null;
  /** 运行中 Agent 的状态，key 是 task id。 */
  runtimeStatus?: Record<string, AgentRuntimeStatus>;
};

/** Paginated terminal-task history; filtering and paging run in Rust. */
export type AgentHistoryQuery = {
  workspaceId?: string;
  status?: AgentTaskStatus;
  keyword?: string;
  taskId?: string;
  offset?: number;
  limit?: number;
};

export type AgentWorkspaceRef = {
  id: string;
  name: string;
};

export type AgentTasksPage = {
  tasks: AgentTask[];
  total: number;
  hasMore: boolean;
  workspaces: AgentWorkspaceRef[];
};

/**
 * Counts of tasks restored by the backend when the user re-enters the system
 * (login + onboarding done). `null` means there was nothing to recover.
 */
export type RecoveryReport = {
  id: number;
  restoredAt: string;
  queued: number;
  retried: number;
  awaitingApproval: number;
  awaitingMerge: number;
  failed: number;
};

/** Lightweight agent state for the island capsule. */
export type AgentSummary = {
  running: boolean;
  awaitingApproval?: number;
  /** Worktree tasks waiting for the user to confirm the merge. */
  awaitingMerge?: number;
  activeTaskId: string | null;
  title: string | null;
  workspaceName: string | null;
  bugId: string | null;
};

/** Statuses that still own the bug inside the agent pipeline. */
const IN_FLIGHT_STATUSES: AgentTaskStatus[] = [
  "queued",
  "preparing",
  "running",
  "awaiting_approval",
  "awaiting_merge",
  "merging",
];

/** Worktree tasks pending user review or merge confirmation. */
export const isAgentApprovalStatus = (status: AgentTaskStatus): boolean =>
  status === "awaiting_approval" || status === "awaiting_merge";

export const isAgentInFlight = (task: AgentTask): boolean =>
  IN_FLIGHT_STATUSES.includes(task.status);

/** Stable key for "this bug already has an agent task". */
export const agentBugKey = (workspaceId: string, bugId: string): string =>
  `${workspaceId}::${bugId}`;

export type AgentInFlight = {
  task: AgentTask;
  /** 1-based FIFO position among queued tasks; null when not queued. */
  position: number | null;
};

/**
 * In-flight agent tasks keyed by workspace + bug. Queue positions are the
 * backend's insertion order, which is the order the serial worker will run.
 */
export function inFlightAgentTasks(tasks: AgentTask[]): Map<string, AgentInFlight> {
  const queued = tasks.filter((task) => task.status === "queued");
  const map = new Map<string, AgentInFlight>();
  for (const task of tasks) {
    if (!isAgentInFlight(task)) continue;
    const key = agentBugKey(task.workspaceId, task.bugId);
    const current = map.get(key);
    // Legacy snapshots can contain duplicates; the most advanced state wins.
    if (current && stateRank(current.task.status) <= stateRank(task.status)) continue;
    const index = queued.findIndex((item) => item.id === task.id);
    map.set(key, {
      task,
      position: index >= 0 ? index + 1 : null,
    });
  }
  return map;
}

const stateRank = (status: AgentTaskStatus): number => {
  switch (status) {
    case "merging":
      return 0;
    case "running":
      return 1;
    case "preparing":
      return 2;
    case "awaiting_merge":
      return 3;
    case "awaiting_approval":
      return 4;
    case "queued":
      return 5;
    default:
      return 6;
  }
};

/**
 * Bugs in one workspace that an agent is currently working on, in display
 * order. Deduplicated because legacy snapshots can contain duplicates.
 */
export function agentActiveBugIds(
  workspaceId: string | null | undefined,
  agentInFlight?: Map<string, AgentInFlight>,
): string[] {
  if (!workspaceId) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const info of agentInFlight?.values() ?? []) {
    if (info.task.workspaceId === workspaceId) push(info.task.bugId);
  }
  return ids;
}

/** Compact state label for bug rows and the detail entry point. */
export function agentInFlightLabel(info: AgentInFlight): string {
  switch (info.task.status) {
    case "queued":
      return info.position ? `排队中 #${info.position}` : "排队中";
    case "preparing":
      return "准备中";
    case "running":
      return "修复中";
    case "awaiting_approval":
      return "待审核";
    case "awaiting_merge":
      return "待合并";
    case "merging":
      return "合并中";
    default:
      return AGENT_STATUS_LABELS[info.task.status];
  }
}

export type AgentEnqueueRequest = {
  workspaceId: string;
  bugId: string;
  workspaceName?: string | null;
  title?: string | null;
  severity?: string | null;
  priority?: string | null;
  /** Markdown instructions typed in the compose sheet. */
  extraPrompt?: string | null;
  /** Absolute paths; the agent only ever receives paths, not file bytes. */
  attachments?: string[];
  /** Runtime for this task only; omitted means the default from settings. */
  runtimeId?: string | null;
};

export type AgentOutputPayload = {
  taskId: string;
  data: string;
};

export const AGENT_STATUS_LABELS: Record<AgentTaskStatus, string> = {
  queued: "排队中",
  preparing: "准备中",
  running: "运行中",
  awaiting_approval: "待审核",
  awaiting_merge: "待合并",
  merging: "合并中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
};

export const AGENT_STATUS_TONES: Record<
  AgentTaskStatus,
  "neutral" | "blue" | "green" | "amber" | "red" | "cyan"
> = {
  queued: "neutral",
  preparing: "blue",
  running: "amber",
  awaiting_approval: "amber",
  awaiting_merge: "cyan",
  merging: "blue",
  succeeded: "green",
  failed: "red",
  canceled: "neutral",
};

/** Result of starting a merge: the agent took over, or the user must merge. */
export type AgentMergeStart = {
  mode: "agent" | "manual";
  task: AgentTask;
  /** Manual steps; also written to `task.merge.instructions`. */
  instructions?: string | null;
};

export const agentApi = {
  /** Declared runtime catalog (lifecycle + capabilities + limitations). */
  runtimes: () =>
    featureCommand<{ runtimes: AgentRuntimeDescriptor[] }>("agent_runtimes"),
  configGet: () => featureCommand<{ config: AgentConfig }>("agent_config_get"),
  configSet: (patch: Partial<AgentConfig>) =>
    featureCommand<{ config: AgentConfig }>("agent_config_set", patch),
  enqueueBug: (request: AgentEnqueueRequest) =>
    featureCommand<{ task: AgentTask }>("agent_enqueue_bug", request),
  /**
   * Initialize the workflow once the user is inside the system. The backend
   * may report the tasks it restored; it is called once per system entry.
   */
  enterSystem: () =>
    featureCommand<{ report: RecoveryReport | null }>("agent_enter_system"),
  /** Persist a pasted screenshot and return its absolute path. */
  saveResource: (name: string, data: string) =>
    featureCommand<{ path: string }>("agent_save_resource", { name, data }),
  tasksList: () => featureCommand<AgentTasksState>("agent_tasks_list"),
  tasksHistory: (query: AgentHistoryQuery = {}) =>
    featureCommand<AgentTasksPage>("agent_tasks_history", query),
  summary: () => featureCommand<AgentSummary>("agent_summary"),
  cancel: (taskId: string) =>
    featureCommand<{ task: AgentTask }>("agent_task_cancel", { taskId }),
  retry: (taskId: string) =>
    featureCommand<{ task: AgentTask }>("agent_task_retry", { taskId }),
  /** Deletes one finished history record; only the local record is removed. */
  deleteTask: (taskId: string) =>
    featureCommand<{ deleted: boolean }>("agent_task_delete", { taskId }),
  /** Approve a paused change: the task re-enters the queue to commit. */
  approveReview: (taskId: string) =>
    featureCommand<{ task: AgentTask }>("agent_review_approve", { taskId }),
  /** Stop a paused change: stash the diff, cancel the task and pause the queue. */
  stopReview: (taskId: string) =>
    featureCommand<{ task: AgentTask }>("agent_review_stop", { taskId }),
  resumeQueue: () => featureCommand<AgentTasksState>("agent_queue_resume"),
  /** Merge the approved worktree branch with the original agent. */
  mergeStart: (taskId: string) =>
    featureCommand<AgentMergeStart>("agent_merge_start", { taskId }),
  /** Confirm the branch is already merged (manual merge fallback). */
  mergeVerify: (taskId: string) =>
    featureCommand<{ task?: AgentTask }>("agent_merge_verify", { taskId }),
  /** Unified diff of the paused change, for the review card. */
  reviewDiff: (taskId: string) =>
    featureCommand<{ diff: string }>("agent_review_diff", { taskId }),
  /** 在系统终端里续接该任务结束后的 Agent 会话。 */
  openTerminal: (taskId: string) =>
    featureCommand<{ ok: boolean }>("agent_open_terminal", { taskId }),
  /** Focus the main window and select this task in the Agent tab. */
  openTask: (taskId: string) =>
    featureCommand<{ opened: boolean }>("agent_open_task", { taskId }),
  input: (taskId: string, data: string) =>
    featureCommand<{ ok: boolean }>("agent_input", { taskId, data }),
  resize: (taskId: string, cols: number, rows: number) =>
    featureCommand<{ ok: boolean }>("agent_resize", { taskId, cols, rows }),
  detect: (path?: string) =>
    featureCommand<{ version: string; path: string }>("agent_detect", {
      path: path ?? null,
    }),
  /** Cached install scan; `force` probes every catalog binary again. */
  scan: (force = false) =>
    featureCommand<AgentScanSnapshot>("agent_scan", { force }),
};

/** Directory containing `bug.json`, for the console's "open export folder" action. */
export const exportDirFor = (jsonPath: string): string | null => {
  if (!jsonPath) return null;
  const index = jsonPath.lastIndexOf("/");
  if (index <= 0) return null;
  return jsonPath.slice(0, index);
};
