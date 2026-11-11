/**
 * Persisted presentation preferences for the bug list: visible/reorderable
 * columns, filters and server-side sort. Pure data + localStorage readers so
 * the component keeps only the state and the effects that write them back.
 */

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
  /** 处理人 nickname; only used in the 全部 scope. */
  owner: string;
  /** 创建人 (TAPD `reporter`) nickname. */
  creator: string;
  /** Title keyword, matched with TAPD's `like` filter. */
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
  try {
    const raw = window.localStorage.getItem(SORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BugSort> | null;
    if (parsed?.name !== "status" && parsed?.name !== "created") return null;
    const order = parsed.order === "asc" ? "asc" : "desc";
    // 取消排序 == TAPD 默认（创建时间倒序），不必把默认态画成用户排序。
    if (parsed.name === "created" && order === "desc") return null;
    return { name: parsed.name, order };
  } catch {
    return null;
  }
}

export function loadFilters(): BugFilters {
  const fallback: BugFilters = {
    statuses: [],
    priority: "",
    severity: "",
    owner: "",
    creator: "",
    keyword: "",
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(FILTER_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<BugFilters>;
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
      owner: typeof parsed.owner === "string" ? parsed.owner : "",
      creator: typeof parsed.creator === "string" ? parsed.creator : "",
      keyword: typeof parsed.keyword === "string" ? parsed.keyword : "",
    };
  } catch {
    return fallback;
  }
}

export function loadColumns(): ColumnPref[] {
  const fallback = DEFAULT_COLUMNS.map((column) => ({ ...column }));
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(COLUMN_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Array<{ key?: unknown; visible?: unknown }>;
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
  } catch {
    return fallback;
  }
}
