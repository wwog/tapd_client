/**
 * Desktop adapter for the shared pure assembler
 * (`apps/shared/agent/subagents.ts`): resolves each child's facts from the
 * agent store (session rows, entry buckets) and exposes the session-level
 * `assembleSessionSubagents(state, blocks, liveTools, liveBlockKey)` used by
 * `MessageStream` (top-level turns and nested child transcripts). The pairing
 * rules, name extraction and pending placeholders live in shared — desktop and
 * companion assemble identically.
 */
import {
  assembleSessionSubagents as assembleSession,
  isPendingChild,
  type SubagentBlock,
  type TurnSubagents,
} from "../../../shared/agent/subagents";
import type { AgentState } from "./store";

export type { TurnSubagents, SubagentBlock };
export { isPendingChild };

function childInfoOf(state: AgentState) {
  return (sessionId: string) => {
    const row = state.sessions[sessionId];
    const bucket = state.entries[sessionId];
    return {
      running: row?.status === "running",
      title: row?.title,
      preset: row?.agentPreset,
      entries: bucket?.items,
      loading: bucket ? !bucket.loaded : false,
    };
  };
}

/**
 * Sub-agent data per turn block of one transcript. Pairing runs across the
 * whole transcript (a background child settles in a later turn than its call),
 * and live placeholders land in `liveBlockKey` only.
 */
export function assembleSessionSubagents(
  state: AgentState,
  blocks: readonly SubagentBlock[],
  liveTools: ReadonlyArray<{ callId?: string; name: string; args: string }>,
  liveBlockKey: string | null,
): Map<string, TurnSubagents> {
  return assembleSession(blocks, liveTools, liveBlockKey, childInfoOf(state));
}
