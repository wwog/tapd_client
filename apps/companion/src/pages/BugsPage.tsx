import { useEffect, useMemo, useState } from "react";
import { Bot, ChevronRight, LoaderCircle, Search, SlidersHorizontal } from "lucide-react";

import {
  api,
  asApiError,
  type AgentRuntimeDescriptor,
  type BugListPage,
  type BugSummary,
  type Workspace,
} from "../lib/api";
import { refreshAgentTasks } from "../lib/agentTasks";
import { bugTitle, ownerNames, relativeTime } from "../lib/format";
import { navigate } from "../lib/router";
import { Badge, PriorityDot, STATUS_TONES } from "../components/Badge";
import { BottomSheet } from "../components/BottomSheet";

const PAGE_SIZE = 20;
/** 未解决 = 还需要开发同学跟进的状态（与桌面状态栏一致的常用口径）。 */
const OPEN_STATUSES = ["new", "in_progress", "reopened"];
/** 筛选面板里固定提供的常用状态；当前数据里出现的其它状态会追加。 */
const COMMON_STATUSES = [
  "new",
  "in_progress",
  "reopened",
  "resolved",
  "verified",
  "closed",
  "rejected",
];

const visitedStamp = (iso: string | null): number => {
  const timestamp = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

/* -------------------------------------------------------------------------
   缺陷筛选：本地持久化（companion.bugFilter），确认后并入 BugQuery。
   ------------------------------------------------------------------------- */

type BugFilter = {
  statuses: string[];
  owners: string[];
  priority: string | null;
  severity: string | null;
  creator: string | null;
};

const FILTER_KEY = "companion.bugFilter";
const EMPTY_FILTER: BugFilter = {
  statuses: [],
  owners: [],
  priority: null,
  severity: null,
  creator: null,
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function readFilter(): BugFilter {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return EMPTY_FILTER;
    const parsed = JSON.parse(raw) as Partial<BugFilter>;
    return {
      statuses: asStringArray(parsed.statuses),
      owners: asStringArray(parsed.owners),
      priority: typeof parsed.priority === "string" ? parsed.priority : null,
      severity: typeof parsed.severity === "string" ? parsed.severity : null,
      creator: typeof parsed.creator === "string" ? parsed.creator : null,
    };
  } catch {
    return EMPTY_FILTER;
  }
}

function writeFilter(filter: BugFilter): void {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filter));
  } catch {
    // Private browsing: filter stays session-local.
  }
}

const toggleIn = (values: string[], value: string): string[] =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

/** Unique values in first-seen order; empty entries dropped. */
function uniqueValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    seen.add(value);
  }
  return [...seen];
}

function FilterChip(props: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={props.onSelect}
      className={`rounded-lg border px-2.5 py-1.5 text-ui-sm transition ${
        props.selected ? "border-sky-200 bg-sky-50 text-sky-700" : "border-border text-slate-500"
      }`}
    >
      {props.label}
    </button>
  );
}

function FilterGroup(props: { label: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 first:mt-0">
      <h3 className="text-ui-sm text-slate-500">{props.label}</h3>
      <div className="mt-2 flex flex-wrap gap-1.5">{props.children}</div>
    </section>
  );
}

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

