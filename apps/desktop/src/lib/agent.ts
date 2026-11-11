import { featureCommand } from "./feature";

export type AgentTaskStatus =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_review"
  | "awaiting_approval"
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
  readyQuietMs: number;
  readyTimeoutMs: number;
  /** TUI 运行时输出静默多久视为本轮结束；0 表示只依赖 MCP 回报。 */
  idleCompleteMs: number;
};

/** A stage every runtime declares in the Agent management dialog. */
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
  /** 启动参数（不含提示词）。 */
  args: string[];
  /** 提示词交付方式。 */
  promptInjection: "argv" | "flag" | "stdin";
  /** flag 模式下承载提示词的参数名。 */
  promptFlag?: string | null;
  available: boolean;
  capabilities: AgentRuntimeCapabilities;
  lifecycle: AgentLifecycleStage[];
  limitations: string[];
  /** What the UI does when an external decision cannot be applied. */
  fallback: string;
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
  mdPath: string;
  repoPath: string;
  status: AgentTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  logPath: string;
  error?: string;
  prompt: string;
  source: string;
  /** Runtime snapshotted at enqueue time. */
  runtimeId?: string;
  /** Present while the task waits for the commit decision. */
  approval?: AgentApproval | null;
  /** The next run is the post-approval commit phase. */
  commitOnly?: boolean;
  /** Markdown instructions from the compose sheet. */
  extraPrompt?: string;
  /** Local resource paths supplied with the task. */
  attachments?: string[];
};

export type AgentTasksState = {
  tasks: AgentTask[];
  activeTaskId: string | null;
  queuedCount?: number;
  waitingReviewCount?: number;
  awaitingApprovalCount?: number;
  /** Set after the user stopped a review; resume from the Agent tab. */
  queuePaused?: boolean;
  /** Fresh external AI claims (backend already drops expired ones). */
  externalClaims?: ExternalClaim[];
};

/** A bug an external MCP client is working on. */
export type ExternalClaimStatus = "queued" | "running";

export type ExternalClaim = {
  workspaceId: string;
  bugId: string;
  title: string;
  /** MCP client name from the handshake, e.g. "Zcode". */
  client: string;
  /** Model the client reported; empty when unknown. */
  model: string;
  status: ExternalClaimStatus;
  note?: string;
  claimedAt: string;
  lastSeenAt: string;
};

/** Claims expire server-side after 15 minutes without a heartbeat. */
export const EXTERNAL_CLAIM_TTL_MS = 15 * 60 * 1000;

export function isExternalClaimFresh(
  claim: ExternalClaim,
  now: number = Date.now(),
): boolean {
  const seen = Date.parse(claim.lastSeenAt);
  return Number.isFinite(seen) && now - seen <= EXTERNAL_CLAIM_TTL_MS;
}

/** Fresh claims keyed by `agentBugKey`, newest state per bug. */
export function externalClaimMap(
  claims: ExternalClaim[] = [],
  now: number = Date.now(),
): Map<string, ExternalClaim> {
  const map = new Map<string, ExternalClaim>();
  for (const claim of claims) {
    if (!isExternalClaimFresh(claim, now)) continue;
    const key = agentBugKey(claim.workspaceId, claim.bugId);
    if (!map.has(key)) map.set(key, claim);
  }
  return map;
}

/** `“Zcode”正在使用“Deepseek”进行处理` */
export function externalClaimLabel(claim: ExternalClaim): string {
  const client = claim.client.trim() || "外部 AI";
  const model = claim.model.trim();
  if (claim.status === "queued") return `“${client}”排队等待处理`;
  return model
    ? `“${client}”正在使用“${model}”进行处理`
    : `“${client}”正在处理`;
}

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

/** Lightweight agent state for the island capsule. */
export type AgentSummary = {
  running: boolean;
  awaitingApproval?: number;
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
  "waiting_review",
  "awaiting_approval",
];

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
    case "running":
      return 0;
    case "preparing":
      return 1;
    case "waiting_review":
      return 2;
    case "awaiting_approval":
      return 3;
    case "queued":
      return 4;
    default:
      return 5;
  }
};

/** Compact state label for bug rows and the detail entry point. */
export function agentInFlightLabel(info: AgentInFlight): string {
  switch (info.task.status) {
    case "queued":
      return info.position ? `排队中 #${info.position}` : "排队中";
    case "preparing":
      return "准备中";
    case "running":
      return "修复中";
    case "waiting_review":
      return "等待权限";
    case "awaiting_approval":
      return "待审核";
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
};

export type AgentOutputPayload = {
  taskId: string;
  data: string;
};

export const AGENT_STATUS_LABELS: Record<AgentTaskStatus, string> = {
  queued: "排队中",
  preparing: "准备中",
  running: "运行中",
  waiting_review: "等待权限",
  awaiting_approval: "待审核",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
};

export const AGENT_STATUS_TONES: Record<
  AgentTaskStatus,
  "neutral" | "blue" | "green" | "amber" | "red"
> = {
  queued: "neutral",
  preparing: "blue",
  running: "amber",
  waiting_review: "red",
  awaiting_approval: "amber",
  succeeded: "green",
  failed: "red",
  canceled: "neutral",
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
  /** Persist a pasted screenshot and return its absolute path. */
  saveResource: (name: string, data: string) =>
    featureCommand<{ path: string }>("agent_save_resource", { name, data }),
  tasksList: () => featureCommand<AgentTasksState>("agent_tasks_list"),
  tasksHistory: (query: AgentHistoryQuery = {}) =>
    featureCommand<AgentTasksPage>("agent_tasks_history", query),
  summary: () => featureCommand<AgentSummary>("agent_summary"),
  cancel: (taskId: string) =>
    featureCommand<{ task: AgentTask }>("agent_task_cancel", { taskId }),
  /** Close an external AI claim from the list (user's 取消 action). */
  externalRelease: (workspaceId: string, bugId: string) =>
    featureCommand<{ released: boolean }>("agent_external_release", {
      workspaceId,
      bugId,
    }),
  retry: (taskId: string) =>
    featureCommand<{ task: AgentTask }>("agent_task_retry", { taskId }),
  /** Approve a paused change: the task re-enters the queue to commit. */
  approveReview: (taskId: string) =>
    featureCommand<{ task: AgentTask }>("agent_review_approve", { taskId }),
  /** Stop a paused change: stash the diff, cancel the task and pause the queue. */
  stopReview: (taskId: string) =>
    featureCommand<{ task: AgentTask }>("agent_review_stop", { taskId }),
  resumeQueue: () => featureCommand<AgentTasksState>("agent_queue_resume"),
  /** Unified diff of the paused change, for the review card. */
  reviewDiff: (taskId: string) =>
    featureCommand<{ diff: string }>("agent_review_diff", { taskId }),
  taskLog: (taskId: string) =>
    featureCommand<{ data: string }>("agent_task_log", { taskId }),
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
};

/** Directory containing `bug.md`, for the console's "open export folder" action. */
export const exportDirFor = (mdPath: string): string | null => {
  if (!mdPath) return null;
  const index = mdPath.lastIndexOf("/");
  if (index <= 0) return null;
  return mdPath.slice(0, index);
};
