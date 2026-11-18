/**
 * Timeline projections for the trajectory overview.
 *
 * Two domains are available: operation sequence (equal-width spans) and
 * recorded duration (idle time between operations compressed away). The
 * overview, the drag selection and the ledger focus all read the same model.
 */
import type { TrajKind, TrajRecord, TrajTurn } from "./model";

export type TrajTimelineMode = "sequence" | "duration";

export type TrajTimeRange = { start: number; end: number };

export type TrajSpan = TrajTimeRange & {
  index: number;
  kind: TrajKind;
  isError: boolean;
  lane: number;
};

export type TrajTimelineModel = TrajTimeRange & {
  spans: TrajSpan[];
  turnBoundaries: { turn: number; time: number }[];
};

/** Lane layout: prompt-side rows, the model's requests/replies, tool work. */
function laneOf(kind: TrajKind): number {
  if (kind === "tool" || kind === "subcall") return 2;
  if (
    kind === "assistant" ||
    kind === "request" ||
    kind === "retry" ||
    kind === "attempt"
  ) {
    return 1;
  }
  return 0;
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function spanRange(record: TrajRecord): TrajTimeRange | null {
  if (!finite(record.startedAtMs)) return null;
  const duration = finite(record.endedAtMs)
    ? Math.max(0, record.endedAtMs - record.startedAtMs)
    : 0;
  return { start: record.startedAtMs, end: record.startedAtMs + duration };
}

/** Every visible record as a three-lane timeline, or `null` when nothing timed. */
export function deriveTimeline(
  turns: readonly TrajTurn[],
  mode: TrajTimelineMode,
): TrajTimelineModel | null {
  if (mode === "duration") return deriveTimedTimeline(turns);
  const spans: TrajSpan[] = [];
  const turnBoundaries: { turn: number; time: number }[] = [];
  for (const turn of turns) {
    const records = turn.groups.flatMap((group) => group.records);
    if (records.length === 0) continue;
    if (turn.turn > 0) turnBoundaries.push({ turn: turn.turn, time: spans.length });
    // The base is fixed before the loop: using `spans.length` while pushing
    // would double-count every earlier record.
    const base = spans.length;
    for (const [offset, record] of records.entries()) {
      spans.push({
        start: base + offset,
        end: base + offset + 1,
        index: record.index,
        kind: record.kind,
        isError: record.state === "error",
        lane: laneOf(record.kind),
      });
    }
  }
  if (spans.length === 0) return null;
  return { start: 0, end: spans.length, spans, turnBoundaries };
}

/**
 * Recorded-duration projection. Idle gaps between operations are removed so a
 * long think or a lunch break does not squash the actual work.
 */
function deriveTimedTimeline(turns: readonly TrajTurn[]): TrajTimelineModel | null {
  const timedTurns = turns.flatMap((turn) => {
    const raw = turn.groups
      .flatMap((group) => group.records)
      .flatMap((record): TrajSpan[] => {
        const range = spanRange(record);
        return range === null
          ? []
          : [
              {
                ...range,
                index: record.index,
                kind: record.kind,
                isError: record.state === "error",
                lane: laneOf(record.kind),
              },
            ];
      });
    return raw.length === 0 ? [] : [{ turn: turn.turn, raw }];
  });
  const rawSpans = timedTurns.flatMap((turn) => turn.raw);
  if (rawSpans.length === 0) return null;

  const removedIdleBySpan = new Map<TrajSpan, number>();
  let removedIdle = 0;
  let coveredUntil: number | null = null;
  for (const span of [...rawSpans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    if (coveredUntil !== null && span.start > coveredUntil) {
      removedIdle += span.start - coveredUntil;
    }
    removedIdleBySpan.set(span, removedIdle);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans: TrajSpan[] = [];
  const turnBoundaries: { turn: number; time: number }[] = [];
  for (const turn of timedTurns) {
    const projected = turn.raw.map((span): TrajSpan => {
      const offset = removedIdleBySpan.get(span) ?? 0;
      return { ...span, start: span.start - offset, end: span.end - offset };
    });
    spans.push(...projected);
    if (turn.turn > 0) {
      let first = Number.POSITIVE_INFINITY;
      for (const span of projected) first = Math.min(first, span.start);
      turnBoundaries.push({ turn: turn.turn, time: first });
    }
  }
  // Spread over a huge array overflows the argument limit; one pass is enough.
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    if (span.start < start) start = span.start;
    if (span.end > end) end = span.end;
  }
  return { start, end, spans, turnBoundaries };
}

/** Records active at any point inside an inclusive selected interval. */
export function timelineFocusIndexes(
  turns: readonly TrajTurn[],
  range: TrajTimeRange,
  mode: TrajTimelineMode,
): ReadonlySet<number> {
  const model = deriveTimeline(turns, mode);
  return new Set(
    (model?.spans ?? [])
      .filter((span) => span.start <= range.end && span.end >= range.start)
      .map((span) => span.index),
  );
}
