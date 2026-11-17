/**
 * Trajectory projection: one session's committed rows (plus the live attempt)
 * as a turn-aware ledger.
 *
 * The view is a pure projection of `DshEntry` — it never invents rows the log
 * does not have. `turn`/`step` come from the backend (dsh's own counters), so
 * grouping matches the runtime instead of being re-derived from timestamps.
 */
import type { DshEntry } from "../../lib/dsh";
import { t } from "../../lib/i18n";
import type { LiveToolCall } from "../store";

export type TrajKind = "user" | "assistant" | "tool";

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
  entry?: DshEntry;
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

/** Collapses Markdown-ish text into one bounded line, like the reference view. */
export function previewText(text: string): string {
  const source = text.slice(0, PREVIEW_SOURCE_CHARACTERS);
  const compact = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~]/g, "")
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

function assistantText(text: string, reasoning?: string): string {
  const preview = previewText(text);
  if (preview !== "") return preview;
  const thought = reasoning === undefined ? "" : previewText(reasoning);
  return thought !== "" ? thought : t("agent.traj.toolCallOnly");
}

function stateOf(entry: DshEntry): TrajState {
  if (entry.kind === "tool") {
    if (entry.status === "error") return "error";
    return entry.status === "running" ? "running" : "complete";
  }
  return "complete";
}

/** Live tail: the assistant reply being streamed and its in-flight calls. */
function liveRecords(
  live: LiveTraceInput | undefined,
  last: TrajRecord | undefined,
  startIndex: number,
): TrajRecord[] {
  if (!live) return [];
  const hasText = live.text.trim() !== "" || live.reasoning.trim() !== "";
  if (!hasText && live.tools.length === 0) return [];
  const turn = last?.turn ?? 0;
  // A reply that follows tool rows is the next step; otherwise it continues
  // the step the log is already on.
  const step =
    last === undefined ? 1 : last.kind === "tool" ? last.step + 1 : Math.max(1, last.step);
  const group = t("agent.traj.groupStep", { step });
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
      group,
      text: assistantText(live.text, live.reasoning),
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
      group,
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
 * Projects one session into turns of grouped records.
 *
 * @param entries - Committed rows in log order.
 * @param live - Live attempt overlaid on the tail, or `undefined`.
 * @returns Turns in log order; empty when the session has no rows.
 */
export function deriveTrajectory(
  entries: readonly DshEntry[],
  live: LiveTraceInput | undefined,
): TrajTurn[] {
  const records: TrajRecord[] = [];
  let index = 0;
  let lastAssistantIndex: number | undefined;

  for (const entry of entries) {
    if (entry.kind === "turn") continue;
    index += 1;
    if (entry.kind === "user") {
      records.push({
        id: `user:${entry.seq}`,
        index,
        kind: "user",
        turn: entry.turn,
        step: 0,
        group: t("agent.traj.groupMessage"),
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
        group: t("agent.traj.groupStep", { step: entry.step }),
        text: assistantText(entry.text, entry.reasoning),
        state: "complete",
        startedAtMs: entry.startedAtMs ?? atMs(entry.at),
        endedAtMs: entry.completedAtMs ?? atMs(entry.at),
        firstTokenAtMs: entry.firstTokenAtMs,
        entry,
      });
      lastAssistantIndex = index;
      continue;
    }
    const raw = resultText(entry.result);
    const result =
      raw === undefined
        ? entry.status === "running"
          ? undefined
          : t("agent.traj.noOutput")
        : previewText(raw);
    records.push({
      id: `tool:${entry.callId || entry.seq}`,
      index,
      kind: "tool",
      turn: entry.turn,
      step: entry.step,
      group: t("agent.traj.groupStep", { step: entry.step }),
      text: toolText(entry.name, entry.args),
      ...(result === undefined ? {} : { result }),
      state: stateOf(entry),
      startedAtMs: entry.startedAtMs ?? atMs(entry.at),
      ...(entry.endedAtMs === undefined ? {} : { endedAtMs: entry.endedAtMs }),
      entry,
      ...(lastAssistantIndex === undefined ? {} : { parentIndex: lastAssistantIndex }),
    });
  }

  records.push(...liveRecords(live, records[records.length - 1], index + 1));

  // Group by turn, then by `step` (0 = the message group, first).
  const turns: TrajTurn[] = [];
  for (const record of records) {
    let turn = turns[turns.length - 1];
    if (turn === undefined || turn.turn !== record.turn) {
      turn = { turn: record.turn, groups: [] };
      turns.push(turn);
    }
    const group = turn.groups.find((candidate) => candidate.title === record.group);
    if (group === undefined) turn.groups.push({ title: record.group, records: [record] });
    else group.records.push(record);
  }
  return turns;
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
export function summarizeTurn(turn: TrajTurn): string {
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
    t(steps === 1 ? "agent.traj.stepsOne" : "agent.traj.steps", { count: steps }),
    t(calls === 1 ? "agent.traj.callsCountOne" : "agent.traj.callsCount", { count: calls }),
  ].join(" · ");
}

/** "M 次工具调用 · bash, read" for collapsed tool rows. */
export function summarizeCalls(records: readonly TrajRecord[]): string {
  const names = [
    ...new Set(
      records
        .map((record) => record.text.split(" · ")[0] ?? record.text)
        .filter((name) => name !== ""),
    ),
  ];
  const count = records.length;
  const summary = t(count === 1 ? "agent.traj.callsCountOne" : "agent.traj.callsCount", { count });
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

/** Tool rows that follow an assistant message in the same step group. */
export function toolCallsAfter(
  records: readonly TrajRecord[],
  assistantIndex: number,
): TrajRecord[] {
  const at = records.findIndex((record) => record.index === assistantIndex);
  if (at === -1 || records[at]?.kind !== "assistant") return [];
  const calls: TrajRecord[] = [];
  for (let cursor = at + 1; cursor < records.length; cursor += 1) {
    const record = records[cursor];
    if (record === undefined || record.kind !== "tool") break;
    calls.push(record);
  }
  return calls;
}

/** Ledger search over what a row actually shows (plus the full text). */
export function matchesQuery(record: TrajRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = [
    record.text,
    record.result ?? "",
    record.entry?.kind === "assistant" ? record.entry.text : "",
    record.entry?.kind === "assistant" ? record.entry.reasoning ?? "" : "",
    record.entry?.kind === "tool" ? record.entry.args : "",
    record.entry?.kind === "user" ? record.entry.text : "",
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

/** Formats a duration in milliseconds the way the reference panel does. */
export function formatDurationMs(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return "—";
  }
  if (milliseconds < 1_000) {
    return t("agent.traj.milliseconds", { value: Math.round(milliseconds) });
  }
  const seconds = milliseconds / 1_000;
  return t("agent.traj.seconds", {
    value: seconds.toFixed(milliseconds < 10_000 ? 2 : 1),
  });
}

/** Local clock with millisecond precision, plus a Unix toggle in the panel. */
export function formatClock(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) {
    return t("agent.traj.notAvailable");
  }
  const date = new Date(timestamp);
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
