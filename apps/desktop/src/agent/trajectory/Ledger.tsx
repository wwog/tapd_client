/**
 * Trajectory ledger: one row per committed record, grouped by turn and step.
 *
 * A row is the log line made readable — kind glyph, a one-line preview, and
 * the tool result after `→`. Folded turns/calls become summary rows, the
 * timeline focus dims rows outside its range, and search dims non-matches.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  FileText,
  Globe,
  Image as ImageIcon,
  PenLine,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";

import { t } from "../../lib/i18n";
import { Button, Spinner } from "../../components/ui";
import { ScrollingName } from "../../components/ScrollingName";
import {
  flatten,
  summarizeCalls,
  summarizeTurn,
  toolCallsAfter,
  turnRecordCount,
  type TrajRecord,
  type TrajTurn,
} from "./model";

const COMPACT_WIDTH = 620;

type LedgerRow = {
  key: string;
  record: TrajRecord;
  turnStart: boolean;
  groupStart: boolean;
  turnEnd: boolean;
  /** Folded summary that replaces the rows below it. */
  summary?: string;
  /** What the folded row expands when clicked. */
  fold?: "turn" | "calls";
};

/** Glyph per row kind; tool names refine the wrench into something readable. */
function KindIcon({ record }: { record: TrajRecord }) {
  const name = record.entry?.kind === "tool" ? record.entry.name : "";
  if (record.kind === "user") {
    return (
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-sky-400"
        aria-hidden="true"
      />
    );
  }
  const Icon =
    record.kind === "assistant"
      ? Sparkles
      : name === "bash" || name === "shell"
        ? Terminal
        : name.startsWith("read")
          ? FileText
          : name.startsWith("write") || name.startsWith("edit")
            ? PenLine
            : name.includes("search") || name.includes("grep")
              ? Search
              : name.startsWith("web") || name.includes("fetch")
                ? Globe
                : name.includes("image")
                  ? ImageIcon
                  : Wrench;
  return (
    <Icon
      size={12}
      className={clsx("shrink-0", record.state === "error" ? "text-rose-500" : "text-slate-400")}
      aria-hidden="true"
    />
  );
}

function kindTagClass(record: TrajRecord): string {
  if (record.kind === "user") return "text-sky-700 bg-sky-50";
  if (record.kind === "assistant") return "text-violet-700 bg-violet-50";
  return "text-amber-700 bg-amber-50";
}

function kindLabel(record: TrajRecord): string {
  if (record.kind === "user") return t("agent.traj.kindUser");
  if (record.kind === "assistant") return t("agent.traj.kindAssistant");
  return t("agent.traj.kindTool");
}

/** Builds display rows: turn folds, call folds and per-turn separators. */
function buildRows(
  turns: readonly TrajTurn[],
  collapsedTurns: ReadonlySet<number>,
  collapsedAssistants: ReadonlySet<string>,
): LedgerRow[] {
  type Draft = {
    record: TrajRecord;
    turn: number;
    turnStart: boolean;
    groupStart: boolean;
    turnEnd: boolean;
    summary?: string;
    fold?: "turn" | "calls";
  };
  const drafts: Draft[] = [];
  for (const turn of turns) {
    let first = true;
    for (const group of turn.groups) {
      for (const record of group.records) {
        drafts.push({
          record,
          turn: turn.turn,
          turnStart: first,
          groupStart: group.records[0] === record,
          turnEnd: false,
        });
        first = false;
      }
    }
    const last = drafts[drafts.length - 1];
    if (last !== undefined) last.turnEnd = true;
  }

  // Turn fold: keep the opening row, replace the rest with one summary row.
  const afterTurns: Draft[] = [];
  for (const turn of turns) {
    const inTurn = drafts.filter((draft) => draft.turn === turn.turn);
    const first = inTurn[0];
    const last = inTurn[inTurn.length - 1];
    if (first === undefined) continue;
    if (turn.turn > 0 && collapsedTurns.has(turn.turn) && inTurn.length > 1) {
      afterTurns.push({ ...first, turnEnd: false });
      afterTurns.push({
        ...first,
        turnStart: false,
        groupStart: false,
        turnEnd: last?.turnEnd ?? true,
        summary: summarizeTurn(turn),
        fold: "turn",
      });
      continue;
    }
    afterTurns.push(...inTurn);
  }

  // Call fold: an assistant's following tool rows become one summary row.
  const out: LedgerRow[] = [];
  for (let cursor = 0; cursor < afterTurns.length; cursor += 1) {
    const draft = afterTurns[cursor];
    if (draft === undefined) continue;
    const calls: Draft[] = [];
    if (draft.record.kind === "assistant" && collapsedAssistants.has(draft.record.id)) {
      for (let next = cursor + 1; next < afterTurns.length; next += 1) {
        const candidate = afterTurns[next];
        if (candidate === undefined || candidate.record.kind !== "tool") break;
        calls.push(candidate);
      }
    }
    out.push({
      key: draft.summary === undefined ? draft.record.id : `fold:turn:${draft.turn}`,
      record: draft.record,
      turnStart: draft.turnStart,
      groupStart: draft.groupStart,
      turnEnd: calls.length > 0 ? false : draft.turnEnd,
      ...(draft.summary === undefined ? {} : { summary: draft.summary }),
      ...(draft.fold === undefined ? {} : { fold: draft.fold }),
    });
    if (calls.length === 0) continue;
    const lastCall = calls[calls.length - 1];
    out.push({
      key: `fold:calls:${draft.record.id}`,
      record: draft.record,
      turnStart: false,
      groupStart: false,
      turnEnd: lastCall?.turnEnd ?? false,
      summary: summarizeCalls(calls.map((call) => call.record)),
      fold: "calls",
    });
    cursor += calls.length;
  }
  return out;
}

