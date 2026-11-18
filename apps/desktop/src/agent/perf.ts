/**
 * Dev-only instrumentation for the agent transcript.
 *
 * The WebView can be occluded (background window, hidden pane), and then rAF
 * and paint are paused; React commits still run. Recording commit durations
 * separately from frame timing is what lets us tell a slow React mount from a
 * slow layout/animation.
 *
 * Enable from the dev probe:
 *   window.__agentPerf.enable()
 *   window.__agentPerf.mark("open-fold")
 *   ...interact...
 *   window.__agentPerf.get()
 */
export type AgentCommit = {
  id: string;
  phase: "mount" | "update" | "nested-update";
  actualMs: number;
  baseMs: number;
  commitTime: number;
  /** Wall-clock mark this commit started after, when one was set. */
  sinceMark?: number;
};

type AgentPerf = {
  enable: () => void;
  disable: () => void;
  clear: () => void;
  mark: (name: string) => void;
  get: () => { commits: AgentCommit[]; marks: Record<string, number>; enabled: boolean };
};

const MAX_COMMITS = 600;
let enabled = false;
let commits: AgentCommit[] = [];
let marks: Record<string, number> = {};
let activeMark: { name: string; at: number } | null = null;

export function recordAgentCommit(input: {
  id: string;
  phase: AgentCommit["phase"];
  actualMs: number;
  baseMs: number;
  commitTime: number;
}): void {
  if (!enabled) return;
  commits.push({
    ...input,
    actualMs: Math.round(input.actualMs * 100) / 100,
    baseMs: Math.round(input.baseMs * 100) / 100,
    ...(activeMark
      ? { sinceMark: Math.round((performance.now() - activeMark.at) * 100) / 100 }
      : {}),
  });
  if (commits.length > MAX_COMMITS) commits.shift();
}

export function installAgentPerf(): void {
  if (typeof window === "undefined") return;
  const target = window as typeof window & { __agentPerf?: AgentPerf };
  if (target.__agentPerf) return;
  target.__agentPerf = {
    enable() {
      enabled = true;
      commits = [];
      marks = {};
      activeMark = null;
    },
    disable() {
      enabled = false;
    },
    clear() {
      commits = [];
      marks = {};
      activeMark = null;
    },
    mark(name: string) {
      const at = performance.now();
      marks[name] = at;
      activeMark = { name, at };
    },
    get() {
      return {
        commits: commits.slice(),
        marks: { ...marks },
        enabled,
      };
    },
  };
}
