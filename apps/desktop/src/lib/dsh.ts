/**
 * Built-in DeepSeek Harness runtime: commands, event payloads and the agent
 * settings extension that carries the model API.
 *
 * The contract (commands, phases, stream revision rules) is documented in
 * `docs/DSH.md` §3. Entries are committed history; streams are token-level
 * deltas the UI overlays on top of them until the entry arrives.
 */
import { invoke } from "@tauri-apps/api/core";

import {
  agentSettingsApi,
  type AgentConfig,
  type DshModelEntry,
  type DshModelProtocol,
  type DshModelsConfig,
  type DshPermissionMode,
  type DshProvider,
  type DshReasoningLevel,
  type ModelSelection,
  type ReasoningEffort,
} from "./agentSettings";

export type DshPhase = "stopped" | "starting" | "ready" | "failed";

export type DshStatus = {
  phase: DshPhase;
  payloadVersion?: string;
  nodeVersion?: string;
  nodePath?: string;
  provider?: string;
  model?: string;
  /** Stable machine code (`node_missing`, `model_missing`, …). */
  errorCode?: string;
  error?: string;
  /** Startup-only settings changed since this process booted. */
  restartRequired?: boolean;
};

export type PayloadReport = {
  version: string;
  /** `env` | `dev` | `bundled`. */
  source: string;
  extracted: boolean;
  archive: string;
  runtimeDir: string;
  archiveBytes: number;
  unpackedBytes: number;
  files: number;
};

export type DshSessionStatus = "idle" | "running" | "failed";

/** Token accounting for one reply, straight from the provider. */
export type DshEntryUsage = {
  /** Input tokens that missed the provider cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

/** Running totals the status line reads; the host derives the percentages. */
export type DshSessionUsage = {
  turns: number;
  /** One step = one model request. */
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  provider: string;
  model: string;
  /** Context window of the latest request; 0 when unknown. */
  contextWindow: number;
  /** Output tokens per second over the last message. */
  tokensPerSecond: number;
  /** Average wait for the first streamed token; 0 when no request was timed. */
  ttftMs: number;
  /** Request start → message settle, summed over every timed request. */
  modelMs: number;
  /** Prompt-side tokens of the latest request (the runtime's own meter). */
  contextUsedTokens: number;
  /** Composition of the latest request surface, as dsh priced it. */
  systemTokens: number;
  toolsTokens: number;
  messageTokens: number;
};

/** One session row as the runtime reports it. */
export type DshSessionRow = {
  id: string;
  title: string;
  updatedAt: string;
  status: DshSessionStatus;
  messageCount: number;
  usage: DshSessionUsage;
  /** The route the session will use next; absent until one is recorded. */
  selection?: ModelSelection;
  /** The engine's plan mode for this session (`plan/mode` events). */
  planActive?: boolean;
  /** Current session todo list (`todo/write`); empty until the agent plans. */
  todos?: DshTodo[];
  /** Present on a child agent session (`header.origin === "subagent"`):
   *  the parent session this child was started from. Roots never set it. */
  parentSession?: string;
  /** The agent preset a child session runs under, when one was recorded. */
  agentPreset?: string;
};

/** dsh's 1-based turn/step counters; a step is one model request. */
type DshEntryPosition = { turn: number; step: number };

/**
 * One entry of the session todo list (`todo/write`, whole-list replacement).
 * No id: every write replaces the list, so entries have no stable identity.
 */
export type DshTodo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

export type DshEntry =
  | ({ kind: "user"; seq: number; at: string; text: string } & DshEntryPosition)
  | ({
      kind: "assistant";
      seq: number;
      at: string;
      text: string;
      reasoning?: string;
      usage?: DshEntryUsage;
      provider?: string;
      model?: string;
      /** `step/start` of the request this reply answered (epoch ms). */
      startedAtMs?: number;
      /** First streamed chunk (epoch ms). */
      firstTokenAtMs?: number;
      /** The `assistant/message` settle time (epoch ms). */
      completedAtMs?: number;
    } & DshEntryPosition)
  | ({
      kind: "tool";
      seq: number;
      at: string;
      callId: string;
      name: string;
      args: string;
      status: "running" | "ok" | "error";
      /** Model-facing result text (docs/DSH.md §8.3). The host sends a string;
       *  the view still normalizes objects so an older producer cannot crash it. */
      result?: unknown;
      /** `tool/call` time (epoch ms). */
      startedAtMs?: number;
      /** `tool/result` time (epoch ms); absent while running. */
      endedAtMs?: number;
    } & DshEntryPosition)
  | {
      kind: "turn";
      seq: number;
      at: string;
      turn: number;
      state: "start" | "end";
      reason?: string;
      error?: string;
    }
  | ({
      /** The runtime's account of a child agent settling (`subagent-settled`
       *  user/message, `source.kind` in the dsh log). Rendered as part of the
       *  sub-agent group, never as a human bubble. */
      kind: "notice";
      seq: number;
      at: string;
      text: string;
      /** The `source.summary` line: how the child ended. */
      summary: string;
      /** `completed` / `aborted` / `max-tokens` / `refusal` / `error` … */
      stopReason?: string;
      /** The child session id, linking this row to the child's transcript. */
      senderSessionId: string;
    } & DshEntryPosition)
  | ({
      /** The rendered system prompt (`system/message`). The trajectory lists
       *  it; the conversation view never renders it as a bubble. */
      kind: "system";
      seq: number;
      at: string;
      text: string;
      /** The prompt replaced an earlier one (phase change / normalization). */
      update?: boolean;
    } & DshEntryPosition)

export type DshStreamDelta =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; callId?: string; name?: string; arguments?: string };

