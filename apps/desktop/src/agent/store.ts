/**
 * Agent page state: runtime status, the unified task list, the selected
 * history, live streams and pending approvals / questions.
 *
 * It is a module store rather than component state because Tauri events arrive
 * outside React and the same facts are read by the task list, the stream and
 * the configuration tab. Streams are kept only for the selected session: the
 * backend replays history on demand, so stale buffers never need to survive a
 * switch.
 */
import {
  dshApi,
  dshPolicyApi,
  dshSettingsApi,
  dshTaskApi,
  dshTeamApi,
  type DshAgentConfig,
  type DshApprovalEvent,
  type DshApprovalOutcome,
  type DshAnswer,
  type DshEntry,
  type DshEntryEvent,
  type DshErrorEvent,
  type DshFocusSessionEvent,
  type DshQuestionEvent,
  type DshSessionEvent,
  type DshStatus,
  type DshStream,
  type DshTask,
  type DshTasksEvent,
  type DshTeam,
  type DshTeamEvent,
} from "../lib/dsh";
import { createExternalStore } from "../lib/store";
import { readPref, writePref } from "../lib/uiPrefs";

export type AgentTab = "tasks" | "config";

/** Which pane the task header shows; the transcript is the fallback. */
export type AgentTeamView = "chat" | "board";

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
 *  the permission mode are written through their own entry points. */
export type AgentConfigDraft = Pick<
  DshAgentConfig,
  "promptTemplate" | "worktreeEnabled" | "executionUnits" | "dshModel"
>;

export type AgentState = {
  tab: AgentTab;
  selectedId: string | null;
  tasks: DshTask[] | null;
  tasksError: string | null;
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
  /** Team board per session; absent until read or pushed. */
  team: Record<string, DshTeam>;
  /** Sessions whose board was read once; `dsh://team` updates it afterwards. */
  teamLoaded: Record<string, true>;
  teamBusy: Record<string, boolean>;
  teamErrors: Record<string, string | null>;
  /** Explicit transcript/board choice; absent means "derive from team mode". */
  teamViews: Record<string, AgentTeamView>;
  preparingSince: number | null;
  starting: boolean;
  stopping: boolean;
  lastError: { code: string | null; message: string } | null;
};

/** Selected task and active tab are view state, but they survive page
 *  unmounts and restarts through the config.json preference blob. */
const UI_PREF_KEY = "agent.ui.v1";

type AgentPrefs = { tab?: unknown; sessionId?: unknown };

/**
 * Sessions allocated by 新建会话 in this app run. They are free conversations:
 * the task table only stores work handed over from a bug or a work item, so a
 * new chat has no task row until the backend creates one.
 */
const drafts = new Set<string>();

