import type { AgentEntry, AgentTurnBlock } from "./types";

/**
 * Splits a transcript into turns.
 *
 * A prompt commits *inside* its turn (`turn/start` is written before
 * `user/message`), so grouping by the markers is exact. Older logs may have no
 * markers at all, and a runtime crash can leave a turn without its `end`; both
 * cases still produce one block instead of dropping rows.
 */
export function groupTurns(items: AgentEntry[]): AgentTurnBlock[] {
  const blocks: AgentTurnBlock[] = [];
  let open: AgentTurnBlock | null = null;

  const loose = (entry: AgentEntry): AgentTurnBlock => {
    const block: AgentTurnBlock = { key: `loose:${entry.seq}`, entries: [] };
    blocks.push(block);
    return block;
  };

  for (const item of items) {
    // The conversation shows bubbles and tool work only: system prompts,
    // injected context, request headers, retries, compaction and the rest are
    // trajectory rows (they would render as empty blocks here at best).
    if (
      item.kind !== "user" &&
      item.kind !== "assistant" &&
      item.kind !== "tool" &&
      item.kind !== "turn" &&
      item.kind !== "notice"
    ) {
      continue;
    }
    if (item.kind === "turn") {
      if (item.state === "start") {
        // A prompt that committed just before the marker belongs to this turn.
        const last = blocks[blocks.length - 1];
        if (
          last &&
          !last.start &&
          !last.end &&
          last.entries.every((entry) => entry.kind === "user")
        ) {
          last.start = { seq: item.seq, at: item.at, turn: item.turn };
          last.key = `turn:${item.seq}`;
          open = last;
          continue;
        }
        const block: AgentTurnBlock = {
          key: `turn:${item.seq}`,
          start: { seq: item.seq, at: item.at, turn: item.turn },
          entries: [],
        };
        blocks.push(block);
        open = block;
      } else if (open && open.start && !open.end) {
        open.end = {
          seq: item.seq,
          at: item.at,
          turn: item.turn,
          reason: item.reason,
          error: item.error,
        };
        open = null;
      }
      continue;
    }

    if (!open) open = loose(item);
    open.entries.push(item);
  }

  return blocks;
}
