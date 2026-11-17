import type { AgentLocale } from "./types";
import { agentLabel } from "./labels";

/**
 * Time formatting for the shared chat view: the turn's elapsed clock and the
 * per-message clock. Both ends render the same strings, so the copy lives in
 * the shared label catalogue.
 */

/** `5500` → `5.5 秒` (or `6 秒` when rounded); a minute and up reads `1 分 12 秒`. */
export function duration(ms: number, locale: AgentLocale, precise = false): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return agentLabel("stats.seconds", locale, {
      seconds: precise ? seconds.toFixed(1) : String(Math.round(seconds)),
    });
  }
  const whole = Math.round(seconds);
  return agentLabel("stats.minutes", locale, {
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
