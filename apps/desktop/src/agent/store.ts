/**
 * Agent page state: runtime status, sessions, the selected history, live
 * streams and pending approvals / questions.
 *
 * It is a module store rather than component state because Tauri events arrive
 * outside React and the same facts are read by the session list, the stream and
 * the configuration tab. Streams are kept only for the selected session: the
 * backend replays history on demand, so stale buffers never need to survive a
 * switch.
 */
import {
  dshApi,
  dshSettingsApi,
  type DshAgentConfig,
  type DshApprovalEvent,
  type DshApprovalOutcome,
  type DshAnswer,
  type DshEntry,
  type DshEntryEvent,
  type DshErrorEvent,
  type DshQuestionEvent,
  type DshSession,
  type DshSessionEvent,
  type DshStatus,
  type DshStream,
} from "../lib/dsh";
import { createExternalStore } from "../lib/store";
import { readPref, writePref } from "../lib/uiPrefs";

export type AgentTab = "sessions" | "config";

export type LiveToolCall = {
  callId: string;
  name: string;
  args: string;
};

/** One attempt's accumulated stream, overlaid on committed history. */
export type LiveRun = {
  attemptId: string;
  revision: number;
  text: string;
  reasoning: string;
  tools: LiveToolCall[];
};

export type SessionHistory = {
  items: DshEntry[];
  loaded: boolean;
  error: string | null;
};

export type PendingApproval = {
  rpcId: number;
  sessionId: string;
  toolName: string;
  reason: string | null;
  busy: boolean;
};

export type PendingQuestion = {
  rpcId: number;
  sessionId: string;
  questions: DshQuestionEvent["request"]["questions"];
  busy: boolean;
};

/** The part of the agent settings the configuration tab owns. Projects and
 *  repository paths stay with the projects page and are merged on save. */
export type AgentConfigDraft = Pick<
  DshAgentConfig,
  "promptTemplate" | "worktreeEnabled" | "executionUnits" | "dshModel"
>;

export type AgentState = {
  tab: AgentTab;
  selectedId: string | null;
  sessions: DshSession[] | null;
  sessionsError: string | null;
  status: DshStatus | null;
  statusError: string | null;
  config: DshAgentConfig | null;
  configError: string | null;
  entries: Record<string, SessionHistory>;
  live: Record<string, LiveRun | undefined>;
  /** Prompts accepted by the runtime but not yet echoed as a user entry. */
  pendingPrompts: Record<string, string[] | undefined>;
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  preparingSince: number | null;
  starting: boolean;
  stopping: boolean;
  lastError: { code: string | null; message: string } | null;
};

/** Selected session and active tab are view state, but they survive page
 *  unmounts and restarts through the config.json preference blob. */
const UI_PREF_KEY = "agent.ui.v1";

type AgentPrefs = { tab?: unknown; sessionId?: unknown };

const initialState: AgentState = {
  tab: "sessions",
  selectedId: null,
  sessions: null,
  sessionsError: null,
  status: null,
  statusError: null,
  config: null,
  configError: null,
  entries: {},
  live: {},
  pendingPrompts: {},
  approvals: [],
  questions: [],
  preparingSince: null,
  starting: false,
  stopping: false,
  lastError: null,
};

export const agentStore = createExternalStore<AgentState>(initialState);

function update(mutate: (state: AgentState) => AgentState): void {
  agentStore.set(mutate);
}

function setError(error: unknown, code: string | null = null): void {
  update((state) => ({
    ...state,
    lastError: { code, message: String(error) },
  }));
}

function persistPrefs(): void {
  const state = agentStore.get();
  writePref(UI_PREF_KEY, { tab: state.tab, sessionId: state.selectedId });
}

function hydratePrefs(): void {
  const saved = readPref<AgentPrefs>(UI_PREF_KEY);
  if (!saved) return;
  const tab: AgentTab = saved.tab === "config" ? "config" : "sessions";
  const sessionId =
    typeof saved.sessionId === "string" && saved.sessionId ? saved.sessionId : null;
  update((state) => ({
    ...state,
    tab,
    selectedId: state.selectedId ?? sessionId,
  }));
}

// ---------------------------------------------------------------------------
// History merge: a fetch and live entries can race. Fetched rows come first,
// live rows overwrite the same key, and everything sorts by sequence.
// ---------------------------------------------------------------------------

function entryKey(entry: DshEntry): string {
  if (entry.kind === "tool" && entry.callId) return `tool:${entry.callId}`;
  return `${entry.kind}:${entry.seq}`;
}

function upsertEntry(items: DshEntry[], entry: DshEntry): DshEntry[] {
  const key = entryKey(entry);
  const index = items.findIndex((item) => entryKey(item) === key);
  if (index === -1) return [...items, entry].sort((a, b) => a.seq - b.seq);
  const next = items.slice();
  next[index] = entry;
  return next;
}

