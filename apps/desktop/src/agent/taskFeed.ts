/**
 * Workflow-task feed for surfaces outside the Agent page: the bug list's
 * row status line and the global workflow queue.
 *
 * The Agent store changes on every stream token, so subscribing to it whole
 * would re-render a 50-row bug table per token. This module keeps one cached,
 * signature-keyed snapshot of only the workflow facts those surfaces read.
 */
import { useSyncExternalStore } from "react";

import { resolveActiveModel } from "../lib/agentSettings";
import type { DshSessionStatus, DshTask } from "../lib/dsh";
import { agentStore, type AgentState } from "./store";

/** A row that still belongs to the workflow, including review/merging. */
const ACTIVE_WORKFLOWS = new Set([
  "queued",
  "running",
  "awaiting_review",
  "finalizing",
]);

/** Mirror of the backend's startup recovery grace (`recover_interrupted`). */
const INTERRUPT_GRACE_MS = 15_000;

export type TaskFeedEntry = {
  task: DshTask;
  /** Live session status; absent when the runtime has no row for it. */
  status: DshSessionStatus | undefined;
  /** The round was stopped and has not resumed. */
  interrupted: boolean;
  /** Model id the row should paint, resolved against the catalog. */
  model: string | null;
  /** 1-based global FIFO position; null when not queued. */
  position: number | null;
};

export type TaskFeedSnapshot = {
  /** False until the first task list read lands. */
  loaded: boolean;
  entries: TaskFeedEntry[];
  executionUnits: number;
};

const EMPTY: TaskFeedSnapshot = {
  loaded: false,
  entries: [],
  executionUnits: 0,
};

let cache: { key: string; value: TaskFeedSnapshot } | null = null;

/** Stable key for "this bug already owns a workflow task". */
export function bugTaskKey(workspaceId: string, bugId: string): string {
  return `${workspaceId}::${bugId}`;
}

/**
 * The engine's live route wins; the hand-over model covers a queued task that
 * has not produced a request yet; the configured default covers tasks created
 * without an explicit pick.
 */
export function taskModelName(state: AgentState, task: DshTask): string | null {
  const row = state.sessions[task.id];
  const recorded = row?.usage.model || row?.selection?.model || task.model;
  if (recorded) return recorded;
  return resolveActiveModel(state.config?.dshModels)?.model.id ?? null;
}

/**
 * A `running` row with no live turn is interrupted. The backend persists that
 * on a stop or at startup recovery; the age check covers the gap between a
 * crash and that recovery, and a failed runtime row covers an exit while the
 * app stayed open.
 */
export function taskInterrupted(
  state: AgentState,
  task: DshTask,
  now = Date.now(),
): boolean {
  // A chat has no workflow to resume: `running` is only its neutral value, and
  // an idle chat is finished, not stopped. Without this guard every chat older
  // than the grace period painted 已中断.
  if (task.kind === "chat") return false;
  if (task.workflow !== "running") return false;
  if (task.interrupted) return true;
  const status = state.sessions[task.id]?.status;
  if (status === "running") return false;
  if (status === "failed") return true;
  // Only a ready runtime has a complete session registry: during startup a
  // missing row means "not read yet", not "stopped".
  if (state.status?.phase !== "ready") return false;
  const updated = Date.parse(task.updatedAt);
  return Number.isFinite(updated) && now - updated > INTERRUPT_GRACE_MS;
}

/** Queue order mirrors `next_queued`: immutable creation time, then id. */
export function queueOrder(left: DshTask, right: DshTask): number {
  return (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}

function buildSnapshot(state: AgentState): TaskFeedSnapshot {
  const tasks = state.tasks;
  if (!tasks) return EMPTY;

  const now = Date.now();
  const queued = tasks
    .filter((task) => task.kind !== "chat" && task.workflow === "queued")
    .sort(queueOrder);
  const positions = new Map(queued.map((task, index) => [task.id, index + 1]));

  const entries: TaskFeedEntry[] = [];
  for (const task of tasks) {
    if (task.kind === "chat" || !ACTIVE_WORKFLOWS.has(task.workflow)) continue;
    entries.push({
      task,
      status: state.sessions[task.id]?.status,
      interrupted: taskInterrupted(state, task, now),
      model: taskModelName(state, task),
      position: positions.get(task.id) ?? null,
    });
  }

  return {
    loaded: true,
    entries,
    executionUnits: state.config?.executionUnits ?? 0,
  };
}

function signature(value: TaskFeedSnapshot): string {
  if (!value.loaded) return "loading";
  return value.entries
    .map(
      (entry) =>
        [
          entry.task.id,
          entry.task.workflow,
          entry.task.updatedAt,
          entry.task.interrupted ? "1" : "0",
          entry.status ?? "",
          entry.model ?? "",
          entry.position ?? "",
        ].join(":"),
    )
    .join("|");
}

function select(): TaskFeedSnapshot {
  const next = buildSnapshot(agentStore.get());
  const key = signature(next);
  if (cache && cache.key === key) return cache.value;
  cache = { key, value: next };
  return next;
}

/** The workflow feed; re-renders only when a painted fact changes. */
export function useTaskFeed(): TaskFeedSnapshot {
  return useSyncExternalStore(agentStore.subscribe, select, select);
}

/** Active workflow tasks of one TAPD project, newest activity first. */
export function workspaceEntries(
  feed: TaskFeedSnapshot,
  workspaceId: string | null | undefined,
): TaskFeedEntry[] {
  if (!workspaceId) return [];
  return feed.entries
    .filter(
      (entry) =>
        entry.task.project?.kind === "tapd" &&
        entry.task.project.id === workspaceId,
    )
    .sort((left, right) =>
      right.task.updatedAt.localeCompare(left.task.updatedAt),
    );
}

/**
 * Bugs whose tasks are still in the queue (running or waiting). These leave the
 * normal list; review/merging rows stay there.
 */
export function queuedBugEntries(entries: TaskFeedEntry[]): TaskFeedEntry[] {
  return entries.filter(
    (entry) =>
      Boolean(entry.task.bugId) &&
      (entry.task.workflow === "queued" || entry.task.workflow === "running"),
  );
}