export type DshStream = {
  sessionId: string;
  attemptId: string;
  /** Monotonic per attempt; a change replaces the accumulated text. */
  revision: number;
  index: number;
  delta: DshStreamDelta;
};

export type DshApprovalRequest = {
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
};

export type DshQuestionOption = {
  label: string;
  description?: string;
};

export type DshQuestion = {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: DshQuestionOption[];
  multiSelect?: boolean;
  /** Presentation hint (`plan-review`, `approval`); kept untyped upstream. */
  intent?: unknown;
};

export type DshQuestionRequest = {
  requestId: string;
  sessionId: string;
  questions: DshQuestion[];
};

export type DshAnswer = {
  id: string;
  selected: string[];
  custom?: string;
};

export type DshApprovalOutcome = "allowed-once" | "rejected" | "cancelled";

export type {
  DshModelEntry,
  DshModelProtocol,
  DshModelsConfig,
  DshPermissionMode,
  DshProvider,
  DshReasoningLevel,
  ModelSelection,
  ReasoningEffort,
};

/** The settings shape the runtime reads; the model block is part of it. */
export type DshAgentConfig = AgentConfig;

// ---------------------------------------------------------------------------
// Unified tasks (docs/DSH.md §9.1)
// ---------------------------------------------------------------------------

export type DshTaskKind = "chat" | "bug" | "local_item";

/** The only list grouping and the only state machine (docs/AGENT_TASK_FLOW.md §3). */
export type DshTaskWorkflow =
  | "queued"
  | "running"
  | "awaiting_review"
  | "finalizing"
  | "done"
  | "failed"
  | "canceled";

export type DshTaskProject = {
  id: string;
  name: string;
  kind: "tapd" | "local";
};

/** A configured project, whether or not it owns a session (list grouping). */
export type DshProject = DshTaskProject & {
  /** Empty when the project has no repository configured. */
  repoPath: string;
};

export type DshTaskChanges = {
  files: number;
  additions: number;
  deletions: number;
};

/** What the model reported when it asked for review (from `task_submit`). */
export type DshTaskReview = {
  summary: string;
  verification?: string;
  risks?: string;
  files: string[];
};

/** Where the host is in commit → merge → cleanup → writeback. */
export type DshFinalizeStep = "commit" | "merge" | "cleanup" | "writeback";

export type DshTaskFinalize = {
  /** The step that is running (or failed, when `error` is set). */
  step: DshFinalizeStep | null;
  error?: string;
  instructions?: string;
  /** Non-fatal remark, e.g. a worktree kept because it was dirty. */
  notice?: string;
};

export type DshTaskFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

/** One changed file as `dsh_task_changes` reports it. */
export type DshTaskFile = {
  /** Relative to the worktree root. */
  path: string;
  status: DshTaskFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
};

