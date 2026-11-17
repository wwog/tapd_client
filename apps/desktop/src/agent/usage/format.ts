/**
 * Formatting shared by the usage popovers and the session dock. The host sends
 * raw counts only; percentages and units are display decisions and live here.
 */
import { t } from "../../lib/i18n";

/** `8306` → `8.3K`, `1_000_000` → `1.0M`. */
export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** Exact counts in the popovers: `12,060`. */
export function exactCount(value: number): string {
  return value.toLocaleString();
}

/** Share of input tokens served from the provider cache, rounded to a percent. */
export function cacheHitPercent(input: number, cacheRead: number): number {
  const total = input + cacheRead;
  if (total === 0) return 0;
  return Math.round((cacheRead * 100) / total);
}

/** How much of the context window the latest request used. */
export function contextPercent(used: number, contextWindow: number): number {
  if (contextWindow === 0) return 0;
  return Math.min(100, Math.round((used * 100) / contextWindow));
}

/** `5500` → `5.5 秒`; a minute and up reads as `1 分 12 秒`. */
export function duration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return t("agent.stats.seconds", { seconds: seconds.toFixed(1) });
  const whole = Math.round(seconds);
  return t("agent.stats.minutes", {
    minutes: Math.floor(whole / 60),
    seconds: whole % 60,
  });
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
