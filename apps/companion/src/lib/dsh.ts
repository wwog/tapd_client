/**
 * Typed adapter for the built-in dsh runtime (desktop DeepSeek Harness).
 *
 * Every command goes through the companion feature proxy (`POST
 * /companion/api/feature`); the desktop executes it and returns the same serde
 * shapes its own windows consume. The phone renders transcripts and sends
 * prompts — it never talks to the runtime directly.
 *
 * Types are the contract of `dsh_*` commands (see docs/DSH.md). Everything is
 * funnelled through `dshApi`, so one transport/shape change is made in one
 * place.
 *
 * The task list and the blocking requests share one polled feed (`agentFeed`):
 * the tab bar badge, the task list and the session page all read the same
 * snapshot, so there is exactly one polling loop for `dsh_tasks` +
 * `dsh_pending` in the app.
 */
import { useEffect, useSyncExternalStore } from "react";

import { asApiError, feature } from "./api";
import type { DshModelsCatalog } from "./agentModels";
import { isPageHidden, onPageVisibilityChange } from "./visibility";

export type DshPhase = "stopped" | "starting" | "ready" | "failed";

export type DshStatus = {
  phase: DshPhase;
  payloadVersion?: string;
  nodeVersion?: string;
  provider?: string;
  model?: string;
  /** Stable machine code, e.g. `node_missing` / `model_missing`. */
  errorCode?: string;
  error?: string;
};

export type DshSessionStatus = "idle" | "running" | "failed";

/** `auto` / `notify` / `full`; plan is a separate engine flag, not a mode. */
export type DshPermissionMode = "auto" | "notify" | "full";

/** One session's model route; `reasoningEffort` absent means the adapter default. */
export type ModelSelection = {
  provider: string;
  model: string;
  reasoningEffort?: string;
};

/** Running totals the composer's status line reads (desktop parity). */
export type DshSessionUsage = {
  turns: number;
  steps: number;
  totalTokens: number;
  contextWindow: number;
  contextUsedTokens: number;
  tokensPerSecond: number;
  ttftMs: number;
  modelMs: number;
  provider: string;
  model: string;
};

export type DshSession = {
  id: string;
  title: string;
  updatedAt: string;
  status: DshSessionStatus;
  messageCount: number;
  usage?: DshSessionUsage;
  /** The route the session will use next; absent until one is recorded. */
  selection?: ModelSelection;
  /** The engine's plan mode for this session (`plan/mode` events). */
  planActive?: boolean;
  /** Current session todo list (`todo/write`); empty until the agent plans. */
  todos?: DshTodo[];
  /** Present on a child agent session: the parent session it was started
   *  from. Root sessions never set it. */
  parentSession?: string;
  /** The agent preset a child was started with; absent on root sessions. */
  agentPreset?: string;
};

/**
 * One entry of the session todo list (`todo/write`, whole-list replacement).
 * No id: every write replaces the list, so entries have no stable identity.
 */
export type DshTodo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

/* -------------------------------------------------------------------------
   Unified task list (docs/AGENT_TASK_FLOW.md §12.1)
   ------------------------------------------------------------------------- */

export type DshTaskKind = "chat" | "bug" | "local_item";
export type DshProjectKind = "tapd" | "local";

/**
 * The workflow state machine (docs/AGENT_TASK_FLOW.md §3): `queued` waits for
 * an execution slot, `awaiting_review` is the human gate and `finalizing` is
 * the host's commit → merge → cleanup → TAPD writeback run.
 */
export type DshWorkflow =
  | "queued"
  | "running"
  | "awaiting_review"
  | "finalizing"
  | "done"
  | "failed"
  | "canceled";

export type DshTaskProject = { id: string; name: string; kind: DshProjectKind };

/** One project group header source (`dsh_projects`). */
export type DshProjectOption = {
  kind: DshProjectKind;
  id: string;
  name: string;
  repoPath?: string;
};

export type DshTaskChanges = { files: number; additions: number; deletions: number };

/** What the model wrote with `task_submit`; shown on the review screen. */
export type DshTaskReview = {
  summary: string;
  verification?: string;
  risks?: string;
  files: string[];
};

export type DshFinalizeStep = "commit" | "merge" | "cleanup" | "writeback";

