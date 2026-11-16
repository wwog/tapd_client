import { agentBugKey, type AgentTask } from "./agent";
import { createExternalStore } from "./store";

/**
 * Development-only row states used by the bug-row context menu. Nothing here
 * touches the real queue: the values are merged into the UI maps so the
 * activity line and cancel button can be checked without enqueueing a real
 * task.
 */
export const DEV_SIM = import.meta.env.DEV;

export type DevSimKind = "agent-queued" | "agent-running";

export type DevSimEntry = {
  workspaceId: string;
  bugId: string;
  kind: DevSimKind;
  /** Milliseconds; keeps the elapsed counter stable while simulating. */
  startedAt: number;
};

type DevSimState = Record<string, DevSimEntry>;

const store = createExternalStore<DevSimState>({});

export function useDevSim(): DevSimState {
  return store.use();
}

export function setDevSim(
  workspaceId: string,
  bugId: string,
  kind: DevSimKind,
): void {
  if (!DEV_SIM) return;
  const key = agentBugKey(workspaceId, bugId);
  store.set((current) => ({
    ...current,
    [key]: { workspaceId, bugId, kind, startedAt: Date.now() },
  }));
}

export function clearDevSim(workspaceId: string, bugId: string): void {
  const key = agentBugKey(workspaceId, bugId);
  store.set((current) => {
    if (!(key in current)) return current;
    const next = { ...current };
    delete next[key];
    return next;
  });
}

/** Clears a simulated row when its 取消 button is pressed. */
export function clearDevSimForTask(taskId: string): boolean {
  const current = store.get();
  const key = Object.keys(current).find(
    (entry) => devSimTaskId(current[entry]) === taskId,
  );
  if (!key) return false;
  store.set((state) => {
    const next = { ...state };
    delete next[key];
    return next;
  });
  return true;
}

export function devSimTaskId(entry: DevSimEntry): string {
  return `dev-sim-${entry.workspaceId}-${entry.bugId}`;
}

export function devSimTask(entry: DevSimEntry): AgentTask {
  const queued = entry.kind === "agent-queued";
  return {
    id: devSimTaskId(entry),
    workspaceId: entry.workspaceId,
    workspaceName: "开发模拟", // i18n-exempt: dev-only mock data
    bugId: entry.bugId,
    title: "开发模拟任务", // i18n-exempt: dev-only mock data
    severity: "",
    priority: "",
    jsonPath: "",
    repoPath: "",
    status: queued ? "queued" : "running",
    createdAt: new Date(entry.startedAt).toISOString(),
    startedAt: queued ? undefined : new Date(entry.startedAt).toISOString(),
    prompt: "",
    source: "dev-sim",
  };
}
