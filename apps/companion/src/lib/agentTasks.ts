/**
 * Shared `agent_tasks_list` feed: one poll while at least one mounted consumer
 * exists (tab badge in App, Agent page, settings worktree lock). Interval is
 * adaptive — 8s while the Agent tab is on screen, 30s elsewhere (the badge
 * only needs the counts) — and pauses entirely while the page is hidden.
 * The poll doubles as a desktop-recovery probe on gated screens.
 */
import { useEffect, useSyncExternalStore } from "react";

import { api, asApiError, type AgentTask, type AgentTasksState } from "./api";
import { isPageHidden, onPageVisibilityChange } from "./visibility";

/** Agent 页 / 任务详情实时节奏。 */
const POLL_ACTIVE_MS = 8000;
/** 其他页面的角标节奏。 */
const POLL_IDLE_MS = 30_000;

export type AgentPollMode = "active" | "idle";

let pollMode: AgentPollMode = "idle";

/** App switches the cadence with the visible tab; an armed timer restarts. */
export function setAgentPollMode(mode: AgentPollMode): void {
  if (pollMode === mode) return;
  pollMode = mode;
  if (timer !== null && consumers > 0) {
    stopPoll();
    startPoll();
  }
}

const pollInterval = (): number => (pollMode === "active" ? POLL_ACTIVE_MS : POLL_IDLE_MS);

export type AgentTasksFeed = {
  state: AgentTasksState | null;
  /** Last poll failure; rendered inline by consumers (errors persist). */
  error: string | null;
};

let feed: AgentTasksFeed = { state: null, error: null };
const listeners = new Set<() => void>();
let timer: number | null = null;
let consumers = 0;
let inFlight = false;

const emit = () => {
  for (const listener of listeners) listener();
};

const getFeed = (): AgentTasksFeed => feed;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Refresh once; concurrent calls collapse into the running one. */
export async function refreshAgentTasks(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const state = await api.agentTasks();
    feed = { state, error: null };
  } catch (err) {
    // Offline / not-logged-in gates take over visually; keep the last state.
    feed = { ...feed, error: asApiError(err).message };
  } finally {
    inFlight = false;
    emit();
  }
}

const startPoll = () => {
  if (timer !== null || isPageHidden() || consumers === 0) return;
  void refreshAgentTasks();
  timer = window.setInterval(() => void refreshAgentTasks(), pollInterval());
};

const stopPoll = () => {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
};

let visibilityHooked = false;

const hookVisibility = () => {
  if (visibilityHooked) return;
  visibilityHooked = true;
  onPageVisibilityChange(() => {
    // 隐藏暂停一切轮询；恢复可见立即补一轮再按当前节奏继续。
    if (isPageHidden()) stopPoll();
    else startPoll();
  });
};

/** Synchronous lookup, e.g. resolving a task id against the live feed. */
export const getAgentTasks = (): AgentTasksState | null => feed.state;

/**
 * Subscribes to the feed and keeps the poll alive while mounted. `refresh`
 * re-fetches right away (after a review action, retry, cancel …).
 */
export function useAgentTasks(): AgentTasksFeed & { refresh: () => void } {
  useSyncExternalStore(subscribe, getFeed, getFeed);

  useEffect(() => {
    consumers += 1;
    hookVisibility();
    startPoll();
    return () => {
      consumers -= 1;
      if (consumers === 0) stopPoll();
    };
  }, []);

  return { ...feed, refresh: () => void refreshAgentTasks() };
}

/** Section buckets for the Agent page: approval / merge / running / queued. */
export type AgentTaskBuckets = {
  approvals: AgentTask[];
  merges: AgentTask[];
  running: AgentTask[];
  queued: AgentTask[];
};

export function bucketAgentTasks(tasks: AgentTask[]): AgentTaskBuckets {
  const approvals: AgentTask[] = [];
  const merges: AgentTask[] = [];
  const running: AgentTask[] = [];
  const queued: AgentTask[] = [];
  for (const task of tasks) {
    switch (task.status) {
      case "awaiting_approval":
        approvals.push(task);
        break;
      case "awaiting_merge":
        merges.push(task);
        break;
      case "preparing":
      case "running":
      case "merging":
        running.push(task);
        break;
      case "queued":
        queued.push(task);
        break;
      default:
        break;
    }
  }
  return { approvals, merges, running, queued };
}