/** Host-side finishing progress; `step` marks where a failure stopped. */
export type DshTaskFinalize = {
  step: DshFinalizeStep | null;
  error?: string;
  instructions?: string;
  notice?: string;
};

export type DshTaskFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

/** One changed file inside the task's worktree. */
export type DshTaskFile = {
  path: string;
  status: DshTaskFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
};

/** One list row = one dsh session plus our workflow metadata. */
export type DshTask = {
  id: string;
  kind: DshTaskKind;
  /** `null` for a free chat with no project behind it. */
  project: DshTaskProject | null;
  title: string;
  /** Only on `kind: "bug"`. */
  bugId?: string;
  workflow: DshWorkflow;
  status: DshSessionStatus;
  /** The round was stopped and the workflow has not resumed it. */
  interrupted?: boolean;
  repoPath?: string;
  worktreePath?: string;
  branch?: string;
  jsonPath?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  changes?: DshTaskChanges | null;
  review?: DshTaskReview | null;
  finalize?: DshTaskFinalize | null;
  /** The round's start / commit / merge revisions, for the task pane. */
  git: DshTaskGit;
  /** TAPD write-back result of the finished round. */
  writeback: DshTaskWriteback;
  /** This round works directly in the repository (no worktree, no merge). */
  direct: boolean;
};

export type DshTaskGit = {
  /** The round's starting revision (worktree baseline or repo HEAD). */
  start?: string;
  /** The commit the finishing chain created. */
  commit?: string;
  /** The merge commit, absent for direct rounds. */
  merge?: string;
};

export type DshTaskWriteback = {
  comment: boolean;
  statusFrom?: string;
  statusTo?: string;
};

export function isTerminalWorkflow(workflow: DshWorkflow): boolean {
  return workflow === "done" || workflow === "failed" || workflow === "canceled";
}

export type DshToolStatus = "running" | "ok" | "error";

/* -------------------------------------------------------------------------
   Team board (docs/DSH.md §9.5)
   ------------------------------------------------------------------------- */

export type DshTeamTaskStatus = "pending" | "in_progress" | "completed";

