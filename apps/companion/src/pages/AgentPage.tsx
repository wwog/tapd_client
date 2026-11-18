import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Play, Plus, RefreshCw } from "lucide-react";

import { asApiError } from "../lib/api";
import { Badge, type BadgeTone } from "../components/Badge";
import {
  dshApi,
  useAgentFeed,
  type DshProjectOption,
  type DshStatus,
  type DshTask,
  type DshTaskProject,
  type DshWorkflow,
} from "../lib/dsh";
import { relativeTime } from "../lib/format";
import { t, type MessageKey } from "../lib/i18n";
import { navigate } from "../lib/router";
import { isPageHidden, onPageVisibilityChange } from "../lib/visibility";

/** Runtime status cadence; the task/approval feed is polled once by `App`. */
const LIST_POLL_MS = 8_000;

const PHASE_LABELS: Record<DshStatus["phase"], MessageKey> = {
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

/** Workflow chip shared by the task list and the session header. */
export function WorkflowChip(props: { workflow: DshWorkflow }) {
  return (
    <Badge tone={WORKFLOW_TONES[props.workflow]}>{t(WORKFLOW_LABELS[props.workflow])}</Badge>
  );
}

function ListSkeleton() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="border-b border-border px-4 py-3">
          <div className="h-4 w-2/3 animate-pulse rounded bg-overlay-soft" />
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

function TaskRow(props: { task: DshTask }) {
  const task = props.task;
  return (
    <button
      type="button"
      onClick={() => navigate(`#/agent/session/${encodeURIComponent(task.id)}`)}
      className="flex min-h-11 w-full flex-col border-b border-border px-4 py-3 text-left transition active:bg-overlay-soft"
    >
      <span className="flex items-start gap-2">
        {task.status === "running" ? (
          <span
            title={t("mobile.agent.workflowRunning")}
            className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500"
          />
        ) : null}
        <span className="line-clamp-2 min-w-0 flex-1 text-ui-caption text-slate-900">
          {task.title || t("mobile.agent.untitledSession")}
        </span>
      </span>
      <span className="mt-1 flex items-center gap-2">
        {task.kind === "chat" ? null : <WorkflowChip workflow={task.workflow} />}
        <span className="ml-auto shrink-0 text-ui-xs text-slate-400">
          {relativeTime(task.updatedAt)}
        </span>
      </span>
    </button>
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

  const runtimeLabel =
    status?.phase === "ready"
      ? [status.provider, status.model]
          .filter((value): value is string => Boolean(value))
          .join(" · ")
      : "";
  const failure = status?.phase === "failed" ? (status.error ?? status.errorCode) : null;

  return (
    <div>
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

      {actionError ? (
        <p
          className="px-4 py-3 text-ui-caption text-rose-600"
          title={t("mobile.agent.newSessionFailed")}
        >
          {actionError}
        </p>
      ) : null}

      {feed.tasksError ? (
        <p
          className="px-4 py-3 text-ui-caption text-rose-600"
          title={t("mobile.agent.loadFailed")}
        >
          {feed.tasksError}
        </p>
      ) : null}

      {feed.pendingError && feed.pendingError !== feed.tasksError ? (
        <p
          className="px-4 py-3 text-ui-caption text-rose-600"
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
              <TaskRow key={task.id} task={task} />
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
    </div>
  );
}
