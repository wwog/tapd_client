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
import {
  agentActiveBugIds,
  type AgentInFlight,
} from "../lib/agent";
import { cacheApi, type Cached } from "../lib/cache";
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
  onAgentFix?: (bug: BugSummary) => void;
  /** Launch with a prompt/resources from the compose sheet. */
  onAgentCompose?: (bug: BugSummary) => void;
  /** In-flight agent tasks keyed by workspace + bug. */
  agentInFlight?: Map<string, AgentInFlight>;
  /** Jump to an already queued/running task instead of enqueuing again. */
  onOpenAgentTask?: (taskId: string) => void;
  onCancelTask?: (taskId: string) => Promise<void> | void;
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
    activeBugId,
    onOpenWeb,
    onCopy,
    onAgentFix,
    onAgentCompose,
    agentInFlight,
    onOpenAgentTask,
    onCancelTask,
    onClaim,
    refreshToken,
  } = props;

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

  /** Bugs in this project that the local agent queue is working on. */
  const processingIds = useMemo(
    () => agentActiveBugIds(workspace?.id, agentInFlight),
    [workspace?.id, agentInFlight],
  );
  /**
   * Content key for the 处理中 set. Agent state emits on every progress tick, so
   * depending on the array identity would re-fetch details far too often; the
   * key only changes when the bug set does.
   */
  const processingKey = processingIds.join("\u0000");

  /**
   * 处理中 rows: TAPD has no "has an agent" filter, so keyword, status, people
   * and sort are applied locally to the bug set from live agent state.
   */
  const buildProcessingPage = useCallback(
    (source: BugSummary[]): BugListPage => {
      const statusMap: Record<string, string> = {};
      for (const bug of source) statusMap[bug.status] = bug.statusLabel;
      const needle = debouncedKeyword.toLowerCase();
      // Mirrors the server-side filter: digits are an id lookup (full or short
      // id, optional `#`), everything else matches the title.
      const keywordId = /^#?\d+$/.test(debouncedKeyword)
        ? debouncedKeyword.replace(/^#/, "")
        : null;
      const bugs = source.filter(
        (bug) =>
          (statusFilter.length === 0 || statusFilter.includes(bug.status)) &&
          (!priority || bug.priority === priority) &&
          (!severity || bug.severity === severity) &&
          (ownerFilter.length === 0 || ownerFilter.includes(bug.owner)) &&
          (!creatorFilter || bug.creator === creatorFilter) &&
          (!needle ||
            (keywordId
              ? bug.id === keywordId || bug.shortId === keywordId
              : bug.title.toLowerCase().includes(needle))),
      );
      if (sort) {
        const direction = sort.order === "asc" ? 1 : -1;
        bugs.sort(
          (a, b) =>
            (sort.name === "created"
              ? a.created.localeCompare(b.created)
              : (a.statusLabel || a.status).localeCompare(
                  b.statusLabel || b.status,
                  "zh-CN",
                )) * direction,
        );
      }
      return {
        page: 1,
        perpage: 50,
        total: bugs.length,
        statusMap,
        // Fetch order is activity order; the filter menu just needs every
        // status present in the set, including custom workflow ones.
        statusOrder: Array.from(new Set(source.map((bug) => bug.status))),
        bugs,
      };
    },
    [statusFilter, priority, severity, ownerFilter, creatorFilter, debouncedKeyword, sort],
  );
  /**
   * Rows already fetched for 处理中. Filtering/sorting re-renders this set
   * locally, so typing in the search box never re-fetches bug details.
   */
  const processingBugsRef = useRef<BugSummary[]>([]);
  /** Rows belong to one project; a switch must not paint another project's bugs. */
  useEffect(() => {
    processingBugsRef.current = [];
  }, [workspace?.id]);
  const buildProcessingPageRef = useRef(buildProcessingPage);
  buildProcessingPageRef.current = buildProcessingPage;
  /** A detail batch is in flight; another one would only queue up behind it. */
  const processingInFlightRef = useRef(false);
  /** A refresh asked for while that batch was in flight; run once after it. */
  const processingDirtyRef = useRef(false);

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

  /**
   * 处理中 has no server query: the rows are exactly the bugs named by live
   * agent state. A scope switch is therefore a local filter over the rows this
   * session already fetched; only bugs never seen get a summary call (one
   * request each, no change history).
   *
   * `force` refreshes rows that are already on screen: the silent tick, the
   * retry buttons and tool writes. Entering the tab never forces.
   */
  /** Re-enters `loadProcessing` with the latest ids after a coalesced batch. */
  const processingRetryRef = useRef<(force: boolean) => void>(() => {});
  /** A coalesced batch ended while a forced refresh was pending. */
  const processingForceRef = useRef(false);
  const loadProcessing = useCallback(async (force = false) => {
    if (!workspace) return;
    const ids = processingKey ? processingKey.split("\u0000") : [];
    if (ids.length === 0) {
      // Activity vanished before App could reset the scope; never show a
      // "failed" banner for a view that is about to close.
      requestIdRef.current += 1;
      loadingRef.current = false;
      setLoading(false);
      setPage(null);
      return;
    }
    // A write or `data://refresh` arriving mid-batch must not start a second
    // round of calls: remember it and run once more when this one ends.
    if (processingInFlightRef.current) {
      processingDirtyRef.current = true;
      processingForceRef.current = processingForceRef.current || force;
      return;
    }

    const known = new Map(processingBugsRef.current.map((bug) => [bug.id, bug]));
    /** Bugs already fetched this session; only the rest need a call. */
    const seen = new Set(known.keys());
    /** Rows in memory paint immediately; the network only fills the gaps. */
    const paint = () => {
      const bugs = ids.flatMap((id) => {
        const bug = known.get(id);
        return bug ? [bug] : [];
      });
      if (bugs.length === 0) return 0;
      processingBugsRef.current = bugs;
      setPage(buildProcessingPageRef.current(bugs));
      return bugs.length;
    };

    const painted = paint();
    const targets = force ? ids : ids.filter((id) => !seen.has(id));

    // Every row is already in memory and nothing asked for a refresh (the user
    // just switched to this tab): a purely local filter, so no request at all.
    if (!force && targets.length === 0) {
      // Still advance the id so a list response from the previous scope cannot
      // paint over these rows.
      requestIdRef.current += 1;
      loadingRef.current = false;
      lastLoadedAtRef.current = Date.now();
      setLoading(false);
      setError(null);
      setSnapshotAt(null);
      return;
    }

    const requestId = ++requestIdRef.current;
    processingInFlightRef.current = true;
    loadingRef.current = true;
    setError(null);
    // A first visit has nothing to paint; rows already on screen never dim.
    if (painted === 0) setLoading(true);

    // Cache-first for bugs this session has not fetched yet, so a first visit
    // still paints before the summary calls return.
    let cachedAt: number | null = null;
    if (!force && targets.length > 0) {
      try {
        const entries = await Promise.all(
          targets.map((id) =>
            cacheApi.bugDetail(workspace.id, id).catch(() => null),
          ),
        );
        if (requestId !== requestIdRef.current) {
          // A newer request (usually a scope switch back to 我负责的 / 全部) owns
          // the page. Hand the in-flight slot back: this batch will never reach
          // its `finally`, and leaving the flag set would make every later
          // 处理中 load bail out for the rest of the session.
          processingInFlightRef.current = false;
          processingForceRef.current = false;
          processingDirtyRef.current = false;
          return;
        }
        const cached = entries.flatMap((entry) =>
          entry?.data ? [entry.data] : [],
        );
        if (cached.length > 0) {
          const times = entries.flatMap((entry) =>
            entry?.fetchedAt ? [entry.fetchedAt] : [],
          );
          cachedAt = times.length > 0 ? Math.min(...times) : null;
          for (const bug of cached) known.set(bug.id, bug);
          paint();
          setLoading(false);
        }
      } catch {
        // Cache misses are not page failures; the summary calls decide.
      }
    }

    try {
      const settled = await Promise.allSettled(
        targets.map((id) => api.bugSummary(workspace.id, id)),
      );
      if (requestId !== requestIdRef.current) return;
      const fresh = targets.flatMap((id, index) => {
        const result = settled[index];
        if (result?.status !== "fulfilled") return [];
        known.set(id, result.value);
        return [result.value];
      });
      const bugs = ids.flatMap((id) => {
        const bug = known.get(id);
        return bug ? [bug] : [];
      });
      if (bugs.length === 0) {
        setError("正在处理的缺陷加载失败，请稍后重试。");
        setPage(null);
        setSnapshotAt(null);
        return;
      }
      processingBugsRef.current = bugs;
      setPage(buildProcessingPageRef.current(bugs));
      // Only claim freshness when every requested row came from the network.
      if (fresh.length === targets.length) {
        setSnapshotAt(null);
      } else if (cachedAt !== null) {
        setSnapshotAt(cachedAt);
      }
      setError(null);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      if (painted === 0) {
        setError(String(cause));
        setPage(null);
        setSnapshotAt(null);
      }
    } finally {
      processingInFlightRef.current = false;
      const retryForce = processingForceRef.current;
      processingForceRef.current = false;
      if (processingDirtyRef.current) {
        processingDirtyRef.current = false;
        // Only when this batch is still the newest; a newer request already
        // owns the page.
        if (requestId === requestIdRef.current) {
          processingRetryRef.current(retryForce);
        }
      }
      if (requestId === requestIdRef.current) {
        loadingRef.current = false;
        lastLoadedAtRef.current = Date.now();
        setLoading(false);
      }
    }
  }, [workspace, processingKey]);

  processingRetryRef.current = (force) => void loadProcessing(force);

  const load = useCallback(
    async (silent = false) => {
      if (scope === "processing") {
        // Always a background refresh: the rows on screen stay put and only
        // their summaries are re-read (no change history).
        await loadProcessing(true);
        return;
      }
      await loadList(silent);
    },
    [scope, loadList, loadProcessing],
  );

  const loadRef = useRef(load);
  loadRef.current = load;

  // Server views reload on query changes. 处理中 is a filter over live agent
  // state: entering the tab repaints the rows this session already fetched and
  // only calls for unseen bugs, so typing in the search box is not a network
  // event either.
  useEffect(() => {
    if (scope === "processing") return;
    void loadList();
  }, [scope, loadList, reloadTick, refreshToken]);

  useEffect(() => {
    if (scope !== "processing") return;
    void loadProcessing(false);
  }, [scope, loadProcessing]);

  /**
   * Rows on screen may have changed while a refresh token arrived (tool write,
   * notification poll, retry pressed); re-read them in the background. Tokens
   * observed on another scope are not replayed on entry.
   */
  const processingTokenRef = useRef({ refreshToken, reloadTick });
  useEffect(() => {
    if (scope !== "processing") {
      processingTokenRef.current = { refreshToken, reloadTick };
      return;
    }
    const previous = processingTokenRef.current;
    processingTokenRef.current = { refreshToken, reloadTick };
    if (
      previous.refreshToken === refreshToken &&
      previous.reloadTick === reloadTick
    ) {
      return;
    }
    void loadProcessing(true);
  }, [scope, refreshToken, reloadTick, loadProcessing]);

  useEffect(() => {
    if (scope !== "processing" || processingBugsRef.current.length === 0) return;
    setPage(buildProcessingPage(processingBugsRef.current));
  }, [scope, buildProcessingPage]);

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
    <div className="flex min-h-0 flex-1 flex-col">
      <BugTableToolbar
        scope={scope}
        me={me}
        onScopeChange={onScopeChange}
        showProcessing={processingIds.length > 0}
        keyword={keyword}
        onKeywordChange={(value) => {
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
            title={
              scope === "processing"
                ? "当前没有正在处理的缺陷"
                : scope === "mine"
                  ? "你名下没有符合条件的缺陷"
                  : "没有符合条件的缺陷"
            }
            description={
              scope === "processing"
                ? activeFilterCount > 0
                  ? "试试清除部分筛选条件。"
                  : "内部 Agent 开始处理后会出现在这里。"
                : activeFilterCount > 0
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
            activeBugId={activeBugId}
            columns={columns}
            hideOwner={hideOwner}
            agentInFlight={agentInFlight}
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
