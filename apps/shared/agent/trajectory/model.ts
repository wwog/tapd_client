/**
 * Trajectory projection: one session's committed rows (plus the live attempt)
 * as a turn-aware ledger.
 *
 * The view is a pure projection of `AgentEntry` — it never invents rows the log
 * does not have. `turn`/`step` come from the backend (dsh's own counters), so
 * grouping matches the runtime instead of being re-derived from timestamps.
 */
import type { AgentEntry, AgentLocale } from "../types";
import { agentLabel } from "../labels";

export type TrajKind = "user" | "assistant" | "tool" | "notice";

/** One in-flight call of the live attempt; the host's stream shape fits as-is. */
export type LiveToolCall = { callId?: string; name: string; args: string };

export type TrajState = "complete" | "running" | "error";

/** One ledger row. Tool rows keep the call's seq; the result updates in place. */
export type TrajRecord = {
  id: string;
  /** 1-based position in the session log. */
  index: number;
  kind: TrajKind;
  /** dsh turn number; 0 for rows before the first `turn/start`. */
  turn: number;
  /** dsh step number; 0 for the message group. */
  step: number;
  /** Group title (`第 N 步` / `消息`). */
  group: string;
  /** One-line preview, already whitespace-collapsed and bounded. */
  text: string;
  /** Tool result preview; the ledger draws it after `→`. */
  result?: string;
  state: TrajState;
  /** Epoch ms of the operation's own start, when the log recorded it. */
  startedAtMs?: number;
  /** Epoch ms when the operation settled. */
  endedAtMs?: number;
  /** First streamed token of an assistant reply. */
  firstTokenAtMs?: number;
  /** Committed row behind this record; absent for the live tail. */
  entry?: AgentEntry;
  /** Live-only rows carry no committed seq yet. */
  live?: true;
  /** Index of the assistant message this tool row belongs to. */
  parentIndex?: number;
};

export type TrajGroup = { title: string; records: TrajRecord[] };

export type TrajTurn = { turn: number; groups: TrajGroup[] };

/** What the live attempt contributes to the ledger tail. */
export type LiveTraceInput = {
  text: string;
  reasoning: string;
  tools: LiveToolCall[];
};

const PREVIEW_SOURCE_CHARACTERS = 2_048;
const PREVIEW_OUTPUT_CHARACTERS = 512;

/**
 * Collapses text into one bounded line.
 *
 * Only block decoration is removed: fence markers, heading hashes and quote
 * carets at the start of a line. Everything else — a `>` inside a shell
 * argument, `_` in a path, the code inside a fence — is content and stays.
 * This preview also renders tool arguments, where stripping punctuation would
 * misstate what the tool was asked to do.
 */