export type DshTask = {
  id: string;
  kind: DshTaskKind;
  /** `null` for a free conversation with no project behind it. */
  project: DshTaskProject | null;
  title: string;
  bugId?: string;
  workflow: DshTaskWorkflow;
  /** Live dsh session status; the task's own state is `workflow`. */
  status: DshSessionStatus;
  repoPath: string;
  worktreePath?: string;
  branch?: string;
  jsonPath: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  changes?: DshTaskChanges | null;
  review?: DshTaskReview | null;
  finalize?: DshTaskFinalize | null;
};

// ---------------------------------------------------------------------------
// Team board (docs/DSH.md §9.5)
// ---------------------------------------------------------------------------

export type DshTeamTaskStatus = "pending" | "in_progress" | "completed";

export type DshTeamTask = {
  id: string;
  subject: string;
  description: string;
  status: DshTeamTaskStatus;
  /** The subagent session that owns the task. */
  ownerId?: string;
  ownerName?: string;
  blockedBy: string[];
  writeScopes: string[];
  /** Nothing blocks this task, so the owner can start right away. */
  ready: boolean;
};

export type DshTeam = {
  sessionId: string;
  enabled: boolean;
  tasks: DshTeamTask[];
  /** Present only when the runtime's own projection failed. */
  failure?: string;
};

export const dshSettingsApi = {
  get: () => agentSettingsApi.get(),
  save: (config: DshAgentConfig) => agentSettingsApi.set(config) as Promise<DshAgentConfig>,
};

export const dshApi = {
  status: () => invoke<DshStatus>("dsh_status"),
  prepare: () => invoke<PayloadReport>("dsh_prepare"),
  start: () => invoke<DshStatus>("dsh_start"),
  stop: () => invoke<DshStatus>("dsh_stop"),
  /** Stop + start: applies startup-only settings without quitting the app. */
  restart: () => feature<DshStatus>("dsh_restart"),
  /** Stops one session's current turn; the task workflow is untouched. */
  cancelTurn: (sessionId: string) =>
    feature<{ ok: true }>("dsh_session_cancel", { sessionId }),
  /** Continues the last failed turn in place: the prompt is not sent again, so
   *  it never lands in the context twice. */
  retryTurn: (sessionId: string) =>
    feature<{ sessionId: string; ok: true }>("dsh_session_retry", { sessionId }),
  sessions: () => invoke<{ sessions: DshSessionRow[] }>("dsh_sessions"),
  pending: () => invoke<{ requests: DshPendingRequest[] }>("dsh_pending"),
  sessionEntries: (sessionId: string) =>
    invoke<{ sessionId: string; known: boolean; entries: DshEntry[] }>(
      "dsh_session_entries",
      { sessionId },
    ),
  prompt: (sessionId: string, text: string) =>
    invoke<{ receipt: unknown }>("dsh_prompt", { sessionId, text }),
  selectModel: (sessionId: string, selection: ModelSelection) =>
    invoke<{ ok: true }>("dsh_select_model", {
      sessionId,
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort ?? null,
    }),
  /** `mode: null` means the session inherits the configured default. */
  sessionMode: (sessionId: string) =>
    feature<{ sessionId: string; mode: DshPermissionMode | null }>("dsh_session_mode_get", {
      sessionId,
    }),
  /** A plan toggle leaves the permission mode untouched. */
  setSessionMode: (sessionId: string, patch: { mode?: DshPermissionMode; plan?: boolean }) =>
    feature<{ sessionId: string; mode: DshPermissionMode | null; plan: boolean | null }>(
      "dsh_session_mode_set",
      { sessionId, ...patch },
    ),
  approvalAnswer: (rpcId: number, outcome: DshApprovalOutcome) =>
    invoke<void>("dsh_approval_answer", { rpcId, outcome }),
  questionAnswer: (rpcId: number, answers: DshAnswer[] | null) =>
    invoke<void>("dsh_question_answer", { rpcId, answers }),
};

/** Event payloads, kept next to the command types they mirror. */
export type DshEntryEvent = { sessionId: string; entry: DshEntry };
export type DshSessionsEvent = { sessions: DshSessionRow[] };
export type DshSessionEvent = { sessionId: string; stream: DshStream };
export type DshApprovalEvent = { rpcId: number; request: DshApprovalRequest };
export type DshQuestionEvent = { rpcId: number; request: DshQuestionRequest };
export type DshErrorEvent = { code: string; message: string };
export type DshTasksEvent = { tasks: DshTask[] };
/** A request was answered on another surface (or its runtime went away). */
export type DshSettledEvent = { rpcId: number };
/** Pushed on connect, on every switch and on any task or owner change. */
export type DshTeamEvent = { sessionId: string; team: DshTeam };
/** The capsule asks the main window to reveal a session (docs/DSH.md §9.4). */
export type DshFocusSessionEvent = { sessionId: string };

