import { listen } from "@tauri-apps/api/event";

import {
  agentApi,
  isAgentTerminalStatus,
  type AgentChangeSummary,
  type AgentRuntimeStatus,
  type AgentTasksState,
  type AgentTask,
} from "./agent";
import { createExternalStore } from "./store";

type AgentRuntimeEvent = {
  taskId: string;
  status?: AgentRuntimeStatus | null;
};

/** Pushed while the changes panel is open for a running task. */
type AgentTaskChangesEvent = {
  taskId: string;
  changes: AgentChangeSummary;
};

/**
 * Shared `agent://state` snapshot. App and AgentPage both read this store, so
 * the app has one initial fetch and one event subscription in total.
 */
export const agentTasksStore = createExternalStore<AgentTasksState | null>(null);

/**
 * Latest `agent://task_changes` summary per task. Only populated by the push
 * channel; callers fall back to `agent_task_changes` / `task.changes` when a
 * task has no entry here. Entries are dropped once the task is terminal or
 * gone from the queue snapshot.
 */
export const agentTaskChangesStore = createExternalStore<
  Record<string, AgentChangeSummary>
>({});

/** Drops pushed summaries for tasks that finished or left the queue. */
const pruneTaskChanges = (tasks: AgentTask[]): void => {
  const statuses = new Map(tasks.map((task) => [task.id, task.status] as const));
  agentTaskChangesStore.set((current) => {
    const entries = Object.entries(current);
    if (entries.length === 0) return current;
    let dropped = false;
    const next: Record<string, AgentChangeSummary> = {};
    for (const [taskId, summary] of entries) {
      const status = statuses.get(taskId);
      if (!status || isAgentTerminalStatus(status)) {
        dropped = true;
        continue;
      }
      next[taskId] = summary;
    }
    return dropped ? next : current;
  });
};

let subscriberCount = 0;
let stopSubscription: (() => void) | null = null;

const startSubscription = (): (() => void) => {
  let cancelled = false;
  let unlisten: (() => void) | undefined;

  void agentApi
    .tasksList()
    .then((state) => {
      if (cancelled) return;
      agentTasksStore.set(state);
      pruneTaskChanges(state.tasks);
    })
    .catch(() => {
      // Settle the UI instead of leaving it on the loading state; a focus or
      // any queue action retries through the normal refresh path.
      if (!cancelled) {
        agentTasksStore.set({ tasks: [], activeTaskId: null, queuePaused: false });
      }
    });

  void listen<AgentTasksState>("agent://state", (event) => {
    if (cancelled) return;
    agentTasksStore.set(event.payload);
    pruneTaskChanges(event.payload.tasks);
  }).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });

  // 运行时状态更新频繁，单独推送，避免每次工具事件都重发整份任务列表。
  let unlistenRuntime: (() => void) | undefined;
  void listen<AgentRuntimeEvent>("agent://runtime", (event) => {
    if (cancelled) return;
    agentTasksStore.set((current) => {
      if (!current) return current;
      const next = { ...(current.runtimeStatus ?? {}) };
      if (event.payload.status) {
        next[event.payload.taskId] = event.payload.status;
      } else {
        delete next[event.payload.taskId];
      }
      return { ...current, runtimeStatus: next };
    });
  }).then((fn) => {
    if (cancelled) fn();
    else unlistenRuntime = fn;
  });

  // 变更面板打开时后端才推送；单独保存，避免覆盖命令返回的完整快照。
  let unlistenChanges: (() => void) | undefined;
  void listen<AgentTaskChangesEvent>("agent://task_changes", (event) => {
    if (cancelled) return;
    const { taskId, changes } = event.payload ?? {};
    if (!taskId || !changes) return;
    agentTaskChangesStore.set((current) => ({ ...current, [taskId]: changes }));
  }).then((fn) => {
    if (cancelled) fn();
    else unlistenChanges = fn;
  });

  return () => {
    cancelled = true;
    unlisten?.();
    unlistenRuntime?.();
    unlistenChanges?.();
  };
};

/**
 * Ref-counted subscription: the first consumer starts the initial snapshot and
 * the event listener, and the last one releases them.
 */
export function acquireAgentTasksStore(): () => void {
  subscriberCount += 1;
  if (!stopSubscription) stopSubscription = startSubscription();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberCount -= 1;
    if (subscriberCount === 0) {
      stopSubscription?.();
      stopSubscription = null;
    }
  };
}

/** React binding for the shared agent task snapshot. */
export function useAgentTasksStore(): AgentTasksState | null {
  return agentTasksStore.use();
}

/** Latest pushed summary for one task, or undefined when nothing arrived. */
export function useAgentTaskChanges(
  taskId: string | null | undefined,
): AgentChangeSummary | undefined {
  const changes = agentTaskChangesStore.use();
  return taskId ? changes[taskId] : undefined;
}