export function previewText(text: string): string {
  const source = text.slice(0, PREVIEW_SOURCE_CHARACTERS);
  const compact = source
    .replace(/^\s{0,3}```[^\n]*$/gm, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const preview = compact.slice(0, PREVIEW_OUTPUT_CHARACTERS).trimEnd();
  return source.length < text.length || preview.length < compact.length
    ? `${preview}…`
    : preview;
}

/** Tool results arrive as a string or as the JSON value the host received. */
export function resultText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** `at` is RFC3339; the trajectory works in epoch ms. */
function atMs(at: string): number | undefined {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toolText(name: string, args: string): string {
  const preview = previewText(args);
  if (preview === "" || preview === "{}") return name;
  return `${name} · ${preview}`;
}

function assistantText(text: string, reasoning: string | undefined, locale: AgentLocale): string {
  const preview = previewText(text);
  if (preview !== "") return preview;
  const thought = reasoning === undefined ? "" : previewText(reasoning);
  return thought !== "" ? thought : agentLabel("traj.toolCallOnly", locale);
}

function stateOf(entry: AgentEntry): TrajState {
  if (entry.kind === "tool") {
    if (entry.status === "error") return "error";
    return entry.status === "running" ? "running" : "complete";
  }
  return "complete";
}

function stepTitle(step: number, locale: AgentLocale): string {
  return agentLabel("traj.groupStep", locale, { step });
}

/**
 * Live tail: the assistant reply being streamed and its in-flight calls.
 *
 * The stream carries no step counters, so the rows continue the step the log
 * is on (a reply after tool rows opens the next one). The ledger positions
 * them at the tail; the timeline has no timing for them yet.
 */
function liveRecords(
  live: LiveTraceInput | undefined,
  last: TrajRecord | undefined,
  startIndex: number,
  locale: AgentLocale,
): TrajRecord[] {
  if (!live) return [];
  const hasText = live.text.trim() !== "" || live.reasoning.trim() !== "";
  if (!hasText && live.tools.length === 0) return [];
  const turn = last?.turn ?? 0;
  const step =
    last === undefined ? 1 : last.kind === "tool" ? last.step + 1 : Math.max(1, last.step);
  const out: TrajRecord[] = [];
  let index = startIndex;
  const assistantIndex = hasText ? index : undefined;
  if (hasText) {
    out.push({
      id: "live:assistant",
      index,
      kind: "assistant",
      turn,
      step,
      group: stepTitle(step, locale),
      text: assistantText(live.text, live.reasoning, locale),
      state: "running",
      live: true,
    });
    index += 1;
  }
  for (const [offset, tool] of live.tools.entries()) {
    out.push({
      id: `live:tool:${tool.callId || offset}`,
      index,
      kind: "tool",
      turn,
      step,
      group: stepTitle(step, locale),
      text: toolText(tool.name, tool.args),
      state: "running",
      live: true,
      ...(assistantIndex === undefined ? {} : { parentIndex: assistantIndex }),
    });
    index += 1;
  }
  return out;
}

/**
 * Projects committed rows into turns of grouped records.
 *
 * @param entries - Committed rows in log order.
 * @param locale - Copy language for group titles and placeholders.
 * @returns Turns in log order; empty when the session has no rows.
 */
export function deriveTrajectory(entries: readonly AgentEntry[], locale: AgentLocale): TrajTurn[] {
  const records: TrajRecord[] = [];
  let index = 0;
  let lastAssistant: { index: number; turn: number; step: number } | undefined;

  for (const entry of entries) {
    if (entry.kind === "turn") continue;
    index += 1;
    if (entry.kind === "user") {
      records.push({
        id: `user:${entry.seq}`,
        index,
        kind: "user",
        turn: entry.turn,
        // A steering message keeps its own step so it stays where it happened;
        // the opening prompt owns the message group.
        step: entry.step,
        group: entry.step === 0 ? agentLabel("traj.groupMessage", locale) : stepTitle(entry.step, locale),
        text: previewText(entry.text),
        state: "complete",
        startedAtMs: atMs(entry.at),
        endedAtMs: atMs(entry.at),
        entry,
      });
      continue;
    }
    if (entry.kind === "assistant") {
      records.push({
        id: `assistant:${entry.seq}`,
        index,
        kind: "assistant",
        turn: entry.turn,
        step: entry.step,
        group: stepTitle(entry.step, locale),
        text: assistantText(entry.text, entry.reasoning, locale),
        state: "complete",
        startedAtMs: entry.startedAtMs ?? atMs(entry.at),
        endedAtMs: entry.completedAtMs ?? atMs(entry.at),
        firstTokenAtMs: entry.firstTokenAtMs,
        entry,
      });
      lastAssistant = { index, turn: entry.turn, step: entry.step };
      continue;
    }
    if (entry.kind === "notice") {
      // A child agent's settlement: the summary (how it ended, plus the exact
      // stop reason when recorded) is the row, the closing message its result.
      records.push({
        id: `notice:${entry.seq}`,
        index,
        kind: "notice",
        turn: entry.turn,
        step: entry.step,
        group: stepTitle(entry.step, locale),
        text: previewText([entry.summary, entry.stopReason].filter(Boolean).join(" · ")),
        ...(entry.text.trim() === "" ? {} : { result: previewText(entry.text) }),
        state: "complete",
        startedAtMs: atMs(entry.at),
        endedAtMs: atMs(entry.at),
        entry,
      });
      continue;
    }
    const raw = resultText(entry.result);
    const result =
      raw === undefined
        ? entry.status === "running"
          ? undefined
          : agentLabel("traj.noOutput", locale)
        : previewText(raw);
    // A tool row only belongs to an assistant that answered the same step;
    // tool-only steps have no assistant row at all.
    const parent =
      lastAssistant !== undefined &&
      lastAssistant.turn === entry.turn &&
      lastAssistant.step === entry.step
        ? lastAssistant.index
        : undefined;
    records.push({
      id: `tool:${entry.callId || entry.seq}`,
      index,
      kind: "tool",
      turn: entry.turn,
      step: entry.step,
      group: stepTitle(entry.step, locale),
      text: toolText(entry.name, entry.args),
      ...(result === undefined ? {} : { result }),
      state: stateOf(entry),
      startedAtMs: entry.startedAtMs ?? atMs(entry.at),
      ...(entry.endedAtMs === undefined ? {} : { endedAtMs: entry.endedAtMs }),
      entry,
      ...(parent === undefined ? {} : { parentIndex: parent }),
    });
  }

  // Bucket by turn number (a repeated number is one turn) and keep group order.
  const turns: TrajTurn[] = [];
  const turnByNumber = new Map<number, TrajTurn>();
  for (const record of records) {
    let turn = turnByNumber.get(record.turn);
    if (turn === undefined) {
      turn = { turn: record.turn, groups: [] };
      turnByNumber.set(record.turn, turn);
      turns.push(turn);
    }
    const group = turn.groups.find((candidate) => candidate.title === record.group);
    if (group === undefined) turn.groups.push({ title: record.group, records: [record] });
    else group.records.push(record);
  }
  return turns;
}

/** Appends the in-flight rows to an already-derived projection. */
export function appendLiveTurns(
  turns: readonly TrajTurn[],
  live: LiveTraceInput | undefined,
  locale: AgentLocale,
): readonly TrajTurn[] {
  const all = flatten(turns);
  const last = all[all.length - 1];
  const rows = liveRecords(live, last, (last?.index ?? 0) + 1, locale);
  if (rows.length === 0) return turns;
  const out = turns.map((turn) => ({
    turn: turn.turn,
    groups: turn.groups.map((group) => ({ title: group.title, records: [...group.records] })),
  }));
  const turnNumber = rows[0]?.turn ?? 0;
  let turn = out.find((candidate) => candidate.turn === turnNumber);
  if (turn === undefined) {
    turn = { turn: turnNumber, groups: [] };
    out.push(turn);
  }
  const title = rows[0]?.group ?? "";
  let group = turn.groups.find((candidate) => candidate.title === title);
  if (group === undefined) {
    group = { title, records: [] };
    turn.groups.push(group);
  }
  group.records.push(...rows);
  return out;
}

/** Flattens turns back into log order (the ledger renders this list). */
export function flatten(turns: readonly TrajTurn[]): TrajRecord[] {
  return turns.flatMap((turn) => turn.groups.flatMap((group) => group.records));
}

/** Records a turn actually did something with; used for fold decisions. */
export function turnRecordCount(turn: TrajTurn): number {
  return turn.groups.reduce((count, group) => count + group.records.length, 0);
}

/** "N 步 · M 次工具调用" for a collapsed turn. */
export function summarizeTurn(turn: TrajTurn, locale: AgentLocale): string {
  const steps = new Set(
    turn.groups
      .flatMap((group) => group.records)
      .filter((record) => record.step > 0)
      .map((record) => record.step),
  ).size;
  const calls = turn.groups
    .flatMap((group) => group.records)
    .filter((record) => record.kind === "tool").length;
  return [
    agentLabel(steps === 1 ? "traj.stepsOne" : "traj.steps", locale, { count: steps }),
    agentLabel(calls === 1 ? "traj.callsCountOne" : "traj.callsCount", locale, { count: calls }),
  ].join(" · ");
}

/** "M 次工具调用 · bash, read" for collapsed tool rows. */
export function summarizeCalls(records: readonly TrajRecord[], locale: AgentLocale): string {
  const names = [
    ...new Set(
      records
        .map((record) => record.text.split(" · ")[0] ?? record.text)
        .filter((name) => name !== ""),
    ),
  ];
  const count = records.length;
  const summary = agentLabel(count === 1 ? "traj.callsCountOne" : "traj.callsCount", locale, {
    count,
  });
  return names.length > 0 ? `${summary} · ${names.join(", ")}` : summary;
}

/** The assistant message a tool row hangs under, when it is in the list. */
export function parentAssistant(
  records: readonly TrajRecord[],
  record: TrajRecord,
): TrajRecord | undefined {
  if (record.parentIndex === undefined) return undefined;
  return records.find((candidate) => candidate.index === record.parentIndex);
}

/**
 * Tool rows that follow an assistant message in the same step.
 *
 * The backend writes no row for a tool-only reply, so the scan must stop when
 * the step changes: those tools belong to the next step, not this message.
 */
export function toolCallsAfter(
  records: readonly TrajRecord[],
  assistantIndex: number,
): TrajRecord[] {
  const at = records.findIndex((record) => record.index === assistantIndex);
  const assistant = records[at];
  if (assistant === undefined || assistant.kind !== "assistant") return [];
  const calls: TrajRecord[] = [];
  for (let cursor = at + 1; cursor < records.length; cursor += 1) {
    const record = records[cursor];
    if (
      record === undefined ||
      record.kind !== "tool" ||
      record.step !== assistant.step ||
      record.turn !== assistant.turn
    ) {
      break;
    }
    calls.push(record);
  }
  return calls;
}

/** Assistant rows that own at least one tool row (one pass, for fold-all). */
export function collapsibleAssistantIds(records: readonly TrajRecord[]): string[] {
  const ids: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.kind !== "assistant") continue;
    const next = records[index + 1];
    if (
      next !== undefined &&
      next.kind === "tool" &&
      next.step === record.step &&
      next.turn === record.turn
    ) {
      ids.push(record.id);
    }
  }
  return ids;
}

/** Ledger search over what a row shows plus the full recorded payload. */
export function matchesQuery(record: TrajRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const entry = record.entry;
  const haystack = [
    record.text,
    record.result ?? "",
    entry?.kind === "assistant" ? entry.text : "",
    entry?.kind === "assistant" ? entry.reasoning ?? "" : "",
    entry?.kind === "tool" ? entry.args : "",
    entry?.kind === "tool" ? resultText(entry.result) ?? "" : "",
    entry?.kind === "user" ? entry.text : "",
    entry?.kind === "notice" ? entry.summary : "",
    entry?.kind === "notice" ? entry.text : "",
    entry?.kind === "notice" ? entry.stopReason ?? "" : "",
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

/** Formats a duration in milliseconds the way the reference panel does. */
export function formatDurationMs(
  milliseconds: number | null | undefined,
  locale: AgentLocale,
): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return "—";
  }
  if (milliseconds < 1_000) {
    return agentLabel("traj.milliseconds", locale, { value: Math.round(milliseconds) });
  }
  const seconds = milliseconds / 1_000;
  return agentLabel("traj.seconds", locale, {
    value: seconds.toFixed(milliseconds < 10_000 ? 2 : 1),
  });
}

/** Local clock with millisecond precision, plus a Unix toggle in the panel. */
export function formatClock(timestamp: number | null | undefined, locale: AgentLocale): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) {
    return agentLabel("traj.notAvailable", locale);
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return agentLabel("traj.notAvailable", locale);
  const two = (value: number) => String(value).padStart(2, "0");
  const three = (value: number) => String(value).padStart(3, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(
    date.getHours(),
  )}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`;
}

/** Own duration of one row, or `undefined` while it is still running. */
export function recordDuration(record: TrajRecord): number | undefined {
  if (record.startedAtMs === undefined || record.endedAtMs === undefined) return undefined;
  return Math.max(0, record.endedAtMs - record.startedAtMs);
}
