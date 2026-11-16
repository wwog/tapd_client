export { formatBytes } from "./api";

import { localeTag } from "./i18n";

/** Accepts RFC3339 and TAPD's "YYYY-MM-DD HH:MM:SS"; null when unparseable. */
const parseTimestamp = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Safari/WebKit is not required to parse the space-separated TAPD form.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)
    ? trimmed.replace(" ", "T")
    : trimmed;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
};

const DEFAULT_DATE_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

/**
 * Formats RFC3339 or TAPD timestamps for display. Missing values render as
 * "—"; strings that cannot be parsed are returned unchanged so the raw value
 * is never lost.
 */
export const formatDateTime = (
  isoOrTapd: string | null,
  options: Intl.DateTimeFormatOptions = DEFAULT_DATE_TIME,
): string => {
  if (!isoOrTapd) return "—";
  const timestamp = parseTimestamp(isoOrTapd);
  if (timestamp === null) return isoOrTapd;
  return new Date(timestamp).toLocaleString(localeTag(), options);
};

/** "2026-11-10T16:00:00+08:00" -> "2026/11/10 16:00:00". */
export const formatTimestamp = (value: string | number | Date | null): string => {
  if (value == null) return "—";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? "—"
      : value.toLocaleString(localeTag(), { hour12: false });
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? new Date(value).toLocaleString(localeTag(), { hour12: false })
      : "—";
  }
  const timestamp = parseTimestamp(value);
  if (timestamp === null) return value;
  return new Date(timestamp).toLocaleString(localeTag(), { hour12: false });
};

const AUDIT_DATE_TIME: Intl.DateTimeFormatOptions = {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

/** Compact timestamp for audit/log rows: "11-10 16:00:00". */
export const formatAuditTime = (value: string): string =>
  formatDateTime(value, AUDIT_DATE_TIME);
