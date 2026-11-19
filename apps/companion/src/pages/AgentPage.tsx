import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ListTodo, LoaderCircle, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";

import { asApiError } from "../lib/api";
import { Badge, type BadgeTone } from "../components/Badge";
import { BottomSheet } from "../components/BottomSheet";
import {
  applyAgentTask,
  dshApi,
  refreshAgentFeed,
  useAgentFeed,
  type DshProjectOption,
  type DshStatus,
  type DshTask,
  type DshTaskProject,
  type DshWorkflow,
} from "../lib/dsh";
import { plainTitle, relativeTime } from "../lib/format";
import { t, type MessageKey } from "../lib/i18n";
import { navigate } from "../lib/router";
import { isPageHidden, onPageVisibilityChange } from "../lib/visibility";

/** Runtime status cadence; the task/approval feed is polled once by `App`. */
const LIST_POLL_MS = 8_000;

export const PHASE_LABELS: Record<DshStatus["phase"], MessageKey> = {
  stopped: "mobile.agent.phaseStopped",
  starting: "mobile.agent.phaseStarting",
  ready: "mobile.agent.phaseReady",
  failed: "mobile.agent.phaseFailed",
};

const PHASE_DOTS: Record<DshStatus["phase"], string> = {
  stopped: "bg-slate-400",
  starting: "bg-amber-500",
  ready: "bg-emerald-500",
  failed: "bg-rose-500",
};

const WORKFLOW_LABELS: Record<DshWorkflow, MessageKey> = {
  queued: "mobile.agent.workflowQueued",
  running: "mobile.agent.workflowRunning",
  awaiting_review: "mobile.agent.workflowReview",
  finalizing: "mobile.agent.workflowFinalizing",
  done: "mobile.agent.workflowDone",
  failed: "mobile.agent.workflowFailed",
  canceled: "mobile.agent.workflowCanceled",
};

const WORKFLOW_TONES: Record<DshWorkflow, BadgeTone> = {
  queued: "neutral",
  running: "blue",
  awaiting_review: "amber",
  finalizing: "cyan",
  done: "green",
  failed: "red",
  canceled: "neutral",
};

/** Workflow chip shared by the task list, queue view and session header. */
export function WorkflowChip(props: { workflow: DshWorkflow; interrupted?: boolean }) {
  if (props.interrupted) {
    return <Badge tone="amber">{t("mobile.agent.workflowInterrupted")}</Badge>;
  }
  return (
    <Badge tone={WORKFLOW_TONES[props.workflow]}>{t(WORKFLOW_LABELS[props.workflow])}</Badge>
  );
}

/**
 * A `running` row whose session is not working is a stopped turn. The backend
 * persists the flag on a user stop and at startup recovery; a failed session
 * row covers a runtime exit while the app stayed open. Shared with the
 * session page so its chips agree with the list.
 */
export const isInterrupted = (task: DshTask): boolean =>
  task.workflow === "running" && (Boolean(task.interrupted) || task.status === "failed");

