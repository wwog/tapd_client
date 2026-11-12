/**
 * Persisted presentation preferences for the bug list: visible/reorderable
 * columns, filters and server-side sort. Pure data + readers for the
 * `config.json` preference blob so the component keeps only the state and the
 * effects that write them back.
 */

import { readPref, writePref } from "../lib/uiPrefs";

export const PRIORITIES = [
  ["urgent", "紧急"],
  ["high", "高"],
  ["medium", "中"],
  ["low", "低"],
  ["insignificant", "无关紧要"],
];

export const SEVERITIES = [
  ["fatal", "致命"],
  ["serious", "严重"],
  ["normal", "一般"],
  ["prompt", "提示"],
  ["advice", "建议"],
];

/**
 * Bug list scope switch: my bugs, the whole project, or the bug set the local
 * agent queue is working on. 处理中 only appears while that set is non-empty.
 */
export type BugScope = "mine" | "all" | "processing";

export type ColumnKey =
  | "status"
  | "priority"
  | "severity"
  | "owner"
  | "creator"
  | "created";

export type ColumnPref = { key: ColumnKey; visible: boolean };

export const COLUMN_KEY = "tapd.bug-columns.v1";

export const COLUMN_LABELS: Record<ColumnKey, string> = {
  status: "状态",
  priority: "优先级",
  severity: "严重程度",
  owner: "处理人",
  creator: "创建人",
  created: "创建时间",
};

export const COLUMN_WIDTHS: Record<ColumnKey, number> = {
  status: 92,
  priority: 76,
  severity: 100,
  owner: 104,
  creator: 88,
  created: 136,
};

export const DEFAULT_COLUMNS: ColumnPref[] = [
  { key: "status", visible: true },
  { key: "priority", visible: true },
  { key: "severity", visible: false },
  { key: "owner", visible: true },
  { key: "creator", visible: false },
  { key: "created", visible: true },
];

export const TITLE_MIN_WIDTH = 370;
export const ACTION_WIDTH = 104;

export type BugFilters = {
  statuses: string[];
  priority: string;
  severity: string;
  /** 处理人 nicknames; several match with OR. Only used in the 全部 scope. */
  owners: string[];
  /** 创建人 (TAPD `reporter`) nickname. */
  creator: string;
  /** Title keyword; digits-only values match a bug id (full or short). */
  keyword: string;
};

export const FILTER_KEY = "tapd.bug-filters.v1";

/**
 * Sortable columns. TAPD sorts server-side (so the order holds across pages):
 * `created` by time and `status` by the workspace's configured workflow order.
 *
 * A column click cycles 升序 → 降序 → 取消; `null` means no explicit sort and
 * the query falls back to TAPD's default (newest created first).
 */
export type SortKey = "created" | "status";
export type BugSort = { name: SortKey; order: "asc" | "desc" };

export const SORT_KEY = "tapd.bug-sort.v1";
export const DEFAULT_SORT: BugSort = { name: "created", order: "desc" };

export function loadSort(): BugSort | null {
  if (typeof window === "undefined") return null;
  const parsed = readPref<Partial<BugSort> | null>(SORT_KEY);
  if (!parsed) return null;
  if (parsed.name !== "status" && parsed.name !== "created") return null;
  const order = parsed.order === "asc" ? "asc" : "desc";
  // 取消排序 == TAPD 默认（创建时间倒序），不必把默认态画成用户排序。
  if (parsed.name === "created" && order === "desc") return null;
  return { name: parsed.name, order };
}

export function saveSort(sort: BugSort | null) {
  writePref(SORT_KEY, sort);
}

export function loadFilters(): BugFilters {
  const fallback: BugFilters = {
    statuses: [],
    priority: "",
    severity: "",
    owners: [],
    creator: "",
    keyword: "",
  };
  if (typeof window === "undefined") return fallback;
  const parsed = readPref<Partial<BugFilters>>(FILTER_KEY);
  if (!parsed) return fallback;
  return {
    statuses: Array.isArray(parsed.statuses)
      ? parsed.statuses.filter((value): value is string => typeof value === "string")
      : [],
    priority:
      typeof parsed.priority === "string" &&
      PRIORITIES.some(([value]) => value === parsed.priority)
        ? parsed.priority
        : "",
    severity:
      typeof parsed.severity === "string" &&
      SEVERITIES.some(([value]) => value === parsed.severity)
        ? parsed.severity
        : "",
    owners: Array.isArray(parsed.owners)
      ? parsed.owners.filter((value): value is string => typeof value === "string")
      : [],
    creator: typeof parsed.creator === "string" ? parsed.creator : "",
    keyword: typeof parsed.keyword === "string" ? parsed.keyword : "",
  };
}

export function saveFilters(filters: BugFilters) {
  writePref(FILTER_KEY, filters);
}

export function loadColumns(): ColumnPref[] {
  const fallback = DEFAULT_COLUMNS.map((column) => ({ ...column }));
  if (typeof window === "undefined") return fallback;
  const parsed = readPref<Array<{ key?: unknown; visible?: unknown }>>(COLUMN_KEY);
  if (!Array.isArray(parsed)) return fallback;

  const known = new Set<ColumnKey>(DEFAULT_COLUMNS.map((column) => column.key));
  const seen = new Set<ColumnKey>();
  const result: ColumnPref[] = [];
  for (const item of parsed) {
    if (typeof item?.key !== "string") continue;
    const key = item.key as ColumnKey;
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push({ key, visible: Boolean(item.visible) });
  }
  for (const column of DEFAULT_COLUMNS) {
    if (!seen.has(column.key)) result.push({ ...column });
  }
  return result;
}

export function saveColumns(columns: ColumnPref[]) {
  writePref(COLUMN_KEY, columns);
}
