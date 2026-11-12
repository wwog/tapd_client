/**
 * Companion data layer: same-origin relative fetches against the desktop's
 * companion server, Bearer session token, `{ ok, data }` envelope.
 *
 * Data shapes are copied verbatim from `apps/desktop/src/lib/api.ts` (the
 * serde contract lives there; the companion renders exactly what the desktop
 * components render).
 */
import { useSyncExternalStore } from "react";

import { navigate } from "./router";
import { clearSession, getSession } from "./session";

export type UserProfile = {
  nick: string;
  userId: string;
  company: string;
};

export type Workspace = {
  id: string;
  name: string;
  prettyName: string;
  category: string;
  status: string;
  logoColor: string | null;
  lastVisitedTime: string | null;
  jumpUrl: string | null;
};

export type WorkspaceContext = {
  user: UserProfile;
  workspaces: Workspace[];
};

export type BugQuery = {
  workspaceId: string;
  /** 处理人 nicknames; several match with OR. */
  owners: string[];
  /** Creator (TAPD `reporter`) nickname. */
  creator: string | null;
  statuses: string[];
  priorities: string[];
  severities: string[];
  keyword: string | null;
  modifiedAfter: string | null;
  createdAfter: string | null;
  sortName: string;
  order: string;
  page: number;
  perpage: number;
  confId: string | null;
};

export type BugSummary = {
  id: string;
  shortId: string;
  workspaceId: string;
  title: string;
  status: string;
  statusLabel: string;
  priority: string;
  priorityLabel: string;
  severity: string;
  severityLabel: string;
  owner: string;
  creator: string;
  created: string;
  modified: string;
  due: string;
  iterationId: string;
  iterationName: string;
  module: string;
  versionReport: string;
  storyId: string;
  storyName: string;
  bugUrl: string;
};

export type BugListPage = {
  page: number;
  perpage: number;
  total: number;
  statusMap: Record<string, string>;
  /** Status keys in the workspace's configured workflow order. */
  statusOrder: string[];
  bugs: BugSummary[];
};

export type Comment = {
  id: string;
  author: string;
  created: string;
  descriptionHtml: string;
  plainText: string;
  isDeleted: boolean;
  replies: Comment[];
};

export type Attachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  filetype: string;
  owner: string;
  created: string;
  entryId: string;
  videoPoster: string;
  videoOriginFile: string;
  downloadUrl: string;
};

export type MediaKind = "image" | "video" | "file";

/** Image/video embedded in the rich-text description or a comment. */
export type MediaRef = {
  url: string;
  kind: MediaKind;
  filenameHint: string;
};

export type ChangeField = {
  field: string;
  before: string;
  after: string;
};

export type ChangeEntry = {
  seq: number;
  time: string;
  author: string;
  kind: string;
  fields: ChangeField[];
};

export type ChangeHistory = {
  total: number;
  changes: ChangeEntry[];
  error: string | null;
};

/** A person who can be picked as owner / creator in a workspace. */
export type WorkspaceMember = {
  nick: string;
  userId: string;
  name: string;
  avatar: string;
};

export type BugTransitionChoice = {
  key: string;
  label: string;
};

export type BugTransitionInfo = {
  currentStatus: string;
  currentLabel: string;
  transitions: BugTransitionChoice[];
};

export type BugTransitionResult = {
  from: string;
  status: string;
  label: string;
  changed: boolean;
};

export type BugDetail = BugSummary & {
  descriptionHtml: string;
  descriptionText: string;
  platform: string;
  os: string;
  testtype: string;
  testphase: string;
  source: string;
  resolution: string;
  resolved: string;
  closed: string;
  reopenTime: string;
  fixer: string;
  de: string;
  te: string;
  participants: string;
  cc: string;
  follower: string;
  releaseName: string;
  workspaceName: string;
  customFields: Record<string, string>;
  comments: Comment[];
  attachments: Attachment[];
  embeddedMedia: MediaRef[];
  changes: ChangeHistory;
};

/** `GET /companion/api/state` — read-only desktop connection info. */
export type CompanionState = {
  loggedIn: boolean;
  version: string;
  me: string | null;
  workspaces: Workspace[];
};

/** Mirror of the desktop notification engine's entries (read-only). */
export type CompanionNotification = {
  id: string;
  workspaceId: string;
  bugId: string;
  title: string;
  kind: string;
  created: string;
  detectedAt: string;
};