function ListSkeleton() {
  return (
    <div data-component="ListSkeleton" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="border-b border-border px-4 py-3">
          <div className="h-4 w-2/3 animate-pulse rounded bg-overlay-soft" />
          <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-overlay-soft" />
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------
   Task list
   ------------------------------------------------------------------------- */

/** The default "no project" group; its key never collides with a real one. */
const NO_PROJECT_GROUP = "";

type TaskGroup = {
  key: string;
  project: DshTaskProject | null;
  tasks: DshTask[];
};

const projectKey = (project: DshTaskProject): string => `${project.kind}:${project.id}`;

const newestFirst = (left: DshTask, right: DshTask): number =>
  right.updatedAt.localeCompare(left.updatedAt);

const latestActivity = (group: TaskGroup): string => group.tasks[0]?.updatedAt ?? "";

/**
 * Groups = every configured project + the default "no project" group. Projects
 * keep a header even when they have no sessions; groups follow their newest
 * session and the default group is always last.
 */
function groupTasks(tasks: DshTask[], projects: DshProjectOption[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  const ensure = (project: DshTaskProject): TaskGroup => {
    const key = projectKey(project);
    let group = groups.get(key);
    if (!group) {
      group = { key, project, tasks: [] };
      groups.set(key, group);
    }
    return group;
  };

  for (const project of projects) ensure(project);

  const noProject: TaskGroup = {
    key: NO_PROJECT_GROUP,
    project: null,
    tasks: [],
  };
  for (const task of tasks) {
    if (task.project) ensure(task.project).tasks.push(task);
    else noProject.tasks.push(task);
  }

  for (const group of groups.values()) group.tasks.sort(newestFirst);
  noProject.tasks.sort(newestFirst);

  const list = [...groups.values()].sort((left, right) => {
    const delta = latestActivity(right).localeCompare(latestActivity(left));
    if (delta !== 0) return delta;
    return (left.project?.name ?? "").localeCompare(right.project?.name ?? "");
  });
  list.push(noProject);
  return list;
}

/** One list row: tap opens the session, the trailing button asks to delete. */
function TaskRow(props: { task: DshTask; onDelete: (task: DshTask) => void }) {
  const task = props.task;
  return (
    <div data-component="TaskRow" className="flex items-stretch border-b border-border">
      <button
        type="button"
        onClick={() => navigate(`#/agent/session/${encodeURIComponent(task.id)}`)}
        className="flex min-h-11 min-w-0 flex-1 flex-col px-4 py-3 text-left transition active:bg-overlay-soft"
      >
        <span className="flex items-start gap-2">
          {task.status === "running" && task.kind === "chat" ? (
            <span
              title={t("mobile.agent.workflowRunning")}
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500"
            />
          ) : null}
          <span className="line-clamp-2 min-w-0 flex-1 text-ui-caption text-slate-900">
            {plainTitle(task.title) || t("mobile.agent.untitledSession")}
          </span>
        </span>
        <span className="mt-1 flex items-center gap-2">
          {task.kind === "chat" ? null : (
            <WorkflowChip workflow={task.workflow} interrupted={isInterrupted(task)} />
          )}
          <span className="ml-auto shrink-0 text-ui-xs text-slate-400">
            {relativeTime(task.updatedAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={t("mobile.agent.deleteTitle")}
        title={t("mobile.agent.deleteTitle")}
        onClick={() => props.onDelete(task)}
        className="grid w-11 shrink-0 place-items-center text-slate-400 transition active:bg-rose-50 active:text-rose-600"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

/** One queue bucket: heading plus rows, hidden while empty. */
function QueueSection(props: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  if (props.count === 0) return null;
  return (
    <section>
      <div className="flex items-center gap-2 border-b border-border bg-overlay-soft px-4 py-1">
        <h2 className="min-w-0 flex-1 truncate text-ui-2xs text-slate-500">{props.label}</h2>
        <span className="shrink-0 text-ui-2xs text-slate-400">{props.count}</span>
      </div>
      {props.children}
    </section>
  );
}

/** Queue row: tap opens the session — or, while queued (no session exists
 *  yet, the desktop's queue opens the source record too), the bug/local item
 *  the task came from. Stopped rows offer continue, live ones cancel. */
function QueueRow(props: {
  task: DshTask;
  busy: boolean;
  onContinue: (task: DshTask) => void;
  onCancel: (task: DshTask) => void;
}) {
  const { task, busy } = props;
  const interrupted = isInterrupted(task);
  /** Captured first so the navigation closure keeps the narrowed values. */
  const bugRef =
    task.kind === "bug" && task.bugId && task.project
      ? { bugId: task.bugId, workspaceId: task.project.id }
      : null;
  const localProjectId =
    task.kind === "local_item" && task.project ? task.project.id : null;
  const open = (() => {
    if (task.workflow !== "queued") {
      return () => navigate(`#/agent/session/${encodeURIComponent(task.id)}`);
    }
    if (bugRef) {
      return () =>
        navigate(
          `#/bug/${encodeURIComponent(bugRef.bugId)}?w=${encodeURIComponent(bugRef.workspaceId)}`,
        );
    }
    if (localProjectId) {
      return () => navigate(`#/local?p=${encodeURIComponent(localProjectId)}`);
    }
    return null;
  })();
  return (
    <div data-component="QueueRow" className="flex items-start gap-2 border-b border-border px-4 py-3">
      <button
        type="button"
        disabled={!open}
        onClick={() => open?.()}
        title={
          task.workflow === "queued" && open
            ? t("mobile.agent.openSource")
            : undefined
        }
        className="min-w-0 flex-1 text-left transition active:bg-overlay-soft disabled:active:bg-transparent"
      >
        <span className="flex items-start gap-2">
          <span className="line-clamp-2 min-w-0 flex-1 text-ui-caption text-slate-900">
            {plainTitle(task.title) || t("mobile.agent.untitledSession")}
          </span>
          <WorkflowChip workflow={task.workflow} interrupted={interrupted} />
        </span>
        <span className="mt-1 flex items-center gap-2 text-ui-xs text-slate-400">
          <span className="min-w-0 truncate">
            {task.project?.name ?? t("mobile.agent.noProject")}
          </span>
          <span className="ml-auto shrink-0">{relativeTime(task.updatedAt)}</span>
        </span>
      </button>
      {interrupted ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => props.onContinue(task)}
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
        >
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Play size={12} />}
          {t("mobile.agent.continue")}
        </button>
      ) : task.workflow === "queued" || task.workflow === "running" ? (
        <button
          type="button"
          disabled={busy}
          aria-label={t("mobile.agent.cancelTask")}
          title={t("mobile.agent.cancelTask")}
          onClick={() => props.onCancel(task)}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface text-slate-500 transition active:bg-rose-50 disabled:opacity-40"
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Agent tab: the built-in dsh runtime on the desktop and one unified task list
 * grouped by project. The task/approval snapshot is shared with the tab badge
 * and the session page (`useAgentFeed`), so this page does not poll it itself.
 */
export function AgentPage() {
  const feed = useAgentFeed();
  const [status, setStatus] = useState<DshStatus | null>(null);
  const [statusError, setStatusError] = useState<{
    message: string;
    title: MessageKey;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  /** Group key whose "+" is creating a session; `null` when idle. */
  const [creating, setCreating] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Every configured project, so empty groups still render a header. */
  const [projects, setProjects] = useState<DshProjectOption[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  /** Task list vs. the desktop's workflow queue view. */
  const [view, setView] = useState<"tasks" | "queue">("tasks");
  /** Queue rows whose continue/cancel request is in flight. */
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());

  /** Delete flow: the tapped row opens the confirm sheet; failures stay in it. */
  const [deleting, setDeleting] = useState<DshTask | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteTask = async () => {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await dshApi.taskDelete(deleting.id);
      setDeleting(null);
      void refreshAgentFeed();
    } catch (err) {
      setDeleteError(asApiError(err).message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await dshApi.status();
      if (!alive.current) return;
      setStatus(next);
      setStatusError(null);
    } catch (err) {
      if (!alive.current) return;
      setStatusError({
        message: asApiError(err).message,
        title: "mobile.agent.statusLoadFailed",
      });
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const { projects: rows } = await dshApi.projects();
      if (!alive.current) return;
      setProjects(rows);
      setProjectsError(null);
    } catch (err) {
      if (!alive.current) return;
      setProjectsError(asApiError(err).message);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshProjects();
    const timer = window.setInterval(() => {
      if (!isPageHidden()) void refreshStatus();
    }, LIST_POLL_MS);
    const off = onPageVisibilityChange(() => {
      if (isPageHidden()) return;
      void refreshStatus();
      void refreshProjects();
    });
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [refreshStatus, refreshProjects]);

  /** A stopped or failed runtime gets one explicit start/retry button. */
  const startRuntime = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const next = await dshApi.start();
      if (alive.current) {
        setStatus(next);
        setStatusError(null);
      }
    } catch (err) {
      if (alive.current) {
        setStatusError({
          message: asApiError(err).message,
          title: "mobile.agent.startFailed",
        });
      }
    } finally {
      if (alive.current) setStarting(false);
    }
  };

  /** A group's "+" creates a free chat; the project scopes its cwd/group. */
  const createSession = async (project: DshTaskProject | null) => {
    if (creating !== null) return;
    const key = project ? projectKey(project) : NO_PROJECT_GROUP;
    setCreating(key);
    setActionError(null);
    try {
      const { sessionId } = await dshApi.newSession(
        project ? { kind: project.kind, id: project.id } : undefined,
      );
      navigate(`#/agent/session/${encodeURIComponent(sessionId)}`);
    } catch (err) {
      if (alive.current) setActionError(asApiError(err).message);
    } finally {
      if (alive.current) setCreating(null);
    }
  };

  const groups = useMemo(
    () => groupTasks(feed.tasks ?? [], projects ?? []),
    [feed.tasks, projects],
  );

  /**
   * Queue buckets, in the desktop's order and FIFO ordering. Chats stay out
   * (the desktop's feed does the same): a chat's workflow is the neutral
   * `running`, so they would otherwise fill the running bucket and the row's
   * cancel button would terminate the conversation record for good.
   */
  const queue = useMemo(() => {
    const byCreated = (left: DshTask, right: DshTask): number =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    const tasks = (feed.tasks ?? []).filter((task) => task.kind !== "chat");
    const interrupted = tasks.filter(isInterrupted).sort(byCreated);
    const running = tasks
      .filter((task) => task.workflow === "running" && !isInterrupted(task))
      .sort(byCreated);
    const queued = tasks.filter((task) => task.workflow === "queued").sort(byCreated);
    const review = tasks
      .filter((task) => task.workflow === "awaiting_review")
      .sort(byCreated);
    const finalizing = tasks
      .filter((task) => task.workflow === "finalizing")
      .sort(byCreated);
    return {
      interrupted,
      running,
      queued,
      review,
      finalizing,
      total:
        interrupted.length +
        running.length +
        queued.length +
        review.length +
        finalizing.length,
    };
  }, [feed.tasks]);

  /** One queue action at a time per row; failures stay on the page. */
  const runQueueAction = async (id: string, action: () => Promise<void>) => {
    if (busyIds.has(id)) return;
    setBusyIds((current) => new Set(current).add(id));
    setActionError(null);
    try {
      await action();
    } catch (err) {
      if (alive.current) setActionError(asApiError(err).message);
    } finally {
      if (alive.current) {
        setBusyIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    }
  };

  /** Continue a stopped round from the existing context (desktop parity).
   *  The local flip mirrors the desktop's optimistic update: between the
   *  prompt ack and the engine's turn/start event landing in the feed, a
   *  second tap would queue the nudge prompt twice. */
  const continueTask = (task: DshTask) =>
    void runQueueAction(task.id, async () => {
      await dshApi.taskResume(task.id);
      applyAgentTask({ ...task, interrupted: false, status: "running" });
      await dshApi.prompt(task.id, t("mobile.agent.continuePrompt"));
      void refreshAgentFeed();
      navigate(`#/agent/session/${encodeURIComponent(task.id)}`);
    });

  const cancelTask = (task: DshTask) =>
    void runQueueAction(task.id, async () => {
      await dshApi.taskCancel(task.id);
      void refreshAgentFeed();
    });

  const renderQueueRow = (task: DshTask) => (
    <QueueRow
      key={task.id}
      task={task}
      busy={busyIds.has(task.id)}
      onContinue={continueTask}
      onCancel={cancelTask}
    />
  );

  const runtimeLabel =
    status?.phase === "ready"
      ? [status.provider, status.model]
          .filter((value): value is string => Boolean(value))
          .join(" · ")
      : "";
  const failure = status?.phase === "failed" ? (status.error ?? status.errorCode) : null;

  return (
    <div data-component="AgentPage">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-canvas px-4 py-2">
        <h1 className="min-w-0 flex-1 text-ui-base text-slate-900">{t("mobile.tab.agent")}</h1>
      </header>

      <section className="border-b border-border px-4 py-3">
        {status ? (
          <div className="flex items-center gap-2 text-ui-caption text-slate-900">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${PHASE_DOTS[status.phase]} ${
                status.phase === "starting" ? "animate-pulse" : ""
              }`}
            />
            <span className="shrink-0">{t(PHASE_LABELS[status.phase])}</span>
            {runtimeLabel ? (
              <span
                className="min-w-0 truncate font-mono text-ui-xs text-slate-400"
                title={runtimeLabel}
              >
                {runtimeLabel}
              </span>
            ) : null}
            {status.phase === "stopped" || status.phase === "failed" ? (
              <button
                type="button"
                disabled={starting}
                onClick={() => void startRuntime()}
                className="ml-auto inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
              >
                {starting ? (
                  <LoaderCircle size={12} className="animate-spin" />
                ) : status.phase === "failed" ? (
                  <RefreshCw size={12} />
                ) : (
                  <Play size={12} />
                )}
                {status.phase === "failed" ? t("common.retry") : t("mobile.agent.start")}
              </button>
            ) : null}
          </div>
        ) : statusError ? null : (
          <p className="text-ui-caption text-slate-400">{t("common.reading")}</p>
        )}
        {failure ? (
          <p className="mt-1 text-ui-sm leading-5 text-rose-600" title={status?.errorCode}>
            {failure}
          </p>
        ) : null}
        {statusError ? (
          <p className="mt-1 text-ui-caption leading-5 text-rose-600" title={t(statusError.title)}>
            {statusError.message}
          </p>
        ) : null}
      </section>

      <div
        role="tablist"
        aria-label={t("mobile.tab.agent")}
        className="mx-4 mt-2 flex items-center rounded-lg border border-border bg-surface p-0.5"
      >
        {[
          { key: "tasks" as const, label: t("mobile.agent.viewTasks"), count: feed.tasks?.length ?? 0 },
          { key: "queue" as const, label: t("mobile.agent.viewQueue"), count: queue.total },
        ].map((tab) => {
          const active = view === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setView(tab.key)}
              className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md text-ui-sm transition ${
                active ? "bg-slate-100 text-slate-900" : "text-slate-500"
              }`}
            >
              {tab.label}
              <span
                className={`tabular-nums text-ui-2xs ${active ? "text-slate-500" : "text-slate-400"}`}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {actionError ? (
        <p
          className="px-4 py-2 text-ui-xs text-rose-600"
          title={t("common.actionFailed")}
        >
          {actionError}
        </p>
      ) : null}

      {feed.tasksError ? (
        <p
          className="px-4 py-2 text-ui-xs text-rose-600"
          title={t("mobile.agent.loadFailed")}
        >
          {feed.tasksError}
        </p>
      ) : null}

      {feed.pendingError && feed.pendingError !== feed.tasksError ? (
        <p
          className="px-4 py-2 text-ui-xs text-rose-600"
          title={t("mobile.agent.pendingLoadFailed")}
        >
          {feed.pendingError}
        </p>
      ) : null}

      {projectsError && projects === null ? (
        <p
          className="px-4 py-2 text-ui-xs text-rose-600"
          title={t("mobile.agent.projectsLoadFailed")}
        >
          {projectsError}
        </p>
      ) : null}

      {view === "tasks" ? (
        <>
          {feed.tasks === null && !feed.tasksError ? <ListSkeleton /> : null}

          {groups.map((group) => {
            const name = group.project?.name ?? t("mobile.agent.noProject");
            return (
              <section key={group.key || "__none__"}>
                <div className="flex items-center gap-2 border-b border-border bg-overlay-soft px-4 py-1">
                  <h2 className="min-w-0 flex-1 truncate text-ui-2xs text-slate-500" title={name}>
                    {name}
                  </h2>
                  {group.tasks.length > 0 ? (
                    <span className="shrink-0 text-ui-2xs text-slate-400">
                      {group.tasks.length}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={t("mobile.agent.newSessionInProject", { project: name })}
                    title={
                      creating === group.key
                        ? t("mobile.agent.creating")
                        : t("mobile.agent.newSessionInProject", { project: name })
                    }
                    disabled={creating !== null}
                    onClick={() => void createSession(group.project)}
                    className="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-md text-slate-500 transition active:bg-overlay-soft disabled:opacity-40"
                  >
                    {creating === group.key ? (
                      <LoaderCircle size={14} className="animate-spin" />
                    ) : (
                      <Plus size={14} />
                    )}
                  </button>
                </div>
                {group.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} onDelete={setDeleting} />
                ))}
                {group.project === null &&
                group.tasks.length === 0 &&
                feed.tasks !== null &&
                !feed.tasksError ? (
                  <p
                    className="px-4 py-10 text-center text-ui-base text-slate-400"
                    title={t("mobile.agent.emptyHint")}
                  >
                    {t("mobile.agent.empty")}
                  </p>
                ) : null}
              </section>
            );
          })}
        </>
      ) : feed.tasks === null && !feed.tasksError ? (
        <ListSkeleton />
      ) : queue.total === 0 ? (
        <div className="px-4 py-10 text-center" title={t("mobile.agent.queueEmptyHint")}>
          <ListTodo size={22} className="mx-auto text-slate-300" />
          <p className="mt-2 text-ui-base text-slate-400">{t("mobile.agent.queueEmpty")}</p>
        </div>
      ) : (
        <div data-component="QueueView">
          <QueueSection
            label={t("mobile.agent.workflowRunning")}
            count={queue.running.length}
          >
            {queue.running.map(renderQueueRow)}
          </QueueSection>
          <QueueSection
            label={t("mobile.agent.workflowInterrupted")}
            count={queue.interrupted.length}
          >
            {queue.interrupted.map(renderQueueRow)}
          </QueueSection>
          <QueueSection label={t("mobile.agent.workflowQueued")} count={queue.queued.length}>
            {queue.queued.map(renderQueueRow)}
          </QueueSection>
          <QueueSection label={t("mobile.agent.workflowReview")} count={queue.review.length}>
            {queue.review.map(renderQueueRow)}
          </QueueSection>
          <QueueSection
            label={t("mobile.agent.workflowFinalizing")}
            count={queue.finalizing.length}
          >
            {queue.finalizing.map(renderQueueRow)}
          </QueueSection>
        </div>
      )}

      <BottomSheet
        open={deleting !== null}
        title={t("mobile.agent.deleteTitle")}
        onClose={() => {
          if (!deleteBusy) setDeleting(null);
        }}
        footer={
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={deleteBusy}
              onClick={() => setDeleting(null)}
              className="min-h-11 shrink-0 rounded-lg border border-border bg-surface px-3 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={deleteBusy}
              onClick={() => void deleteTask()}
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-rose-200 bg-rose-50 px-3 text-ui-sm text-rose-700 transition active:bg-overlay-soft disabled:opacity-40"
            >
              {deleteBusy ? <LoaderCircle size={13} className="mx-auto animate-spin" /> : t("common.delete")}
            </button>
          </div>
        }
      >
        {deleting ? (
          <>
            <p className="text-ui-caption text-slate-900">
              {plainTitle(deleting.title) || t("mobile.agent.untitledSession")}
            </p>
            <p className="mt-2 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700">
              {t("mobile.agent.deleteHint", {
                title: plainTitle(deleting.title) || t("mobile.agent.untitledSession"),
              })}
            </p>
            {deleteError ? (
              <p
                className="mt-2 text-ui-sm leading-5 text-rose-600"
                title={t("mobile.agent.deleteFailed")}
              >
                {deleteError}
              </p>
            ) : null}
          </>
        ) : null}
      </BottomSheet>
    </div>
  );
}
