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
};

/** One session row as the runtime reports it. */
export type DshSessionRow = {
  id: string;
  title: string;
  updatedAt: string;
  status: DshSessionStatus;
  messageCount: number;
  usage: DshSessionUsage;
};

export type DshEntry =
  | { kind: "user"; seq: number; at: string; text: string }
  | {
      kind: "assistant";
      seq: number;
      at: string;
      text: string;
      reasoning?: string;
      usage?: DshEntryUsage;
      provider?: string;
      model?: string;
    }
  | {
      kind: "tool";
      seq: number;
      at: string;
      callId: string;
      name: string;
      args: string;
      status: "running" | "ok" | "error";
      /** Raw result. The contract documents a string; the host forwards the
       *  JSON value it received, so the view normalizes either shape. */
      result?: unknown;
    }
  | { kind: "turn"; seq: number; at: string; state: "start" | "end"; reason?: string };

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
  ReasoningEffort,
};

/** The settings shape the runtime reads; the model block is part of it. */
export type DshAgentConfig = AgentConfig;

// ---------------------------------------------------------------------------
// Unified tasks (docs/DSH.md §9.1)
// ---------------------------------------------------------------------------

export type DshTaskKind = "chat" | "bug" | "local_item";

/** The only list grouping and the only state machine. */
export type DshTaskWorkflow =
  | "running"
  | "awaiting_review"
  | "awaiting_merge"
  | "done"
  | "failed"
  | "canceled";

export type DshTaskProject = {
  id: string;
  name: string;
  kind: "tapd" | "local";
};

export type DshTaskChanges = {
  files: number;
  additions: number;
  deletions: number;
};

/** Reserved for a model-written review; no producer yet. */
export type DshTaskReview = {
  summary: string;
  files: string[];
  risk?: string;
};

export type DshTaskMerge = {
  error?: string;
  instructions?: string;
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
  merge?: DshTaskMerge | null;
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
  newSession: () => invoke<{ sessionId: string }>("dsh_new_session"),
  sessions: () => invoke<{ sessions: DshSessionRow[] }>("dsh_sessions"),
  pending: () => invoke<{ requests: DshPendingRequest[] }>("dsh_pending"),
  sessionEntries: (sessionId: string) =>
    invoke<{ sessionId: string; known: boolean; entries: DshEntry[] }>(
      "dsh_session_entries",
      { sessionId },
    ),
  prompt: (sessionId: string, text: string) =>
    invoke<{ receipt: unknown }>("dsh_prompt", { sessionId, text }),
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
  | "dsh_tasks"
  | "dsh_task_enqueue_bug"
  | "dsh_task_enqueue_local"
  | "dsh_task_approve"
  | "dsh_task_merge"
  | "dsh_task_cancel"
  | "dsh_task_diff"
  | "dsh_task_resume"
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
  ) =>
    feature<{ task: DshTask }>("dsh_task_enqueue_bug", {
      workspaceId,
      bugId,
      ...(extraPrompt ? { extraPrompt } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    }),
  enqueueLocal: (
    projectId: string,
    itemId: string,
    extraPrompt?: string,
    attachments?: string[],
  ) =>
    feature<{ task: DshTask }>("dsh_task_enqueue_local", {
      projectId,
      itemId,
      ...(extraPrompt ? { extraPrompt } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    }),
  approve: (sessionId: string) =>
    feature<{ task: DshTask }>("dsh_task_approve", { sessionId }),
  merge: (sessionId: string) =>
    feature<{ task: DshTask }>("dsh_task_merge", { sessionId }),
  cancel: (sessionId: string, stash = false) =>
    feature<{ task: DshTask }>("dsh_task_cancel", { sessionId, stash }),
  diff: (sessionId: string) =>
    feature<{ diff: string; truncated: boolean }>("dsh_task_diff", { sessionId }),
  resume: (sessionId: string) =>
    feature<{ task: DshTask }>("dsh_task_resume", { sessionId }),
};

export const dshPolicyApi = {
  /** The mode is part of `agent_settings_get`; only writes go through policy. */
  set: (mode: DshPermissionMode) =>
    feature<{ mode: DshPermissionMode }>("dsh_policy_set", { mode }),
};

export const dshTeamApi = {
  /** Reads the persisted board; a session with no board returns it disabled. */
  get: (sessionId: string) => feature<{ team: DshTeam }>("dsh_team_get", { sessionId }),
  /** Enabling also queues the coworker roster into the session. */
  set: (sessionId: string, enabled: boolean) =>
    feature<{ team: DshTeam }>("dsh_team_set", { sessionId, enabled }),
};

/** A request the runtime is still blocked on (snapshot after a page reload). */
export type DshPendingRequest =
  | { rpcId: number; sessionId: string; kind: "approval"; request: DshApprovalRequest }
  | { rpcId: number; sessionId: string; kind: "question"; request: DshQuestionRequest };
