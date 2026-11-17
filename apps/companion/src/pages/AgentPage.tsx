import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Play, Plus, RefreshCw } from "lucide-react";

import { asApiError } from "../lib/api";
import { Badge, type BadgeTone } from "../components/Badge";
import {
  dshApi,
  useAgentFeed,
  type DshStatus,
  type DshTask,
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
  running: "mobile.agent.workflowRunning",
  awaiting_review: "mobile.agent.workflowReview",
  awaiting_merge: "mobile.agent.workflowMerge",
  done: "mobile.agent.workflowDone",
  failed: "mobile.agent.workflowFailed",
  canceled: "mobile.agent.workflowCanceled",
};

const WORKFLOW_TONES: Record<DshWorkflow, BadgeTone> = {
  running: "blue",
  awaiting_review: "amber",
  awaiting_merge: "cyan",
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

type TaskGroup = { key: string; project: DshTask["project"]; tasks: DshTask[] };

/** Group by project (local projects included); newest first inside a group. */
function groupTasks(tasks: DshTask[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const task of tasks) {
    const key = task.project?.id ?? "";
    const group = groups.get(key);
    if (group) group.tasks.push(task);
    else groups.set(key, { key, project: task.project, tasks: [task] });
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  // Groups follow their newest task, so the whole list stays newest-first.
  list.sort((left, right) =>
    (right.tasks[0]?.updatedAt ?? "").localeCompare(left.tasks[0]?.updatedAt ?? ""),
  );
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
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => {
      if (!isPageHidden()) void refreshStatus();
    }, LIST_POLL_MS);
    const off = onPageVisibilityChange(() => {
      if (!isPageHidden()) void refreshStatus();
    });
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [refreshStatus]);

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

  const createSession = async () => {
    if (creating) return;
    setCreating(true);
    setActionError(null);
    try {
      const { sessionId } = await dshApi.newSession();
      navigate(`#/agent/session/${encodeURIComponent(sessionId)}`);
    } catch (err) {
      if (alive.current) setActionError(asApiError(err).message);
    } finally {
      if (alive.current) setCreating(false);
    }
  };

  const groups = useMemo(() => groupTasks(feed.tasks ?? []), [feed.tasks]);

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
        <button
          type="button"
          disabled={creating}
          onClick={() => void createSession()}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-50"
        >
          {creating ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}
          {creating ? t("mobile.agent.creating") : t("mobile.agent.newSession")}
        </button>
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

      {feed.tasks === null && !feed.tasksError ? <ListSkeleton /> : null}

      {feed.tasks && feed.tasks.length === 0 && !feed.tasksError ? (
        <p
          className="px-4 py-10 text-center text-ui-base text-slate-400"
          title={t("mobile.agent.emptyHint")}
        >
          {t("mobile.agent.empty")}
        </p>
      ) : null}

      {groups.map((group) => (
        <section key={group.key || "__none__"}>
          <h2 className="border-b border-border bg-overlay-soft px-4 py-1.5 text-ui-2xs text-slate-500">
            {group.project?.name ?? t("mobile.agent.noProject")}
          </h2>
          {group.tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </section>
      ))}
    </div>
  );
}
