/**
 * The ↑ history: what the user already sent, newest first.
 *
 * Three sources, merged and deduplicated by text:
 * - the selected session's committed user rows (persisted by dsh itself),
 * - prompts accepted but not yet echoed back (`pendingPrompts`),
 * - the local recent list (`dsh_prompt_history`), which is what a brand-new
 *   chat has to offer.
 *
 * Pure so the panel order is testable and the composer only renders it.
 */
const MAX_ITEMS = 50;
const MAX_LENGTH = 2000;

function normalize(text: string): string {
  return text.trim();
}

export function collectPromptHistory(
  sources: ReadonlyArray<readonly string[] | undefined>,
): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const raw of source) {
      const text = normalize(raw);
      if (!text || text.length > MAX_LENGTH) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      items.push(text);
      if (items.length >= MAX_ITEMS) return items;
    }
  }
  return items;
}

/** History rows matching what the user has typed so far (`""` matches all). */
export function filterHistory(items: readonly string[], query: string): string[] {
  const needle = normalize(query).toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => item.toLowerCase().includes(needle));
}
