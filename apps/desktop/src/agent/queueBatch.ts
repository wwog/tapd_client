/**
 * Workflow queue batches: one report per "the queue started and then finished"
 * window, plus the activity-bar badge.
 *
 * The Agent store only exposes the current task list, so a completed row can be
 * reopened or deleted later and lose its facts. This module therefore snapshots
 * the completion facts while the batch is open and persists the report in
 * `config.json`; the queue page reads that snapshot.
 */
import { useEffect, useSyncExternalStore } from "react";

import type { DshTask, DshTaskProject, DshTaskWorkflow } from "../lib/dsh";
import { createExternalStore } from "../lib/store";
import { readPref, writePref } from "../lib/uiPrefs";
import { agentStore } from "./store";
import { taskInterrupted } from "./taskFeed";

const PREF_KEY = "agent.queue-batch.v1";
const MAX_REPORT_ROWS = 50;
const MAX_ACTIVE_IDS = 200;

/** A task still belongs to the workflow until it reaches a terminal state. */
const OPEN_WORKFLOWS = new Set<DshTaskWorkflow>([
  "queued",
  "running",
  "awaiting_review",
  "finalizing",
]);

export type QueueReportStatus = "done" | "canceled" | "failed";

export type QueueReportRow = {
  id: string;
  kind: DshTask["kind"];
  title: string;
  project: DshTaskProject | null;
  bugId?: string;
  localItemId?: string;
  workflow: QueueReportStatus;
  changes: DshTask["changes"];
  git: DshTask["git"];
  writeback: DshTask["writeback"];
  model?: string;
  createdAt: string;
  finishedAt: string;
};

export type QueueReport = {
  startedAt: string;
  finishedAt: string;
  rows: QueueReportRow[];
};

type CurrentBatch = {
  startedAt: string;
  /** Every task that was open at some point in this batch. */
  activeIds: string[];
  completed: QueueReportRow[];
};

export type QueueBatchState = {
  current: CurrentBatch | null;
  report: QueueReport | null;
  /** The green badge until the queue view is opened. */
  unseen: boolean;
};

export type QueueBadge = "running" | "done" | null;

const INITIAL: QueueBatchState = { current: null, report: null, unseen: false };

const store = createExternalStore<QueueBatchState>(INITIAL);

/** The snapshot every queue surface reads. */
export function useQueueBatch(): QueueBatchState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Yellow while a batch is open, green until its report has been viewed. */
export function useQueueBadge(): QueueBadge {
  const state = useQueueBatch();
  if (state.current) return "running";
  return state.report && state.unseen ? "done" : null;
}

/** The queue view was opened: the green badge has done its job. */
export function markQueueReportSeen(): void {
  const state = store.get();
  if (!state.unseen) return;
  publish({ ...state, unseen: false });
}

function publish(next: QueueBatchState): void {
  store.set(next);
  writePref(PREF_KEY, next);
}

function snapshot(task: DshTask): QueueReportRow {
  return {
    id: task.id,
    kind: task.kind,
    title: task.title,
    project: task.project,
    ...(task.bugId ? { bugId: task.bugId } : {}),
    ...(task.localItemId ? { localItemId: task.localItemId } : {}),
    workflow: task.workflow as QueueReportStatus,
    changes: task.changes ?? null,
    git: task.git,
    writeback: task.writeback,
    ...(task.model ? { model: task.model } : {}),
    createdAt: task.createdAt,
    finishedAt: task.updatedAt,
  };
}

function reconcile(tasks: DshTask[]): void {
  const batchState = store.get();
  const agent = agentStore.get();
  // A stopped (interrupted) turn is not "in progress": it must not keep the
  // yellow badge lit forever while the user ignores it.
  const open = tasks.filter(
    (task) =>
      task.kind !== "chat" &&
      OPEN_WORKFLOWS.has(task.workflow) &&
      !(task.workflow === "running" && taskInterrupted(agent, task)),
  );
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const openIds = new Set(open.map((task) => task.id));

  let current = batchState.current
    ? {
        ...batchState.current,
        activeIds: [...batchState.current.activeIds],
        completed: [...batchState.current.completed],
      }
    : null;
  let report = batchState.report;
  let unseen = batchState.unseen;

  if (!current && open.length > 0) {
    current = {
      startedAt: new Date().toISOString(),
      activeIds: [],
      completed: [],
    };
  }

  if (current) {
    for (const id of openIds) {
      if (!current.activeIds.includes(id)) current.activeIds.push(id);
    }
    // Snapshot every task that was part of this batch and just settled.
    for (const id of current.activeIds) {
      const task = byId.get(id);
      if (!task || OPEN_WORKFLOWS.has(task.workflow)) continue;
      const row = snapshot(task);
      const index = current.completed.findIndex((item) => item.id === id);
      if (index >= 0) current.completed[index] = row;
      else current.completed.push(row);
    }
    // A row that was reopened is open again; it must not be reported as done
    // for this batch (the next settle will snapshot it afresh).
    current.completed = current.completed
      .filter((row) => !openIds.has(row.id))
      // A lingering review/finalizing task can keep this batch open for a long
      // time; the persisted blob must stay bounded.
      .slice(-MAX_REPORT_ROWS);
    // Once a settled task is snapshotted, only currently open ids are needed:
    // this keeps the persisted `activeIds` from growing across a long batch.
    current.activeIds = [...openIds].slice(-MAX_ACTIVE_IDS);

    if (open.length === 0) {
      if (current.completed.length > 0) {
        report = {
          startedAt: current.startedAt,
          finishedAt: new Date().toISOString(),
          rows: current.completed.slice(-MAX_REPORT_ROWS),
        };
        unseen = true;
      }
      current = null;
    }
  }

  const next = { current, report, unseen };
  if (JSON.stringify(next) !== JSON.stringify(batchState)) publish(next);
}