export type DshTeamTask = {
  id: string;
  subject: string;
  description: string;
  status: DshTeamTaskStatus;
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

/** dsh's 1-based turn/step counters; a step is one model request. */
type DshEntryPosition = { turn: number; step: number };

/**
 * One rendered transcript row; `seq` is unique and monotonic per session.
 * Field names mirror `apps/desktop/src/lib/dsh.ts` (the serde contract lives
 * in `crates/dsh-host/src/transcript.rs`), so the shared agent view consumes
 * both apps' rows unchanged.
 */
export type DshEntry =
  | ({ kind: "user"; seq: number; at: string; text: string } & DshEntryPosition)
  | ({
      kind: "assistant";
      seq: number;
      at: string;
      text: string;
      reasoning?: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        totalTokens: number;
      };
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
      status: DshToolStatus;
      /** Model-facing result text (docs/DSH.md §8.3). The host sends a string;
       *  the view still normalizes objects so an older producer cannot crash it. */
      result?: unknown;
      /** `tool/call` time (epoch ms). */
      startedAtMs?: number;
      /** `tool/result` time (epoch ms); absent while running. */
      endedAtMs?: number;
      /** Child session of a `subagent`/`subagent_fork` call (`subagent/catalog`). */
      childSessionId?: string;
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
       *  user/message). Rendered as part of the sub-agent group, never as a
       *  human bubble. */
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
  | ({
      /** Injected request context (non-human `user/message` source, or
       *  `developer/message`). Trajectory only. */
      kind: "context";
      seq: number;
      at: string;
      text: string;
      producer?: string;
      form?: string;
    } & DshEntryPosition)
  | ({
      /** The full request header: route + capacity + tool names. */
      kind: "request";
      seq: number;
      at: string;
      reason: string;
      provider?: string;
      model?: string;
      effort?: string;
      maxTokens?: number;
      tools: string[];
    } & DshEntryPosition)
  | ({
      /** One provider-routed retry wait (`llm/retry`). */
      kind: "retry";
      seq: number;
      at: string;
      provider: string;
      retry: number;
      maxRetries?: number;
      delayMs: number;
      message: string;
      code: string;
      status?: number;
    } & DshEntryPosition)
  | ({
      /** A request attempt that committed no message (`assistant/attempt`). */
      kind: "attempt";
      seq: number;
      at: string;
      startedAtMs?: number;
      endedAtMs?: number;
    } & DshEntryPosition)
  | ({
      /** One compaction cycle, merged in place (start → summary → end). */
      kind: "compaction";
      seq: number;
      at: string;
      status: "running" | "ok" | "error";
      summary?: string;
      shadowedTokens?: number;
      error?: string;
    } & DshEntryPosition)
  | ({
      /** A PTC sub-call nested in a parent tool call. */
      kind: "subcall";
      seq: number;
      at: string;
      callId: string;
      parentCallId: string;
      name: string;
      args: string;
      status: "running" | "ok" | "error";
      result?: string;
      startedAtMs?: number;
      endedAtMs?: number;
    } & DshEntryPosition)
  | {
      /** The inherited-history boundary (`session/end-seed`). */
      kind: "seed";
      seq: number;
      at: string;
      inherited?: boolean;
    };

/* -------------------------------------------------------------------------
   Blocking requests: approvals and user questions (docs/DSH.md §4.4, §8.7)
   ------------------------------------------------------------------------- */

/** Only `allowed-once` grants a tool call; the rest deny or cancel it. */
export type DshApprovalOutcome = "allowed-once" | "rejected" | "cancelled";

export type DshApprovalRequest = {
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
};

export type DshQuestionOption = { label: string; description?: string };

export type DshQuestion = {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: DshQuestionOption[];
  multiSelect?: boolean;
  /** Presentation hint (`plan-review`, `approval`, …); display only. */
  intent?: unknown;
};

export type DshQuestionRequest = {
  requestId: string;
  sessionId: string;
  questions: DshQuestion[];
};

export type DshPendingRequest =
  | { rpcId: number; sessionId: string; kind: "approval"; request: DshApprovalRequest }
  | { rpcId: number; sessionId: string; kind: "question"; request: DshQuestionRequest };

export type DshAnswer = { id: string; selected: string[]; custom?: string };

export const dshApi = {
  status: () => feature<DshStatus>("dsh_status"),
  /** Extracts the payload and starts + initializes the runtime. */
  start: () => feature<DshStatus>("dsh_start"),
  stop: () => feature<DshStatus>("dsh_stop"),

  sessions: () => feature<{ sessions: DshSession[] }>("dsh_sessions"),
  entries: (sessionId: string, sinceSeq?: number) =>
    feature<{ sessionId: string; known: boolean; entries: DshEntry[]; lastSeq: number }>(
      "dsh_session_entries",
      sinceSeq === undefined ? { sessionId } : { sessionId, sinceSeq },
    ),
  pending: () => feature<{ requests: DshPendingRequest[] }>("dsh_pending"),

  /** Allocates a session id; the runtime creates the session at first prompt.
   *  A project scopes the chat to that repo (and its group); manual sessions
   *  are always free chats. */
  newSession: (project?: { kind: DshProjectKind; id: string }) =>
    feature<{ sessionId: string }>("dsh_new_session", project ? { project } : {}),
  prompt: (sessionId: string, text: string) =>
    feature<{ receipt: unknown }>("dsh_prompt", { sessionId, text }),
  /** Stops the running turn; pending approval/question requests settle as cancelled. */
  cancelTurn: (sessionId: string) =>
    feature<{ ok: true }>("dsh_session_cancel", { sessionId }),
  /** Session-local model route; recorded durably in the session's log. */
  selectModel: (sessionId: string, selection: ModelSelection) =>
    feature<{ ok: true }>("dsh_select_model", { sessionId, ...selection }),
  /** The sanitized model catalog (no API keys) for the composer picker. */
  agentModels: () => feature<{ models: DshModelsCatalog }>("settings_agent_models"),

  /** One session's permission mode; `mode: null` means "inherit the default". */
  sessionMode: (sessionId: string) =>
    feature<{ sessionId: string; mode: DshPermissionMode | null }>(
      "dsh_session_mode_get",
      { sessionId },
    ),
  /** Sets the mode and/or the plan flag; both apply at the next tool call. */
  setSessionMode: (sessionId: string, patch: { mode?: DshPermissionMode; plan?: boolean }) =>
    feature<{ sessionId: string; mode: DshPermissionMode | null; plan: boolean | null }>(
      "dsh_session_mode_set",
      { sessionId, ...patch },
    ),
  /** The runtime-wide default mode a session without its own choice inherits. */
  policyGet: () => feature<{ mode: DshPermissionMode }>("dsh_policy_get"),

  tasks: () => feature<{ tasks: DshTask[] }>("dsh_tasks"),
  /** Hands a bug to the agent; the task queues until an execution slot frees. */
  taskEnqueueBug: (
    workspaceId: string,
    bugId: string,
    options: { extraPrompt?: string; model?: ModelSelection } = {},
  ) =>
    feature<{ task: DshTask }>("dsh_task_enqueue_bug", {
      workspaceId,
      bugId,
      ...(options.extraPrompt ? { extraPrompt: options.extraPrompt } : {}),
      ...(options.model ? { model: options.model } : {}),
    }),
  /** Hands a local work item to the agent; same queue as a bug task. */
  taskEnqueueLocal: (
    projectId: string,
    itemId: string,
    options: { extraPrompt?: string; model?: ModelSelection } = {},
  ) =>
    feature<{ task: DshTask }>("dsh_task_enqueue_local", {
      projectId,
      itemId,
      ...(options.extraPrompt ? { extraPrompt: options.extraPrompt } : {}),
      ...(options.model ? { model: options.model } : {}),
    }),
  /** Commits → merges → cleans the worktree → starts TAPD writeback. */
  taskApprove: (sessionId: string) =>
    feature<{ task: DshTask }>("dsh_task_approve", { sessionId }),
  /** Re-runs finishing from `finalize.step`. */
  taskRetryFinalize: (sessionId: string) =>
    feature<{ task: DshTask }>("dsh_task_retry_finalize", { sessionId }),
  /** `stash` preserves the working tree changes instead of discarding them. */
  taskCancel: (sessionId: string, stash = false) =>
    feature<{ task: DshTask }>("dsh_task_cancel", { sessionId, stash }),
  /** The changed files of the task's worktree (review screen list). */
  taskChanges: (sessionId: string) =>
    feature<{ files: DshTaskFile[]; truncated: boolean }>("dsh_task_changes", {
      sessionId,
    }),
  taskDiff: (sessionId: string, file?: string) =>
    feature<{ diff: string; truncated: boolean }>("dsh_task_diff", {
      sessionId,
      file: file ?? null,
    }),
  /** Reattaches a task's persisted dsh session after a desktop restart. */
  taskResume: (sessionId: string) =>
    feature<{ task: DshTask }>("dsh_task_resume", { sessionId }),

  /** Every configured project (TAPD + local) so empty groups still render. */
  projects: () => feature<{ projects: DshProjectOption[] }>("dsh_projects"),
  /** Free-chat worktree switch; only meaningful for an idle chat session. */
  chatWorktree: (sessionId: string, enabled: boolean) =>
    feature<{ task: DshTask }>("dsh_chat_worktree", { sessionId, enabled }),

  /** The persisted board of one session; disabled with no tasks by default. */
  teamGet: (sessionId: string) => feature<{ team: DshTeam }>("dsh_team_get", { sessionId }),
  /** Enabling also queues the coworker roster into the session. */
  teamSet: (sessionId: string, enabled: boolean) =>
    feature<{ team: DshTeam }>("dsh_team_set", { sessionId, enabled }),

  approvalAnswer: (rpcId: number, outcome: DshApprovalOutcome) =>
    feature<{ ok: true }>("dsh_approval_answer", { rpcId, outcome }),
  /** `answers: null` dismisses the question (the runtime gets a cancellation). */
  questionAnswer: (rpcId: number, answers: DshAnswer[] | null) =>
    feature<{ ok: true }>("dsh_question_answer", { rpcId, answers }),
};

/* -------------------------------------------------------------------------
   Polled task/request feed — the single source for the list, the badge and
   the session page.
   ------------------------------------------------------------------------- */

export type AgentFeed = {
  /** `null` until the first successful load. */
  tasks: DshTask[] | null;
  tasksError: string | null;
  /** Oldest first, exactly as the runtime reports them. */
  pending: DshPendingRequest[];
  pendingError: string | null;
  /** Team boards per session, keyed by id; only the open task is polled. */
  teams: Record<string, DshTeam>;
  teamErrors: Record<string, string | null>;
};

/** Task list cadence; the badge and the open board are part of the same loop. */
const FEED_POLL_MS = 8_000;

const emptyFeed = (): AgentFeed => ({
  tasks: null,
  tasksError: null,
  pending: [],
  pendingError: null,
  teams: {},
  teamErrors: {},
});

let feed: AgentFeed = emptyFeed();
const feedListeners = new Set<() => void>();
let queue: Promise<void> = Promise.resolve();

/**
 * The session whose board the poller refreshes. The task page registers it on
 * open, so the app keeps one polling loop instead of one per board.
 */
let watchedTeamSession: string | null = null;

const publish = (next: AgentFeed): void => {
  feed = next;
  for (const listener of feedListeners) listener();
};

const fetchFeed = async (): Promise<void> => {
  const watched = watchedTeamSession;
  const [tasks, pending, team] = await Promise.allSettled([
    dshApi.tasks(),
    dshApi.pending(),
    watched ? dshApi.teamGet(watched) : Promise.resolve(null),
  ]);

  const teamError = team.status === "rejected" ? asApiError(team.reason).message : null;
  publish({
    // A failed call keeps the last good rows: an inline error explains the gap.
    tasks: tasks.status === "fulfilled" ? tasks.value.tasks : feed.tasks,
    tasksError: tasks.status === "fulfilled" ? null : asApiError(tasks.reason).message,
    pending: pending.status === "fulfilled" ? pending.value.requests : feed.pending,
    pendingError:
      pending.status === "fulfilled" ? null : asApiError(pending.reason).message,
    teams:
      watched && team.status === "fulfilled" && team.value
        ? { ...feed.teams, [watched]: team.value.team }
        : feed.teams,
    teamErrors:
      watched === null ? feed.teamErrors : { ...feed.teamErrors, [watched]: teamError },
  });
};

/**
 * Refreshes both halves once. Calls are serialised so an answer that lands
 * while a poll is in flight still gets a request made after the answer.
 */
export const refreshAgentFeed = (): Promise<void> => {
  const next = queue.then(fetchFeed, fetchFeed);
  queue = next.catch(() => undefined);
  return next;
};

/** Folds one command's returned task into the current snapshot. */
export const applyAgentTask = (task: DshTask): void => {
  if (feed.tasks === null) return;
  const tasks = feed.tasks
    .map((row) => (row.id === task.id ? task : row))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  publish({ ...feed, tasks, tasksError: null });
};

/** Folds a `dsh_team_set` result (or a fresh read) into the snapshot. */
export const applyAgentTeam = (sessionId: string, team: DshTeam): void => {
  publish({
    ...feed,
    teams: { ...feed.teams, [sessionId]: team },
    teamErrors: { ...feed.teamErrors, [sessionId]: null },
  });
};

/**
 * Registers the session whose board the feed polls; `null` stops polling it.
 * Called by the open task page so the app keeps a single interval.
 */
export const watchAgentTeam = (sessionId: string | null): void => {
  if (watchedTeamSession === sessionId) return;
  watchedTeamSession = sessionId;
  if (sessionId) void refreshAgentFeed();
};

const subscribeFeed = (listener: () => void): (() => void) => {
  feedListeners.add(listener);
  return () => {
    feedListeners.delete(listener);
  };
};

const getFeed = (): AgentFeed => feed;

/** One snapshot for the tab badge, the task list and the session page. */
export function useAgentFeed(): AgentFeed {
  return useSyncExternalStore(subscribeFeed, getFeed, getFeed);
}

/**
 * Starts the feed's only polling loop. Mounted once by `App` (the badge lives
 * in the tab bar, so the loop must outlive the Agent tab).
 */
export function useAgentFeedPolling(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    void refreshAgentFeed();
    const timer = window.setInterval(() => {
      if (!isPageHidden()) void refreshAgentFeed();
    }, FEED_POLL_MS);
    const off = onPageVisibilityChange(() => {
      if (!isPageHidden()) void refreshAgentFeed();
    });
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [enabled]);
}
