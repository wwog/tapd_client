/**
 * Trajectory panel: toolbar, timing overview, ledger and inspector.
 *
 * Everything here is a projection of the session log (`DshEntry`) plus the live
 * attempt; the panel never mutates the transcript. Selection and folding are
 * local view state, so switching to the conversation and back keeps the log
 * untouched.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Clock, Search } from "lucide-react";

import { t } from "../../lib/i18n";
import type { DshEntry } from "../../lib/dsh";
import { TrajectoryInspector } from "./Inspector";
import { TrajectoryLedger } from "./Ledger";
import { TrajectoryTimeline } from "./Timeline";
import {
  appendLiveTurns,
  collapsibleAssistantIds,
  deriveTrajectory,
  flatten,
  matchesQuery,
  turnRecordCount,
  type LiveTraceInput,
  type TrajRecord,
} from "./model";
import {
  timelineFocusIndexes,
  type TrajTimeRange,
  type TrajTimelineMode,
} from "./projection";

type Props = {
  entries: readonly DshEntry[];
  live: LiveTraceInput | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
};

/** Fold button: pressed state = everything of that kind is folded. */
function FoldButton({
  label,
  collapsed,
  onClick,
}: {
  label: string;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={collapsed}
      title={label}
      onClick={onClick}
      className={clsx(
        "inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-ui-2xs transition",
        collapsed ? "bg-selected text-slate-700" : "text-slate-400 hover:bg-overlay hover:text-slate-700",
      )}
    >
      <span className="font-mono text-ui-sm leading-none" aria-hidden="true">
        {collapsed ? "⊞" : "⊟"}
      </span>
      {label}
    </button>
  );
}

