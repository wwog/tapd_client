import { useEffect, useState } from "react";
import { ChevronLeft, LoaderCircle, RotateCcw, X } from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  api,
  asApiError,
  isAgentInFlight,
  type AgentTask,
} from "../lib/api";
import { getAgentTasks, refreshAgentTasks, useAgentTasks } from "../lib/agentTasks";
import { t } from "../lib/i18n";
import { navigate } from "../lib/router";
import { absoluteTime, bugTitle, taskDuration } from "../lib/format";
import { Badge } from "../components/Badge";
import { MergeCard, ReviewCard } from "../components/AgentTaskCards";

/** Single page cap when paging through history to locate one record. */
const PAGE_SIZE = 20;
const MAX_OFFSET = 400;

function MetaRow(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-b-0">
      <span className="shrink-0 text-ui-xs text-slate-500">{props.label}</span>
      <span className="min-w-0 truncate text-right text-ui-caption text-slate-700">
        {props.children}
      </span>
    </div>
  );
}

/**
 * 任务详情：实时任务优先，不在实时列表的（历史记录）先按 taskId 过滤查询，
 * 后端不支持时退回逐页查找。不做终端输出回放（桌面同样没有）。
 */
export function AgentTaskPage(props: { id: string }) {
  const { id } = props;
  const { state, error: feedError } = useAgentTasks();
  // undefined = still resolving; null = not found anywhere.
  const [resolved, setResolved] = useState<AgentTask | null | undefined>(undefined);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [manualMerge, setManualMerge] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResolved(undefined);
    setResolveError(null);
    setManualMerge(null);
    void (async () => {
      // 1) Already live in the tasks feed.
      const inFeed = getAgentTasks()?.tasks.find((task) => task.id === id) ?? null;
      if (inFeed) {
        setResolved(inFeed);
        return;
      }
      // 2) History filtered by taskId (works when the backend supports it).
      try {
        const direct = await api.agentHistory({ taskId: id, limit: 1 });
        const hit = direct.tasks.find((task) => task.id === id);
        if (hit) {
          if (!cancelled) setResolved(hit);
          return;
        }
      } catch {
        // Fall through to paging.
      }
      // 3) Page through history until found (bounded).
      try {
        for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE_SIZE) {
          const page = await api.agentHistory({ offset, limit: PAGE_SIZE });
          const hit = page.tasks.find((task) => task.id === id);
          if (hit) {
            if (!cancelled) setResolved(hit);
            return;
          }
          if (!page.hasMore) break;
        }
        if (!cancelled) setResolved(null);
      } catch (err) {
        if (!cancelled) {
          setResolveError(asApiError(err).message);
          setResolved(undefined);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const back = () => {
    if (window.history.length > 1) window.history.back();
    else navigate("#/agent");
  };

  const act = async (run: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    try {
      await run();
      setActionError(null);
      await refreshAgentTasks();
      after?.();
    } catch (err) {
      setActionError(asApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const approve = () => void act(() => api.agentApprove(id));
  const stop = () => void act(() => api.agentStop(id));
  const cancel = () => void act(() => api.agentCancel(id));
  const retry = () =>
    void act(() => api.agentRetry(id), () => navigate("#/agent"));
  const mergeStart = () =>
    void act(async () => {
      const result = await api.agentMergeStart(id);
      setManualMerge(result.mode === "manual" ? (result.instructions ?? null) : null);
    });

  // The live copy wins once the poll brings this task back (post-action).
  const task = state?.tasks.find((item) => item.id === id) ?? resolved;

  return (
    <div>
      <header className="sticky top-0 z-20 flex items-center gap-1.5 border-b border-border bg-canvas px-2 py-2">
        <button
          type="button"
          aria-label={t("mobile.nav.back")}
          onClick={back}
          className="rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-500">
          {t("magent.taskDetail")}
        </span>
        {task && !isAgentInFlight(task) ? (
          <button
            type="button"
            aria-label={t("common.retry")}
            title={t("magent.retryHint")}
            disabled={busy}
            onClick={retry}
            className="shrink-0 rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft disabled:opacity-40"
          >
            <RotateCcw size={16} />
          </button>
        ) : null}
      </header>

      {feedError || resolveError ? (
        <p className="px-4 py-3 text-ui-caption text-rose-600">{resolveError ?? feedError}</p>
      ) : null}

      {actionError ? (
        <p className="px-4 py-3 text-ui-caption text-rose-600" title={t("magent.lastActionFailed")}>
          {actionError}
        </p>
      ) : null}

      {task === undefined && !resolveError ? (
        <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-slate-400">
          <LoaderCircle size={14} className="animate-spin" />
          {t("magent.taskLoading")}
        </div>
      ) : null}

      {task === null ? (
        <p
          className="px-4 py-10 text-center text-ui-base text-slate-400"
          title={t("magent.taskDeletedHint")}
        >
          {t("magent.taskNotFound")}
        </p>
      ) : null}

      {task ? (
        <div className="pb-6">
          <h1 className="px-4 pt-3 text-ui-base leading-6 text-slate-900" title={bugTitle(task.title)}>
            {bugTitle(task.title) || t("magent.untitled")}
          </h1>

          {task.status === "awaiting_approval" ? (
            <section className="px-3 pt-3">
              <ReviewCard task={task} busy={busy} onApprove={approve} onStop={stop} />
            </section>
          ) : null}

          {task.status === "awaiting_merge" ? (
            <section className="px-3 pt-3">
              <MergeCard
                task={task}
                busy={busy}
                instructions={manualMerge ?? undefined}
                onMergeStart={mergeStart}
              />
            </section>
          ) : null}

          <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface px-4 py-1">
            <MetaRow label={t("common.status")}>
              <Badge tone={AGENT_STATUS_TONES[task.status]}>
                {t(AGENT_STATUS_LABELS[task.status])}
              </Badge>
            </MetaRow>
            <MetaRow label={t("common.bugs")}>
              <button
                type="button"
                onClick={() =>
                  navigate(`#/bug/${task.bugId}?w=${encodeURIComponent(task.workspaceId)}`)
                }
                className="text-sky-700 underline-offset-2 active:underline"
              >
                #{task.bugId.slice(-7)}
              </button>
            </MetaRow>
            <MetaRow label={t("common.projects")}>{task.workspaceName || task.workspaceId}</MetaRow>
            <MetaRow label={t("magent.repo")}>
              <span className="font-mono">
                {task.worktreePath || task.repoPath || t("magent.noRepo")}
              </span>
            </MetaRow>
            {task.worktreeBranch ? (
              <MetaRow label={t("magent.branch")}>
                <span className="font-mono">{task.worktreeBranch}</span>
              </MetaRow>
            ) : null}
            <MetaRow label={t("magent.runtime")}>
              <span className="font-mono">{task.runtimeId || "—"}</span>
            </MetaRow>
            <MetaRow label={t("magent.source")}>{task.source || "—"}</MetaRow>
            <MetaRow label={t("magent.created")}>{absoluteTime(task.createdAt)}</MetaRow>
            {task.startedAt ? (
              <MetaRow label={t("magent.started")}>{absoluteTime(task.startedAt)}</MetaRow>
            ) : null}
            {task.finishedAt ? (
              <MetaRow label={t("magent.finished")}>{absoluteTime(task.finishedAt)}</MetaRow>
            ) : null}
            <MetaRow label={t("magent.duration")}>{taskDuration(task)}</MetaRow>
          </section>

          {task.error ? (
            <p className="select-text mx-3 mt-3 break-words rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700">
              {t("magent.error", { error: task.error })}
            </p>
          ) : null}

          {isAgentInFlight(task) && task.status !== "awaiting_approval" ? (
            <div className="mx-3 mt-3">
              <button
                type="button"
                disabled={busy}
                title={t("magent.cancelHintDetail")}
                onClick={cancel}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-50"
              >
                <X size={13} />
                {t("magent.cancelTask")}
              </button>
            </div>
          ) : null}

          {!isAgentInFlight(task) ? (
            <div className="mx-3 mt-3">
              <button
                type="button"
                disabled={busy}
                title={t("magent.retryNote")}
                onClick={retry}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-50"
              >
                <RotateCcw size={13} />
                {t("common.retry")}
              </button>
            </div>
          ) : null}

          {task.prompt ? (
            <details className="mx-3 mt-3 rounded-lg border border-border bg-surface">
              <summary className="cursor-pointer select-none px-3 py-2 text-ui-sm text-slate-500">
                {t("magent.prompt")}
              </summary>
              <pre className="select-text max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-ui-xs leading-5 text-slate-600">
                {task.prompt}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
