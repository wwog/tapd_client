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
  type DshPermissionMode,
  type DshProject,
  type DshQuestionEvent,
  type DshSessionEvent,
  type DshSessionRow,
  type DshSessionStatus,
  type DshSessionsEvent,
  type DshSettledEvent,
  type DshStatus,
  type DshStream,
  type DshTask,
  type DshTasksEvent,
  type DshTeam,
  type DshTeamEvent,
  type ModelSelection,
} from "../lib/dsh";
import { createExternalStore } from "../lib/store";
import { readPref, writePref } from "../lib/uiPrefs";
import {
  agentSettingsApi,
  defaultSelection,
  type DshModelsConfig,
} from "../lib/agentSettings";
import { isWorkflowTask } from "./workflow";

export type AgentTeamView = "chat" | "board";

/** The session's panes: the task's own record, the transcript, the trajectory
 *  ledger. A workflow task opens on its task record; a free chat has no task
 *  pane and opens on the transcript. */
export type AgentTaskView = "task" | "chat" | "trajectory";

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
  "promptTemplate" | "teamEnabled" | "executionUnits" | "dshModels"
>;

/** The settings dialog's groups, in nav order. */
export type AgentConfigSection =
  | "general"
  | "models"
  | "rules"
  | "integrations"
  | "plugins";

export type AgentState = {
  /** The settings dialog; the page itself only shows the conversation. */
  configOpen: boolean;
  /** Group the dialog opened on; the entry point chooses it. */
  configSection: AgentConfigSection;
  selectedId: string | null;
  tasks: DshTask[] | null;
  tasksError: string | null;
  /** Every configured project, in the order the list groups them. */
  projects: DshProject[] | null;
  status: DshStatus | null;
  statusError: string | null;
  config: DshAgentConfig | null;
  configError: string | null;
  entries: Record<string, SessionHistory>;
  live: Record<string, LiveRun | undefined>;
  /** The attempt whose committed message already landed. Deltas from it that
   *  arrive after the commit (stream and stdio are different channels) must be
   *  dropped instead of starting a second live run. */
  committedAttempts: Record<string, string | undefined>;
  /** Prompts accepted by the runtime but not yet echoed as a user entry. */
  pendingPrompts: Record<string, string[] | undefined>;
  /** Model picked before a session exists; applied to the next allocation. */
  draftSelection: ModelSelection | null;
  /** Team collaboration for the next free chat. Chats default off even when
   *  the config default is on; a task session inherits the config instead. */
  /** Picks the transcript row does not know yet (a session without a committed
   *  message). Retired once the backend reports the route. */
  selectionOverrides: Record<string, ModelSelection | undefined>;
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  /** Session rows (usage, counters) keyed by id; the status line reads them. */
  sessions: Record<string, DshSessionRow>;
  /** Per-session permission mode; `null` inherits the configured default and
   *  `undefined` means "not read yet". */
  sessionModes: Record<string, DshPermissionMode | null | undefined>;
  /** Plan choices that have not been confirmed by the engine's `plan/mode`
   *  event. The session row is the authority once it matches. */
  planOverrides: Record<string, boolean | undefined>;
  /** Team board per session; absent until read or pushed. */
  team: Record<string, DshTeam>;
  /** Start-only team pick for a chat whose Agent does not exist yet. */
  chatTeamDrafts: Record<string, boolean | undefined>;
  /** Sessions whose board was read once; `dsh://team` updates it afterwards. */
  teamLoaded: Record<string, true>;
  teamBusy: Record<string, boolean>;
  teamErrors: Record<string, string | null>;
  /** Explicit transcript/board choice; absent means "derive from team mode". */
  teamViews: Record<string, AgentTeamView>;
  /** Transcript vs task record vs trajectory per session; absent means the
   *  default (task record for workflow tasks, transcript for chats). */
  taskViews: Record<string, AgentTaskView>;
  /** Bumped by「继续修改」so the composer takes focus after switching back. */
  composerFocusAt: number;
  preparingSince: number | null;
  starting: boolean;
  stopping: boolean;
  lastError: { code: string | null; message: string } | null;
};

/** Selected task is view state, but it survives page unmounts and restarts
 *  through the config.json preference blob. The settings dialog does not. */
const UI_PREF_KEY = "agent.ui.v1";

type AgentPrefs = { sessionId?: unknown };

/**
 * Sessions allocated by 新建会话 in this app run. They are free conversations:
 * the task table only stores work handed over from a bug or a work item, so a
 * new chat has no task row until the backend creates one.
 */
const drafts = new Set<string>();

/** Latest mode write per session. A failed older write must not revert a
 *  newer pick that is already on screen. */
const modeWrites = new Map<string, number>();

const initialState: AgentState = {
  configOpen: false,
  configSection: "general",
  selectedId: null,
  tasks: null,
  tasksError: null,
  projects: null,
  status: null,
  statusError: null,
  config: null,
  configError: null,
  entries: {},
  live: {},
  committedAttempts: {},
  pendingPrompts: {},
  draftSelection: null,
  selectionOverrides: {},
  approvals: [],
  questions: [],
  sessions: {},
  sessionModes: {},
  planOverrides: {},
  team: {},
  chatTeamDrafts: {},
  teamLoaded: {},
  teamBusy: {},
  teamErrors: {},
  teamViews: {},
  taskViews: {},
  composerFocusAt: 0,
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
  writePref(UI_PREF_KEY, { sessionId: agentStore.get().selectedId });
}

