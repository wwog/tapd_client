import { localeTag, t } from "./i18n";

/** Elapsed label with at most two units: `1小时 5分钟`, `10分钟 20秒`, `45秒`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;

  if (days > 0)
    return hours > 0
      ? t("agent.elapsed.daysHours", { days, hours })
      : t("agent.elapsed.days", { days });
  if (hours > 0)
    return minutes > 0
      ? t("agent.elapsed.hoursMinutes", { hours, minutes })
      : t("agent.elapsed.hours", { hours });
  if (minutes > 0)
    return t("agent.elapsed.minutesSeconds", { minutes, seconds });
  return seconds < 5 ? t("common.justNow") : t("agent.elapsed.seconds", { seconds });
}

/** Milliseconds since an RFC 3339 timestamp; 0 when it cannot be parsed. */
export function elapsedSince(iso: string | undefined, now: number): number {
  if (!iso) return 0;
  const started = Date.parse(iso);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

/** `16:39` for today, `11-10 16:39` for older timestamps. */
export function formatStartedAt(iso: string | undefined): string {
  if (!iso) return t("common.unknown");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return t("common.unknown");

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return date.toLocaleString(localeTag(), {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(sameDay ? {} : { month: "2-digit", day: "2-digit" }),
  });
}
