import { useState } from "react";
import { ChevronRight, Clock, LoaderCircle, Users, X } from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  api,
  asApiError,
  type AgentTask,
  type AgentTasksState,
} from "../lib/api";
import { bucketAgentTasks, useAgentTasks } from "../lib/agentTasks";
import { t } from "../lib/i18n";
import { navigate } from "../lib/router";
import { bugTitle } from "../lib/format";
import { Badge } from "../components/Badge";
import { MergeCard, ReviewCard } from "../components/AgentTaskCards";

/** 运行中任务卡：标题 + 运行时 + 实时阶段摘要 + 取消。 */
function RunningCard(props: {
  task: AgentTask;
  state: AgentTasksState | null;
  busy: boolean;
  onCancel: (task: AgentTask) => void;
}) {
  const { task, state } = props;
  const runtimeStatus = state?.runtimeStatus?.[task.id];
  const phase = runtimeStatus
    ? `${runtimeStatus.label}${runtimeStatus.tool ? ` · ${runtimeStatus.tool}` : ""}`
    : null;

  return (
    <article className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3
            className="min-w-0 text-ui-caption leading-5 text-slate-900"
            title={bugTitle(task.title) || t("magent.untitled")}
          >
            {bugTitle(task.title) || t("magent.untitled")}
          </h3>
          <p className="mt-0.5 truncate font-mono text-ui-xs text-slate-400" title={task.runtimeId}>
            {task.runtimeId || "—"}
          </p>
        </div>
        <Badge tone={AGENT_STATUS_TONES[task.status]}>
          {t(AGENT_STATUS_LABELS[task.status])}
        </Badge>
      </div>
      {phase ? (
        <p
          className="select-text mt-2 truncate text-ui-sm text-slate-500"
          title={runtimeStatus?.detail || phase}
        >
          {phase}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          disabled={props.busy}
          title={t("magent.cancelHint")}
          onClick={() => props.onCancel(task)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-50"
        >
          <X size={12} />
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={() => navigate(`#/agent/task/${task.id}`)}
          className="ml-auto rounded-md px-2 py-1.5 text-ui-sm text-slate-400 transition active:bg-overlay-soft"
        >
          {t("common.details")}
        </button>
      </div>
    </article>
  );
}

/** Agent 首页：待审核 / 待合并 / 运行中 / 队列，8s 轮询。 */
export function AgentPage() {
  const { state, error: feedError, refresh } = useAgentTasks();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // 手动合并步骤：merge_start 返回 manual 时展示在对应卡片上。
  const [manualMerge, setManualMerge] = useState<{ taskId: string; instructions: string } | null>(
    null,
  );

  const tasks = state?.tasks ?? [];
  const { approvals, merges, running, queued } = bucketAgentTasks(tasks);
  const idle =
    approvals.length === 0 && merges.length === 0 && running.length === 0 && queued.length === 0;

  const act = async (key: string, run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    try {
      await run();
      setActionError(null);
      await refresh();
    } catch (err) {
      setActionError(asApiError(err).message);
    } finally {
      setBusy(null);
    }
  };

  const approve = (task: AgentTask) => void act(`approve:${task.id}`, () => api.agentApprove(task.id));
  const stop = (task: AgentTask) => void act(`stop:${task.id}`, () => api.agentStop(task.id));
  const cancel = (task: AgentTask) => void act(`cancel:${task.id}`, () => api.agentCancel(task.id));
  const mergeStart = (task: AgentTask) =>
    void act(`merge:${task.id}`, async () => {
      const result = await api.agentMergeStart(task.id);
      setManualMerge(
        result.mode === "manual" && result.instructions
          ? { taskId: task.id, instructions: result.instructions }
          : null,
      );
    });

  return (
    <div>
      <header className="sticky top-0 z-20 border-b border-border bg-canvas px-4 pt-3 pb-2">
        <h1 className="text-ui-base text-slate-900">Agent</h1>
      </header>

      <button
        type="button"
        onClick={() => navigate("#/coworkers")}
        className="flex w-full items-center gap-2 border-b border-border px-4 py-3 text-left transition active:bg-overlay-soft"
        title={t("magent.coworkersHint")}
      >
        <Users size={16} className="shrink-0 text-slate-400" />
        <span className="min-w-0 flex-1 text-ui-caption text-slate-900">{t("magent.coworkers")}</span>
        <ChevronRight size={14} className="shrink-0 text-slate-400" />
      </button>

      <button
        type="button"
        onClick={() => navigate("#/agent/history")}
        className="flex w-full items-center gap-2 border-b border-border px-4 py-3 text-left transition active:bg-overlay-soft"
        title={t("magent.historyHint")}
      >
        <Clock size={16} className="shrink-0 text-slate-400" />
        <span className="min-w-0 flex-1 text-ui-caption text-slate-900">{t("magent.history")}</span>
        <ChevronRight size={14} className="shrink-0 text-slate-400" />
      </button>

      {state?.queuePaused ? (
        <p
          className="mx-3 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-ui-sm leading-5 text-amber-800"
          title={t("magent.queuePausedHint")}
        >
          {t("magent.queuePaused")}
        </p>
      ) : null}

      {state?.storageError ? (
        <p
          className="mx-3 mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700"
          title={t("magent.storageHint")}
        >
          {state.storageError}
        </p>
      ) : null}

      {feedError ? (
        <p
          className="mx-3 mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700"
          title={t("magent.refreshFailedHint")}
        >
          {feedError}
        </p>
      ) : null}

      {actionError ? (
        <p
          className="mx-3 mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700"
          title={t("magent.lastActionFailedHint")}
        >
          {actionError}
        </p>
      ) : null}

      {!state && !feedError ? (
        <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-slate-400">
          <LoaderCircle size={14} className="animate-spin" />
          {t("magent.taskLoading")}
        </div>
      ) : null}

      {state && idle ? (
        <p
          className="px-4 py-10 text-center text-ui-base text-slate-400"
          title={t("magent.idleHint")}
        >
          {t("magent.noActiveTasks")}
        </p>
      ) : null}

      {approvals.length > 0 || merges.length > 0 ? (
        <section className="px-3 pt-3">
          <h2 className="px-1 pb-2 text-ui-sm text-slate-500">{t("magent.awaitingAction")}</h2>
          <div className="space-y-3">
            {approvals.map((task) => (
              <ReviewCard
                key={task.id}
                task={task}
                busy={busy !== null}
                onApprove={approve}
                onStop={stop}
                onOpen={() => navigate(`#/agent/task/${task.id}`)}
              />
            ))}
            {merges.map((task) => (
              <MergeCard
                key={task.id}
                task={task}
                busy={busy !== null}
                instructions={
                  manualMerge?.taskId === task.id ? manualMerge.instructions : undefined
                }
                onMergeStart={mergeStart}
                onOpen={() => navigate(`#/agent/task/${task.id}`)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {running.length > 0 ? (
        <section className="px-3 pt-3">
          <h2 className="px-1 pb-2 text-ui-sm text-slate-500">{t("magent.running")}</h2>
          <div className="space-y-3">
            {running.map((task) => (
              <RunningCard
                key={task.id}
                task={task}
                state={state}
                busy={busy !== null}
                onCancel={cancel}
              />
            ))}
          </div>
        </section>
      ) : null}

      {queued.length > 0 ? (
        <section className="px-3 pt-3">
          <h2 className="px-1 pb-2 text-ui-sm text-slate-500">{t("magent.queue")}</h2>
          <div className="overflow-hidden rounded-2xl border border-border bg-surface">
            {queued.map((task, index) => (
              <div key={task.id} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  onClick={() => navigate(`#/agent/task/${task.id}`)}
                  className="flex w-full items-center gap-2 px-4 pt-3 pb-1 text-left transition active:bg-overlay-soft"
                >
                  <span className="w-5 shrink-0 text-center font-mono text-ui-xs text-slate-400">
                    {index + 1}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-ui-caption text-slate-900"
                    title={bugTitle(task.title) || t("magent.untitled")}
                  >
                    {bugTitle(task.title) || t("magent.untitled")}
                  </span>
                  <Badge tone={AGENT_STATUS_TONES.queued}>
                    {t(AGENT_STATUS_LABELS.queued)}
                  </Badge>
                </button>
                <div className="flex justify-end px-4 pb-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    title={t("magent.cancelQueuedHint")}
                    onClick={() => cancel(task)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-ui-xs text-slate-500 transition active:bg-overlay-soft disabled:opacity-50"
                  >
                    <X size={12} />
                    {t("common.cancel")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