function hydratePrefs(): void {
  const saved = readPref<AgentPrefs>(UI_PREF_KEY);
  if (!saved) return;
  const sessionId =
    typeof saved.sessionId === "string" && saved.sessionId ? saved.sessionId : null;
  update((state) => ({
    ...state,
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

/**
 * Same row from history and from the live feed. The fetched copy is
 * authoritative unless it is a tool call that history saw mid-flight while the
 * local copy already has its result — the old `running` row must not win.
 */
function preferEntry(current: DshEntry, incoming: DshEntry): DshEntry {
  if (current.kind !== "tool" || incoming.kind !== "tool") return current;
  const settled = (entry: Extract<DshEntry, { kind: "tool" }>) =>
    entry.status !== "running" || entry.result !== undefined;
  return settled(current) || !settled(incoming) ? current : incoming;
}

function mergeEntries(fetched: DshEntry[], live: DshEntry[]): DshEntry[] {
  const merged = new Map<string, DshEntry>();
  for (const entry of fetched) merged.set(entryKey(entry), entry);
  for (const entry of live) {
    const key = entryKey(entry);
    const current = merged.get(key);
    merged.set(key, current ? preferEntry(current, entry) : entry);
  }
  return [...merged.values()].sort((a, b) => a.seq - b.seq);
}

/** Whether a session is working right now. The runtime's own status is the
 *  authority; live content covers the moment before the first status event. */
export function isSessionRunning(state: AgentState, sessionId: string | null): boolean {
  if (!sessionId) return false;
  if (state.sessions[sessionId]?.status === "running") return true;
  const live = state.live[sessionId];
  return Boolean(live && (live.text || live.reasoning || live.tools.length > 0));
}

/** Live status for a task row: the session registry wins over the persisted
 *  copy, which is only refreshed when the backend emits a task list. */
export function taskLiveStatus(state: AgentState, task: DshTask): DshSessionStatus {
  return state.sessions[task.id]?.status ?? task.status;
}

/** Last activity for sorting and display, for the same reason. */
export function taskActivityAt(state: AgentState, task: DshTask): string {
  return state.sessions[task.id]?.updatedAt ?? task.updatedAt;
}

/** Effective plan mode: a pending choice first, then the engine's session row. */
export function sessionPlan(state: AgentState, sessionId: string | null): boolean {
  if (!sessionId) return false;
  return state.planOverrides[sessionId] ?? state.sessions[sessionId]?.planActive ?? false;
}

/** `null` inherits the configured default; `undefined` means not read yet. */
export function sessionPermissionMode(
  state: AgentState,
  sessionId: string | null,
): DshPermissionMode | null | undefined {
  if (!sessionId) return undefined;
  return state.sessionModes[sessionId];
}

/** One read per selection; a failure leaves the picker on the default. */
async function readSessionMode(sessionId: string): Promise<void> {
  try {
    const { mode } = await dshApi.sessionMode(sessionId);
    update((state) =>
      // A choice made while the read was in flight wins over the stored value.
      state.sessionModes[sessionId] !== undefined
        ? state
        : {
            ...state,
            sessionModes: { ...state.sessionModes, [sessionId]: mode ?? null },
          },
    );
  } catch {
    // A runtime that is not up still has the persisted value; the next
    // selection retries.
  }
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
/** Session rows are replaced wholesale; the map is small and id-keyed. */
function applySessions(sessions: DshSessionRow[]): void {
  update((state) => {
    // A plan choice is optimistic only until the engine records the same
    // state. Sessions stream unrelated updates during a turn, so keeping the
    // override forever would pin a queued choice that the engine has not
    // applied yet.
    let planOverrides = state.planOverrides;
    let selectionOverrides = state.selectionOverrides;
    for (const row of sessions) {
      if (row.planActive !== undefined) {
        if (planOverrides[row.id] === row.planActive) {
          if (planOverrides === state.planOverrides) planOverrides = { ...planOverrides };
          delete planOverrides[row.id];
        }
      }
      // The row only carries a route once the backend knows the session, so a
      // reported route retires the optimistic pick.
      if (row.selection && selectionOverrides[row.id]) {
        if (selectionOverrides === state.selectionOverrides) {
          selectionOverrides = { ...selectionOverrides };
        }
        delete selectionOverrides[row.id];
      }
    }
    return {
      ...state,
      sessions: Object.fromEntries(sessions.map((session) => [session.id, session])),
      planOverrides,
      selectionOverrides,
    };
  });
}

/** Optimistic selection echo; the `model/selection` event confirms it. */
function applySelection(sessionId: string, selection: ModelSelection | undefined): void {
  update((state) => {
    // A session without a committed message has no transcript row yet, so
    // writing only the row would leave the pick invisible until the first
    // reply. The override keeps it on screen (the runtime uses it for the next
    // request regardless).
    const selectionOverrides = { ...state.selectionOverrides };
    if (selection) selectionOverrides[sessionId] = selection;
    else delete selectionOverrides[sessionId];

    const row = state.sessions[sessionId];
    return {
      ...state,
      selectionOverrides,
      sessions: row
        ? { ...state.sessions, [sessionId]: { ...row, selection } }
        : state.sessions,
    };
  });
}

function adoptTasks(tasks: DshTask[]): void {
  const before = agentStore.get();
  const selectedId = nextSelection({ ...before, tasks }, before.selectedId);
  const moved = selectedId !== null && selectedId !== before.selectedId;
  // A task that newly entered review opens on the task record again, even if
  // the reader had stepped back to the transcript for the previous round.
  const previousWorkflow = new Map(
    (before.tasks ?? []).map((task) => [task.id, task.workflow]),
  );
  const freshReview = tasks
    .filter(
      (task) =>
        task.workflow === "awaiting_review" &&
        previousWorkflow.get(task.id) !== "awaiting_review",
    )
    .map((task) => task.id);

  update((state) => {
    let taskViews = state.taskViews;
    if (freshReview.length > 0) {
      taskViews = { ...taskViews };
      for (const id of freshReview) taskViews[id] = "task";
    }
    return {
      ...state,
      tasks,
      tasksError: null,
      selectedId,
      taskViews,
    };
  });
  persistPrefs();

  // A chat session's row can appear after it was selected, so the board read
  // must not wait for a selection change.
  if (selectedId) ensureTeam(selectedId);
  if (moved && selectedId) {
    void loadEntries(selectedId);
    void readSessionMode(selectedId);
  }
}

function clearSelection(sessionId: string): void {
  drafts.delete(sessionId);
  update((state) => {
    const entries = { ...state.entries };
    delete entries[sessionId];
    const live = { ...state.live };
    delete live[sessionId];
    const committedAttempts = { ...state.committedAttempts };
    delete committedAttempts[sessionId];
    const pendingPrompts = { ...state.pendingPrompts };
    delete pendingPrompts[sessionId];
    const sessionModes = { ...state.sessionModes };
    delete sessionModes[sessionId];
    const planOverrides = { ...state.planOverrides };
    delete planOverrides[sessionId];
    const fallback = (state.tasks ?? []).find((task) => task.id !== sessionId)?.id ?? null;
    return {
      ...state,
      selectedId: state.selectedId === sessionId ? fallback : state.selectedId,
      entries,
      live,
      committedAttempts,
      pendingPrompts,
      sessionModes,
      planOverrides,
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

/** The pane to show: the reader's explicit choice, else the team mode default.
 *  Task sessions open on the board; a free chat keeps its transcript unless the
 *  reader asks for the board, because chatting is the point of a chat. */
export function agentTeamView(state: AgentState, sessionId: string | null): AgentTeamView {
  if (!sessionId) return "chat";
  const explicit = state.teamViews[sessionId];
  if (explicit) return explicit;
  const task = (state.tasks ?? []).find((item) => item.id === sessionId);
  const chat = !isWorkflowTask(task);
  return !chat && state.team[sessionId]?.enabled ? "board" : "chat";
}

/** The session's pane choice: a workflow task opens on its task record, a
 *  free chat on the transcript; an explicit pick always wins. */
export function agentTaskView(state: AgentState, sessionId: string | null): AgentTaskView {
  if (!sessionId) return "chat";
  const explicit = state.taskViews[sessionId];
  const task = (state.tasks ?? []).find((item) => item.id === sessionId);
  const workflowTask = isWorkflowTask(task);
  if (!workflowTask) {
    return explicit === "trajectory" ? "trajectory" : "chat";
  }
  return explicit ?? "task";
}

/** Whether the main pane should offer the review surface at all. */
export function taskReviewable(task: DshTask | null | undefined): boolean {
  return task?.workflow === "awaiting_review" || task?.workflow === "finalizing";
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
  if (state.teamLoaded[sessionId] || teamReads.has(sessionId)) return;
  void readTeam(sessionId);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function applyEntry(payload: DshEntryEvent): void {
  update((state) => {
    const { entry } = payload;
    const sessionId = payload.sessionId;
    const liveRun = state.live[sessionId];
    let live = state.live;
    let committedAttempts = state.committedAttempts;
    let pendingPrompts = state.pendingPrompts;

    // Live bookkeeping runs for every session: a commit that lands while the
    // user is looking at another task still settles that session's overlay.
    if (entry.kind === "assistant") {
      // The committed message supersedes whatever the stream had accumulated.
      if (liveRun) {
        live = { ...live, [sessionId]: undefined };
        committedAttempts = { ...committedAttempts, [sessionId]: liveRun.attemptId };
      }
    } else if (entry.kind === "turn" && entry.state === "end") {
      if (liveRun) {
        committedAttempts = { ...committedAttempts, [sessionId]: liveRun.attemptId };
      }
      live = { ...live, [sessionId]: undefined };
      pendingPrompts = { ...pendingPrompts, [sessionId]: [] };
    } else if (entry.kind === "tool" && liveRun && entry.callId) {
      // The tool row owns the call from now on; leaving a copy in the overlay
      // painted the same call twice and kept it as the "current" action.
      const tools = liveRun.tools.filter((tool) => tool.callId !== entry.callId);
      if (tools.length !== liveRun.tools.length) {
        live = { ...live, [sessionId]: { ...liveRun, tools } };
      }
    } else if (entry.kind === "user") {
      const queue = pendingPrompts[sessionId];
      const index = queue ? queue.indexOf(entry.text) : -1;
      if (queue && index >= 0) {
        const next = queue.slice();
        next.splice(index, 1);
        pendingPrompts = { ...pendingPrompts, [sessionId]: next };
      }
    }

    // Child agent sessions of the selected parent stream their own entries:
    // the sub-agent fold reads them from the same per-session buckets. Their
    // buckets start on the first pushed row; an explicit refresh then merges
    // the full history under what already arrived.
    const selected = sessionId === state.selectedId;
    const childOfSelected = state.sessions[sessionId]?.parentSession === state.selectedId;
    let bucket = state.entries[sessionId];
    if (!bucket && childOfSelected) bucket = { items: [], loaded: false, error: null };
    if ((!selected && !childOfSelected) || !bucket) {
      return { ...state, live, committedAttempts, pendingPrompts };
    }
    return {
      ...state,
      entries: {
        ...state.entries,
        [sessionId]: {
          items: upsertEntry(bucket.items, entry),
          loaded: true,
          error: null,
        },
      },
      live,
      committedAttempts,
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
    const sessionId = payload.sessionId;
    const { attemptId, revision, delta } = payload.stream;
    // Stream deltas and committed entries travel on different channels; a
    // delta from an attempt that already committed must not resurrect its
    // overlay and paint the final answer a second time.
    if (state.committedAttempts[sessionId] === attemptId) return state;
    const previous = state.live[sessionId];
    // `revision` counts emitted frames upstream, so it grows with every chunk
    // and must not be read as "this frame replaced the attempt": doing that
    // reset the overlay on every delta, leaving only the last one on screen.
    // A different attempt, or a revision that went backwards, is the restart.
    const restart =
      !previous || previous.attemptId !== attemptId || revision < previous.revision;
    const base: LiveRun = restart
      ? { attemptId, revision, text: "", reasoning: "", tools: [] }
      : previous;

    let next: LiveRun;
    if (delta.type === "text") {
      next = { ...base, revision, text: base.text + delta.text };
    } else if (delta.type === "reasoning") {
      next = { ...base, revision, reasoning: base.reasoning + delta.text };
    } else {
      next = { ...base, revision, tools: appendToolDelta(base.tools, payload.stream) };
    }

    // Streams are kept for every session, not only the selected one: switching
    // back mid-turn must show the text that already streamed, and a commit for
    // a background task arrives on its own channel anyway.
    return {
      ...state,
      live: { ...state.live, [sessionId]: next },
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
 * A request answered on another surface (the island capsule or the paired
 * phone) leaves `RuntimeState.pending` there; without this event the main
 * window would keep showing a card for a decision that already happened.
 */
function applySettled(payload: DshSettledEvent): void {
  update((state) => {
    const holds =
      state.approvals.some((item) => item.rpcId === payload.rpcId) ||
      state.questions.some((item) => item.rpcId === payload.rpcId);
    if (!holds) return state;
    return {
      ...state,
      approvals: state.approvals.filter((item) => item.rpcId !== payload.rpcId),
      questions: state.questions.filter((item) => item.rpcId !== payload.rpcId),
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
      if (drafts.has(sessionId)) {
        // A draft chat the runtime never registered: fall back to a real task.
        clearSelection(sessionId);
        return;
      }
      // Neither a task nor a draft — a child agent session the runtime has
      // already retired, most likely. Keep whatever streamed in (its settle
      // notice may be all that is left) and never touch the selection.
      update((state) => ({
        ...state,
        entries: {
          ...state.entries,
          [sessionId]: {
            items: state.entries[sessionId]?.items ?? [],
            loaded: true,
            error: null,
          },
        },
      }));
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
  void readSessionMode(sessionId);
  await loadEntries(sessionId);
}

async function allocateSession(project?: {
  kind: DshProject["kind"];
  id: string;
}): Promise<string> {
  const { sessionId } = await dshTaskApi.newSession(project);
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
  void readSessionMode(sessionId);
  applyChatTeam(sessionId);
  return sessionId;
}

/**
 * Free chats start with coworkers off even when the config default is on; the
 * composer work bar can turn it on before the first message. The pick is held
 * locally because the runtime has no Agent to apply it to until the first
 * prompt; `sendPrompt` flushes it then.
 */
function applyChatTeam(sessionId: string): void {
  update((state) => ({
    ...state,
    chatTeamDrafts: { ...state.chatTeamDrafts, [sessionId]: false },
    team: {
      ...state.team,
      [sessionId]: { sessionId, enabled: false, tasks: [] },
    },
  }));
}

/**
 * Applies a model picked before the session existed. The picker updates its
 * own draft when there is no selection, so this is the only place that has to
 * hand it to a freshly allocated session. With no pick at all the session
 * starts on the configured default route, including the level that model last
 * used — the runtime's own boot default knows neither the current catalog nor
 * the remembered level.
 */
async function applyDraftSelection(sessionId: string): Promise<void> {
  const state = agentStore.get();
  const draft = state.draftSelection;
  const selection = draft ?? defaultSelection(state.config?.dshModels);
  if (!selection) return;
  if (draft) update((current) => ({ ...current, draftSelection: null }));
  applySelection(sessionId, selection);
  try {
    await dshApi.selectModel(sessionId, selection);
  } catch (error) {
    setError(error);
  }
}

/** Slider drags fire many picks; the file write waits for the last one. */
const EFFORT_SAVE_DELAY_MS = 400;
let effortSaveTimer: number | null = null;
let effortPending: { provider: string; model: string; level: string } | null = null;

async function flushEffort(): Promise<void> {
  if (effortSaveTimer !== null) {
    window.clearTimeout(effortSaveTimer);
    effortSaveTimer = null;
  }
  const pending = effortPending;
  effortPending = null;
  if (!pending) return;
  try {
    // The backend moves the picked provider/model to the front as well, which
    // is how the app's "order is the default" rule records the last choice.
    const config = await agentSettingsApi.setDefault(
      pending.provider,
      pending.model,
      pending.level,
    );
    update((state) => ({ ...state, config }));
  } catch (error) {
    setError(error);
  }
}

/** The picked provider/model becomes the first entry of both lists. */
function promoteDefault(
  models: DshModelsConfig,
  providerId: string,
  modelId: string,
): DshModelsConfig {
  const providers = [...models.providers];
  const providerIndex = providers.findIndex((item) => item.id === providerId);
  if (providerIndex < 0) return models;
  const provider = providers[providerIndex]!;
  const entries = [...provider.models];
  const modelIndex = entries.findIndex((item) => item.id === modelId);
  if (modelIndex < 0) return models;
  const [model] = entries.splice(modelIndex, 1);
  if (!model) return models;
  providers[providerIndex] = { ...provider, models: [model, ...entries] };
  const [moved] = providers.splice(providerIndex, 1);
  if (!moved) return models;
  return {
    ...models,
    providers: [moved, ...providers],
    activeProviderId: providerId,
    activeModelId: modelId,
  };
}

/**
 * Local echo + debounced write of a pick: the level that model now runs at and
 * the route every new session starts on. Existing sessions keep their own
 * durable selection, so changing the default never reaches back into them.
 */
function rememberEffort(selection: ModelSelection): void {
  const level = selection.reasoningEffort?.trim() || "off";
  effortPending = { provider: selection.provider, model: selection.model, level };
  update((state) => {
    if (!state.config) return state;
    const models = promoteDefault(
      state.config.dshModels,
      selection.provider,
      selection.model,
    );
    return {
      ...state,
      config: {
        ...state.config,
        dshModels: {
          ...models,
          modelEfforts: {
            ...(models.modelEfforts ?? {}),
            [`${selection.provider}/${selection.model}`]: level,
          },
        },
      },
    };
  });
  if (effortSaveTimer !== null) window.clearTimeout(effortSaveTimer);
  effortSaveTimer = window.setTimeout(() => void flushEffort(), EFFORT_SAVE_DELAY_MS);
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
      agentActions.refreshProjects(),
      agentActions.refreshSessions(),
      agentActions.loadConfig(),
      // A blocking ask can arrive before this page was ever opened; seed the
      // same reducers the live events use so the cards render on first paint.
      agentActions.loadPending(),
    ]);
    // A selection restored from preferences is not a move, so `adoptTasks`
    // did not read its board.
    ensureTeam(agentStore.get().selectedId);
    const selected = agentStore.get().selectedId;
    if (selected) void readSessionMode(selected);
  },

  /** Opens the settings dialog. Entry points pick the group they are about:
   *  the task column footer opens 常规, the composer's 「管理模型」 opens 模型. */
  openConfig: (section: AgentConfigSection = "general"): void => {
    update((state) => ({ ...state, configOpen: true, configSection: section }));
  },

  closeConfig: (): void => {
    update((state) => ({ ...state, configOpen: false }));
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

  newSession: async (project?: {
    kind: DshProject["kind"];
    id: string;
  }): Promise<void> => {
    try {
      const sessionId = await allocateSession(project);
      // The backend records the free chat as a task row; reading the list now
      // gives the worktree switch its project/repository facts immediately.
      await agentActions.refreshTasks();
      await applyDraftSelection(sessionId);
    } catch (error) {
      setError(error);
    }
  },

  /** Switches one session's model. With no session yet the pick is kept for
   *  the next allocation instead. */
  selectModel: async (
    sessionId: string | null,
    selection: ModelSelection,
  ): Promise<void> => {
    if (!sessionId) {
      // No Agent to route yet: keep the draft and remember the choice as the
      // default for whichever session is allocated next.
      update((state) => ({ ...state, draftSelection: selection }));
      rememberEffort(selection);
      return;
    }
    const current = agentStore.get();
    const before =
      current.sessions[sessionId]?.selection ?? current.selectionOverrides[sessionId];
    applySelection(sessionId, selection);
    try {
      await dshApi.selectModel(sessionId, selection);
      // Only a route the runtime accepted becomes the next session's default.
      rememberEffort(selection);
    } catch (error) {
      applySelection(sessionId, before);
      setError(error);
    }
  },

  /** Records a route picked outside a live session (the enqueue sheet) as the
   *  default for every session that starts next. Existing sessions keep their
   *  own durable selection. */
  rememberModelDefault: async (selection: ModelSelection): Promise<void> => {
    rememberEffort(selection);
    await flushEffort();
  },

  /** Switches one session between plan mode and the three permission modes.
   *  Plan is a separate engine flag; a permission pick also leaves plan mode. */
  selectSessionMode: async (
    sessionId: string,
    next: DshPermissionMode | "plan",
  ): Promise<void> => {
    const state = agentStore.get();
    const beforeMode = state.sessionModes[sessionId];
    const beforePlan = state.planOverrides[sessionId];
    const plan = next === "plan";
    const mode = next === "plan" ? undefined : next;
    const write = (modeWrites.get(sessionId) ?? 0) + 1;
    modeWrites.set(sessionId, write);
    update((current) => ({
      ...current,
      sessionModes: mode
        ? { ...current.sessionModes, [sessionId]: mode }
        : current.sessionModes,
      planOverrides: { ...current.planOverrides, [sessionId]: plan },
    }));
    try {
      await dshApi.setSessionMode(sessionId, {
        ...(mode ? { mode } : {}),
        plan,
      });
    } catch (error) {
      // A newer pick owns the screen now; its own failure/success decides.
      if (modeWrites.get(sessionId) !== write) return;
      update((current) => {
        const sessionModes = { ...current.sessionModes };
        if (beforeMode === undefined) delete sessionModes[sessionId];
        else sessionModes[sessionId] = beforeMode;
        const planOverrides = { ...current.planOverrides };
        if (beforePlan === undefined) delete planOverrides[sessionId];
        else planOverrides[sessionId] = beforePlan;
        return { ...current, sessionModes, planOverrides };
      });
      setError(error);
    }
  },

  /** Re-reads the unified list and refreshes the selected history. */
  /** Usage totals for the status line; cheap and safe to repeat. */
  refreshSessions: async (): Promise<void> => {
    try {
      const { sessions } = await dshApi.sessions();
      applySessions(sessions);
    } catch {
      // The status line is optional chrome; a failed read leaves it empty.
    }
  },

  refreshTasks: async (): Promise<void> => {
    const before = agentStore.get().selectedId;
    try {
      const { tasks } = await dshTaskApi.list();
      adoptTasks(tasks);
      const selected = agentStore.get().selectedId;
      // A repaired selection was loaded by `adoptTasks`; only an unchanged one
      // still needs its history refreshed.
      if (selected && selected === before) {
        await loadEntries(selected);
      }
    } catch (error) {
      update((state) => ({ ...state, tasksError: String(error) }));
    }
  },

  /**
   * Task rows only, for surfaces outside the Agent page (bug list queue tab,
   * global queue). It does not repair the selection or load a transcript, so a
   * background feed cannot pull the reader into a conversation.
   */
  refreshTaskRows: async (): Promise<void> => {
    try {
      const { tasks } = await dshTaskApi.list();
      update((state) => ({ ...state, tasks, tasksError: null }));
    } catch (error) {
      update((state) => ({ ...state, tasksError: String(error) }));
    }
  },

  /** Configured projects; the list renders one group per project even empty. */
  refreshProjects: async (): Promise<void> => {
    try {
      const { projects } = await dshTaskApi.projects();
      update((state) => ({ ...state, projects }));
    } catch {
      // The list still groups by whatever the task rows carry; a failed read
      // only loses the empty project headers.
    }
  },

  /** Selects a task returned by an enqueue and puts it at the top of the list. */
  adoptTask: (task: DshTask): void => {
    replaceTask(task);
    update((state) => ({
      ...state,
      configOpen: false,
      selectedId: task.id,
      entries: {
        ...state.entries,
        [task.id]: state.entries[task.id] ?? { items: [], loaded: false, error: null },
      },
      live: { ...state.live, [task.id]: undefined },
      committedAttempts: { ...state.committedAttempts, [task.id]: undefined },
      pendingPrompts: { ...state.pendingPrompts, [task.id]: [] },
      lastError: null,
    }));
    persistPrefs();
    void loadEntries(task.id);
    void readSessionMode(task.id);
    ensureTeam(task.id);
  },

  /** Task workflow actions. They throw so the action bar shows the reason next
   *  to the buttons; the returned task is already installed in the list. */
  approveTask: async (sessionId: string): Promise<DshTask> => {
    const { task } = await dshTaskApi.approve(sessionId);
    replaceTask(task);
    return task;
  },

  /** Resumes the finalize pipeline from the step that failed. */
  retryFinalize: async (sessionId: string): Promise<DshTask> => {
    const { task } = await dshTaskApi.retryFinalize(sessionId);
    replaceTask(task);
    return task;
  },

  cancelTask: async (sessionId: string, stash = false): Promise<DshTask> => {
    const { task } = await dshTaskApi.cancel(sessionId, stash);
    replaceTask(task);
    return task;
  },

  /** Opts one free chat into (or out of) its own worktree. A dirty worktree
   *  rejects the disable; the caller surfaces that as a toast. */
  chatWorktree: async (sessionId: string, enabled: boolean): Promise<DshTask> => {
    const { task } = await dshTaskApi.chatWorktree(sessionId, enabled);
    replaceTask(task);
    return task;
  },

  /** Changed files of one task's worktree, for the review pane. */
  taskChanges: (sessionId: string) => dshTaskApi.changes(sessionId),

  /** One file's diff (`file` absent: the whole change set). */
  taskDiff: (sessionId: string, file?: string) => dshTaskApi.diff(sessionId, file),

  /** 「继续修改」switches back to the transcript and puts the caret in the box. */
  focusComposer: (): void => {
    update((state) => ({ ...state, composerFocusAt: Date.now() }));
  },

  /** Deletes one session: row, log, its directory and any worktree it made.
   *  Errors are surfaced through the page's error line; the list self-heals from
   *  the backend's `dsh://tasks` event either way. */
  deleteSession: async (sessionId: string): Promise<void> => {
    try {
      await dshTaskApi.delete(sessionId);
    } catch (error) {
      setError(error);
      return;
    }
    drafts.delete(sessionId);
    update((state) => {
      const tasks = (state.tasks ?? []).filter((task) => task.id !== sessionId);
      const selectedId =
        state.selectedId === sessionId ? (tasks[0]?.id ?? null) : state.selectedId;
      const entries = { ...state.entries };
      delete entries[sessionId];
      const live = { ...state.live };
      delete live[sessionId];
      const committedAttempts = { ...state.committedAttempts };
      delete committedAttempts[sessionId];
      const pendingPrompts = { ...state.pendingPrompts };
      delete pendingPrompts[sessionId];
      const sessionModes = { ...state.sessionModes };
      delete sessionModes[sessionId];
      const planOverrides = { ...state.planOverrides };
      delete planOverrides[sessionId];
      const selectionOverrides = { ...state.selectionOverrides };
      delete selectionOverrides[sessionId];
      const taskViews = { ...state.taskViews };
      delete taskViews[sessionId];
      return {
        ...state,
        tasks,
        selectedId,
        entries,
        live,
        committedAttempts,
        pendingPrompts,
        sessionModes,
        planOverrides,
        selectionOverrides,
        taskViews,
      };
    });
    persistPrefs();
    const selected = agentStore.get().selectedId;
    if (selected) void loadEntries(selected);
  },

  /** Stops the selected session's current turn. This is not a task cancel:
   *  the workflow still settles from the runtime's own `turn/end`. */
  cancelTurn: async (sessionId: string): Promise<void> => {
    try {
      await dshApi.cancelTurn(sessionId);
      update((state) => ({
        ...state,
        pendingPrompts: { ...state.pendingPrompts, [sessionId]: [] },
      }));
    } catch (error) {
      setError(error);
    }
  },

  /** Re-runs a failed turn without queuing its prompt again: the engine
   *  records an empty retry message, so the context keeps one copy. */
  retryTurn: async (sessionId: string): Promise<void> => {
    try {
      update((state) => ({
        ...state,
        // Same reset as a fresh prompt: the failed attempt's overlay is stale.
        live: { ...state.live, [sessionId]: undefined },
        committedAttempts: { ...state.committedAttempts, [sessionId]: undefined },
        lastError: null,
      }));
      await dshApi.retryTurn(sessionId);
    } catch (error) {
      setError(error);
    }
  },

  /**
   * Resumes an interrupted workflow task by sending one continuation prompt.
   * dsh's own retry shape only fires after a failed turn, and a stopped/crashed
   * round has no such end, so a normal prompt is the reliable way back in.
   *
   * The row flips to working locally before the backend event lands; a rejected
   * prompt reloads the stored list so the 已中断 state comes back.
   */
  continueTask: async (sessionId: string, prompt: string): Promise<void> => {
    const text = prompt.trim();
    if (!text) return;
    update((state) => ({
      ...state,
      live: { ...state.live, [sessionId]: undefined },
      committedAttempts: { ...state.committedAttempts, [sessionId]: undefined },
      pendingPrompts: {
        ...state.pendingPrompts,
        [sessionId]: [...(state.pendingPrompts[sessionId] ?? []), text],
      },
      tasks:
        state.tasks?.map((task) =>
          task.id === sessionId
            ? {
                ...task,
                interrupted: false,
                status: "running",
                // Keep the age fallback from re-flagging it while the turn
                // starts and the live session row lands.
                updatedAt: new Date().toISOString(),
              }
            : task,
        ) ?? null,
      lastError: null,
    }));
    try {
      await dshApi.prompt(sessionId, text);
    } catch (error) {
      update((state) => {
        const queue = state.pendingPrompts[sessionId] ?? [];
        const index = queue.indexOf(text);
        const pendingPrompts = { ...state.pendingPrompts };
        if (index >= 0) pendingPrompts[sessionId] = queue.filter((_, i) => i !== index);
        return { ...state, pendingPrompts };
      });
      void agentActions.refreshTaskRows();
      throw error;
    }
  },

  setPermissionMode: async (mode: DshAgentConfig["permissionMode"]): Promise<void> => {
    const { mode: saved } = await dshPolicyApi.set(mode);
    update((state) =>
      state.config ? { ...state, config: { ...state.config, permissionMode: saved } } : state,
    );
    // The runtime keeps the gate it booted with; surface the drift right away.
    void agentActions.refreshStatus();
  },

  setTeamView: (sessionId: string, view: AgentTeamView): void => {
    update((state) => ({
      ...state,
      teamViews: { ...state.teamViews, [sessionId]: view },
    }));
  },

  /** Switches the session pane between the transcript and the trajectory. */
  setTaskView: (sessionId: string, view: AgentTaskView): void => {
    update((state) => ({
      ...state,
      taskViews: { ...state.taskViews, [sessionId]: view },
    }));
  },

  /** Retries a failed board read; the toggle itself never bypasses this. */
  refreshTeam: (sessionId: string): void => {
    void readTeam(sessionId);
  },

  /** Free chats have no session until the first message; the pick waits here. */

  /**
   * Switches team mode for one session. The switch answers the click before the
   * round trip (a queued toggle for a session without an Agent yet has no echo
   * to wait for), and the returned board replaces the local copy. An explicit
   * pane choice is dropped so the new default applies.
   */
  setTeamEnabled: async (sessionId: string, enabled: boolean): Promise<void> => {
    const snapshot = agentStore.get();
    const task = snapshot.tasks?.find((item) => item.id === sessionId);
    const prestart =
      task?.kind === "chat" &&
      task.messageCount === 0 &&
      (snapshot.pendingPrompts[sessionId]?.length ?? 0) === 0 &&
      task.status !== "running";
    if (prestart) {
      const previous = snapshot.team[sessionId];
      const optimistic: DshTeam = previous
        ? { ...previous, enabled }
        : { sessionId, enabled, tasks: [] };
      update((state) => ({
        ...state,
        chatTeamDrafts: { ...state.chatTeamDrafts, [sessionId]: enabled },
        team: { ...state.team, [sessionId]: optimistic },
        teamErrors: { ...state.teamErrors, [sessionId]: null },
      }));
      return;
    }
    if (snapshot.teamBusy[sessionId]) return;
    const previous = snapshot.team[sessionId];
    const optimistic: DshTeam = previous
      ? { ...previous, enabled }
      : { sessionId, enabled, tasks: [] };
    update((state) => ({
      ...state,
      // Live state, not a spinner: the engine records the choice as soon as it
      // accepts the control frame.
      team: { ...state.team, [sessionId]: optimistic },
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
      update((state) => {
        const team = { ...state.team };
        if (previous) team[sessionId] = previous;
        else delete team[sessionId];
        return {
          ...state,
          team,
          teamErrors: { ...state.teamErrors, [sessionId]: String(error) },
        };
      });
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

  /** Stop + start in one backend step, so settings that are only read at boot
   *  take effect without quitting the app. */
  restartRuntime: async (): Promise<void> => {
    if (agentStore.get().starting) return;
    update((state) => ({ ...state, starting: true, lastError: null }));
    try {
      const status = await dshApi.restart();
      update((state) => ({
        ...state,
        status,
        statusError: null,
        starting: false,
        live: {},
        committedAttempts: {},
      }));
      await Promise.all([
        agentActions.refreshSessions(),
        agentActions.refreshTasks(),
        agentActions.refreshProjects(),
        agentActions.loadPending(),
      ]);
    } catch (error) {
      update((state) => ({ ...state, starting: false }));
      setError(error);
      void agentActions.refreshStatus();
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
    // edited elsewhere and must not be overwritten by a stale copy. The
    // remembered levels are written by the composer, not by this draft, so the
    // freshest map wins over the copy the tab loaded with.
    const latest = await dshSettingsApi.get();
    const saved = await dshSettingsApi.save({
      ...latest,
      ...draft,
      dshModels: {
        ...draft.dshModels,
        modelEfforts: latest.dshModels.modelEfforts ?? {},
      },
    });
    update((state) => ({ ...state, config: saved, configError: null }));
    // A catalog edit applies live; the status read either clears the drift flag
    // or keeps the restart button when the runtime could not adopt it.
    void agentActions.refreshStatus();
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
      if (!sessionId) {
        sessionId = await allocateSession();
        await applyDraftSelection(sessionId);
      }
      const targetId = sessionId;
      update((state) => ({
        ...state,
        // A new prompt starts a new attempt; anything the previous one left in
        // the overlay is stale before the first delta arrives.
        live: { ...state.live, [targetId]: undefined },
        committedAttempts: { ...state.committedAttempts, [targetId]: undefined },
        pendingPrompts: {
          ...state.pendingPrompts,
          [targetId]: [...(state.pendingPrompts[targetId] ?? []), trimmed],
        },
        lastError: null,
      }));
      // The first prompt is also when the runtime creates the Agent. Send the
      // start-only team pick first so the bridge queues it and applies it on
      // `agent/created`, before the turn reads the team board.
      const draftTeam = agentStore.get().chatTeamDrafts[targetId];
      if (draftTeam !== undefined) {
        try {
          await dshTeamApi.set(targetId, draftTeam);
        } catch (error) {
          // The prompt still runs; the work bar keeps the visible pick.
          void error;
        }
      }
      await dshApi.prompt(targetId, trimmed);
      if (draftTeam !== undefined) {
        update((state) => {
          const drafts = { ...state.chatTeamDrafts };
          delete drafts[targetId];
          return { ...state, chatTeamDrafts: drafts };
        });
      }
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
    update((state) => {
      const ready = status.phase === "ready";
      return {
        ...state,
        status,
        statusError: null,
        // The process's own phase is the truth here: it also covers the boot
        // that happens without a UI action (auto-start, restart from config).
        starting: status.phase === "starting",
        preparingSince: ready ? null : state.preparingSince,
        lastError: ready ? null : state.lastError,
        // A stopped, restarting or failed process has no live attempts; keeping
        // them alive painted the previous answer over the next turn.
        live: ready ? state.live : {},
        committedAttempts: ready ? state.committedAttempts : {},
      };
    });
  },
  entry: (payload: DshEntryEvent): void => applyEntry(payload),
  stream: (payload: DshSessionEvent): void => applyStream(payload),
  approval: (payload: DshApprovalEvent): void => applyApproval(payload),
  question: (payload: DshQuestionEvent): void => applyQuestion(payload),
  settled: (payload: DshSettledEvent): void => applySettled(payload),
  /** The list is authoritative; replace it and repair the selection. */
  tasks: (payload: DshTasksEvent): void => adoptTasks(payload.tasks),
  /** Usage counters ride on the session rows; they change per entry. */
  sessions: (payload: DshSessionsEvent): void => applySessions(payload.sessions),
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