function mergeEntries(fetched: DshEntry[], live: DshEntry[]): DshEntry[] {
  const merged = new Map<string, DshEntry>();
  for (const entry of fetched) merged.set(entryKey(entry), entry);
  for (const entry of live) merged.set(entryKey(entry), entry);
  return [...merged.values()].sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function applyEntry(payload: DshEntryEvent): void {
  update((state) => {
    if (payload.sessionId !== state.selectedId) return state;
    const bucket = state.entries[payload.sessionId];
    if (!bucket) return state;

    const { entry } = payload;
    let live = state.live;
    let pendingPrompts = state.pendingPrompts;

    if (entry.kind === "assistant") {
      // The committed message supersedes whatever the stream had accumulated.
      live = { ...live, [payload.sessionId]: undefined };
    } else if (entry.kind === "turn" && entry.state === "end") {
      live = { ...live, [payload.sessionId]: undefined };
      pendingPrompts = { ...pendingPrompts, [payload.sessionId]: [] };
    } else if (entry.kind === "user") {
      const queue = pendingPrompts[payload.sessionId];
      const index = queue ? queue.indexOf(entry.text) : -1;
      if (queue && index >= 0) {
        const next = queue.slice();
        next.splice(index, 1);
        pendingPrompts = { ...pendingPrompts, [payload.sessionId]: next };
      }
    }

    return {
      ...state,
      entries: {
        ...state.entries,
        [payload.sessionId]: {
          items: upsertEntry(bucket.items, entry),
          loaded: true,
          error: null,
        },
      },
      live,
      pendingPrompts,
    };
  });
}

function appendToolDelta(tools: LiveToolCall[], stream: DshStream): LiveToolCall[] {
  if (stream.delta.type !== "tool-call") return tools;
  const { callId = "", name, arguments: args } = stream.delta;
  let index = -1;
  if (callId) index = tools.findIndex((tool) => tool.callId === callId);
  if (index === -1 && tools.length > 0) {
    const last = tools[tools.length - 1];
    if (callId && last.callId === "") index = tools.length - 1;
    else if (!callId) index = tools.length - 1;
  }
  if (index === -1) {
    return [...tools, { callId, name: name ?? "", args: args ?? "" }];
  }
  const next = tools.slice();
  const current = next[index];
  next[index] = {
    callId: callId || current.callId,
    name: name || current.name,
    args: current.args + (args ?? ""),
  };
  return next;
}

function applyStream(payload: DshSessionEvent): void {
  update((state) => {
    if (payload.sessionId !== state.selectedId) return state;
    const { attemptId, revision, delta } = payload.stream;
    const current = state.live[payload.sessionId];
    const fresh = !current || current.attemptId !== attemptId || current.revision !== revision;
    const base: LiveRun = fresh
      ? { attemptId, revision, text: "", reasoning: "", tools: [] }
      : current;

    let next: LiveRun;
    if (delta.type === "text") {
      next = { ...base, text: base.text + delta.text };
    } else if (delta.type === "reasoning") {
      next = { ...base, reasoning: base.reasoning + delta.text };
    } else {
      next = { ...base, tools: appendToolDelta(base.tools, payload.stream) };
    }

    return {
      ...state,
      live: { ...state.live, [payload.sessionId]: next },
    };
  });
}

function applyApproval(payload: DshApprovalEvent): void {
  update((state) => {
    if (state.approvals.some((item) => item.rpcId === payload.rpcId)) return state;
    return {
      ...state,
      approvals: [
        ...state.approvals,
        {
          rpcId: payload.rpcId,
          sessionId: payload.request.sessionId,
          toolName: payload.request.toolName,
          reason: payload.request.reason ?? null,
          busy: false,
        },
      ],
    };
  });
}

function applyQuestion(payload: DshQuestionEvent): void {
  update((state) => {
    if (state.questions.some((item) => item.rpcId === payload.rpcId)) return state;
    return {
      ...state,
      questions: [
        ...state.questions,
        {
          rpcId: payload.rpcId,
          sessionId: payload.request.sessionId,
          questions: payload.request.questions,
          busy: false,
        },
      ],
    };
  });
}

async function loadEntries(sessionId: string): Promise<void> {
  update((state) => ({
    ...state,
    entries: {
      ...state.entries,
      [sessionId]: {
        items: state.entries[sessionId]?.items ?? [],
        loaded: false,
        error: null,
      },
    },
  }));
  try {
    const { entries, known } = await dshApi.sessionEntries(sessionId);
    if (!known) {
      // The runtime no longer knows this session (app restarted before the
      // bridge repopulated). Drop the stale selection instead of showing an
      // error the user can do nothing about.
      update((state) => {
        const next = { ...state.entries };
        delete next[sessionId];
        return {
          ...state,
          selectedId: state.selectedId === sessionId ? null : state.selectedId,
          entries: next,
        };
      });
      persistPrefs();
      return;
    }
    update((state) => {
      const current = state.entries[sessionId];
      if (!current) return state;
      return {
        ...state,
        entries: {
          ...state.entries,
          [sessionId]: {
            items: mergeEntries(entries, current.items),
            loaded: true,
            error: null,
          },
        },
      };
    });
  } catch (error) {
    update((state) => ({
      ...state,
      entries: {
        ...state.entries,
        [sessionId]: {
          items: state.entries[sessionId]?.items ?? [],
          loaded: true,
          error: String(error),
        },
      },
    }));
  }
}

async function selectSession(sessionId: string): Promise<void> {
  const state = agentStore.get();
  if (state.selectedId === sessionId) return;

  update((current) => ({
    ...current,
    selectedId: sessionId,
    // A buffer from an earlier visit may have missed its commit; history is
    // authoritative and is fetched now.
    live: { ...current.live, [sessionId]: undefined },
    pendingPrompts: { ...current.pendingPrompts, [sessionId]: [] },
    entries: {
      ...current.entries,
      [sessionId]: {
        items: current.entries[sessionId]?.items ?? [],
        loaded: false,
        error: null,
      },
    },
  }));
  persistPrefs();
  await loadEntries(sessionId);
}

async function allocateSession(): Promise<string> {
  const { sessionId } = await dshApi.newSession();
  update((state) => ({
    ...state,
    selectedId: sessionId,
    entries: {
      ...state.entries,
      [sessionId]: { items: [], loaded: true, error: null },
    },
    pendingPrompts: { ...state.pendingPrompts, [sessionId]: [] },
    lastError: null,
  }));
  persistPrefs();
  return sessionId;
}

export const agentActions = {
  /** Re-reads status, sessions and settings; called when the page mounts. */
  bootstrap: async (): Promise<void> => {
    hydratePrefs();
    // Errors belong to the previous visit; the fresh reads below replace them.
    update((state) => ({ ...state, lastError: null }));
    const selected = agentStore.get().selectedId;
    if (selected) {
      // Refresh the selected history without treating it as a new selection.
      update((state) => ({
        ...state,
        live: { ...state.live, [selected]: undefined },
      }));
      void loadEntries(selected);
    }
    await Promise.all([
      agentActions.refreshStatus(),
      agentActions.refreshSessions(),
      agentActions.loadConfig(),
      // A blocking ask can arrive before this page was ever opened; seed the
      // same reducers the live events use so the cards render on first paint.
      agentActions.loadPending(),
    ]);
  },

  setTab: (tab: AgentTab): void => {
    update((state) => ({ ...state, tab }));
    persistPrefs();
  },

  selectSession: (sessionId: string): void => {
    void selectSession(sessionId);
  },

  /** Re-reads blocking requests; no-op failures keep the live state. */
  loadPending: async (): Promise<void> => {
    try {
      const { requests } = await dshApi.pending();
      for (const item of requests) {
        if (item.kind === "approval") {
          applyApproval({ rpcId: item.rpcId, request: item.request });
        } else {
          applyQuestion({ rpcId: item.rpcId, request: item.request });
        }
      }
    } catch {
      // A runtime that is not up has no pending asks; nothing to seed.
    }
  },

  refreshEntries: (sessionId: string): void => {
    void loadEntries(sessionId);
  },

  newSession: async (): Promise<void> => {
    try {
      await allocateSession();
    } catch (error) {
      setError(error);
    }
  },

  refreshSessions: async (): Promise<void> => {
    try {
      const { sessions } = await dshApi.sessions();
      update((state) => ({ ...state, sessions, sessionsError: null }));
      const state = agentStore.get();
      if (!state.selectedId && sessions.length > 0) {
        await selectSession(sessions[0].id);
      }
    } catch (error) {
      update((state) => ({ ...state, sessionsError: String(error) }));
    }
  },

  refreshStatus: async (): Promise<void> => {
    try {
      const status = await dshApi.status();
      update((state) => ({ ...state, status, statusError: null }));
    } catch (error) {
      update((state) => ({ ...state, statusError: String(error) }));
    }
  },

  startRuntime: async (): Promise<void> => {
    if (agentStore.get().starting) return;
    update((state) => ({ ...state, starting: true, lastError: null }));
    try {
      const status = await dshApi.start();
      update((state) => ({ ...state, status, statusError: null, starting: false }));
    } catch (error) {
      update((state) => ({ ...state, starting: false }));
      setError(error);
      void agentActions.refreshStatus();
    }
  },

  stopRuntime: async (): Promise<void> => {
    if (agentStore.get().stopping) return;
    update((state) => ({ ...state, stopping: true }));
    try {
      const status = await dshApi.stop();
      update((state) => ({ ...state, status, stopping: false }));
    } catch (error) {
      update((state) => ({ ...state, stopping: false }));
      setError(error);
    }
  },

  /** First-run extraction takes seconds and has no progress events: the view
   *  shows elapsed time, then the runtime is started. */
  prepareRuntime: async (): Promise<void> => {
    if (agentStore.get().preparingSince !== null) return;
    update((state) => ({ ...state, preparingSince: Date.now(), lastError: null }));
    try {
      await dshApi.prepare();
    } catch (error) {
      update((state) => ({ ...state, preparingSince: null }));
      setError(error);
      return;
    }
    update((state) => ({ ...state, preparingSince: null }));
    await agentActions.startRuntime();
  },

  loadConfig: async (): Promise<void> => {
    try {
      const config = await dshSettingsApi.get();
      update((state) => ({ ...state, config, configError: null }));
    } catch (error) {
      update((state) => ({ ...state, configError: String(error) }));
    }
  },

  saveConfig: async (draft: AgentConfigDraft): Promise<DshAgentConfig> => {
    // Read right before writing: repositories are edited on the projects page
    // and must not be overwritten by a stale copy loaded earlier.
    const latest = await dshSettingsApi.get();
    const saved = await dshSettingsApi.save({ ...latest, ...draft });
    update((state) => ({ ...state, config: saved, configError: null }));
    return saved;
  },

  /** Returns false when the runtime rejected the prompt, so the composer keeps
   *  the text for a retry. */
  sendPrompt: async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const existing = agentStore.get().selectedId;
    let sessionId: string | null = existing;
    try {
      if (!sessionId) sessionId = await allocateSession();
      const targetId = sessionId;
      update((state) => ({
        ...state,
        pendingPrompts: {
          ...state.pendingPrompts,
          [targetId]: [...(state.pendingPrompts[targetId] ?? []), trimmed],
        },
        lastError: null,
      }));
      await dshApi.prompt(targetId, trimmed);
      return true;
    } catch (error) {
      if (sessionId) {
        const targetId = sessionId;
        update((state) => {
          const queue = state.pendingPrompts[targetId] ?? [];
          const index = queue.indexOf(trimmed);
          if (index === -1) return state;
          const next = queue.slice();
          next.splice(index, 1);
          return {
            ...state,
            pendingPrompts: { ...state.pendingPrompts, [targetId]: next },
          };
        });
      }
      setError(error);
      return false;
    }
  },

  answerApproval: async (
    rpcId: number,
    outcome: DshApprovalOutcome,
  ): Promise<void> => {
    update((state) => ({
      ...state,
      approvals: state.approvals.map((item) =>
        item.rpcId === rpcId ? { ...item, busy: true } : item,
      ),
    }));
    try {
      await dshApi.approvalAnswer(rpcId, outcome);
      update((state) => ({
        ...state,
        approvals: state.approvals.filter((item) => item.rpcId !== rpcId),
      }));
    } catch (error) {
      update((state) => ({
        ...state,
        approvals: state.approvals.map((item) =>
          item.rpcId === rpcId ? { ...item, busy: false } : item,
        ),
      }));
      setError(error);
    }
  },

  answerQuestion: async (rpcId: number, answers: DshAnswer[] | null): Promise<void> => {
    update((state) => ({
      ...state,
      questions: state.questions.map((item) =>
        item.rpcId === rpcId ? { ...item, busy: true } : item,
      ),
    }));
    try {
      await dshApi.questionAnswer(rpcId, answers);
      update((state) => ({
        ...state,
        questions: state.questions.filter((item) => item.rpcId !== rpcId),
      }));
    } catch (error) {
      update((state) => ({
        ...state,
        questions: state.questions.map((item) =>
          item.rpcId === rpcId ? { ...item, busy: false } : item,
        ),
      }));
      setError(error);
    }
  },
};

/** Handlers registered once per app session by `useAgentRuntime`. */
export const agentEvents = {
  status: (status: DshStatus): void => {
    update((state) => ({
      ...state,
      status,
      statusError: null,
      starting: false,
      preparingSince: status.phase === "ready" ? null : state.preparingSince,
      lastError: status.phase === "ready" ? null : state.lastError,
    }));
  },
  entry: (payload: DshEntryEvent): void => applyEntry(payload),
  stream: (payload: DshSessionEvent): void => applyStream(payload),
  approval: (payload: DshApprovalEvent): void => applyApproval(payload),
  question: (payload: DshQuestionEvent): void => applyQuestion(payload),
  error: (payload: DshErrorEvent): void => setError(payload.message, payload.code),
};
