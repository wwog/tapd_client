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

export type DshSession = {
  id: string;
  title: string;
  updatedAt: string;
  status: DshSessionStatus;
  messageCount: number;
};

/* -------------------------------------------------------------------------
   Unified task list (docs/DSH.md §9.1)
   ------------------------------------------------------------------------- */

export type DshTaskKind = "chat" | "bug" | "local_item";
export type DshProjectKind = "tapd" | "local";
export type DshWorkflow =
  | "running"
  | "awaiting_review"
  | "awaiting_merge"
  | "done"
  | "failed"
  | "canceled";

export type DshTaskProject = { id: string; name: string; kind: DshProjectKind };

export type DshTaskChanges = { files: number; additions: number; deletions: number };

/** Reserved for a model-written review; no producer yet. */
export type DshTaskReview = { summary: string; files: string[]; risk: string };

export type DshTaskMerge = { error?: string; instructions?: string };

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
  repoPath?: string;
  worktreePath?: string;
  branch?: string;
  jsonPath?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  changes?: DshTaskChanges | null;
  review?: DshTaskReview | null;
  merge?: DshTaskMerge | null;
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

/** One rendered transcript row; `seq` is unique and monotonic per session. */
export type DshEntry =
  | { kind: "user"; seq: number; at: string; turn: number; step: number; text: string }
  | {
      kind: "assistant";
      seq: number;
      at: string;
      turn: number;
      step: number;
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
      startedAtMs?: number;
      firstTokenAtMs?: number;
      completedAtMs?: number;
    }
  | {
      kind: "tool";
      seq: number;
      at: string;
      turn: number;
      step: number;
      callId: string;
      name: string;
      args: string;
      status: DshToolStatus;
      result?: string;
      startedAtMs?: number;
      endedAtMs?: number;
    }
  | {
      kind: "turn";
      seq: number;
      at: string;
      turn: number;
      state: "start" | "end";
      reason?: string;
      error?: string;
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

  /** Allocates a session id; the runtime creates the session at first prompt. */
  newSession: () => feature<{ sessionId: string }>("dsh_new_session"),
  prompt: (sessionId: string, text: string) =>
    feature<{ receipt: unknown }>("dsh_prompt", { sessionId, text }),

  tasks: () => feature<{ tasks: DshTask[] }>("dsh_tasks"),
  taskApprove: (sessionId: string) =>
    feature<{ task: DshTask }>("dsh_task_approve", { sessionId }),
  taskMerge: (sessionId: string) =>
    feature<{ task: DshTask }>("dsh_task_merge", { sessionId }),
  /** `stash` preserves the working tree changes instead of discarding them. */
  taskCancel: (sessionId: string, stash = false) =>
    feature<{ task: DshTask }>("dsh_task_cancel", { sessionId, stash }),
  taskDiff: (sessionId: string, file?: string) =>
    feature<{ diff: string; truncated: boolean }>("dsh_task_diff", {
      sessionId,
      file: file ?? null,
    }),
  /** Reattaches a task's persisted dsh session after a desktop restart. */
  taskResume: (sessionId: string) =>
    feature<{ task: DshTask }>("dsh_task_resume", { sessionId }),

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
