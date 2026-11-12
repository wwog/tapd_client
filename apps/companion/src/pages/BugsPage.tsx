import { useEffect, useState } from "react";
import { Search, Settings } from "lucide-react";

import { api, asApiError, type BugListPage, type Workspace } from "../lib/api";
import { bugTitle, ownerNames, relativeTime } from "../lib/format";
import { navigate } from "../lib/router";
import { Badge, PriorityDot, STATUS_TONES } from "../components/Badge";

const PAGE_SIZE = 20;
/** 未解决 = 还需要开发同学跟进的状态（与桌面状态栏一致的常用口径）。 */
const OPEN_STATUSES = ["new", "in_progress", "reopened"];

const visitedStamp = (iso: string | null): number => {
  const timestamp = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

function ListSkeleton() {
  return (
    <div>
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div key={row} className="border-b border-border px-4 py-3">
          <div className="h-4 w-3/4 animate-pulse rounded bg-overlay-soft" />
          <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-overlay-soft" />
        </div>
      ))}
    </div>
  );
}

/** Bug list: keyword search, unresolved filter, paged rows. */
export function BugsPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [keyword, setKeyword] = useState("");
  const [query, setQuery] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<BugListPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The list needs a workspace; default to the most recently visited one,
  // mirroring the desktop's startup project.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const context = await api.workspaces();
        if (cancelled) return;
        const sorted = [...context.workspaces].sort(
          (a, b) => visitedStamp(b.lastVisitedTime) - visitedStamp(a.lastVisitedTime),
        );
        setWorkspaces(sorted);
        setWorkspaceId(sorted[0]?.id ?? null);
        if (sorted.length === 0) {
          setError("没有可用项目");
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(asApiError(err).message);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keyword search debounces so each keystroke does not hit the desktop.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(keyword.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    setPage(1);
  }, [workspaceId, query, onlyOpen]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const data = await api.bugs({
          workspaceId,
          owners: [],
          creator: null,
          statuses: onlyOpen ? OPEN_STATUSES : [],
          priorities: [],
          severities: [],
          keyword: query || null,
          modifiedAfter: null,
          createdAfter: null,
          sortName: "created",
          order: "desc",
          page,
          perpage: PAGE_SIZE,
          confId: null,
        });
        if (!cancelled) {
          setResult(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(asApiError(err).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, query, onlyOpen, page]);

  const totalPages = result
    ? Math.max(1, Math.ceil(result.total / Math.max(1, result.perpage)))
    : 1;

  return (
    <div>
      <header className="sticky top-0 z-20 border-b border-border bg-canvas">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <h1 className="text-ui-base text-slate-900">缺陷</h1>
          <button
            type="button"
            aria-label="设置"
            onClick={() => navigate("#/settings")}
            className="rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
          >
            <Settings size={18} />
          </button>
        </div>
        <div className="flex items-center gap-2 px-4 pb-2">
          {workspaces.length > 1 ? (
            <select
              aria-label="项目"
              value={workspaceId ?? ""}
              onChange={(event) => setWorkspaceId(event.target.value)}
              className="max-w-[36%] shrink-0 rounded-lg border border-border bg-surface px-2 py-1.5 text-ui-sm text-slate-700 focus:outline-2 focus:outline-sky-200"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name || workspace.prettyName}
                </option>
              ))}
            </select>
          ) : null}
          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400"
            />
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索缺陷"
              className="w-full rounded-lg border border-border bg-surface py-1.5 pr-2.5 pl-7 text-ui-caption text-slate-700 transition placeholder:text-slate-400 focus:border-sky-300 focus:outline-2 focus:outline-sky-200"
            />
          </div>
        </div>
        <div className="px-4 pb-2">
          <button
            type="button"
            aria-pressed={onlyOpen}
            onClick={() => setOnlyOpen((value) => !value)}
            className={`rounded-md border px-2 py-1 text-ui-sm transition ${
              onlyOpen
                ? "border-sky-200 bg-sky-50 text-sky-700"
                : "border-border text-slate-500"
            }`}
          >
            仅未解决
          </button>
        </div>
      </header>

      {error ? (
        <p className="px-4 py-3 text-ui-caption text-rose-600">{error}</p>
      ) : null}

      {loading && !result ? <ListSkeleton /> : null}

      {!loading && !error && result && result.bugs.length === 0 ? (
        <p className="px-4 py-10 text-center text-ui-base text-slate-400" title="调整关键词或筛选后再试。">
          没有符合条件的缺陷
        </p>
      ) : null}

      {result && result.bugs.length > 0
        ? result.bugs.map((bug) => (
            <button
              key={bug.id}
              type="button"
              onClick={() =>
                workspaceId &&
                navigate(`#/bug/${bug.id}?w=${encodeURIComponent(workspaceId)}`)
              }
              className="block w-full border-b border-border px-4 py-3 text-left transition active:bg-overlay-soft"
            >
              <span className="line-clamp-2 block text-ui-caption text-slate-900">
                {bugTitle(bug.title)}
              </span>
              <span className="mt-1.5 flex items-center gap-2 text-ui-xs text-slate-500">
                <Badge tone={STATUS_TONES[bug.status] ?? "neutral"}>
                  {bug.statusLabel || bug.status}
                </Badge>
                <PriorityDot priority={bug.priority} />
                <span className="truncate">{ownerNames(bug.owner)[0] || "未指派"}</span>
                <span className="ml-auto shrink-0 text-slate-400">
                  {relativeTime(bug.modified)}
                </span>
              </span>
            </button>
          ))
        : null}

      {result && result.bugs.length > 0 ? (
        <div className="flex items-center justify-between px-4 py-3">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
          >
            上一页
          </button>
          <span className="text-ui-xs text-slate-500" title={`共 ${totalPages} 页`}>
            第 {page} 页
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((value) => value + 1)}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      ) : null}
    </div>
  );
}
