import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Terminal } from "lucide-react";

import {
  agentApi,
  isAgentApprovalStatus,
  supportsAgentChat,
  type AgentRuntimeDescriptor,
  type AgentTask,
  type AgentTaskStatus,
} from "../lib/agent";
import {
  acquireAgentTasksStore,
  agentTasksStore,
  useAgentTasksStore,
} from "../lib/agentStore";
import { useAgentChat } from "../hooks/useAgentChat";
import { openTaskExportDir } from "../lib/desktop";
import { t } from "../lib/i18n";
import { AgentApproval, type ManualMerge } from "./AgentApproval";
import { AgentChatPane } from "./AgentChatPane";
import { AgentConfigPane } from "./AgentConfigPane";
import { AgentHistory } from "./AgentHistory";
import { AgentQueuePane, QUEUE_PANE_WIDTH } from "./AgentQueuePane";
import { AgentQueuedDetail } from "./AgentQueuedDetail";
import { AgentRunToolbar, type AgentTab } from "./AgentRunToolbar";
import { AgentTaskHeader, type AgentChatView } from "./AgentTaskHeader";
import { AgentTerminal } from "./AgentTerminal";
import { Button } from "./ui";

const ACTIVE_STATUSES: AgentTaskStatus[] = ["queued", "preparing", "running", "merging"];
const isActiveStatus = (status: AgentTaskStatus) => ACTIVE_STATUSES.includes(status);
const isApprovalStatus = (status: AgentTaskStatus) => isAgentApprovalStatus(status);

/** Tabs whose left column is a list that can collapse into the detail pane. */
const LIST_TABS = ["run", "approval", "history"] as const;
type ListTab = (typeof LIST_TABS)[number];
const isListTab = (tab: AgentTab): tab is ListTab =>
  (LIST_TABS as readonly AgentTab[]).includes(tab);

/** Gap between the list column and the detail section. */
const LIST_PANE_GAP = 12;
/**
 * Detail width each tab still reads well at. Narrower than this and the list
 * column auto-collapses: the TUI needs room for the task header, the review
 * card and record detail just need their buttons and meta grid to wrap sanely.
 */
const DETAIL_MIN_WIDTH: Record<ListTab, number> = {
  run: 560,
  approval: 480,
  history: 480,
};
const autoCollapseWidth = (tab: ListTab) =>
  QUEUE_PANE_WIDTH + LIST_PANE_GAP + DETAIL_MIN_WIDTH[tab];

type Props = {
  /** Task selected by the island capsule (`agent://focus`). */
  focusTaskId: string | null;
  /** Incremented by the title-bar badge to open the 待处理 tab. */
  focusReviewToken?: number;
  /** Jump to the bug a task belongs to (selects workspace + opens drawer). */
  onOpenBug: (workspaceId: string, bugId: string) => void;
  toast: (kind: "ok" | "error", text: string) => void;
  /** Clears the focus request once applied; it is a command, not state. */
  onFocusConsumed?: () => void;
};

/**
 * Agent workspace: "运行" (live queue: running task with PTY on the right,
 * queued tasks below), "待处理" (changes waiting for a review decision and
 * approved worktree branches waiting for the merge decision) and "历史"
 * (terminal execution records, logs and bug links).
 */
