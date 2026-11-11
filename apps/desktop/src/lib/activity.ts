/** Elapsed label with at most two units: `1小时 5分钟`, `10分钟 20秒`, `45秒`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;

  if (days > 0) return hours > 0 ? `${days}天 ${hours}小时` : `${days}天`;
  if (hours > 0) return minutes > 0 ? `${hours}小时 ${minutes}分钟` : `${hours}小时`;
  if (minutes > 0) return `${minutes}分钟 ${seconds}秒`;
  return seconds < 5 ? "刚刚" : `${seconds}秒`;
}

/** Milliseconds since an RFC 3339 timestamp; 0 when it cannot be parsed. */
export function elapsedSince(iso: string | undefined, now: number): number {
  if (!iso) return 0;
  const started = Date.parse(iso);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

/** `16:39` for today, `11-10 16:39` for older timestamps. */
export function formatStartedAt(iso: string | undefined): string {
  if (!iso) return "未知";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未知";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return date.toLocaleString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(sameDay ? {} : { month: "2-digit", day: "2-digit" }),
  });
}