/* -------------------------------------------------------------------------
   Agent workflow types, copied from `apps/desktop/src/lib/agent.ts` (the
   serde contract lives there). Fields the companion never renders are made
   optional defensively, so a new desktop field can never break this app.
   ------------------------------------------------------------------------- */

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

export type AgentApproval = {
  summary: string;
  files: string[];
  risk?: string;
  requestedAt: string;
  approvedAt?: string;
  /** Stash reference recorded when the user stops instead of approving. */
  stash?: string;
};

export type AgentMerge = {
  error?: string | null;
  instructions?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

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
  detail?: string;
  message?: string;
  model?: string;
  sessionId?: string;
  subagents?: number;
  updatedAt: string;
};

export type AgentTask = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  bugId: string;
  title: string;
  severity?: string;
  priority?: string;
  jsonPath?: string;
  repoPath?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  status: AgentTaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  prompt?: string;
  source?: string;
  runtimeId?: string;
  agentSessionId?: string | null;
  approval?: AgentApproval | null;
  merge?: AgentMerge | null;
  commitOnly?: boolean;
  extraPrompt?: string;
  attachments?: string[];
};

export type AgentTasksState = {
  tasks: AgentTask[];
  activeTaskId?: string | null;
  queuedCount?: number;
  awaitingApprovalCount?: number;
  awaitingMergeCount?: number;
  queuePaused?: boolean;
  storageError?: string | null;
  /** 运行中 Agent 的状态，key 是 task id。 */
  runtimeStatus?: Record<string, AgentRuntimeStatus>;
};

/** Paginated terminal-task history (`agent_tasks_history`). */
export type HistoryPage = {
  tasks: AgentTask[];
  total: number;
  hasMore: boolean;
};

export type AgentHistoryQuery = {
  workspaceId?: string;
  status?: AgentTaskStatus;
  keyword?: string;
  taskId?: string;
  offset?: number;
  limit?: number;
};

export type ProjectAgentConfig = {
  repoPath: string;
  rule: string;
};

export type AgentConfig = {
  /** Selected runtime id from the catalog. */
  runtimeId: string;
  binaryPath?: string;
  repoMappings?: Record<string, string>;
  projects?: Record<string, ProjectAgentConfig>;
  promptTemplate?: string;
  coworkerIds?: string[];
  readyQuietMs?: number;
  readyTimeoutMs?: number;
  idleCompleteMs?: number;
  /** 每个任务在独立 git worktree 中运行。 */
  worktreeEnabled: boolean;
  /** 开启 worktree 后的并行任务数；关闭时固定为 1。 */
  executionUnits: number;
  /** 客户端重启后，之前排队（Queued）的任务自动继续。 */
  restoreQueuedTasks: boolean;
};

export type AgentRuntimeCapabilities = {
  interactiveTerminal?: boolean;
  permissionPrompt?: boolean;
  externalDecision?: boolean;
  commitReview?: boolean;
};

export type AgentRuntimeDescriptor = {
  id: string;
  name: string;
  vendor?: string;
  description?: string;
  binary?: string;
  aliases?: string[];
  args?: string[];
  promptInjection?: string;
  promptFlag?: string | null;
  argvSeparator?: string | null;
  sessionHook?: boolean;
  available: boolean;
  capabilities?: AgentRuntimeCapabilities;
  limitations?: string[];
  fallback?: string;
};

/** Result of starting a merge: the agent took over, or the user must merge. */
export type AgentMergeStart = {
  mode: "agent" | "manual";
  task: AgentTask;
  /** Manual steps; also written to `task.merge.instructions`. */
  instructions?: string | null;
};

