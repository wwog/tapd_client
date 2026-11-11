import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Bug, RefreshCw, WifiOff } from "lucide-react";

import {
  api,
  type BugListPage,
  type BugQuery,
  type BugSummary,
  type Workspace,
} from "../lib/api";
import type { AgentInFlight, ExternalClaim } from "../lib/agent";
import { cacheApi, type Cached } from "../lib/cache";
import { SkeletonRows } from "./Skeleton";
import { Button, EmptyState } from "./ui";
import { BugListPager } from "./BugListPager";
import { BugRowContextMenu, type BugRowMenu } from "./BugRowContextMenu";
import { BugTable } from "./BugTable";
import { BugTableToolbar } from "./BugTableToolbar";
import {
  COLUMN_KEY,
  DEFAULT_SORT,
  FILTER_KEY,
  SORT_KEY,
  loadColumns,
  loadFilters,
  loadSort,
  type BugSort,
} from "./bugListPrefs";

/**
 * Bug list auto-refresh cadence.
 *
 * Deliberately independent of the notification poll: that loop only emits
 * `data://refresh` when it produces a notification item, so edits, comments and
 * status changes (or a disabled notification toggle) left the table stale until
 * the user pressed 刷新.
 */
const AUTO_REFRESH_MS = 30_000;

type Scope = "mine" | "all";

type Props = {
  workspace: Workspace | null;
  me: string | null;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  onOpenBug: (bug: BugSummary) => void;
  /** Row actions (action column). */
  onOpenWeb?: (url: string) => void;
  /** Copy arbitrary text from the row context menu. */
  onCopy?: (text: string) => void;
  onAgentFix?: (bug: BugSummary) => void;
  /** Launch with a prompt/resources from the compose sheet. */
  onAgentCompose?: (bug: BugSummary) => void;
  /** In-flight agent tasks keyed by workspace + bug. */
  agentInFlight?: Map<string, AgentInFlight>;
  /** Fresh external AI claims keyed by workspace + bug. */
  externalClaims?: Map<string, ExternalClaim>;
  /** Jump to an already queued/running task instead of enqueuing again. */
  onOpenAgentTask?: (taskId: string) => void;
  onCancelTask?: (taskId: string) => Promise<void> | void;
  onReleaseExternal?: (claim: ExternalClaim) => Promise<void> | void;
  /** Claim a bug owned by someone else, which unlocks its actions. */
  onClaim?: (bug: BugSummary) => Promise<void>;
  refreshToken: number;
};

