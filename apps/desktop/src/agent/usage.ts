/**
 * Formatting shared by the usage popover and the session status line. The host
 * sends raw counts only; percentages are a display decision and live here.
 */

/** `8306` → `8.3K`, `1_000_000` → `1.0M`. */
export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** Exact counts in the popover: `12,060`. */
export function exactCount(value: number): string {
  return value.toLocaleString();
}

/** Share of input tokens served from the provider cache, rounded to a percent. */
export function cacheHitPercent(input: number, cacheRead: number): number {
  const total = input + cacheRead;
  if (total === 0) return 0;
  return Math.round((cacheRead * 100) / total);
}

/** How much of the context window the last request used. */
export function contextPercent(total: number, contextWindow: number): number {
  if (contextWindow === 0) return 0;
  return Math.min(100, Math.round((total * 100) / contextWindow));
}

/** `HH:mm` in local time from the entry's RFC3339 stamp. */
export function clock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