export type AgentEnqueueRequest = {
  workspaceId: string;
  bugId: string;
  workspaceName?: string | null;
  title?: string | null;
  severity?: string | null;
  priority?: string | null;
  /** Markdown instructions typed in the compose sheet. */
  extraPrompt?: string | null;
  runtimeId?: string | null;
  /** Marks the task as raised from the phone. */
  source?: string;
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

export const AGENT_STATUS_TONES: Record<AgentTaskStatus, "neutral" | "blue" | "green" | "amber" | "red" | "cyan"> = {
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

/** Statuses that still own the bug inside the agent pipeline. */
const IN_FLIGHT_STATUSES: AgentTaskStatus[] = [
  "queued",
  "preparing",
  "running",
  "awaiting_approval",
  "awaiting_merge",
  "merging",
];

export const isAgentInFlight = (task: AgentTask): boolean =>
  IN_FLIGHT_STATUSES.includes(task.status);

/* -------------------------------------------------------------------------
   Notification settings, copied from `apps/desktop/src/lib/notification.ts`.
   ------------------------------------------------------------------------- */

export type QuietHours = {
  enabled: boolean;
  start: string;
  end: string;
};

export type NotificationSettings = {
  enabled: boolean;
  /** "mine" | "project"; rendered read-only on the phone. */
  scope?: string;
  includeNew: boolean;
  includeTransferred: boolean;
  includeReopened: boolean;
  pollIntervalSecs: number;
  quietHours: QuietHours;
  maxVisible: number;
  aiEnabled?: boolean;
};

/* -------------------------------------------------------------------------
   Coworker packages, copied from `apps/desktop/src/lib/coworker.ts`.
   ------------------------------------------------------------------------- */

export type CoworkerSkill = {
  name: string;
  description: string;
  /** Absolute path to SKILL.md, injected into the prompt. */
  path: string;
};

/** A bundled coworker package as shown on the 同事 page. */
export type Coworker = {
  /** Folder name; the only stable id. */
  id: string;
  name: string;
  role: string;
  title?: string;
  description?: string;
  /** `#rrggbb`, or empty when the package did not set one. */
  accent?: string;
  /** Data URL, or null when the avatar could not be read. */
  avatar?: string | null;
  skills: CoworkerSkill[];
};

export type CoworkerList = {
  coworkers: Coworker[];
  /** Enabled ids in selection order. */
  selectedIds: string[];
  /** Exact block appended to the task prompt; empty when nobody is enabled. */
  promptSection?: string;
  /** Packages/skills that failed validation; surfaced on the page. */
  warnings?: string[];
};

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function asApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError("error", "请求失败");
}

/** Global desktop-side connection state, shared by every page. */
export type Connection = { kind: "ok" | "offline" | "not_logged_in"; attempt: number };

let connection: Connection = { kind: "ok", attempt: 0 };
const listeners = new Set<() => void>();

function setConnection(kind: Connection["kind"]): void {
  if (connection.kind === kind) return;
  // `attempt` bumps so screens can remount and refetch on recovery/retry.
  connection = { kind, attempt: connection.attempt + 1 };
  for (const listener of listeners) listener();
}

const subscribeConnection = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getConnection = (): Connection => connection;

export const retryConnection = (): void => setConnection("ok");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSession();
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    setConnection("offline");
    throw new ApiError("offline", "无法连接桌面端");
  }

  let envelope: { ok: true; data: T } | { ok: false; code: string; error: string } | null =
    null;
  try {
    envelope = await response.json();
  } catch {
    // Non-JSON body means the server is not our companion API.
  }
  if (!envelope) {
    setConnection("offline");
    throw new ApiError("offline", "桌面端响应异常");
  }

  if (!envelope.ok) {
    if (envelope.code === "unauthorized") {
      clearSession();
      navigate("#/pair");
      throw new ApiError("unauthorized", "配对已失效，请重新扫码");
    }
    if (envelope.code === "not_logged_in") {
      setConnection("not_logged_in");
      throw new ApiError("not_logged_in", "桌面端未登录");
    }
    throw new ApiError(envelope.code || "error", envelope.error || "请求失败");
  }

  // Any success recovers the app automatically (desktop logged back in etc.).
  setConnection("ok");
  return envelope.data;
}

/**
 * Generic feature command (desktop twin of Tauri `feature_command`): the
 * desktop executes it locally and returns the same serde shape its own UI
 * consumes. The typed helpers on `api` wrap it.
 */
export const feature = <T>(name: string, payload: Record<string, unknown> = {}): Promise<T> =>
  request<T>("/companion/api/feature", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, payload }),
  });