const initialState: AgentState = {
  tab: "tasks",
  selectedId: null,
  tasks: null,
  tasksError: null,
  status: null,
  statusError: null,
  config: null,
  configError: null,
  entries: {},
  live: {},
  pendingPrompts: {},
  approvals: [],
  questions: [],
  team: {},
  teamLoaded: {},
  teamBusy: {},
  teamErrors: {},
  teamViews: {},
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
  const tab: AgentTab = saved.tab === "config" ? "config" : "tasks";
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
// Task list and selection
// ---------------------------------------------------------------------------

/** Newest first; `updatedAt` is fixed-width RFC3339, so string order is time. */
function byUpdatedDesc(a: DshTask, b: DshTask): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function isSelectable(state: AgentState, id: string): boolean {
  return drafts.has(id) || (state.tasks ?? []).some((task) => task.id === id);
}

/** Keeps a draft chat or a task; anything else falls back to the newest task. */
function nextSelection(state: AgentState, id: string | null): string | null {
  if (id && isSelectable(state, id)) return id;
  return state.tasks?.[0]?.id ?? null;
}

function replaceTask(task: DshTask): void {
  update((state) => {
    const current = state.tasks ?? [];
    const known = current.some((item) => item.id === task.id);
    const tasks = (known
      ? current.map((item) => (item.id === task.id ? task : item))
      : [task, ...current]
    ).sort(byUpdatedDesc);
    return { ...state, tasks };
  });
}

/** Installs a fresh list, keeping or repairing the selection. */
function adoptTasks(tasks: DshTask[]): void {
  const before = agentStore.get();
  const selectedId = nextSelection({ ...before, tasks }, before.selectedId);
  const moved = selectedId !== null && selectedId !== before.selectedId;

  update((state) => ({
    ...state,
    tasks,
    tasksError: null,
    selectedId,
    // A stream from an earlier visit must not be painted over the new task.
    live: moved && selectedId ? { ...state.live, [selectedId]: undefined } : state.live,
  }));
  persistPrefs();

  if (moved && selectedId) {
    void loadEntries(selectedId);
    ensureTeam(selectedId);
  }
}

function clearSelection(sessionId: string): void {
  drafts.delete(sessionId);
  update((state) => {
    const entries = { ...state.entries };
    delete entries[sessionId];
    const fallback = (state.tasks ?? []).find((task) => task.id !== sessionId)?.id ?? null;
    return {
      ...state,
      selectedId: state.selectedId === sessionId ? fallback : state.selectedId,
      entries,
    };
  });
  persistPrefs();
  const selected = agentStore.get().selectedId;
  if (selected) void loadEntries(selected);
}

// ---------------------------------------------------------------------------
// Team board (docs/DSH.md §9.5)
// ---------------------------------------------------------------------------

/** Reads in flight; keeps selection and enqueue from issuing the same read. */
const teamReads = new Set<string>();

/** Team mode is offered on tasks with workflow metadata, not free chats. */
function hasTeamUi(state: AgentState, sessionId: string): boolean {
  return (state.tasks ?? []).some((task) => task.id === sessionId && task.kind !== "chat");
}

/** The pane to show: the reader's explicit choice, else the team mode default. */
export function agentTeamView(state: AgentState, sessionId: string | null): AgentTeamView {
  if (!sessionId) return "chat";
  return state.teamViews[sessionId] ?? (state.team[sessionId]?.enabled ? "board" : "chat");
}

function applyTeam(sessionId: string, team: DshTeam): void {
  update((state) => ({
    ...state,
    team: { ...state.team, [sessionId]: team },
    teamLoaded: { ...state.teamLoaded, [sessionId]: true },
    teamErrors: { ...state.teamErrors, [sessionId]: null },
  }));
}

/**
 * One read per session; the event channel keeps the board current afterwards.
 * A failed read is retried the next time the task is selected.
 */
async function readTeam(sessionId: string): Promise<void> {
  if (teamReads.has(sessionId)) return;
  teamReads.add(sessionId);
  try {
    const { team } = await dshTeamApi.get(sessionId);
    applyTeam(sessionId, team);
  } catch (error) {
    update((state) => ({
      ...state,
      teamErrors: { ...state.teamErrors, [sessionId]: String(error) },
    }));
  } finally {
    teamReads.delete(sessionId);
  }
}

function ensureTeam(sessionId: string | null): void {
  if (!sessionId) return;
  const state = agentStore.get();
  if (!hasTeamUi(state, sessionId)) return;
  if (state.teamLoaded[sessionId] || teamReads.has(sessionId)) return;
  void readTeam(sessionId);
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

/**
 * Fetches history. A task restored from a previous app run is unknown to the
 * runtime until it is resumed, so an unknown *task* gets one resume and a
 * second read; a draft chat that is unknown simply never existed.
 */
async function readHistory(
  sessionId: string,
): Promise<{ known: boolean; entries: DshEntry[] }> {
  const first = await dshApi.sessionEntries(sessionId);
  if (first.known) return first;
  const isTask = (agentStore.get().tasks ?? []).some((task) => task.id === sessionId);
  if (!isTask) return first;
  try {
    // Opening a persisted task re-attaches the dsh session; a runtime that is
    // not up yet starts on demand.
    await dshTaskApi.resume(sessionId);
  } catch {
    // Best effort: a failed re-attach leaves an empty history, not an error.
    return first;
  }
  return dshApi.sessionEntries(sessionId);
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
    const result = await readHistory(sessionId);
    if (!result.known) {
      const isTask = (agentStore.get().tasks ?? []).some((task) => task.id === sessionId);
      if (isTask) {
        // The task row survives an unreachable runtime: keep it selected with
        // an empty history instead of dropping a task the user can still act on.
        update((state) => ({
          ...state,
          entries: {
            ...state.entries,
            [sessionId]: { items: [], loaded: true, error: null },
          },
        }));
        return;
      }
      // A draft chat the runtime never registered: fall back to a real task.
      clearSelection(sessionId);
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
            items: mergeEntries(result.entries, current.items),
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
  ensureTeam(sessionId);
  await loadEntries(sessionId);
}

async function allocateSession(): Promise<string> {
  const { sessionId } = await dshApi.newSession();
  drafts.add(sessionId);
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
  /** Re-reads status, tasks and settings; called when the page mounts. */
  bootstrap: async (): Promise<void> => {
    hydratePrefs();
    // Errors belong to the previous visit; the fresh reads below replace them.
    update((state) => ({ ...state, lastError: null }));
    await Promise.all([
      agentActions.refreshStatus(),
      agentActions.refreshTasks(),
      agentActions.loadConfig(),
      // A blocking ask can arrive before this page was ever opened; seed the
      // same reducers the live events use so the cards render on first paint.
      agentActions.loadPending(),
    ]);
    // A selection restored from preferences is not a move, so `adoptTasks`
    // did not read its board.
    ensureTeam(agentStore.get().selectedId);
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

  /** Re-reads the unified list and refreshes the selected history. */
  refreshTasks: async (): Promise<void> => {
    const before = agentStore.get().selectedId;
    try {
      const { tasks } = await dshTaskApi.list();
      adoptTasks(tasks);
      const selected = agentStore.get().selectedId;
      // A repaired selection was loaded by `adoptTasks`; only an unchanged one
      // still needs its history refreshed.
      if (selected && selected === before) {
        update((state) => ({
          ...state,
          live: { ...state.live, [selected]: undefined },
        }));
        await loadEntries(selected);
      }
    } catch (error) {
      update((state) => ({ ...state, tasksError: String(error) }));
    }
  },

  /** Selects a task returned by an enqueue and puts it at the top of the list. */
  adoptTask: (task: DshTask): void => {
    replaceTask(task);
    update((state) => ({
      ...state,
      tab: "tasks",
      selectedId: task.id,
      entries: {
        ...state.entries,
        [task.id]: state.entries[task.id] ?? { items: [], loaded: false, error: null },
      },
      live: { ...state.live, [task.id]: undefined },
      pendingPrompts: { ...state.pendingPrompts, [task.id]: [] },
      lastError: null,
    }));
    persistPrefs();
    void loadEntries(task.id);
    ensureTeam(task.id);
  },

  /** Task workflow actions. They throw so the action bar shows the reason next
   *  to the buttons; the returned task is already installed in the list. */
  approveTask: async (sessionId: string): Promise<DshTask> => {
    const { task } = await dshTaskApi.approve(sessionId);
    replaceTask(task);
    return task;
  },

  mergeTask: async (sessionId: string): Promise<DshTask> => {
    const { task } = await dshTaskApi.merge(sessionId);
    replaceTask(task);
    return task;
  },

  cancelTask: async (sessionId: string, stash = false): Promise<DshTask> => {
    const { task } = await dshTaskApi.cancel(sessionId, stash);
    replaceTask(task);
    return task;
  },

  setPermissionMode: async (mode: DshAgentConfig["permissionMode"]): Promise<void> => {
    const { mode: saved } = await dshPolicyApi.set(mode);
    update((state) =>
      state.config ? { ...state, config: { ...state.config, permissionMode: saved } } : state,
    );
  },

  setTeamView: (sessionId: string, view: AgentTeamView): void => {
    update((state) => ({
      ...state,
      teamViews: { ...state.teamViews, [sessionId]: view },
    }));
  },

  /** Retries a failed board read; the toggle itself never bypasses this. */
  refreshTeam: (sessionId: string): void => {
    void readTeam(sessionId);
  },

  /**
   * Switches team mode for one session. The returned board replaces the local
   * copy, and an explicit pane choice is dropped so the new default applies.
   */
  setTeamEnabled: async (sessionId: string, enabled: boolean): Promise<void> => {
    if (agentStore.get().teamBusy[sessionId]) return;
    update((state) => ({
      ...state,
      teamBusy: { ...state.teamBusy, [sessionId]: true },
      teamErrors: { ...state.teamErrors, [sessionId]: null },
    }));
    try {
      const { team } = await dshTeamApi.set(sessionId, enabled);
      applyTeam(sessionId, team);
      update((state) => {
        const teamViews = { ...state.teamViews };
        delete teamViews[sessionId];
        return { ...state, teamViews };
      });
    } catch (error) {
      update((state) => ({
        ...state,
        teamErrors: { ...state.teamErrors, [sessionId]: String(error) },
      }));
    } finally {
      update((state) => ({
        ...state,
        teamBusy: { ...state.teamBusy, [sessionId]: false },
      }));
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
    // Read right before writing: repositories and the permission mode are
    // edited elsewhere and must not be overwritten by a stale copy.
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
  /** The list is authoritative; replace it and repair the selection. */
  tasks: (payload: DshTasksEvent): void => adoptTasks(payload.tasks),
  /** The board is authoritative for its session, including after a toggle. */
  team: (payload: DshTeamEvent): void => applyTeam(payload.sessionId, payload.team),
  /** The capsule asked for a session: show the task list on that task. */
  focusSession: (payload: DshFocusSessionEvent): void => {
    update((state) => ({ ...state, tab: "tasks" }));
    persistPrefs();
    void selectSession(payload.sessionId);
  },
  error: (payload: DshErrorEvent): void => setError(payload.message, payload.code),
};
