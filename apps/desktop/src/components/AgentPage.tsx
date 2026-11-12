import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Terminal } from "lucide-react";

import {
  agentApi,
  type AgentRuntimeDescriptor,
  type AgentTask,
  type AgentTaskStatus,
} from "../lib/agent";
import {
  acquireAgentTasksStore,
  agentTasksStore,
  useAgentTasksStore,
} from "../lib/agentStore";
import { openTaskExportDir } from "../lib/desktop";
import { AgentApproval } from "./AgentApproval";
import { AgentConfigPane } from "./AgentConfigPane";
import { AgentHistory } from "./AgentHistory";
import { AgentQueuePane } from "./AgentQueuePane";
import { AgentQueuedDetail } from "./AgentQueuedDetail";
import { AgentRunToolbar, type AgentTab } from "./AgentRunToolbar";
import { AgentTaskHeader } from "./AgentTaskHeader";
import { AgentTerminal } from "./AgentTerminal";
import { Button } from "./ui";

const ACTIVE_STATUSES: AgentTaskStatus[] = ["queued", "preparing", "running"];
const isActiveStatus = (status: AgentTaskStatus) => ACTIVE_STATUSES.includes(status);
const isApprovalStatus = (status: AgentTaskStatus) => status === "awaiting_approval";

type Props = {
  /** Task selected by the island capsule (`agent://focus`). */
  focusTaskId: string | null;
  /** Incremented by the title-bar review badge to open the 待审核 tab. */
  focusReviewToken?: number;
  /** Incremented by 设置 → 默认 Agent to open the 配置 tab. */
  focusConfigToken?: number;
  /** Jump to the bug a task belongs to (selects workspace + opens drawer). */
  onOpenBug: (workspaceId: string, bugId: string) => void;
  toast: (kind: "ok" | "error", text: string) => void;
  /** Clears the focus request once applied; it is a command, not state. */
  onFocusConsumed?: () => void;
};

/**
 * Agent workspace: "运行" (live queue: running task with PTY on the right,
 * queued tasks below), "待审核" (complex changes waiting for a commit decision)
 * and "历史" (terminal execution records, logs and bug links).
 */