export const api = {
  state: () => request<CompanionState>("/companion/api/state"),

  /** Project list from the desktop's workspace context (default = most recent). */
  workspaces: () => request<WorkspaceContext>("/companion/api/workspaces"),

  /** One-time pairing code -> long-lived session token. */
  pair: (token: string, name: string) =>
    request<{ sessionToken: string }>("/companion/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name }),
    }),

  bugs: (query: BugQuery) =>
    request<BugListPage>("/companion/api/bugs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    }),

  bug: (workspaceId: string, bugId: string) => {
    const params = new URLSearchParams({ workspaceId, bugId });
    return request<BugDetail>(`/companion/api/bug?${params.toString()}`);
  },

  /** Member directory for filter options (server caches 2h; client 30min). */
  members: (workspaceId: string) => {
    const params = new URLSearchParams({ workspaceId });
    return request<WorkspaceMember[]>(`/companion/api/members?${params.toString()}`);
  },

  /* -- Bug write actions (user-initiated only) ---------------------------- */

  bugAddComment: (workspaceId: string, bugId: string, comment: string) =>
    request<void>("/companion/api/bug/comment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, bugId, comment }),
    }),

  bugUpdateField: (workspaceId: string, bugId: string, field: string, value: string, claim = false) =>
    request<void>("/companion/api/bug/update-field", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, bugId, field, value, claim }),
    }),

  bugTransitions: (workspaceId: string, bugId: string) => {
    const params = new URLSearchParams({ workspaceId, bugId });
    return request<BugTransitionInfo>(`/companion/api/bug/transitions?${params.toString()}`);
  },

  bugTransition: (workspaceId: string, bugId: string, status: string) =>
    request<BugTransitionResult>("/companion/api/bug/transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, bugId, status }),
    }),

  /** 认领：桌面侧取 me 改派处理人并接受。 */
  bugClaim: (workspaceId: string, bugId: string) =>
    request<void>("/companion/api/bug/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, bugId }),
    }),

  notifications: () => request<CompanionNotification[]>("/companion/api/notifications"),

  feature,

  /* -- Agent tasks ------------------------------------------------------- */

  agentTasks: () => feature<AgentTasksState>("agent_tasks_list"),

  agentHistory: (query: AgentHistoryQuery = {}) =>
    feature<HistoryPage>("agent_tasks_history", { ...query }),

  agentApprove: (taskId: string) =>
    feature<{ task?: AgentTask }>("agent_review_approve", { taskId }),

  /** 停止审核：stash 改动、取消任务并暂停队列（恢复在桌面端进行）。 */
  agentStop: (taskId: string) =>
    feature<{ task?: AgentTask }>("agent_review_stop", { taskId }),

  agentDiff: async (taskId: string): Promise<string> => {
    const data = await feature<unknown>("agent_review_diff", { taskId });
    if (typeof data === "string") return data;
    if (data && typeof data === "object" && "diff" in data) {
      const diff = (data as { diff?: unknown }).diff;
      if (typeof diff === "string") return diff;
    }
    return "";
  },

  agentMergeStart: (taskId: string) =>
    feature<AgentMergeStart>("agent_merge_start", { taskId }),

  agentCancel: (taskId: string) =>
    feature<{ task?: AgentTask }>("agent_task_cancel", { taskId }),

  agentRetry: async (taskId: string): Promise<AgentTask | null> => {
    const data = await feature<unknown>("agent_task_retry", { taskId });
    if (data && typeof data === "object" && "task" in data) {
      return ((data as { task?: AgentTask | null }).task ?? null);
    }
    return (data as AgentTask) ?? null;
  },

  /** Enqueue a fix task for one bug, raised from the phone. */
  agentEnqueueBug: (req: AgentEnqueueRequest) =>
    feature<{ task?: AgentTask }>("agent_enqueue_bug", { ...req }),

  /* -- Agent / notification / coworker settings --------------------------- */

  agentConfig: async (): Promise<AgentConfig> => {
    const data = await feature<unknown>("agent_config_get", {});
    const inner = (data as { config?: AgentConfig } | null)?.config;
    return inner ?? (data as AgentConfig);
  },

  agentConfigSet: async (patch: Partial<AgentConfig>): Promise<AgentConfig> => {
    const data = await feature<unknown>("agent_config_set", { ...patch });
    const inner = (data as { config?: AgentConfig } | null)?.config;
    return inner ?? (data as AgentConfig);
  },

  agentRuntimes: async (): Promise<AgentRuntimeDescriptor[]> => {
    const data = await feature<unknown>("agent_runtimes", {});
    if (Array.isArray(data)) return data as AgentRuntimeDescriptor[];
    return (data as { runtimes?: AgentRuntimeDescriptor[] } | null)?.runtimes ?? [];
  },

  notificationSettings: () =>
    feature<{ settings: NotificationSettings }>("notification_settings_get", {}),

  notificationSettingsSet: (patch: Partial<NotificationSettings>) =>
    feature<{ settings: NotificationSettings }>("notification_settings_set", { ...patch }),

  coworkerList: () => feature<CoworkerList>("coworker_list", {}),

  coworkerSelect: (ids: string[]) =>
    feature<{ selectedIds: string[] }>("coworker_select", { ids }),
};

/** Reactive connection state for full-screen gates. */
export function useConnection(): Connection {
  return useSyncExternalStore(subscribeConnection, getConnection, getConnection);
}
