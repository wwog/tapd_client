import type { DshEntry } from "../lib/dsh";

type TurnMarker = Extract<DshEntry, { kind: "turn" }>;

/**
 * One user-visible turn: everything committed between `turn/start` and
 * `turn/end`, with the markers kept for their timestamps.
 */
export type TurnBlock = {
  /** Stable React key: the start seq when known, else the first entry's. */
  key: string;
  start?: TurnMarker;
  end?: TurnMarker;
  /** User / assistant / tool rows in commit order; markers excluded. */
  entries: DshEntry[];
};

/**
 * Splits a transcript into turns.
 *
 * A prompt commits *inside* its turn (`turn/start` is written before
 * `user/message`), so grouping by the markers is exact. Older logs may have no
 * markers at all, and a runtime crash can leave a turn without its `end`; both
 * cases still produce one block instead of dropping rows.
 */
export function groupTurns(items: DshEntry[]): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  let open: TurnBlock | null = null;

  const loose = (entry: DshEntry): TurnBlock => {
    const block: TurnBlock = { key: `loose:${entry.seq}`, entries: [] };
    blocks.push(block);
    return block;
  };

  for (const item of items) {
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
          last.start = item;
          last.key = `turn:${item.seq}`;
          open = last;
          continue;
        }
        const block: TurnBlock = { key: `turn:${item.seq}`, start: item, entries: [] };
        blocks.push(block);
        open = block;
      } else if (open && open.start && !open.end) {
        open.end = item;
        open = null;
      }
      continue;
    }

    if (!open) open = loose(item);
    open.entries.push(item);
  }

  return blocks;
}