/**
 * Task and policy commands ride the shared feature surface
 * (`feature_command`), not Tauri's `#[command]` list, so the paired phone and
 * the desktop share one implementation. `lib/feature.ts` keeps the union for
 * feature windows; this local union covers the `dsh_*` names the router sends
 * here instead.
 */
type DshFeatureCommand =
  | "dsh_restart"
  | "dsh_session_cancel"
  | "dsh_session_retry"
  | "dsh_session_dir"
  | "dsh_worktrees"
  | "dsh_worktree_remove"
  | "dsh_plugins"
  | "dsh_tools"
  | "dsh_session_mode_get"
  | "dsh_session_mode_set"
  | "dsh_models_discover"
  | "dsh_tasks"
  | "dsh_task_enqueue_bug"
  | "dsh_task_enqueue_local"
  | "dsh_task_approve"
  | "dsh_task_retry_finalize"
  | "dsh_task_cancel"
  | "dsh_task_changes"
  | "dsh_task_diff"
  | "dsh_task_resume"
  | "dsh_task_delete"
  | "dsh_new_session"
  | "dsh_projects"
  | "dsh_chat_worktree"
  | "dsh_policy_set"
  | "dsh_team_get"
  | "dsh_team_set";

const feature = <T>(name: DshFeatureCommand, payload: unknown = {}): Promise<T> =>
  invoke<T>("feature_command", { name, payload });

