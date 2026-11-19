/**
 * The turn list of one session: `groupTurns` on the committed rows, each turn
 * drawn by the shared `TurnBlock` with the turn's sub-agent data injected
 * (assembled by the shared session-level assembler through the companion
 * adapter in `subagents.ts` — calls pair with settle notices across turn
 * blocks, so a background child's fold stops spinning when it settles).
 *
 * Child transcripts arrive through `childEntries` and are rendered with this
 * same component (recursion), so a nested `reviewer/checker` chain renders
 * identically end to end. Child folds are controlled
 * (`openSubagentIds`/`onToggleSubagent` threaded down through every level):
 * the toggle is where the host lazy-loads a child transcript, so no
 * mount/unmount inference is needed.
 */
import { useMemo } from "react";

import { groupTurns } from "../../../../shared/agent/turns";
import { isPendingChild } from "../../../../shared/agent/subagents";
import type { AgentSubagentRow } from "../../../../shared/agent/subagents";
import type { AgentLocale } from "../../../../shared/agent/types";

import type { DshEntry, DshSession } from "../../lib/dsh";
import { assembleSubagentGroups } from "./subagents";
import { TurnBlock } from "./turnBlocks";

/** Hard stop for child-of-child recursion; the runtime nests one level today. */
const MAX_DEPTH = 3;

export type TurnStackProps = {
  /** Full transcript of one session, oldest first. */
  entries: DshEntry[];
  /** True while this session's latest turn is still running. */
  running: boolean;
  locale: AgentLocale;
  /** The session `entries` belongs to; root of the sub-agent lookup. */
  sessionId: string;
  /** Current `dsh_sessions` rows: child running flags, titles, presets. */
  sessions: DshSession[];
  /** Committed rows of one child session; undefined until first fetched. */
  childEntries: (sessionId: string) => DshEntry[] | undefined;
  /** True while a child transcript has never loaded. */
  childLoading: (sessionId: string) => boolean;
  /** The child transcript fetch failed; shown inside the fold. */
  childError: (sessionId: string) => string | null;
  /** Controlled child folds across every level (ids are session ids). */
  openSubagentIds: ReadonlySet<string>;
  /** A child fold toggled; the host lazy-loads on open and stops polling on close. */
  onToggleSubagent: (sessionId: string) => void;
  depth?: number;
};

export function TurnStack({
  entries,
  running,
  locale,
  sessionId,
  sessions,
  childEntries,
  childLoading,
  childError,
  openSubagentIds,
  onToggleSubagent,
  depth = 0,
}: TurnStackProps) {
  // Grouping is pure, but the poll re-renders the stack every few seconds:
  // both projections memo on the inputs so folded state survives cheap renders.
  const blocks = useMemo(() => groupTurns(entries), [entries]);
  const groups = useMemo(
    () =>
      assembleSubagentGroups({
        blocks,
        sessions,
        sessionId,
        childEntries,
        childLoading,
        childError,
      }),
    [blocks, sessions, sessionId, childEntries, childLoading, childError],
  );

  // The live tail belongs to the turn whose `turn/end` has not landed yet;
  // the companion has no token stream, so "running" only widens the last
  // open block into the working state.
  let activeKey: string | null = null;
  if (running) {
    const last = blocks[blocks.length - 1];
    if (last && last.start && !last.end) activeKey = last.key;
  }
  const shown = blocks.filter(
    (block) =>
      block.entries.length > 0 ||
      block.key === activeKey ||
      // A failed turn keeps its block so the error line stays visible.
      block.end?.reason === "error" ||
      block.end?.reason === "blocked",
  );

  const renderChildTurns = (child: AgentSubagentRow) => {
    if (depth >= MAX_DEPTH || isPendingChild(child.sessionId)) return null;
    // The root sub-agent row owns the height cap and its own scroll; nesting
    // another scroller here would trap the touch scroll twice.
    return (
      <TurnStack
        entries={childEntries(child.sessionId) ?? []}
        running={child.running}
        locale={locale}
        sessionId={child.sessionId}
        sessions={sessions}
        childEntries={childEntries}
        childLoading={childLoading}
        childError={childError}
        openSubagentIds={openSubagentIds}
        onToggleSubagent={onToggleSubagent}
        depth={depth + 1}
      />
    );
  };

  return (
    <div data-component="TurnStack" className="flex min-w-0 flex-col gap-4">
      {shown.map((block) => {
        const active = block.key === activeKey;
        const subagents = groups.get(block.key);
        return (
          <TurnBlock
            key={block.key}
            block={block}
            running={active}
            locale={locale}
            subagents={subagents?.children}
            orphanNotices={subagents?.orphans}
            renderTurns={renderChildTurns}
            openSubagentIds={openSubagentIds}
            onToggleSubagent={onToggleSubagent}
          />
        );
      })}
    </div>
  );
}