export function AgentPage({
  focusTaskId,
  focusReviewToken = 0,
  focusConfigToken = 0,
  onOpenBug,
  toast,
  onFocusConsumed,
}: Props) {
  // Shared with App: one `agent://state` subscription and one task snapshot.
  const tasksState = useAgentTasksStore();
  const [tab, setTab] = useState<AgentTab>("run");
  // Task explicitly selected by `agent://focus` or a click in the run queue;
  // cleared when the active task changes so the terminal follows the worker.
  const [explicitTaskId, setExplicitTaskId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  /** Runtime catalog, used to show which agent owns the selected task. */
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);

  const appliedFocusRef = useRef<string | null>(null);
  const focusRefreshRef = useRef<string | null>(null);

  useEffect(() => acquireAgentTasksStore(), []);

  const tasks = tasksState?.tasks ?? [];
  const activeTaskId = tasksState?.activeTaskId ?? null;
  const loaded = tasksState !== null;
  const runTasks = tasks.filter((task) => isActiveStatus(task.status));
  const approvalTasks = tasks.filter((task) => isApprovalStatus(task.status));

  const refresh = useCallback(async () => {
    try {
      agentTasksStore.set(await agentApi.tasksList());
    } catch (error) {
      toast("error", String(error));
    }
  }, [toast]);

  // A focused task stays selected until the queue moves to a different task.
  useEffect(() => {
    setExplicitTaskId(null);
  }, [activeTaskId]);

  // Runtime names are stable; fetch once for the task header.
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

  // Follow the island capsule's focus request. Terminal tasks belong to the
  // history tab; active/queued ones to the run tab.
  useEffect(() => {
    if (!focusTaskId) {
      appliedFocusRef.current = null;
      focusRefreshRef.current = null;
      return;
    }
    if (appliedFocusRef.current === focusTaskId) return;

    const focused = tasksState?.tasks.find((task) => task.id === focusTaskId);
    if (focused) {
      appliedFocusRef.current = focusTaskId;
      if (isApprovalStatus(focused.status)) {
        setTab("approval");
      } else if (isActiveStatus(focused.status)) {
        setExplicitTaskId(focusTaskId);
        setTab("run");
      } else {
        setTab("history");
      }
      onFocusConsumed?.();
      return;
    }

    // The task may not be in the last snapshot yet; refresh once per focus id.
    if (focusRefreshRef.current !== focusTaskId) {
      focusRefreshRef.current = focusTaskId;
      void refresh();
      return;
    }

    // Terminal tasks are not in the live snapshot; the history tab fetches
    // them by id.
    appliedFocusRef.current = focusTaskId;
    setTab("history");
    onFocusConsumed?.();
  }, [focusTaskId, tasksState, refresh, onFocusConsumed]);

  // The title-bar review badge opens the approval queue directly. The token is
  // a one-shot command: leaving it set would drag every later visit back here.
  useEffect(() => {
    if (focusReviewToken <= 0) return;
    setTab("approval");
    onFocusConsumed?.();
  }, [focusReviewToken, onFocusConsumed]);

  // 设置页的「管理全部运行时」直接落到配置子页。
  useEffect(() => {
    if (focusConfigToken <= 0) return;
    setTab("config");
  }, [focusConfigToken]);

  // The queue is strictly FIFO: active work first, then the insertion order in
  // which the Rust worker will pick the rest.
  const activeRunTasks = runTasks.filter((task) => task.status !== "queued");
  const queuedTasks = runTasks.filter((task) => task.status === "queued");
  const queuePosition = (task: AgentTask): number | null => {
    const index = queuedTasks.findIndex((item) => item.id === task.id);
    return index >= 0 ? index + 1 : null;
  };

  // Prefer the active task, then the next queued one. Terminal tasks never
  // leak into the run tab.
  const fallbackId =
    (activeTaskId && runTasks.some((task) => task.id === activeTaskId)
      ? activeTaskId
      : null) ??
    runTasks[0]?.id ??
    null;
  const selectedId =
    (explicitTaskId && runTasks.some((task) => task.id === explicitTaskId)
      ? explicitTaskId
      : null) ?? fallbackId;
  const selectedTask = runTasks.find((task) => task.id === selectedId) ?? null;
  const selectedQueuePosition = selectedTask ? queuePosition(selectedTask) : null;
  /** Human-readable runtime name for a task; falls back to the stored id. */
  const runtimeName = (id?: string) =>
    runtimes.find((runtime) => runtime.id === id)?.name ?? id ?? "Agent";
  /** The PTY is live only while the task is actually running. */
  const live = selectedTask !== null && selectedTask.status === "running";

  const counts = useMemo(() => {
    const queued =
      tasksState?.queuedCount ??
      tasks.filter((task) => task.status === "queued").length;
    const active = tasks.filter(
      (task) => task.status === "preparing" || task.status === "running",
    ).length;
    const awaiting =
      tasksState?.awaitingApprovalCount ??
      tasks.filter((task) => task.status === "awaiting_approval").length;
    return {
      queued,
      active,
      awaiting,
      paused: Boolean(tasksState?.queuePaused),
    };
  }, [tasksState, tasks]);

  const runAction = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      if (actionBusy) return;
      setActionBusy(key);
      try {
        await action();
        // The queue re-renders from the pushed `agent://state` snapshot, so a
        // success toast would only duplicate the visible status change.
        await refresh();
      } catch (error) {
        toast("error", String(error));
      } finally {
        setActionBusy(null);
      }
    },
    [actionBusy, refresh, toast],
  );

  const handleApprove = async (task: AgentTask) => {
    if (actionBusy) return;
    setActionBusy(`approve:${task.id}`);
    try {
      await agentApi.approveReview(task.id);
      // The approved task re-enters the queue; show it running again.
      setExplicitTaskId(task.id);
      setTab("run");
      await refresh();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setActionBusy(null);
    }
  };

  const handleStopReview = async (task: AgentTask) => {
    if (actionBusy) return;
    setActionBusy(`stop:${task.id}`);
    try {
      const { task: stopped } = await agentApi.stopReview(task.id);
      // The stash ref is only visible in history otherwise; keep it in reach.
      toast("ok", stopped.error ?? "已停止并储藏改动");
      await refresh();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setActionBusy(null);
    }
  };

  const handleResumeQueue = () =>
    runAction("queue:resume", () => agentApi.resumeQueue());

  const canCancel = selectedTask !== null && ACTIVE_STATUSES.includes(selectedTask.status);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 pt-2.5">
      <AgentRunToolbar
        tab={tab}
        onTabChange={setTab}
        counts={counts}
        actionBusy={actionBusy}
        onResumeQueue={handleResumeQueue}
        onRefresh={() => void refresh()}
      />

      {tasksState?.storageError ? (
        <div
          role="alert"
          title="任务变更会保留在内存中并在下次写入时重试，但重启前可能丢失。"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-ui-sm text-rose-700"
        >
          {tasksState.storageError}
        </div>
      ) : null}

      {tab === "config" ? (
        <AgentConfigPane toast={toast} />
      ) : tab === "history" ? (
        <AgentHistory
          revision={`${counts.active}:${counts.queued}:${counts.awaiting}`}
          focusTaskId={focusTaskId}
          onOpenBug={onOpenBug}
          onQueued={(taskId) => {
            setExplicitTaskId(taskId);
            setTab("run");
          }}
          toast={toast}
        />
      ) : tab === "approval" ? (
        <AgentApproval
          tasks={approvalTasks}
          busy={actionBusy}
          queuePaused={counts.paused}
          onApprove={handleApprove}
          onStop={handleStopReview}
          onResumeQueue={handleResumeQueue}
          onOpenBug={onOpenBug}
          onOpenExportDir={(task) => openTaskExportDir(task, toast)}
        />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          <AgentQueuePane
            loaded={loaded}
            runTasks={runTasks}
            activeRunTasks={activeRunTasks}
            queuedTasks={queuedTasks}
            selectedId={selectedId}
            queuePosition={queuePosition}
            runtimeStatus={tasksState?.runtimeStatus}
            onSelect={setExplicitTaskId}
          />

          {/* Right: PTY terminal for the running task, queue card otherwise. */}
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface ">
            {!selectedTask ? (
              <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">
                <div className="max-w-md">
                  <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400">
                    <Bot size={22} />
                  </div>
                  <h3
                    className="mt-3 text-ui-base text-slate-800"
                    title="在缺陷详情点击「用 Agent 修复」后，任务会出现在这里；已结束的任务在「历史」里可以打开系统终端继续处理。"
                  >
                    当前没有运行中的任务
                  </h3>
                  {counts.awaiting > 0 ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-3"
                      onClick={() => setTab("approval")}
                    >
                      有 {counts.awaiting} 个改动待审核
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : selectedTask.status === "queued" ? (
              <AgentQueuedDetail
                task={selectedTask}
                runtimeName={runtimeName(selectedTask.runtimeId)}
                position={selectedQueuePosition ?? 1}
                queuePaused={counts.paused}
                busy={actionBusy}
                onCancel={() =>
                  void runAction(`cancel:${selectedTask.id}`, () =>
                    agentApi.cancel(selectedTask.id),
                  )
                }
                onOpenBug={() => onOpenBug(selectedTask.workspaceId, selectedTask.bugId)}
              />
            ) : (
              <>
                <AgentTaskHeader
                  task={selectedTask}
                  runtimeName={runtimeName(selectedTask.runtimeId)}
                  runtimeStatus={tasksState?.runtimeStatus?.[selectedTask.id]}
                  canCancel={canCancel}
                  actionBusy={actionBusy}
                  live={live}
                  onCancel={() =>
                    void runAction(`cancel:${selectedTask.id}`, () =>
                      agentApi.cancel(selectedTask.id),
                    )
                  }
                  onOpenExportDir={() => openTaskExportDir(selectedTask, toast)}
                  onOpenBug={() =>
                    onOpenBug(selectedTask.workspaceId, selectedTask.bugId)
                  }
                />

                {selectedTask.error ? (
                  <div className="shrink-0 break-all border-b border-rose-100 bg-rose-50 px-3.5 py-1.5 text-ui-sm leading-5 text-rose-700">
                    {selectedTask.error}
                  </div>
                ) : null}

                {live ? (
                  <div className="min-h-0 flex-1 bg-zinc-950 p-1.5">
                    <AgentTerminal
                      key={selectedTask.id}
                      taskId={selectedTask.id}
                      interactive={live}
                      className="h-full w-full"
                    />
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-slate-50/70 p-6 text-center">
                    <div className="grid h-12 w-12 place-items-center theme-static-dark rounded-2xl bg-slate-900 text-sky-300">
                      <Terminal size={22} />
                    </div>
                    <div>
                      <p
                        className="text-ui-base text-slate-700"
                        title="任务开始后，opencode TUI 会直接显示在这里，可以像命令行一样操作。"
                      >
                        任务尚未开始
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