export const dshTaskApi = {
  /** Newest first, one unified list. */
  list: () => feature<{ tasks: DshTask[] }>("dsh_tasks"),
  enqueueBug: (
    workspaceId: string,
    bugId: string,
    extraPrompt?: string,
    attachments?: string[],
    team?: boolean,
  ) =>
    feature<{ task: DshTask }>("dsh_task_enqueue_bug", {
      workspaceId,
      bugId,
      ...(extraPrompt ? { extraPrompt } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(typeof team === "boolean" ? { team } : {}),
    }),
  enqueueLocal: (
    projectId: string,
    itemId: string,
    extraPrompt?: string,
    attachments?: string[],
    team?: boolean,
  ) =>
    feature<{ task: DshTask }>("dsh_task_enqueue_local", {
      projectId,
      itemId,
      ...(extraPrompt ? { extraPrompt } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(typeof team === "boolean" ? { team } : {}),
    }),
  approve: (sessionId: string) =>
    feature<{ task: DshTask }>("dsh_task_approve", { sessionId }),
  /** Resumes commit/merge/cleanup/writeback from `finalize.step`. */
  retryFinalize: (sessionId: string) =>
    feature<{ task: DshTask }>("dsh_task_retry_finalize", { sessionId }),
  cancel: (sessionId: string, stash = false) =>
    feature<{ task: DshTask }>("dsh_task_cancel", { sessionId, stash }),
  /** Changed files of the task's worktree; `file` narrows the diff to one. */
  changes: (sessionId: string) =>
    feature<{ files: DshTaskFile[]; truncated: boolean }>("dsh_task_changes", {
      sessionId,
    }),
  diff: (sessionId: string, file?: string) =>
    feature<{ diff: string; truncated: boolean }>("dsh_task_diff", {
      sessionId,
      ...(file ? { file } : {}),
    }),
  resume: (sessionId: string) =>
    feature<{ task: DshTask }>("dsh_task_resume", { sessionId }),
  /** Creates a free chat, optionally already grouped under a project. */
  newSession: (project?: { kind: DshTaskProject["kind"]; id: string }) =>
    feature<{ sessionId: string }>("dsh_new_session", {
      ...(project ? { project } : {}),
    }),
  /** Every configured project, for the task list's empty groups. */
  projects: () => feature<{ projects: DshProject[] }>("dsh_projects"),
  /** Opts one free chat into (or out of) its own git worktree. */
  chatWorktree: (sessionId: string, enabled: boolean) =>
    feature<{ task: DshTask }>("dsh_chat_worktree", { sessionId, enabled }),
  /** Removes the row, its log and whatever directory the app made for it. */
  delete: (sessionId: string) =>
    feature<{ sessionId: string }>("dsh_task_delete", { sessionId }),
  /** The directory a session works in, for "在 Finder 中打开". */
  sessionDir: (sessionId: string) =>
    feature<{ path: string; exists: boolean }>("dsh_session_dir", { sessionId }),
};

/** One leftover directory under the app's worktree root. */
export type DshWorktree = {
  sessionId: string;
  path: string;
  updatedAt: string;
  title: string;
  project: DshTask["project"];
  repoPath: string;
  /** No task row owns it any more. */
  orphan: boolean;
};

export const dshWorktreeApi = {
  list: () => feature<{ root: string; worktrees: DshWorktree[] }>("dsh_worktrees"),
  remove: (path: string) => feature<{ path: string }>("dsh_worktree_remove", { path }),
};

/** What a path written in a reply turned out to be on disk. */
export type DshFileTarget = {
  /** Project id, `__session__:<id>` or `__root__`. */
  workspaceId: string;
  /** Relative to that workspace's root, `/`-separated. */
  path: string;
  label: string;
  kind: "file" | "dir" | "missing";
};

/**
 * Desktop-only: maps a path from an assistant reply onto the workspace root it
 * lives under, so the workbench can open a file tab in the right scope.
 */
export const dshFileApi = {
  target: (sessionId: string, path: string) =>
    invoke<DshFileTarget>("dsh_file_target", { sessionId, path }),
};

/** Root-Fiber phase of one composed plugin entry; null when it has no fiber. */
export type DshPluginPhase =
  | "pending"
  | "loading"
  | "active"
  | "failed"
  | "unloading"
  | null;

/** One plugin the runtime actually composed, as the Loader reports it. */
export type DshPluginEntry = {
  id: string;
  module: string;
  /** Package behind the module specifier; our own rows are entry URLs. */
  package: string;
  /** Composition group rows are filtered out server-side; kept for clarity. */
  group?: boolean;
  enabled: boolean;
  phase: DshPluginPhase;
  /** `session` when the row lives inside one session's subtree. */
  scope: "session" | "global";
  sessionId: string | null;
  title: { zh: string; en: string } | null;
  description: { zh: string; en: string } | null;
};

export const dshPluginApi = {
  list: () => feature<{ entries: DshPluginEntry[] }>("dsh_plugins"),
};

/** One tool the runtime registers for a session created now. */
export type DshToolEntry = {
  name: string;
  description: string;
  /** Model-facing JSON schema (property names, required list, …). */
  parameters: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  /** Registered behind a mode (Agent Team's board tools) rather than composed. */
  conditional: boolean;
};

export const dshToolApi = {
  list: () => feature<{ tools: DshToolEntry[] }>("dsh_tools"),
};

export const dshPolicyApi = {
  /** The mode is part of `agent_settings_get`; only writes go through policy. */
  set: (mode: DshPermissionMode) =>
    feature<{ mode: DshPermissionMode }>("dsh_policy_set", { mode }),
};

/** One model a provider endpoint or the engine's catalog advertises. */
export type DshDiscoveredModel = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  inputModalities?: string[];
};

export const dshModelApi = {
  /**
   * Asks the running engine for a draft endpoint's model list. Catalog routes
   * are answered from the installed catalog, everything else from its listing.
   */
  discover: (request: {
    provider: string;
    baseUrl: string;
    api: DshModelProtocol;
    apiKey?: string;
  }) => feature<{ models: DshDiscoveredModel[] }>("dsh_models_discover", request),
};

export const dshTeamApi = {
  /** Reads the persisted board; a session with no board returns it disabled. */
  get: (sessionId: string) => feature<{ team: DshTeam }>("dsh_team_get", { sessionId }),
  /** Enabling only switches the engine's Team tools on; nothing is queued. */
  set: (sessionId: string, enabled: boolean) =>
    feature<{ team: DshTeam }>("dsh_team_set", { sessionId, enabled }),
};

/** A request the runtime is still blocked on (snapshot after a page reload). */
export type DshPendingRequest =
  | { rpcId: number; sessionId: string; kind: "approval"; request: DshApprovalRequest }
  | { rpcId: number; sessionId: string; kind: "question"; request: DshQuestionRequest };
