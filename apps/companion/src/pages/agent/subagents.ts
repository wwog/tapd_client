/**
 * Companion host adapter over the shared sub-agent assembly
 * (`apps/shared/agent/subagents.ts`): the pairing logic (k-th `subagent` call
 * ↔ k-th settle notice ACROSS turn blocks, pending placeholders) lives in
 * shared; this file only resolves per-child facts from the companion's own
 * stores — the polled `dsh_sessions` rows and the lazily fetched child
 * transcripts.
 */
import {
  assembleSessionSubagents,
  isPendingChild,
  type ChildSessionInfo,
  type SubagentBlock,
  type TurnSubagents,
} from "../../../../shared/agent/subagents";
import type { AgentSubagentChild } from "../../../../shared/agent/SubagentGroup";
import type { DshEntry, DshSession } from "../../lib/dsh";

export { isPendingChild };
export type { SubagentBlock, TurnSubagents };

export type ChildTranscriptAccessors = {
  /** Committed rows of one child session, oldest first; undefined until loaded. */
  childEntries: (sessionId: string) => DshEntry[] | undefined;
  /** True while the host is fetching this child's transcript for the first time. */
  childLoading: (sessionId: string) => boolean;
  /** The last fetch failed; the fold shows it instead of retrying silently. */
  childError: (sessionId: string) => string | null;
};

/**
 * Sub-agent data per `groupTurns` block, keyed by block key: `{ children,
 * orphans }` for `TurnBlock`'s `subagents` / `orphanNotices` props. `blocks`
 * come from the host's own memoized `groupTurns` so both projections share one
 * grouping. The companion has no token stream, so there are no live
 * placeholders.
 */
export function assembleSubagentGroups(args: {
  /** The `groupTurns` blocks of ONE session, oldest first. */
  blocks: readonly SubagentBlock[];
  /** Current `dsh_sessions` rows; supplies running flags, titles, presets. */
  sessions: DshSession[];
  /** The session whose transcript the blocks belong to (lookup root). */
  sessionId: string;
} & ChildTranscriptAccessors): Map<string, TurnSubagents> {
  const { blocks, sessions, sessionId, childEntries, childLoading, childError } = args;
  const childRows = sessions.filter((row) => row.parentSession === sessionId);

  const childInfo = (childId: string): ChildSessionInfo | undefined => {
    const row = childRows.find((candidate) => candidate.id === childId);
    if (!row) return undefined;
    return {
      running: row.status === "running",
      title: row.title,
      preset: row.agentPreset,
      entries: childEntries(childId),
      loading: childLoading(childId),
    };
  };

  const groups = assembleSessionSubagents(blocks, [], null, childInfo);
  // The shared assembler has no error channel; enrich here so a failed
  // fetch renders inside the fold instead of retrying invisibly.
  const enriched = new Map<string, TurnSubagents>();
  for (const [key, group] of groups) {
    const children = group.children.map(
      (child): AgentSubagentChild =>
        isPendingChild(child.sessionId)
          ? child
          : { ...child, error: childError(child.sessionId) ?? undefined },
    );
    enriched.set(key, { children, orphans: group.orphans });
  }
  return enriched;
}