/** Bug list: keyword search, unresolved filter, filter sheet, agent actions. */
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

  // 行操作 sheet 与「用 Agent 修复」sheet 互斥；入队表单独立在 compose。
  const [actionBug, setActionBug] = useState<BugSummary | null>(null);
  const [composeBug, setComposeBug] = useState<BugSummary | null>(null);
  const [extraPrompt, setExtraPrompt] = useState("");
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);
  const [runtimeId, setRuntimeId] = useState("");
  const [enqueueBusy, setEnqueueBusy] = useState(false);
  const [enqueueError, setEnqueueError] = useState<string | null>(null);

  // Persisted filter; the sheet edits a draft that applies on 确认.
  const [filter, setFilter] = useState<BugFilter>(readFilter);
  const [filterDraft, setFilterDraft] = useState<BugFilter>(EMPTY_FILTER);
  const [filterOpen, setFilterOpen] = useState(false);

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
  }, [workspaceId, query, onlyOpen, filter]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const data = await api.bugs({
          workspaceId,
          owners: filter.owners,
          creator: filter.creator,
          statuses: [...new Set([...(onlyOpen ? OPEN_STATUSES : []), ...filter.statuses])],
          priorities: filter.priority ? [filter.priority] : [],
          severities: filter.severity ? [filter.severity] : [],
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
  }, [workspaceId, query, onlyOpen, page, filter]);

  // 聚合选项：当前列表数据去重（状态并上常用集）。
  const statusOptions = useMemo(() => {
    const keys = [
      ...COMMON_STATUSES,
      ...Object.keys(result?.statusMap ?? {}),
      ...uniqueValues(result?.bugs.map((bug) => bug.status) ?? []),
    ];
    return uniqueValues(keys);
  }, [result]);

  const ownerOptions = useMemo(
    () => uniqueValues((result?.bugs ?? []).flatMap((bug) => ownerNames(bug.owner))),
    [result],
  );

  const priorityOptions = useMemo(
    () => uniqueValues((result?.bugs ?? []).map((bug) => bug.priority)),
    [result],
  );

  const severityOptions = useMemo(
    () => uniqueValues((result?.bugs ?? []).map((bug) => bug.severity)),
    [result],
  );

  const creatorOptions = useMemo(
    () => uniqueValues((result?.bugs ?? []).map((bug) => bug.creator)),
    [result],
  );

  const statusLabel = (key: string): string => result?.statusMap?.[key] || key;
  const priorityLabel = (key: string): string =>
    result?.bugs.find((bug) => bug.priority === key)?.priorityLabel || key;
  const severityLabel = (key: string): string =>
    result?.bugs.find((bug) => bug.severity === key)?.severityLabel || key;

  const activeFilterCount =
    filter.statuses.length +
    filter.owners.length +
    (filter.priority ? 1 : 0) +
    (filter.severity ? 1 : 0) +
    (filter.creator ? 1 : 0);

  const applyFilter = (next: BugFilter) => {
    setFilter(next);
    writeFilter(next);
  };

  const openFilter = () => {
    setFilterDraft(filter);
    setFilterOpen(true);
  };

  // 用 Agent 修复：打开时读取运行时目录与桌面默认运行时。
  useEffect(() => {
    if (!composeBug) return;
    let cancelled = false;
    setExtraPrompt("");
    setEnqueueError(null);
    setRuntimes([]);
    setRuntimeId("");
    void Promise.all([api.agentConfig(), api.agentRuntimes()])
      .then(([config, catalog]) => {
        if (cancelled) return;
        setRuntimes(catalog.filter((runtime) => runtime.available));
        setRuntimeId(config.runtimeId);
      })
      .catch(() => {
        // 目录读取失败时仍可提交；省略 runtimeId 走桌面默认。
      });
    return () => {
      cancelled = true;
    };
  }, [composeBug]);

  const workspaceName = (id: string | null): string | null =>
    workspaces.find((workspace) => workspace.id === id)?.name || null;

  const submitEnqueue = async () => {
    if (!composeBug || !workspaceId || enqueueBusy) return;
    setEnqueueBusy(true);
    setEnqueueError(null);
    try {
      await api.agentEnqueueBug({
        workspaceId,
        bugId: composeBug.id,
        workspaceName: workspaceName(workspaceId),
        title: composeBug.title,
        severity: composeBug.severity || null,
        priority: composeBug.priority || null,
        extraPrompt: extraPrompt.trim() || null,
        runtimeId: runtimeId || null,
        source: "companion",
      });
      setComposeBug(null);
      // 立刻刷新角标，并跳到 Agent 页看队列里的新任务。
      await refreshAgentTasks();
      navigate("#/agent");
    } catch (err) {
      setEnqueueError(asApiError(err).message);
    } finally {
      setEnqueueBusy(false);
    }
  };

  const totalPages = result
    ? Math.max(1, Math.ceil(result.total / Math.max(1, result.perpage)))
    : 1;

  return (
    <div>
      <header className="sticky top-0 z-20 border-b border-border bg-canvas">
        <div className="flex items-center px-4 pt-3 pb-2">
          <h1 className="text-ui-base text-slate-900">缺陷</h1>
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
        <div className="flex items-center gap-2 px-4 pb-2">
          <button
            type="button"
            aria-pressed={onlyOpen}
            onClick={() => setOnlyOpen((value) => !value)}
            className={`rounded-md border px-2 py-1 text-ui-sm transition ${
              onlyOpen ? "border-sky-200 bg-sky-50 text-sky-700" : "border-border text-slate-500"
            }`}
          >
            仅未解决
          </button>
          <button
            type="button"
            onClick={openFilter}
            aria-haspopup="dialog"
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-ui-sm transition ${
              activeFilterCount > 0
                ? "border-sky-200 bg-sky-50 text-sky-700"
                : "border-border text-slate-500"
            }`}
          >
            <SlidersHorizontal size={12} />
            筛选{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
          </button>
        </div>
      </header>

      {error ? <p className="px-4 py-3 text-ui-caption text-rose-600">{error}</p> : null}

      {loading && !result ? <ListSkeleton /> : null}

      {!loading && !error && result && result.bugs.length === 0 ? (
        <p
          className="px-4 py-10 text-center text-ui-base text-slate-400"
          title="调整关键词或筛选后再试。"
        >
          没有符合条件的缺陷
        </p>
      ) : null}

      {result && result.bugs.length > 0
        ? result.bugs.map((bug) => (
            <div key={bug.id} className="flex items-stretch border-b border-border">
              <button
                type="button"
                onClick={() =>
                  workspaceId && navigate(`#/bug/${bug.id}?w=${encodeURIComponent(workspaceId)}`)
                }
                className="min-w-0 flex-1 px-4 py-3 text-left transition active:bg-overlay-soft"
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
              <button
                type="button"
                aria-label="更多操作"
                aria-haspopup="dialog"
                title="查看详情 / 用 Agent 修复"
                onClick={() => setActionBug(bug)}
                className="flex shrink-0 items-center px-3 text-slate-400 transition active:bg-overlay-soft"
              >
                <ChevronRight size={16} />
              </button>
            </div>
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

      {/* -- 筛选 sheet：草稿态多选，应用后才生效并持久化 ----------------- */}
      <BottomSheet
        open={filterOpen}
        title="筛选"
        onClose={() => setFilterOpen(false)}
        footer={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setFilterDraft(EMPTY_FILTER)}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
            >
              重置
            </button>
            <button
              type="button"
              onClick={() => {
                applyFilter(filterDraft);
                setFilterOpen(false);
              }}
              className="min-w-0 flex-1 rounded-lg bg-primary px-3 py-2 text-ui-sm text-primary-foreground transition active:bg-primary-hover"
            >
              应用
            </button>
          </div>
        }
      >
        <FilterGroup
          label={`状态${filterDraft.statuses.length ? `（已选 ${filterDraft.statuses.length}）` : ""}`}
        >
          {statusOptions.map((key) => (
            <FilterChip
              key={key}
              label={statusLabel(key)}
              selected={filterDraft.statuses.includes(key)}
              onSelect={() =>
                setFilterDraft((current) => ({
                  ...current,
                  statuses: toggleIn(current.statuses, key),
                }))
              }
            />
          ))}
        </FilterGroup>
        {ownerOptions.length > 0 ? (
          <FilterGroup
            label={`处理人${filterDraft.owners.length ? `（已选 ${filterDraft.owners.length}）` : ""}`}
          >
            {ownerOptions.map((owner) => (
              <FilterChip
                key={owner}
                label={owner}
                selected={filterDraft.owners.includes(owner)}
                onSelect={() =>
                  setFilterDraft((current) => ({
                    ...current,
                    owners: toggleIn(current.owners, owner),
                  }))
                }
              />
            ))}
          </FilterGroup>
        ) : null}
        {priorityOptions.length > 0 ? (
          <FilterGroup label="优先级">
            {priorityOptions.map((key) => (
              <FilterChip
                key={key}
                label={priorityLabel(key)}
                selected={filterDraft.priority === key}
                onSelect={() =>
                  setFilterDraft((current) => ({
                    ...current,
                    priority: current.priority === key ? null : key,
                  }))
                }
              />
            ))}
          </FilterGroup>
        ) : null}
        {severityOptions.length > 0 ? (
          <FilterGroup label="严重程度">
            {severityOptions.map((key) => (
              <FilterChip
                key={key}
                label={severityLabel(key)}
                selected={filterDraft.severity === key}
                onSelect={() =>
                  setFilterDraft((current) => ({
                    ...current,
                    severity: current.severity === key ? null : key,
                  }))
                }
              />
            ))}
          </FilterGroup>
        ) : null}
        {creatorOptions.length > 0 ? (
          <FilterGroup label="创建人">
            {creatorOptions.map((creator) => (
              <FilterChip
                key={creator}
                label={creator}
                selected={filterDraft.creator === creator}
                onSelect={() =>
                  setFilterDraft((current) => ({
                    ...current,
                    creator: current.creator === creator ? null : creator,
                  }))
                }
              />
            ))}
          </FilterGroup>
        ) : null}
        <p
          className="mt-4 text-ui-xs text-slate-400"
          title="选项来自当前列表数据；翻页或切换项目后会重新聚合。"
        >
          选项来自当前列表数据
        </p>
      </BottomSheet>

      {/* -- 行操作 sheet：查看详情 / 用 Agent 修复 ------------------------ */}
      <BottomSheet
        open={actionBug !== null}
        title={actionBug ? bugTitle(actionBug.title) : "操作"}
        onClose={() => setActionBug(null)}
      >
        {actionBug ? (
          <>
            <p className="flex items-center gap-2 text-ui-sm text-slate-500">
              <Badge tone={STATUS_TONES[actionBug.status] ?? "neutral"}>
                {actionBug.statusLabel || actionBug.status}
              </Badge>
              <PriorityDot priority={actionBug.priority} />
              <span>{actionBug.severityLabel || actionBug.severity || "—"}</span>
              <span>#{actionBug.id.slice(-7)}</span>
            </p>
            <div className="mt-4 space-y-2">
              <button
                type="button"
                onClick={() => {
                  const target = actionBug;
                  setActionBug(null);
                  if (workspaceId) {
                    navigate(`#/bug/${target.id}?w=${encodeURIComponent(workspaceId)}`);
                  }
                }}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-left text-ui-caption text-slate-700 transition active:bg-overlay-soft"
              >
                查看详情
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = actionBug;
                  setActionBug(null);
                  setComposeBug(target);
                }}
                className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-left text-ui-caption text-slate-700 transition active:bg-overlay-soft"
              >
                <Bot size={14} className="shrink-0 text-slate-400" />
                用 Agent 修复
              </button>
            </div>
          </>
        ) : null}
      </BottomSheet>

      {/* -- 用 Agent 修复 sheet：附加说明 + 运行时 ------------------------ */}
      <BottomSheet
        open={composeBug !== null}
        title="用 Agent 修复"
        onClose={() => setComposeBug(null)}
        footer={
          <button
            type="button"
            disabled={enqueueBusy}
            onClick={() => void submitEnqueue()}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-50"
          >
            {enqueueBusy ? <LoaderCircle size={13} className="animate-spin" /> : <Bot size={13} />}
            {enqueueBusy ? "正在入队…" : "入队"}
          </button>
        }
      >
        {composeBug ? (
          <>
            <p className="text-ui-caption leading-5 text-slate-900" title={bugTitle(composeBug.title)}>
              {bugTitle(composeBug.title)}
            </p>
            <p className="mt-1 flex items-center gap-3 text-ui-xs text-slate-500">
              <span title={`严重程度 ${composeBug.severityLabel || composeBug.severity || "—"}`}>
                严重程度 {composeBug.severityLabel || composeBug.severity || "—"}
              </span>
              <span title={`处理人 ${ownerNames(composeBug.owner)[0] || "未指派"}`}>
                {ownerNames(composeBug.owner)[0] || "未指派"}
              </span>
            </p>
            <label className="mt-3 block">
              <span className="text-ui-sm text-slate-500">附加说明</span>
              <textarea
                value={extraPrompt}
                onChange={(event) => setExtraPrompt(event.target.value)}
                rows={4}
                placeholder="给 Agent 的补充说明（可选，支持 Markdown）"
                className="mt-1.5 w-full resize-none rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-caption leading-5 text-slate-700 transition placeholder:text-slate-400 focus:border-sky-300 focus:outline-2 focus:outline-sky-200"
              />
            </label>
            <label className="mt-3 block">
              <span className="text-ui-sm text-slate-500" title="默认跟随桌面端设置。">
                运行时
              </span>
              <select
                value={runtimeId}
                onChange={(event) => setRuntimeId(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-caption text-slate-700 focus:outline-2 focus:outline-sky-200"
              >
                {runtimeId && !runtimes.some((runtime) => runtime.id === runtimeId) ? (
                  <option value={runtimeId}>{runtimeId}</option>
                ) : null}
                {runtimes.map((runtime) => (
                  <option key={runtime.id} value={runtime.id}>
                    {runtime.name}
                  </option>
                ))}
              </select>
            </label>
            {enqueueError ? (
              <p
                className="mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700"
                title="入队失败，表单保留可重试。"
              >
                {enqueueError}
              </p>
            ) : null}
          </>
        ) : null}
      </BottomSheet>
    </div>
  );
}
