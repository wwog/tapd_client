import { describeTool } from "../../../shared/agent/actions";
import type { AgentLocale, AgentTurnBlock } from "../../../shared/agent/types";

export type PromptNavItem = {
  /** Turn key; the fallback scroll target when the user row is not found. */
  key: string;
  /** Stable user-row seq used as the exact scroll anchor. */
  seq: number;
  text: string;
  added: number;
  removed: number;
};

const statsCache = new WeakMap<AgentTurnBlock, { added: number; removed: number }>();

/** Line stats for a turn, computed once per committed block. */
function turnStats(block: AgentTurnBlock, locale: AgentLocale): {
  added: number;
  removed: number;
} {
  const cached = statsCache.get(block);
  if (cached) return cached;
  let added = 0;
  let removed = 0;
  for (const entry of block.entries) {
    if (entry.kind !== "tool") continue;
    const action = describeTool(entry.name, entry.args, locale);
    added += action.added ?? 0;
    removed += action.removed ?? 0;
  }
  const stats = { added, removed };
  statsCache.set(block, stats);
  return stats;
}

/**
 * One navigator row per turn, newest first. The row uses the turn's first
 * visible prompt (the task hand-off) and the line stats of its file tools;
 * retry-only blocks without a prompt are skipped.
 */
export function buildPromptItems(
  blocks: readonly AgentTurnBlock[],
  locale: AgentLocale,
): PromptNavItem[] {
  const items: PromptNavItem[] = [];
  for (const block of blocks) {
    const prompt = block.entries.find(
      (entry) => entry.kind === "user" && entry.text.trim() !== "",
    );
    if (!prompt || prompt.kind !== "user") continue;
    items.push({
      key: block.key,
      seq: prompt.seq,
      text: prompt.text,
      ...turnStats(block, locale),
    });
  }
  return items.reverse();
}
