/**
 * Shared `agent_tasks_list` feed: one 8s poll while at least one mounted
 * consumer exists (tab badge in App, Agent page, settings worktree lock).
 * The poll doubles as a desktop-recovery probe on gated screens.
 */
import { useEffect, useSyncExternalStore } from "react";

import { api, asApiError, type AgentTask, type AgentTasksState } from "./api";

const POLL_MS = 8000;

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
  if (timer !== null) return;
  void refreshAgentTasks();
  timer = window.setInterval(() => void refreshAgentTasks(), POLL_MS);
};

const stopPoll = () => {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
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
