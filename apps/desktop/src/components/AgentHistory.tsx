import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  Bug,
  FolderOpen,
  Loader2,
  RotateCcw,
  Search,
  Terminal,
} from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  agentApi,
  type AgentRuntimeDescriptor,
  type AgentTask,
  type AgentTaskStatus,
  type AgentWorkspaceRef,
} from "../lib/agent";
import { relativeTime } from "../lib/api";
import { bugTitle } from "../lib/bug";
import { openTaskExportDir } from "../lib/desktop";
import { Badge, Button, selectClass } from "./ui";

// History only contains terminal tasks; active ones live in the run tab.
const STATUS_OPTIONS: AgentTaskStatus[] = ["succeeded", "failed", "canceled"];
const PAGE_SIZE = 50;

type Props = {
  /** Changes when a task leaves the live queue, so the first page refreshes. */
  revision?: string;
  /** History row selected by the island capsule / enqueue flow. */
  focusTaskId?: string | null;
  onOpenBug: (workspaceId: string, bugId: string) => void;
  /** Called after a retry so the parent can focus the task in the run tab. */
  onQueued?: (taskId: string) => void;
  toast: (kind: "ok" | "error", text: string) => void;
};

/** Execution records: server-filtered, paginated newest-first list plus detail. */
export function AgentHistory({
  revision,
  focusTaskId,
  onOpenBug,
  onQueued,
  toast,
}: Props) {
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | AgentTaskStatus>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [workspaces, setWorkspaces] = useState<AgentWorkspaceRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [terminalBusy, setTerminalBusy] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);
  const appliedFocusRef = useRef<string | null>(null);
  const requestRef = useRef(0);

  // Debounce the keyword so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Runtime names for the detail pane; the catalog is static for the session.
  useEffect(() => {
    let cancelled = false;
    void agentApi
      .runtimes()
      .then((result) => {
        if (!cancelled) setRuntimes(result.runtimes);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchPage = useCallback(
    async (offset: number, focus?: string | null) => {
      const request = ++requestRef.current;
      if (offset === 0) {
        setLoading(true);
        setLoadingMore(false);
      } else {
        setLoadingMore(true);
      }
      try {
        const page = await agentApi.tasksHistory({
          workspaceId: workspaceFilter === "all" ? undefined : workspaceFilter,
          status: statusFilter === "all" ? undefined : statusFilter,
          keyword: debouncedQuery || undefined,
          taskId: focus || undefined,
          offset,
          limit: PAGE_SIZE,
        });
        if (request !== requestRef.current) return;
        setTasks((current) => (offset === 0 ? page.tasks : [...current, ...page.tasks]));
        setTotal(page.total);
        setHasMore(page.hasMore);
        setWorkspaces(page.workspaces);
        if (focus) setSelectedId(focus);
      } catch (error) {
        if (request === requestRef.current) toast("error", String(error));
      } finally {
        if (request === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [workspaceFilter, statusFilter, debouncedQuery, toast],
  );

  // First page on mount, filter change and whenever a task leaves the queue.
  useEffect(() => {
    void fetchPage(0);
  }, [fetchPage, revision]);

  // Keep a sensible selection as pages load or filters change.
  useEffect(() => {
    setSelectedId((current) => {
      if (current && tasks.some((task) => task.id === current)) return current;
      return tasks[0]?.id ?? null;
    });
  }, [tasks]);

  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  // A focus request from the island/enqueue flow wins over the current page.
  useEffect(() => {
    if (!focusTaskId || appliedFocusRef.current === focusTaskId) return;
    appliedFocusRef.current = focusTaskId;
    if (tasks.some((task) => task.id === focusTaskId)) {
      setSelectedId(focusTaskId);
      return;
    }
    void fetchPage(0, focusTaskId);
  }, [focusTaskId, tasks, fetchPage]);

  const runtimeName = (id?: string) =>
    runtimes.find((runtime) => runtime.id === id)?.name ?? id ?? "—";

  const retry = async (task: AgentTask) => {
    setRetryBusy(task.id);
    try {
      const { task: queued } = await agentApi.retry(task.id);
      // Jump to the run tab with the new task selected: that is the result,
      // and it is more useful than a toast saying where the task went.
      onQueued?.(queued.id);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setRetryBusy(null);
    }
  };

  /**
   * Hands the task over to a system terminal that resumes the agent session in
   * its repository. No success toast: the terminal window coming to the front
   * is the feedback.
   */
  const openTerminal = async (task: AgentTask) => {
    setTerminalBusy(task.id);
    try {
      await agentApi.openTerminal(task.id);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setTerminalBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <select
          value={workspaceFilter}
          onChange={(event) => setWorkspaceFilter(event.target.value)}
          className={selectClass}
          aria-label="按工作区筛选"
        >
          <option value="all">全部工作区</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(event) =>
            setStatusFilter(event.target.value as "all" | AgentTaskStatus)
          }
          className={selectClass}
          aria-label="按状态筛选"
        >
          <option value="all">全部状态</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {AGENT_STATUS_LABELS[status]}
            </option>
          ))}
        </select>

        <label className="relative min-w-[180px] flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题或缺陷 ID"
            className="w-full rounded-lg border border-border bg-surface py-1.5 pl-8 pr-2.5 text-ui-caption text-slate-700 transition placeholder:text-slate-300 focus:border-sky-300 focus:outline-2 focus:outline-sky-200"
          />
        </label>

        <span className="shrink-0 text-ui-sm text-slate-400">{total} 条记录</span>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="w-[300px] shrink-0 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 ">
          {tasks.length === 0 ? (
            <div className="grid place-items-center px-3 py-8 text-center text-ui-caption text-slate-400">
              {loading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin" />
                  加载中…
                </span>
              ) : (
                "没有匹配的执行记录"
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {tasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => setSelectedId(task.id)}
                  className={clsx(
                    "w-full rounded-lg px-2.5 py-2 text-left transition",
                    task.id === selectedId
                      ? "bg-sky-50 border border-sky-200"
                      : "hover:bg-slate-50",
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <Badge tone={AGENT_STATUS_TONES[task.status]} dot>
                      {AGENT_STATUS_LABELS[task.status]}
                    </Badge>
                    <span className="ml-auto shrink-0 text-ui-xs text-slate-400">
                      {relativeTime(task.createdAt)}
                    </span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-ui-caption font-normal leading-4 text-slate-700">
                    {bugTitle(task.title) || "（无标题）"}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-ui-xs text-slate-400">
                    {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
                  </div>
                </button>
              ))}
              {hasMore ? (
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void fetchPage(tasks.length)}
                  className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-caption text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
                >
                  {loadingMore ? <Loader2 size={12} className="animate-spin" /> : null}
                  加载更多（已显示 {tasks.length} / {total}）
                </button>
              ) : null}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-surface ">
          {!selected ? (
            <div className="grid h-full place-items-center px-6 py-10 text-center text-ui-caption text-slate-400">
              选择左侧记录查看详情
            </div>
          ) : (
            <div className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 flex-1 truncate text-ui-base font-normal text-slate-900">
                  {bugTitle(selected.title) || "（无标题）"}
                </h2>
                <Badge tone={AGENT_STATUS_TONES[selected.status]}>
                  {AGENT_STATUS_LABELS[selected.status]}
                </Badge>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Bug size={12} />}
                  onClick={() => onOpenBug(selected.workspaceId, selected.bugId)}
                >
                  打开缺陷
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<FolderOpen size={12} />}
                  disabled={!selected.mdPath}
                  onClick={() => openTaskExportDir(selected, toast)}
                >
                  打开导出目录
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Terminal size={12} />}
                  disabled={!selected.repoPath || terminalBusy === selected.id}
                  onClick={() => void openTerminal(selected)}
                >
                  打开系统终端
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={
                    retryBusy === selected.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RotateCcw size={12} />
                    )
                  }
                  disabled={retryBusy !== null}
                  onClick={() => void retry(selected)}
                >
                  重试
                </Button>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-ui-sm sm:grid-cols-3">
                <Meta label="工作区" value={selected.workspaceName || selected.workspaceId} />
                <Meta label="缺陷 ID" value={selected.bugId} mono />
                <Meta label="来源" value={selected.source || "—"} />
                <Meta label="Agent" value={runtimeName(selected.runtimeId)} />
                <Meta label="创建时间" value={relativeTime(selected.createdAt)} title={selected.createdAt} />
                <Meta
                  label="开始时间"
                  value={selected.startedAt ? relativeTime(selected.startedAt) : "—"}
                  title={selected.startedAt}
                />
                <Meta
                  label="结束时间"
                  value={selected.finishedAt ? relativeTime(selected.finishedAt) : "—"}
                  title={selected.finishedAt}
                />
                <Meta
                  label="退出码"
                  value={selected.exitCode !== undefined ? String(selected.exitCode) : "—"}
                  mono
                />
                <Meta label="仓库" value={selected.repoPath || "未配置仓库"} mono wide />
              </dl>

              {selected.error ? (
                <div className="select-text mt-3 break-all rounded-lg bg-rose-50 px-2.5 py-2 text-ui-sm leading-5 text-rose-700 border border-rose-100">
                  <div className="mb-0.5 font-normal">错误</div>
                  {selected.error}
                </div>
              ) : null}

              <details className="mt-3 rounded-lg border border-slate-100 bg-slate-50/60">
                <summary className="cursor-pointer select-none px-2.5 py-1.5 text-ui-sm font-normal text-slate-600">
                  提示词
                </summary>
                <pre className="select-text max-h-64 overflow-auto whitespace-pre-wrap break-words px-2.5 pb-2.5 font-mono text-ui-sm leading-5 text-slate-600">
                  {selected.prompt || "（空）"}
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

function Meta(props: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
  title?: string;
}) {
  return (
    <div className={clsx("min-w-0", props.wide && "col-span-2 sm:col-span-3")}>
      <dt className="text-ui-xs text-slate-400">
        {props.label}
      </dt>
      <dd
        title={props.title}
        className={clsx(
          "truncate text-slate-700",
          props.mono && "font-mono text-ui-xs",
        )}
      >
        {props.value}
      </dd>
    </div>
  );
}