export function AgentPage({
  focusTaskId,
  focusReviewToken = 0,
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
  /** 每个任务显式选择的右侧视图；未选择时按运行时自动决定。 */
  const [viewChoice, setViewChoice] = useState<Record<string, AgentChatView>>({});
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  /** Manual steps returned by 用原 Agent 合并 when the agent cannot merge. */
  const [manualMerge, setManualMerge] = useState<ManualMerge | null>(null);
  /** One-shot selection for the 待处理 tab (e.g. just entered AwaitingMerge). */
  const [approvalFocusId, setApprovalFocusId] = useState<string | null>(null);
  /** Worktree task approved with a pending commit; prompt merge when it lands. */
  const [mergeWatchId, setMergeWatchId] = useState<string | null>(null);
  /** Runtime catalog, used to show which agent owns the selected task. */
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);
  /** List tab -> its left column is collapsed to give the detail its width. */
  const [listCollapsed, setListCollapsed] = useState<Record<ListTab, boolean>>({
    run: false,
    approval: false,
    history: false,
  });
  /** Width of the mounted list split (not the viewport), measured. */
  const [listAreaWidth, setListAreaWidth] = useState<number | null>(null);
  const listAreaRef = useRef<HTMLDivElement | null>(null);
  /** Latched narrow flag per tab; widening never re-expands the list. */
  const listNarrowRef = useRef<Record<ListTab, boolean>>({
    run: false,
    approval: false,
    history: false,
  });

  const appliedFocusRef = useRef<string | null>(null);
  const focusRefreshRef = useRef<string | null>(null);

  useEffect(() => acquireAgentTasksStore(), []);

  const tasks = tasksState?.tasks ?? [];
  const activeTaskId = tasksState?.activeTaskId ?? null;
  const loaded = tasksState !== null;
  const runTasks = tasks.filter((task) => isActiveStatus(task.status));
  const approvalTasks = tasks.filter((task) => isApprovalStatus(task.status));

  // A worktree task approved with uncommitted changes first re-enters the
  // queue to commit. As soon as that commit round lands in AwaitingMerge,
  // bring the user straight to the merge confirmation instead of leaving them
  // on the run tab.
  useEffect(() => {
    if (!mergeWatchId) return;
    const watched = tasks.find((task) => task.id === mergeWatchId);
    if (!watched) return;
    if (watched.status === "awaiting_merge") {
      setMergeWatchId(null);
      setApprovalFocusId(watched.id);
      setTab("approval");
    } else if (watched.status === "failed") {
      setMergeWatchId(null);
      toast("error", watched.error ?? t("agent.merge.commitFailed"));
    } else if (
      watched.status === "succeeded" ||
      watched.status === "canceled"
    ) {
      setMergeWatchId(null);
    }
  }, [tasks, mergeWatchId, toast]);

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

  // Measure the list split rather than the viewport: the detail drawer and the
  // project column both take width away from this page. Only one list tab is
  // mounted at a time, so one ref and one observer cover all three.
  useEffect(() => {
    const node = listAreaRef.current;
    setListAreaWidth(null);
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number" && width > 0) setListAreaWidth(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [tab]);

  // Collapsing is one-way per tab: crossing into a narrow area hides the list,
  // but widening the window leaves the user's expanded choice alone.
  useEffect(() => {
    if (!isListTab(tab) || listAreaWidth === null) return;
    const narrow = listAreaWidth < autoCollapseWidth(tab);
    if (narrow && !listNarrowRef.current[tab]) {
      setListCollapsed((current) =>
        current[tab] ? current : { ...current, [tab]: true },
      );
    }
    listNarrowRef.current[tab] = narrow;
  }, [tab, listAreaWidth]);

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
  /** The PTY is live while the task is running or merging. */
  const live =
    selectedTask !== null &&
    (selectedTask.status === "running" || selectedTask.status === "merging");
  const chatSupported = supportsAgentChat(selectedTask?.runtimeId);
  const selectedRuntime = selectedTask
    ? runtimes.find((runtime) => runtime.id === selectedTask.runtimeId)
    : undefined;
  const selectedPermission = selectedRuntime?.permissions.find(
    (permission) => permission.id === (selectedTask?.permissionMode || "default"),
  );
  // 默认：支持对话且正在运行时看对话，否则终端；用户手动选择优先。
  const view: AgentChatView = selectedTask
    ? (viewChoice[selectedTask.id] ??
      (chatSupported && live ? "chat" : "terminal"))
    : "terminal";
  // 只有真正跑起来的任务才有 transcript；排队/准备阶段不探测会话文件。
  const chat = useAgentChat(live ? selectedTask?.id ?? null : null, live && chatSupported);
  const currentModel =
    selectedTask?.model ||
    chat.data?.model ||
    (selectedTask ? tasksState?.runtimeStatus?.[selectedTask.id]?.model : undefined) ||
    undefined;

  const counts = useMemo(() => {
    const queued =
      tasksState?.queuedCount ??
      tasks.filter((task) => task.status === "queued").length;
    const active = tasks.filter(
      (task) =>
        task.status === "preparing" ||
        task.status === "running" ||
        task.status === "merging",
    ).length;
    // 审核与合并都算「待处理」；后端计数已包含两者各自的合计。
    const awaitingApproval =
      tasksState?.awaitingApprovalCount ??
      tasks.filter((task) => task.status === "awaiting_approval").length;
    const awaitingMerge =
      tasksState?.awaitingMergeCount ??
      tasks.filter((task) => task.status === "awaiting_merge").length;
    return {
      queued,
      active,
      awaiting: awaitingApproval + awaitingMerge,
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
      const { task: approved } = await agentApi.approveReview(task.id);
      if (approved.status === "awaiting_merge") {
        // Committed worktree task: the next step is the merge confirmation.
        setManualMerge(null);
        setApprovalFocusId(approved.id);
        setTab("approval");
      } else {
        // A worktree task with uncommitted changes commits first; switch to
        // the merge tab automatically when that round completes.
        if (task.worktreeBranch) setMergeWatchId(task.id);
        setExplicitTaskId(task.id);
        setTab("run");
      }
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
      toast("ok", stopped.error ?? t("agent.review.stoppedStashed"));
      await refresh();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setActionBusy(null);
    }
  };

  const handleResumeQueue = () =>
    runAction("queue:resume", () => agentApi.resumeQueue());

  const handleMergeStart = async (task: AgentTask) => {
    if (actionBusy) return;
    setActionBusy(`merge:${task.id}`);
    try {
      const result = await agentApi.mergeStart(task.id);
      if (result.mode === "manual") {
        // Keep the user on the merge card: the agent cannot merge, so show
        // the steps it would have run instead of pretending work started.
        setManualMerge({
          taskId: task.id,
          instructions:
            result.instructions ?? result.task.merge?.instructions ?? "",
        });
        await refresh();
        return;
      }
      // The merge agent owns the task now; follow it in the run tab.
      setManualMerge(null);
      setExplicitTaskId(task.id);
      setTab("run");
      await refresh();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setActionBusy(null);
    }
  };

  const handleMergeVerify = async (task: AgentTask) => {
    if (actionBusy) return;
    setActionBusy(`verify:${task.id}`);
    try {
      await agentApi.mergeVerify(task.id);
      setManualMerge(null);
      await refresh();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setActionBusy(null);
    }
  };

  const handleCancelMerge = async (task: AgentTask) => {
    if (actionBusy) return;
    setActionBusy(`merge-cancel:${task.id}`);
    try {
      await agentApi.cancel(task.id);
      setManualMerge(null);
      await refresh();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setActionBusy(null);
    }
  };

  const canCancel = selectedTask !== null && ACTIVE_STATUSES.includes(selectedTask.status);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 pt-2.5">
      <AgentRunToolbar
        tab={tab}
        onTabChange={setTab}
        counts={counts}
        actionBusy={actionBusy}
        listCollapsed={isListTab(tab) ? listCollapsed[tab] : false}
        onToggleList={() => {
          if (!isListTab(tab)) return;
          setListCollapsed((current) => ({ ...current, [tab]: !current[tab] }));
        }}
        onResumeQueue={handleResumeQueue}
        onRefresh={() => void refresh()}
      />

      {tasksState?.storageError ? (
        <div
          role="alert"
          title={t("agent.storage.warning")}
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
          areaRef={listAreaRef}
          listCollapsed={listCollapsed.history}
        />
      ) : tab === "approval" ? (
        <AgentApproval
          tasks={approvalTasks}
          busy={actionBusy}
          queuePaused={counts.paused}
          manualMerge={manualMerge}
          onApprove={handleApprove}
          onStop={handleStopReview}
          onMergeStart={handleMergeStart}
          onMergeVerify={handleMergeVerify}
          onCancelMerge={handleCancelMerge}
          onResumeQueue={handleResumeQueue}
          onOpenBug={onOpenBug}
          onOpenExportDir={(task) => openTaskExportDir(task, toast)}
          focusTaskId={approvalFocusId}
          onFocusConsumed={() => setApprovalFocusId(null)}
          areaRef={listAreaRef}
          listCollapsed={listCollapsed.approval}
        />
      ) : (
        <div ref={listAreaRef} className="flex min-h-0 flex-1 gap-3">
          {listCollapsed.run ? null : (
            <AgentQueuePane
              loaded={loaded}
              runTasks={runTasks}
              activeRunTasks={activeRunTasks}
              queuedTasks={queuedTasks}
              selectedId={selectedId}
              queuePosition={queuePosition}
              runtimeStatus={tasksState?.runtimeStatus}
              chat={chat.data}
              chatError={chat.error}
              live={live}
              onSelect={setExplicitTaskId}
            />
          )}

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
                    title={t("agent.page.emptyHint")}
                  >
                    {t("agent.page.noRunning")}
                  </h3>
                  {counts.awaiting > 0 ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="mt-3"
                      onClick={() => setTab("approval")}
                    >
                      {t("agent.page.pendingCount", { count: counts.awaiting })}
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
                  view={view}
                  chatSupported={chatSupported}
                  model={currentModel}
                  permissionLabel={selectedPermission?.label}
                  permissionId={selectedTask.permissionMode || "default"}
                  onViewChange={(next) =>
                    setViewChoice((current) => ({
                      ...current,
                      [selectedTask.id]: next,
                    }))
                  }
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

                {live && view === "chat" && chatSupported ? (
                  <AgentChatPane
                    key={selectedTask.id}
                    taskId={selectedTask.id}
                    runtimeId={selectedTask.runtimeId}
                    runtimeName={runtimeName(selectedTask.runtimeId)}
                    status={tasksState?.runtimeStatus?.[selectedTask.id]}
                    model={currentModel}
                    chat={chat.data}
                    chatError={chat.error}
                    loading={chat.loading}
                    live={live}
                    onSwitchToTerminal={() =>
                      setViewChoice((current) => ({
                        ...current,
                        [selectedTask.id]: "terminal",
                      }))
                    }
                    toast={toast}
                  />
                ) : live ? (
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
                        title={t("agent.page.stdinHint")}
                      >
                        {t("agent.page.notStarted")}
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