type Props = {
  turns: readonly TrajTurn[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onClearSelection: () => void;
  /** Row the timeline asked to reveal without selecting it. */
  focusIndex?: number | null;
  focusIndexes: ReadonlySet<number> | null;
  searchMatchIndexes: ReadonlySet<number> | null;
  collapsedTurns: ReadonlySet<number>;
  collapsedAssistants: ReadonlySet<string>;
  onToggleTurn: (turn: number) => void;
  onToggleAssistant: (id: string) => void;
};

/** Scrollable ledger; the inspector sits beside it. */
export function TrajectoryLedger({
  turns,
  loading,
  failed,
  onRetry,
  selectedIndex,
  onSelect,
  onClearSelection,
  focusIndex = null,
  focusIndexes,
  searchMatchIndexes,
  collapsedTurns,
  collapsedAssistants,
  onToggleTurn,
  onToggleAssistant,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  const rows = useMemo(
    () => buildRows(turns, collapsedTurns, collapsedAssistants),
    [turns, collapsedTurns, collapsedAssistants],
  );
  const allRecords = useMemo(() => flatten(turns), [turns]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setCompact(element.clientWidth < COMPACT_WIDTH);
    });
    observer.observe(element);
    setCompact(element.clientWidth < COMPACT_WIDTH);
    return () => observer.disconnect();
  }, []);

  // A timeline focus scrolls the nearest row into view.
  useEffect(() => {
    if (selectedIndex === null) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(
      `[data-record-index="${selectedIndex}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    if (focusIndex === null) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(
      `[data-record-index="${focusIndex}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [focusIndex]);

  if (loading) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center">
        <div className="flex items-center gap-2 text-ui-caption text-slate-400">
          <Spinner />
          {t("common.loading")}
        </div>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center">
        <div className="flex items-center gap-3 text-ui-caption text-slate-400">
          <span>{t("agent.stream.loadFailed")}</span>
          <Button size="sm" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center px-6 text-ui-caption text-slate-400">
        {t("agent.traj.empty")}
      </div>
    );
  }

  const expand = (row: LedgerRow) => {
    if (row.fold === "calls") onToggleAssistant(row.record.id);
    else onToggleTurn(row.record.turn);
  };

  return (
    <div
      ref={scrollRef}
      className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClearSelection();
      }}
    >
      <table className="w-full table-fixed border-separate border-spacing-0 text-ui-xs">
        <colgroup>
          <col style={{ width: compact ? 50 : 84 }} />
          <col />
        </colgroup>
        <tbody>
          {rows.map((row) => {
            const { record } = row;
            const folded = row.summary !== undefined;
            const outside =
              focusIndexes !== null && !folded && !focusIndexes.has(record.index);
            const dimmed =
              searchMatchIndexes !== null && !folded && !searchMatchIndexes.has(record.index);
            const selected = !folded && selectedIndex === record.index;
            return (
              <tr
                key={row.key}
                tabIndex={folded ? -1 : 0}
                aria-selected={selected}
                data-record-index={folded ? undefined : record.index}
                className={clsx(
                  "outline-none transition-[background-color,opacity] duration-100",
                  "hover:bg-overlay",
                  selected && "bg-selected",
                  outside && "opacity-25",
                  dimmed && "opacity-15",
                )}
                onClick={() => {
                  if (folded) {
                    expand(row);
                    return;
                  }
                  onSelect(record.index);
                }}
                onDoubleClick={(event) => {
                  if (folded) return;
                  if (collapsedTurns.has(record.turn)) {
                    event.preventDefault();
                    onToggleTurn(record.turn);
                    return;
                  }
                  if (
                    record.kind === "assistant" &&
                    toolCallsAfter(allRecords, record.index).length > 0
                  ) {
                    event.preventDefault();
                    onToggleAssistant(record.id);
                    return;
                  }
                  const turn = turns.find((candidate) => candidate.turn === record.turn);
                  if (turn === undefined || turnRecordCount(turn) <= 1) return;
                  event.preventDefault();
                  onToggleTurn(record.turn);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  if (folded) {
                    expand(row);
                    return;
                  }
                  onSelect(record.index);
                }}
              >
                <td
                  className={clsx(
                    "relative h-[30px] overflow-visible border-b border-border pr-1 pl-7 align-middle",
                    row.turnStart && "border-t-2",
                  )}
                >
                  {row.turnStart && record.turn > 0 ? (
                    <span
                      className="absolute top-0 left-0 z-[3] rounded-br bg-canvas px-1 py-px font-mono text-ui-2xs text-slate-400 select-none"
                      aria-label={t("agent.traj.turnLabel", { turn: record.turn })}
                    >
                      #{record.turn}
                    </span>
                  ) : null}
                  {record.turn > 0 ? (
                    <span
                      className={clsx(
                        "absolute inset-y-0 left-0 w-0.5",
                        record.state === "error" ? "bg-rose-200" : "bg-sky-200",
                      )}
                      aria-hidden="true"
                    />
                  ) : null}
                  {selected ? (
                    <span
                      className="absolute inset-y-0 left-0 z-[5] w-[3px] bg-sky-500"
                      aria-hidden="true"
                    />
                  ) : null}
                  {row.groupStart && !folded && record.step > 0 ? (
                    <span
                      className="absolute top-1/2 left-3 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-slate-300"
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="flex h-full min-w-0 items-center justify-start gap-1.5">
                    {folded ? (
                      <span className="text-slate-300 select-none">…</span>
                    ) : (
                      <>
                        <KindIcon record={record} />
                        {compact ? null : (
                          <span
                            className={clsx(
                              "inline-flex h-[19px] items-center rounded px-1 text-ui-2xs",
                              kindTagClass(record),
                            )}
                          >
                            {kindLabel(record)}
                          </span>
                        )}
                      </>
                    )}
                  </span>
                </td>
                <td
                  className={clsx(
                    "h-[30px] min-w-0 overflow-hidden border-b border-border pr-2 pl-1 align-middle",
                    row.turnStart && "border-t-2",
                  )}
                >
                  {folded ? (
                    <span className="flex min-w-0 items-center text-slate-500">
                      <span className="min-w-0 flex-1">
                        <ScrollingName text={row.summary ?? ""} />
                      </span>
                    </span>
                  ) : (
                    <span
                      className={clsx(
                        "grid min-w-0 grid-cols-[minmax(140px,34%)_minmax(0,1fr)] items-center gap-2",
                        record.kind === "tool" && "font-mono",
                      )}
                    >
                      <ScrollingName
                        text={record.text || "—"}
                        className={clsx(
                          record.kind === "user" ? "text-slate-700" : "text-slate-600",
                          record.text === t("agent.traj.toolCallOnly") && "text-slate-400",
                        )}
                      />
                      {record.result === undefined ? null : (
                        <span className="flex min-w-0 items-center">
                          <span className="mr-2 shrink-0 text-slate-300 select-none">→</span>
                          <ScrollingName
                            text={record.result}
                            className={clsx(
                              record.state === "error" ? "text-rose-600" : "text-slate-500",
                              record.result === t("agent.traj.noOutput") && "text-slate-300",
                            )}
                          />
                        </span>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="h-2" />
    </div>
  );
}
