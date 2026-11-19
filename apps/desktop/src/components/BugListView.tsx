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
import { cacheApi, type Cached } from "../lib/cache";
import { localeTag, t, useLocale } from "../lib/i18n";
import {
  bugTaskKey,
  queuedBugEntries,
  useTaskFeed,
  workspaceEntries,
  type TaskFeedEntry,
} from "../agent/taskFeed";
import { SkeletonRows } from "./Skeleton";
import { Button, EmptyState } from "./ui";
import { BugListPager } from "./BugListPager";
import { BugRowContextMenu, type BugRowMenu } from "./BugRowContextMenu";
import { BugTable } from "./BugTable";
import { BugTableToolbar } from "./BugTableToolbar";
import {
  DEFAULT_SORT,
  loadColumns,
  loadFilters,
  loadSort,
  saveColumns,
  saveFilters,
  saveSort,
  type BugScope,
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

type Props = {
  workspace: Workspace | null;
  me: string | null;
  scope: BugScope;
  onScopeChange: (scope: BugScope) => void;
  onOpenBug: (bug: BugSummary) => void;
  /** Bug shown in the detail pane, highlighted in the table. */
  activeBugId?: string | null;
  /** Row actions (action column). */
  onOpenWeb?: (url: string) => void;
  /** Copy arbitrary text from the row context menu. */
  onCopy?: (text: string) => void;
  /** Claim a bug owned by someone else, which unlocks its actions. */
  onClaim?: (bug: BugSummary) => Promise<void>;
  /** Jump to an already queued/running task instead of enqueuing again. */
  onOpenAgentTask?: (sessionId: string) => void;
  /** Take a queued/running task out of the workflow queue. */
  onCancelAgentTask?: (sessionId: string) => Promise<void>;
  /** Brings the global workflow queue forward. */
  onOpenQueue?: () => void;
  refreshToken: number;
};

function BugListViewImpl(props: Props) {
  // `memo` would otherwise skip the root re-render on a language switch.
  useLocale();
  const {
    workspace,
    me,
    scope,
    onScopeChange,
    onOpenBug,
    activeBugId,
    onOpenWeb,
    onCopy,
    onClaim,
    onOpenAgentTask,
    onCancelAgentTask,
    onOpenQueue,
    refreshToken,
  } = props;

  // Workflow tasks of this project, from the app-wide feed. The per-row
  // status line reads this snapshot; running/queued rows are hidden here.
  const feed = useTaskFeed();
  const projectEntries = useMemo(
    () => workspaceEntries(feed, workspace?.id),
    [feed, workspace?.id],
  );
  /** One task per bug for the row status line / action cell. */
  const agentTasks = useMemo(() => {
    /** The most active task wins when a bug was handed over twice. */
    const rank = (entry: TaskFeedEntry) =>
      entry.task.workflow === "running"
        ? 0
        : entry.task.workflow === "queued"
          ? 1
          : entry.task.workflow === "awaiting_review"
            ? 2
            : 3;
    const map = new Map<string, TaskFeedEntry>();
    for (const entry of projectEntries) {
      const bugId = entry.task.bugId;
      if (!bugId || !entry.task.project) continue;
      const key = bugTaskKey(entry.task.project.id, bugId);
      const current = map.get(key);
      if (
        !current ||
        rank(entry) < rank(current) ||
        (rank(entry) === rank(current) &&
          current.task.updatedAt < entry.task.updatedAt)
      ) {
        map.set(key, entry);
      }
    }
    return map;
  }, [projectEntries]);
  /** Bugs whose tasks are running / waiting; they leave the normal list. */
  const queueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of queuedBugEntries(projectEntries)) {
      if (entry.task.bugId) ids.add(entry.task.bugId);
    }
    return [...ids];
  }, [projectEntries]);

  const [initialFilters] = useState(loadFilters);
  const [statusFilter, setStatusFilter] = useState<string[]>(
    initialFilters.statuses,
  );
  const [priority, setPriority] = useState(initialFilters.priority);
  const [severity, setSeverity] = useState(initialFilters.severity);
  const [ownerFilter, setOwnerFilter] = useState<string[]>(
    initialFilters.owners,
  );
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
    saveColumns(columns);
  }, [columns]);

  useEffect(() => {
    saveFilters({
      statuses: statusFilter,
      priority,
      severity,
      owners: ownerFilter,
      creator: creatorFilter,
      keyword: debouncedKeyword,
    });
  }, [statusFilter, priority, severity, ownerFilter, creatorFilter, debouncedKeyword]);

  useEffect(() => {
    saveSort(sort);
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

  // Apply the keyword and reset the page in the same commit: resetting the
  // page on every keystroke would fire one request with the *previous*
  // keyword from page 2+.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keyword.trim());
      setPageNo(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    setPageNo(1);
  }, [scope]);

  /** Server-side page load for 我负责的 / 全部. */
  const loadList = useCallback(async (silent = false) => {
    if (!workspace) return;

    const query: BugQuery = {
      workspaceId: workspace.id,
      // "我负责的" always wins; the 处理人 filter only applies in 全部.
      owners: scope === "mine" ? (me ? [me] : []) : ownerFilter,
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
      // `observe: true` = this page is on screen. The backend additionally
      // requires the window to be focused right now, so an auto-refresh
      // running while the user is in another app never silences a notification.
      const result = await api.bugList(query, true);
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

  const load = useCallback(
    async (silent = false) => {
      await loadList(silent);
    },
    [loadList],
  );

  const loadRef = useRef(load);
  loadRef.current = load;

  // Server views reload on query changes.
  useEffect(() => {
    void loadList();
  }, [loadList, reloadTick, refreshToken]);

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
    (!hideOwner && ownerFilter.length > 0 ? 1 : 0) +
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
      .sort((a, b) => a.localeCompare(b, localeTag()))
      .map((nick) => ({ value: nick, label: nick }));
  }, [memberNicks, page?.bugs]);

  /** Queue-owned bugs leave the normal scopes; review/merging rows stay. */
  const queueIdSet = useMemo(() => new Set(queueIds), [queueIds]);
  const visiblePage = useMemo(() => {
    if (!page) return null;
    if (queueIdSet.size === 0) return page;
    const bugs = page.bugs.filter((bug) => !queueIdSet.has(bug.id));
    return bugs.length === page.bugs.length ? page : { ...page, bugs };
  }, [page, queueIdSet]);
  const hiddenByQueue = Boolean(
    page && visiblePage && page.bugs.length > 0 && visiblePage.bugs.length === 0,
  );

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
    setOwnerFilter([]);
    setCreatorFilter("");
    setKeyword("");
    // Clear the applied keyword in the same commit, otherwise the reset page
    // is fetched once with the old keyword still in the query.
    setDebouncedKeyword("");
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
    <div data-component="BugListView" className="flex min-h-0 flex-1 flex-col">
      <BugTableToolbar
        scope={scope}
        me={me}
        onScopeChange={onScopeChange}
        keyword={keyword}
        onKeywordChange={(value) => {
          setKeyword(value);
        }}
        columns={columns}
        onColumnsChange={setColumns}
        hideOwner={hideOwner}
      />

      {page && snapshotAt !== null && !loading && !error ? (
        <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50/80 px-5 py-1.5 text-ui-sm text-amber-700">
          <WifiOff size={12} className="shrink-0" />
          <span className="truncate">
            {t("bugs.offlineSnapshot", {
              time: formatSnapshotTime(snapshotAt),
            })}
          </span>
          <button
            type="button"
            onClick={() => setReloadTick((tick) => tick + 1)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-amber-200 bg-surface px-1.5 py-0.5 text-ui-xs text-amber-700 transition hover:bg-amber-100"
          >
            <RefreshCw size={10} />
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="m-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-ui-caption leading-6 text-rose-700">
            <div className="font-normal">{t("bugs.loadFailed")}</div>
            <div className="mt-1 break-all">{error}</div>
            <div className="mt-3">
              <Button size="sm" onClick={() => setReloadTick((tick) => tick + 1)}>
                {t("common.retry")}
              </Button>
            </div>
          </div>
        ) : null}

        {!error && !visiblePage && loading ? (
          <SkeletonRows
            className="pt-1"
            rows={9}
            columns={["w-[36%]", "w-12", "w-9", "w-14", "w-16", "w-12", "w-24"]}
            label={t("bugs.loadingList")}
          />
        ) : null}

        {!error && visiblePage && visiblePage.bugs.length === 0 ? (
          <EmptyState
            icon={<Bug size={22} />}
            title={
              hiddenByQueue
                ? t("bugs.emptyQueueHidden")
                : scope === "mine"
                  ? t("bugs.emptyMine")
                  : t("bugs.emptyAll")
            }
            description={
              hiddenByQueue
                ? t("bugs.emptyQueueHiddenHint")
                : activeFilterCount > 0
                  ? t("bugs.emptyHintFiltersAll")
                  : t("bugs.emptyProject")
            }
            action={
              hiddenByQueue ? (
                <div className="flex items-center justify-center gap-2">
                  {activeFilterCount > 0 ? (
                    <Button size="sm" variant="ghost" onClick={clearFilters}>
                      {t("bugs.clearFilters")}
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={onOpenQueue}>
                    {t("app.nav.queue")}
                  </Button>
                </div>
              ) : activeFilterCount > 0 ? (
                <Button size="sm" onClick={clearFilters}>
                  {t("bugs.clearFilters")}
                </Button>
              ) : null
            }
          />
        ) : null}

        {!error && visiblePage && visiblePage.bugs.length > 0 ? (
          <BugTable
            page={visiblePage}
            loading={loading}
            me={me}
            activeBugId={activeBugId}
            columns={columns}
            hideOwner={hideOwner}
            claimingId={claimingId}
            sort={sort}
            statusFilter={statusFilter}
            priority={priority}
            severity={severity}
            ownerFilter={ownerFilter}
            creatorFilter={creatorFilter}
            peopleOptions={peopleOptions}
            onClearFilters={clearFilters}
            clearableFilters={activeFilterCount > 0}
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
            onClaim={claim}
            agentTasks={agentTasks}
            onOpenAgentTask={onOpenAgentTask}
            onCancelAgentTask={onCancelAgentTask}
          />
        ) : null}
      </div>

      <BugListPager
        page={visiblePage}
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
 * Memoized so detail-pane state changes (loading/detail) do not reconcile the
 * whole bug table. The one exception is `activeBugId`, which changes when the
 * pane opens or closes: one cheap render to move the row highlight.
 * Props must stay referentially stable: App passes
 * `useCallback` handlers and the workspace object from the loaded context.
 */
export const BugListView = memo(BugListViewImpl);

/** "上次同步" label: time only for today, date + time for older snapshots. */
function formatSnapshotTime(fetchedAt: number): string {
  const date = new Date(fetchedAt * 1000);
  if (Number.isNaN(date.getTime())) return t("common.unknown");

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
  return date.toLocaleString(localeTag(), options);
}
