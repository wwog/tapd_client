import { useEffect, useRef, useState } from "react";
import { ChevronLeft, LoaderCircle, RotateCcw } from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  api,
  asApiError,
  type AgentTask,
  type AgentTaskStatus,
} from "../lib/api";
import { refreshAgentTasks, useAgentTasks } from "../lib/agentTasks";
import { navigate } from "../lib/router";
import { bugTitle, relativeTime, taskDuration } from "../lib/format";
import { Badge } from "../components/Badge";

const PAGE_SIZE = 20;
/** 历史只有终态任务；进行中的在 Agent 页。 */
const STATUS_OPTIONS: ReadonlyArray<{ value: AgentTaskStatus | "all"; label: string }> = [
  { value: "all", label: "全部" },
  { value: "succeeded", label: AGENT_STATUS_LABELS.succeeded },
  { value: "failed", label: AGENT_STATUS_LABELS.failed },
  { value: "canceled", label: AGENT_STATUS_LABELS.canceled },
];

type Page = { tasks: AgentTask[]; total: number; hasMore: boolean };

/** 执行记录：状态筛选 + 分页（offset/limit），行内可重试。 */
export function AgentHistoryPage() {
  const { state } = useAgentTasks();
  const [statusFilter, setStatusFilter] = useState<AgentTaskStatus | "all">("all");
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    setLoading(true);
    void (async () => {
      try {
        const data = await api.agentHistory({
          status: statusFilter === "all" ? undefined : statusFilter,
          offset: 0,
          limit: PAGE_SIZE,
        });
        if (request !== requestRef.current) return;
        setPage(data);
        setError(null);
      } catch (err) {
        if (request !== requestRef.current) return;
        setError(asApiError(err).message);
        setPage(null);
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    })();
  }, [statusFilter]);

  const loadMore = async () => {
    if (!page || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await api.agentHistory({
        status: statusFilter === "all" ? undefined : statusFilter,
        offset: page.tasks.length,
        limit: PAGE_SIZE,
      });
      setPage({ tasks: [...page.tasks, ...data.tasks], total: data.total, hasMore: data.hasMore });
    } catch (err) {
      setError(asApiError(err).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const retry = async (task: AgentTask) => {
    if (retryBusy) return;
    if (!window.confirm("重试会创建一个新任务并重新排队，确定重试？")) return;
    setRetryBusy(task.id);
    try {
      await api.agentRetry(task.id);
      setRetryError(null);
      await refreshAgentTasks();
      navigate("#/agent");
    } catch (err) {
      setRetryError(asApiError(err).message);
    } finally {
      setRetryBusy(null);
    }
  };

  const back = () => {
    if (window.history.length > 1) window.history.back();
    else navigate("#/agent");
  };

  return (
    <div>
      <header className="sticky top-0 z-20 border-b border-border bg-canvas px-2 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="返回"
            onClick={back}
            className="rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="text-ui-caption text-slate-900">执行记录</span>
        </div>
        <div className="mt-2 flex items-center gap-1.5 px-2 pb-1" role="tablist" aria-label="按状态筛选">
          {STATUS_OPTIONS.map((option) => {
            const active = option.value === statusFilter;
            return (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setStatusFilter(option.value)}
                className={`rounded-lg border px-2.5 py-1 text-ui-sm transition ${
                  active
                    ? "border-sky-200 bg-sky-50 text-sky-700"
                    : "border-border text-slate-500"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </header>

      {error ? (
        <p className="px-4 py-3 text-ui-caption text-rose-600">{error}</p>
      ) : null}
      {retryError ? (
        <p className="px-4 py-3 text-ui-caption text-rose-600" title="上一次重试失败的结果。">
          {retryError}
        </p>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-slate-400">
          <LoaderCircle size={14} className="animate-spin" />
          正在读取记录…
        </div>
      ) : null}

      {!loading && !error && page && page.tasks.length === 0 ? (
        <p className="px-4 py-10 text-center text-ui-base text-slate-400" title="结束的任务会出现在这里。">
          没有执行记录
        </p>
      ) : null}

      {page && page.tasks.length > 0 ? (
        <div className="overflow-hidden" title="删除执行记录请在桌面端操作。">
          {page.tasks.map((task) => {
            const live = state?.tasks.find((item) => item.id === task.id);
            const view = live ?? task;
            return (
              <div key={task.id} className="flex items-stretch border-b border-border">
                <button
                  type="button"
                  onClick={() => navigate(`#/agent/task/${task.id}`)}
                  className="min-w-0 flex-1 px-4 py-3 text-left transition active:bg-overlay-soft"
                >
                  <span className="line-clamp-2 block text-ui-caption text-slate-900" title={bugTitle(task.title)}>
                    {bugTitle(task.title) || "（无标题）"}
                  </span>
                  <span className="mt-1.5 flex items-center gap-2 text-ui-xs text-slate-500">
                    <Badge tone={AGENT_STATUS_TONES[view.status]}>{AGENT_STATUS_LABELS[view.status]}</Badge>
                    <span className="shrink-0" title={`创建 ${relativeTime(task.createdAt)}`}>
                      {taskDuration(task)}
                    </span>
                    {task.finishedAt ? (
                      <span className="ml-auto shrink-0 text-slate-400">
                        {relativeTime(task.finishedAt)}
                      </span>
                    ) : null}
                  </span>
                </button>
                <div className="flex shrink-0 items-center pr-3">
                  <button
                    type="button"
                    aria-label="重试"
                    title="用同样内容创建一个新任务。"
                    disabled={retryBusy !== null}
                    onClick={() => void retry(task)}
                    className="rounded-md p-2 text-slate-400 transition active:bg-overlay-soft disabled:opacity-40"
                  >
                    <RotateCcw size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {page && page.tasks.length > 0 && page.hasMore ? (
        <div className="px-4 py-3">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-50"
          >
            {loadingMore ? "加载中…" : `加载更多（已显示 ${page.tasks.length} / ${page.total}）`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