const REPORT_STATUSES = new Set(["done", "canceled", "failed"]);

/** A persisted row must be usable by the report UI; drop anything malformed. */
function isReportRow(value: unknown): value is QueueReportRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<QueueReportRow>;
  return (
    typeof row.id === "string" &&
    typeof row.title === "string" &&
    typeof row.finishedAt === "string" &&
    typeof row.workflow === "string" &&
    REPORT_STATUSES.has(row.workflow)
  );
}

function hydrate(): void {
  const saved = readPref<Partial<QueueBatchState>>(PREF_KEY);
  if (!saved || typeof saved !== "object") return;
  const rawCurrent = saved.current;
  const current =
    rawCurrent &&
    typeof rawCurrent === "object" &&
    typeof rawCurrent.startedAt === "string" &&
    Array.isArray(rawCurrent.activeIds) &&
    Array.isArray(rawCurrent.completed)
      ? {
          startedAt: rawCurrent.startedAt,
          activeIds: rawCurrent.activeIds
            .filter((id): id is string => typeof id === "string")
            .slice(-MAX_ACTIVE_IDS),
          completed: rawCurrent.completed
            .filter(isReportRow)
            .slice(-MAX_REPORT_ROWS),
        }
      : null;
  const rawReport = saved.report;
  const rows =
    rawReport &&
    typeof rawReport === "object" &&
    typeof rawReport.startedAt === "string" &&
    typeof rawReport.finishedAt === "string" &&
    Array.isArray(rawReport.rows)
      ? rawReport.rows.filter(isReportRow).slice(-MAX_REPORT_ROWS)
      : [];
  const report =
    rows.length > 0 && rawReport
      ? {
          startedAt: rawReport.startedAt!,
          finishedAt: rawReport.finishedAt!,
          rows,
        }
      : null;
  store.set({
    current,
    report,
    unseen: saved.unseen === true && report !== null,
  });
}

/**
 * Mounted once by App: hydrates the persisted batch, then watches task-list
 * replacements only (streams must not drive this state machine).
 */
/** Open-task facts that change `taskInterrupted` without changing the list. */
function statusKey(state: ReturnType<typeof agentStore.get>): string {
  const tasks = state.tasks;
  if (!tasks) return "";
  return tasks
    .filter(
      (task) => task.kind !== "chat" && OPEN_WORKFLOWS.has(task.workflow),
    )
    .map(
      (task) =>
        `${task.id}:${task.interrupted ? "1" : "0"}:${
          state.sessions[task.id]?.status ?? ""
        }:${state.status?.phase ?? ""}`,
    )
    .join("|");
}

export function useQueueBatchRuntime(): void {
  useEffect(() => {
    hydrate();
    // A persisted batch must survive until the first real task list arrives:
    // treating `null` (not read yet) as an empty list would discard it.
    const initial = agentStore.get();
    let lastTasks = initial.tasks;
    let lastStatus = statusKey(initial);
    // A malformed persisted batch must never throw out of the agent store's
    // synchronous listener and break the other subscribers.
    const safeReconcile = (tasks: DshTask[]) => {
      try {
        reconcile(tasks);
      } catch (error) {
        console.warn("queue batch reconcile failed", error);
      }
    };
    if (lastTasks) safeReconcile(lastTasks);
    const unsubscribe = agentStore.subscribe(() => {
      const state = agentStore.get();
      const tasks = state.tasks;
      const status = statusKey(state);
      if (tasks === lastTasks && status === lastStatus) return;
      lastTasks = tasks;
      lastStatus = status;
      if (tasks) safeReconcile(tasks);
    });
    return unsubscribe;
  }, []);
}
