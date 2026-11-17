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
  deriveTrajectory,
  flatten,
  matchesQuery,
  toolCallsAfter,
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
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [range, setRange] = useState<TrajTimeRange | null>(null);
  const [mode, setMode] = useState<TrajTimelineMode>("sequence");
  const [query, setQuery] = useState("");

  const turns = useMemo(() => deriveTrajectory(entries, live), [entries, live]);
  const records = useMemo(() => flatten(turns), [turns]);

  // A selection that no longer exists (session switch) is cleared.
  useEffect(() => {
    if (selectedIndex === null) return;
    if (!records.some((record) => record.index === selectedIndex)) setSelectedIndex(null);
  }, [records, selectedIndex]);

  const collapsibleTurns = useMemo(
    () => turns.filter((turn) => turn.turn > 0 && turnRecordCount(turn) > 1).map((turn) => turn.turn),
    [turns],
  );
  const allTurnsCollapsed =
    collapsibleTurns.length > 0 && collapsibleTurns.every((turn) => collapsedTurns.has(turn));

  const collapsibleAssistants = useMemo(
    () =>
      records
        .filter(
          (record) => record.kind === "assistant" && toolCallsAfter(records, record.index).length > 0,
        )
        .map((record) => record.id),
    [records],
  );
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

  const selected = useMemo<TrajRecord | undefined>(
    () => (selectedIndex === null ? undefined : records.find((record) => record.index === selectedIndex)),
    [records, selectedIndex],
  );

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

        <div className="ml-auto flex h-[22px] min-w-[84px] flex-[0_1_164px] items-center gap-1 rounded-md border border-border bg-canvas px-1.5 text-slate-400 transition focus-within:border-sky-400">
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
        onRecordSelect={setSelectedIndex}
        onRecordFocus={setFocusIndex}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <TrajectoryLedger
          turns={turns}
          loading={loading}
          failed={failed}
          onRetry={onRetry}
          selectedIndex={selectedIndex}
          onSelect={setSelectedIndex}
          onClearSelection={() => setSelectedIndex(null)}
          focusIndexes={focusIndexes}
          searchMatchIndexes={searchMatchIndexes}
          collapsedTurns={collapsedTurns}
          collapsedAssistants={collapsedAssistants}
          onToggleTurn={toggleTurn}
          onToggleAssistant={toggleAssistant}
          focusIndex={focusIndex}
        />
        {selected !== undefined ? (
          <TrajectoryInspector
            key={selected.id}
            record={selected}
            records={records}
            onSelect={setSelectedIndex}
            onClose={() => setSelectedIndex(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