function BugListViewImpl(props: Props) {
  const {
    workspace,
    me,
    scope,
    onScopeChange,
    onOpenBug,
    onOpenWeb,
    onCopy,
    onAgentFix,
    onAgentCompose,
    agentInFlight,
    externalClaims,
    onOpenAgentTask,
    onCancelTask,
    onReleaseExternal,
    onClaim,
    refreshToken,
  } = props;

  const [initialFilters] = useState(loadFilters);
  const [statusFilter, setStatusFilter] = useState<string[]>(
    initialFilters.statuses,
  );
  const [priority, setPriority] = useState(initialFilters.priority);
  const [severity, setSeverity] = useState(initialFilters.severity);
  const [ownerFilter, setOwnerFilter] = useState(initialFilters.owner);
  const [creatorFilter, setCreatorFilter] = useState(initialFilters.creator);
  const [keyword, setKeyword] = useState(initialFilters.keyword);
  const [sort, setSort] = useState<BugSort | null>(loadSort);
  /** 处理人 / 创建人 filter options: workspace directory + people on this page. */
  const [memberNicks, setMemberNicks] = useState<string[]>([]);
  const [debouncedKeyword, setDebouncedKeyword] = useState(
    initialFilters.keyword.trim(),
  );
  const [pageNo, setPageNo] = useState(1);
  const [page, setPage] = useState<BugListPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  /** Sync time (Unix seconds) of the cached snapshot currently on screen. */
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  /** Newest request wins; older responses (filters/page changed) are dropped. */
  const requestIdRef = useRef(0);
  /** Skips an auto-refresh tick while a request is already in flight. */
  const loadingRef = useRef(false);
  /** When the last request for the current query finished. */
  const lastLoadedAtRef = useRef(0);
  /** Bug id whose claim request is in flight. */
  const [claimingId, setClaimingId] = useState<string | null>(null);
  /** User-configurable middle columns (title/action are fixed). */
  const [columns, setColumns] = useState(loadColumns);
  /** Right-click menu anchored at the pointer, on the row's bug. */
  const [rowMenu, setRowMenu] = useState<(BugRowMenu & { seq: number }) | null>(null);
  const menuSeqRef = useRef(0);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLUMN_KEY, JSON.stringify(columns));
    } catch {
      // Storage disabled: the layout still applies for this run.
    }
  }, [columns]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FILTER_KEY,
        JSON.stringify({
          statuses: statusFilter,
          priority,
          severity,
          owner: ownerFilter,
          creator: creatorFilter,
          keyword,
        }),
      );
    } catch {
      // Storage disabled: filters still apply for this run.
    }
  }, [statusFilter, priority, severity, ownerFilter, creatorFilter, keyword]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SORT_KEY, JSON.stringify(sort));
    } catch {
      // Storage disabled: the sort still applies for this run.
    }
  }, [sort]);

  // Owner / creator filter options. The list response only covers one page, so
  // the workspace directory fills in everyone else; a failure just leaves the
  // people already visible on this page selectable.
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    setMemberNicks([]);
    api
      .workspaceMembers(workspace.id)
      .then((members) => {
        if (cancelled) return;
        setMemberNicks(members.map((member) => member.nick).filter(Boolean));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    setPageNo(1);
  }, [scope]);

  const load = useCallback(async (silent = false) => {
    if (!workspace) return;

    const query: BugQuery = {
      workspaceId: workspace.id,
      // "我负责的" always wins; the 处理人 filter only applies in 全部.
      owner: scope === "mine" ? me : ownerFilter || null,
      creator: creatorFilter || null,
      statuses: statusFilter,
      priorities: priority ? [priority] : [],
      severities: severity ? [severity] : [],
      keyword: debouncedKeyword || null,
      modifiedAfter: null,
      createdAfter: null,
      sortName: sort?.name ?? DEFAULT_SORT.name,
      order: sort?.order ?? DEFAULT_SORT.order,
      page: pageNo,
      perpage: 50,
      confId: null,
    };

    const requestId = ++requestIdRef.current;
    loadingRef.current = true;

    // Cache-first: paint the last snapshot for exactly this query before the
    // network round-trip, so a slow/offline TAPD never shows an empty table.
    // A background refresh already has a table on screen, so it skips this and
    // cannot flash an older snapshot over the current rows.
    let cached: Cached<BugListPage> | null = null;
    if (!silent) {
      try {
        cached = await cacheApi.bugList(query);
      } catch {
        // A cache read failure is not a page failure; the live request decides.
      }
      if (requestId !== requestIdRef.current) return;

      const snapshot = cached?.data ?? null;
      if (snapshot) {
        setPage(snapshot);
        setSnapshotAt(cached?.fetchedAt ?? null);
      }
    }

    if (!silent) {
      setError(null);
      setLoading(true);
    }
    // Background refreshes stay invisible: no table dimming and no spinner
    // outside the table footer.
    try {
      const result = await api.bugList(query);
      if (requestId !== requestIdRef.current) return;
      const lastPageNo = Math.max(
        1,
        Math.ceil(result.total / Math.max(1, result.perpage)),
      );
      if (pageNo > lastPageNo) {
        // The result set shrank while this tab was on a trailing page. Jump to
        // the new last page instead of rendering an empty table.
        setPageNo(lastPageNo);
        return;
      }
      setPage(result);
      setSnapshotAt(null);
      setError(null);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      if (silent) {
        // Keep the last good table; the next visible refresh surfaces failures.
      } else if (cached?.data) {
        // Offline: keep the cached table and let the inline notice explain it.
        setSnapshotAt(cached.fetchedAt ?? null);
      } else {
        setError(String(cause));
        setPage(null);
        setSnapshotAt(null);
      }
    } finally {
      if (requestId === requestIdRef.current) {
        loadingRef.current = false;
        lastLoadedAtRef.current = Date.now();
        if (!silent) setLoading(false);
      }
    }
  }, [workspace, scope, me, statusFilter, priority, severity, ownerFilter, creatorFilter, debouncedKeyword, sort, pageNo]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void load();
  }, [load, reloadTick, refreshToken]);

  // Auto-refresh the visible list. Hidden windows pause; becoming visible
  // again catches up immediately when the snapshot is older than one interval.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (loadingRef.current) return;
      if (Date.now() - lastLoadedAtRef.current < AUTO_REFRESH_MS) return;
      void loadRef.current(true);
    };
    const timer = window.setInterval(tick, AUTO_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const hideOwner = scope === "mine" && Boolean(me);
  const activeFilterCount =
    statusFilter.length +
    (priority ? 1 : 0) +
    (severity ? 1 : 0) +
    (!hideOwner && ownerFilter ? 1 : 0) +
    (creatorFilter ? 1 : 0) +
    (keyword.trim() ? 1 : 0);

  /** Workspace directory plus anyone already on screen, so options are never empty. */
  const peopleOptions = useMemo(() => {
    const values = new Set(memberNicks);
    for (const bug of page?.bugs ?? []) {
      if (bug.owner) values.add(bug.owner);
      if (bug.creator) values.add(bug.creator);
    }
    return Array.from(values)
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
      .map((nick) => ({ value: nick, label: nick }));
  }, [memberNicks, page?.bugs]);

  /** Cycle 升序 → 降序 → 取消（回到 TAPD 默认排序）. */
  const toggleSort = (name: "created" | "status") => {
    setPageNo(1);
    setSort((current) => {
      if (!current || current.name !== name) return { name, order: "asc" };
      return current.order === "asc" ? { name, order: "desc" } : null;
    });
  };

  const clearFilters = () => {
    setPageNo(1);
    setStatusFilter([]);
    setPriority("");
    setSeverity("");
    setOwnerFilter("");
    setCreatorFilter("");
    setKeyword("");
  };

  const claim = async (bug: BugSummary) => {
    if (!onClaim || claimingId) return;
    setClaimingId(bug.id);
    try {
      await onClaim(bug);
    } catch {
      // App reports the failure; the row just returns to its claim button.
    } finally {
      setClaimingId(null);
    }
  };

  const openRowMenu = (event: ReactMouseEvent<HTMLTableRowElement>, bug: BugSummary) => {
    event.preventDefault();
    setRowMenu({
      x: event.clientX,
      y: event.clientY,
      bug,
      seq: ++menuSeqRef.current,
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BugTableToolbar
        scope={scope}
        me={me}
        onScopeChange={onScopeChange}
        keyword={keyword}
        onKeywordChange={(value) => {
          setPageNo(1);
          setKeyword(value);
        }}
        activeFilterCount={activeFilterCount}
        onClearFilters={clearFilters}
        columns={columns}
        onColumnsChange={setColumns}
        hideOwner={hideOwner}
      />

      {page && snapshotAt !== null && !loading && !error ? (
        <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50/80 px-5 py-1.5 text-ui-sm text-amber-700">
          <WifiOff size={12} className="shrink-0" />
          <span className="truncate">
            离线数据 · 上次同步 {formatSnapshotTime(snapshotAt)}
          </span>
          <button
            type="button"
            onClick={() => setReloadTick((tick) => tick + 1)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-amber-200 bg-surface px-1.5 py-0.5 text-ui-xs text-amber-700 transition hover:bg-amber-100"
          >
            <RefreshCw size={10} />
            重试
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="m-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-ui-caption leading-6 text-rose-700">
            <div className="font-normal">缺陷加载失败</div>
            <div className="mt-1 break-all">{error}</div>
            <div className="mt-3">
              <Button size="sm" onClick={() => setReloadTick((tick) => tick + 1)}>
                重试
              </Button>
            </div>
          </div>
        ) : null}

        {!error && !page && loading ? (
          <SkeletonRows
            className="pt-1"
            rows={9}
            columns={["w-[36%]", "w-12", "w-9", "w-14", "w-16", "w-12", "w-24"]}
            label="正在读取缺陷列表"
          />
        ) : null}

        {!error && page && page.bugs.length === 0 ? (
          <EmptyState
            icon={<Bug size={22} />}
            title={scope === "mine" ? "你名下没有符合条件的缺陷" : "没有符合条件的缺陷"}
            description={
              activeFilterCount > 0
                ? "试试清除部分筛选条件，或切换到「全部」。"
                : "当前项目的缺陷列表为空，或视图权限不足。"
            }
            action={
              activeFilterCount > 0 ? (
                <Button size="sm" onClick={clearFilters}>
                  清除筛选
                </Button>
              ) : null
            }
          />
        ) : null}

        {!error && page && page.bugs.length > 0 ? (
          <BugTable
            page={page}
            loading={loading}
            me={me}
            columns={columns}
            hideOwner={hideOwner}
            agentInFlight={agentInFlight}
            externalClaims={externalClaims}
            claimingId={claimingId}
            sort={sort}
            statusFilter={statusFilter}
            priority={priority}
            severity={severity}
            ownerFilter={ownerFilter}
            creatorFilter={creatorFilter}
            peopleOptions={peopleOptions}
            onToggleSort={toggleSort}
            onStatusChange={(values) => {
              setPageNo(1);
              setStatusFilter(values);
            }}
            onPriorityChange={(value) => {
              setPageNo(1);
              setPriority(value);
            }}
            onSeverityChange={(value) => {
              setPageNo(1);
              setSeverity(value);
            }}
            onOwnerChange={(value) => {
              setPageNo(1);
              setOwnerFilter(value);
            }}
            onCreatorChange={(value) => {
              setPageNo(1);
              setCreatorFilter(value);
            }}
            onOpenBug={onOpenBug}
            onRowContextMenu={openRowMenu}
            onAgentFix={onAgentFix}
            onAgentCompose={onAgentCompose}
            onOpenAgentTask={onOpenAgentTask}
            onCancelTask={onCancelTask}
            onReleaseExternal={onReleaseExternal}
            onClaim={claim}
          />
        ) : null}
      </div>

      <BugListPager
        page={page}
        pageNo={pageNo}
        loading={loading}
        onRefresh={() => setReloadTick((tick) => tick + 1)}
        onPageChange={setPageNo}
      />

      {rowMenu ? (
        <BugRowContextMenu
          key={rowMenu.seq}
          menu={rowMenu}
          onClose={() => setRowMenu(null)}
          onCopy={onCopy}
          onOpenWeb={onOpenWeb}
        />
      ) : null}
    </div>
  );
}

/**
 * Memoized so detail-pane state changes (open/loading/detail) do not reconcile
 * the whole bug table. Props must stay referentially stable: App passes
 * `useCallback` handlers and the workspace object from the loaded context.
 */
export const BugListView = memo(BugListViewImpl);

/** "上次同步" label: time only for today, date + time for older snapshots. */
function formatSnapshotTime(fetchedAt: number): string {
  const date = new Date(fetchedAt * 1000);
  if (Number.isNaN(date.getTime())) return "未知";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const options: Intl.DateTimeFormatOptions = {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(sameDay ? {} : { month: "2-digit", day: "2-digit" }),
  };
  return date.toLocaleString("zh-CN", options);
}