export function TrajectoryView({ entries, live, loading, failed, onRetry }: Props) {
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set());
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<string>>(new Set());
  /** Selection is a record identity, not a position: a merged history page can
   *  shift every ordinal while the row the user picked stays the same. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ index: number; nonce: number } | null>(null);
  const [range, setRange] = useState<TrajTimeRange | null>(null);
  const [mode, setMode] = useState<TrajTimelineMode>("sequence");
  const [query, setQuery] = useState("");
  const [inspectorWidth, setInspectorWidth] = useState<number | null>(null);

  // Committed rows are the expensive part (previews, grouping); the live tail
  // is layered on top so a streamed token does not rebuild the whole ledger.
  const committed = useMemo(() => deriveTrajectory(entries), [entries]);
  const turns = useMemo(() => appendLiveTurns(committed, live), [committed, live]);
  const records = useMemo(() => flatten(turns), [turns]);

  const selected = useMemo<TrajRecord | undefined>(
    () => (selectedId === null ? undefined : records.find((record) => record.id === selectedId)),
    [records, selectedId],
  );
  const selectedIndex = selected?.index ?? null;

  // A selection whose record is gone (session switch, fold of a retracted
  // live row) is cleared instead of silently pointing at a neighbour.
  useEffect(() => {
    if (selectedId !== null && selected === undefined) setSelectedId(null);
  }, [selected, selectedId]);

  const collapsibleTurns = useMemo(
    () => turns.filter((turn) => turn.turn > 0 && turnRecordCount(turn) > 1).map((turn) => turn.turn),
    [turns],
  );
  const allTurnsCollapsed =
    collapsibleTurns.length > 0 && collapsibleTurns.every((turn) => collapsedTurns.has(turn));

  const collapsibleAssistants = useMemo(() => collapsibleAssistantIds(records), [records]);
  const allAssistantsCollapsed =
    collapsibleAssistants.length > 0 &&
    collapsibleAssistants.every((id) => collapsedAssistants.has(id));

  const searchMatchIndexes = useMemo(() => {
    if (query.trim() === "") return null;
    return new Set(records.filter((record) => matchesQuery(record, query)).map((record) => record.index));
  }, [records, query]);

  const focusIndexes = useMemo(
    () => (range === null ? null : timelineFocusIndexes(turns, range, mode)),
    [turns, range, mode],
  );

  const toggleTurn = useCallback((turn: number) => {
    setCollapsedTurns((current) => {
      const next = new Set(current);
      if (next.has(turn)) next.delete(turn);
      else next.add(turn);
      return next;
    });
  }, []);

  const toggleAssistant = useCallback((id: string) => {
    setCollapsedAssistants((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Selecting a row the ledger folded away reopens its turn. */
  const selectRecord = useCallback(
    (record: TrajRecord) => {
      setSelectedId(record.id);
      if (collapsedTurns.has(record.turn)) {
        setCollapsedTurns((current) => {
          const next = new Set(current);
          next.delete(record.turn);
          return next;
        });
      }
    },
    [collapsedTurns],
  );

  const focusRecord = useCallback((index: number) => {
    setFocus((current) => ({ index, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface">
      <div
        role="toolbar"
        aria-label={t("agent.traj.toolbarAria")}
        className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-1.5 py-1"
      >
        <button
          type="button"
          aria-pressed={mode === "duration"}
          aria-label={t("agent.traj.duration")}
          title={mode === "duration" ? t("agent.traj.useSequence") : t("agent.traj.useDuration")}
          onClick={() => {
            setMode((current) => (current === "duration" ? "sequence" : "duration"));
            setRange(null);
          }}
          className={clsx(
            "inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-ui-2xs transition",
            mode === "duration"
              ? "bg-selected text-slate-700"
              : "text-slate-400 hover:bg-overlay hover:text-slate-700",
          )}
        >
          <Clock size={12} className="shrink-0" aria-hidden="true" />
          {t("agent.traj.duration")}
        </button>

        <FoldButton
          label={t("agent.traj.turns")}
          collapsed={allTurnsCollapsed}
          onClick={() =>
            setCollapsedTurns(allTurnsCollapsed ? new Set() : new Set(collapsibleTurns))
          }
        />
        <FoldButton
          label={t("agent.traj.calls")}
          collapsed={allAssistantsCollapsed}
          onClick={() =>
            setCollapsedAssistants(
              allAssistantsCollapsed ? new Set() : new Set(collapsibleAssistants),
            )
          }
        />

        <div className="ml-auto flex h-[22px] min-w-[84px] flex-[0_1_164px] items-center gap-1 rounded-md border border-border bg-canvas px-1.5 text-slate-400 transition">
          <Search size={11} className="shrink-0" aria-hidden="true" />
          <input
            type="search"
            className="min-w-0 flex-1 bg-transparent text-ui-2xs text-slate-700 outline-none placeholder:text-slate-300"
            aria-label={t("agent.traj.search")}
            placeholder={t("agent.traj.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
      </div>

      <TrajectoryTimeline
        turns={turns}
        mode={mode}
        range={range}
        selectedIndex={selectedIndex}
        searchMatchIndexes={searchMatchIndexes}
        onRangeChange={setRange}
        onRecordSelect={(index) => {
          const record = records.find((candidate) => candidate.index === index);
          if (record !== undefined) selectRecord(record);
        }}
        onRecordFocus={focusRecord}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <TrajectoryLedger
          turns={turns}
          loading={loading}
          failed={failed}
          onRetry={onRetry}
          selectedIndex={selectedIndex}
          onSelect={(index) => {
            const record = records.find((candidate) => candidate.index === index);
            if (record !== undefined) selectRecord(record);
          }}
          onClearSelection={() => setSelectedId(null)}
          focusIndex={focus?.index ?? null}
          focusNonce={focus?.nonce ?? 0}
          focusIndexes={focusIndexes}
          searchMatchIndexes={searchMatchIndexes}
          collapsedTurns={collapsedTurns}
          collapsedAssistants={collapsedAssistants}
          onToggleTurn={toggleTurn}
          onToggleAssistant={toggleAssistant}
        />
        {selected !== undefined ? (
          <TrajectoryInspector
            record={selected}
            records={records}
            width={inspectorWidth}
            onWidthChange={setInspectorWidth}
            onSelect={(index) => {
              const record = records.find((candidate) => candidate.index === index);
              if (record !== undefined) selectRecord(record);
            }}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
