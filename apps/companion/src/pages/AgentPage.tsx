import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Wrench,
  X,
} from "lucide-react";

import { asApiError } from "../lib/api";
import { Badge, type BadgeTone } from "../components/Badge";
import { BottomSheet } from "../components/BottomSheet";
import {
  applyAgentTask,
  applyAgentTeam,
  dshApi,
  isTerminalWorkflow,
  refreshAgentFeed,
  useAgentFeed,
  watchAgentTeam,
  type DshAnswer,
  type DshApprovalOutcome,
  type DshEntry,
  type DshPendingRequest,
  type DshStatus,
  type DshTask,
  type DshTeam,
  type DshTeamTask,
  type DshTeamTaskStatus,
  type DshToolStatus,
  type DshWorkflow,
} from "../lib/dsh";
import { absoluteTime, relativeTime } from "../lib/format";
import { t, type MessageKey } from "../lib/i18n";
import { navigate } from "../lib/router";
import { isPageHidden, onPageVisibilityChange } from "../lib/visibility";

/** Runtime status cadence; the task/approval feed is polled once by `App`. */
const LIST_POLL_MS = 8_000;
const SESSION_POLL_MS = 3_000;
/** Soft cap on the composer's growth before it scrolls internally. */
const COMPOSER_MAX_HEIGHT = 120;

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

const TOOL_LABELS: Record<DshToolStatus, MessageKey> = {
  running: "mobile.agent.toolRunning",
  ok: "common.done",
  error: "common.failed",
};

const TEAM_COLUMNS: ReadonlyArray<{ status: DshTeamTaskStatus; label: MessageKey }> = [
  { status: "pending", label: "mobile.agent.colPending" },
  { status: "in_progress", label: "mobile.agent.colInProgress" },
  { status: "completed", label: "mobile.agent.colCompleted" },
];

/** Scope chips per card; the rest collapse into a `+n` chip. */
const MAX_SCOPES = 3;

type ApprovalPending = Extract<DshPendingRequest, { kind: "approval" }>;
type QuestionPending = Extract<DshPendingRequest, { kind: "question" }>;
type TaskAction = "approve" | "merge" | "cancel" | "diff";

function WorkflowChip(props: { workflow: DshWorkflow }) {
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

function TranscriptSkeleton() {
  return (
    <div className="space-y-3 px-4 py-3" aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="rounded-lg border border-border px-3 py-2">
          <div className="h-3 w-2/3 animate-pulse rounded bg-overlay-soft" />
          <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-overlay-soft" />
        </div>
      ))}
    </div>
  );
}

function UserRow(props: { entry: Extract<DshEntry, { kind: "user" }> }) {
  return (
    <div className="flex justify-end">
      <p
        className="max-w-[85%] select-text break-words whitespace-pre-wrap rounded-2xl border border-border bg-surface px-3 py-2 text-ui-caption leading-5 text-slate-900"
        title={absoluteTime(props.entry.at)}
      >
        {props.entry.text}
      </p>
    </div>
  );
}

function AssistantRow(props: { entry: Extract<DshEntry, { kind: "assistant" }> }) {
  const entry = props.entry;
  const [open, setOpen] = useState(false);
  if (!entry.text && !entry.reasoning) return null;
  return (
    <div className="select-text" title={absoluteTime(entry.at)}>
      {entry.reasoning ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex items-center gap-0.5 text-ui-2xs text-slate-400 transition active:text-slate-600"
        >
          <ChevronRight size={12} className={`transition ${open ? "rotate-90" : ""}`} />
          {t("mobile.agent.reasoning")}
        </button>
      ) : null}
      {open && entry.reasoning ? (
        <p className="mt-1 rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-xs leading-5 break-words whitespace-pre-wrap text-slate-500">
          {entry.reasoning}
        </p>
      ) : null}
      {entry.text ? (
        <p className="mt-1 text-ui-caption leading-5 break-words whitespace-pre-wrap text-slate-900">
          {entry.text}
        </p>
      ) : null}
    </div>
  );
}

function ToolRow(props: { entry: Extract<DshEntry, { kind: "tool" }> }) {
  const entry = props.entry;
  const [open, setOpen] = useState(false);
  const failed = entry.status === "error";
  return (
    <div
      className={`rounded-lg border ${failed ? "border-rose-200 bg-rose-50" : "border-border bg-surface"}`}
      title={absoluteTime(entry.at)}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition active:bg-overlay-soft"
      >
        {entry.status === "running" ? (
          <LoaderCircle size={12} className="shrink-0 animate-spin text-sky-500" />
        ) : (
          <Wrench
            size={12}
            className={`shrink-0 ${failed ? "text-rose-500" : "text-slate-400"}`}
          />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-slate-600">
          {entry.name}
        </span>
        <span
          className={`shrink-0 text-ui-2xs ${
            failed
              ? "text-rose-700"
              : entry.status === "running"
                ? "text-sky-600"
                : "text-slate-400"
          }`}
        >
          {t(TOOL_LABELS[entry.status])}
        </span>
        <ChevronDown
          size={12}
          className={`shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className={`border-t px-3 py-2 ${failed ? "border-rose-200" : "border-border"}`}>
          {entry.args ? (
            <>
              <p className="text-ui-2xs text-slate-400">{t("mobile.agent.toolArgs")}</p>
              <pre
                className={`mt-1 overflow-x-auto font-mono text-ui-2xs break-all whitespace-pre-wrap select-text ${
                  failed ? "text-rose-700" : "text-slate-600"
                }`}
              >
                {entry.args}
              </pre>
            </>
          ) : null}
          {entry.result ? (
            <>
              <p className="mt-2 text-ui-2xs text-slate-400">{t("mobile.agent.toolResult")}</p>
              <pre
                className={`mt-1 overflow-x-auto font-mono text-ui-2xs break-all whitespace-pre-wrap select-text ${
                  failed ? "text-rose-700" : "text-slate-600"
                }`}
              >
                {entry.result}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TurnRow(props: { entry: Extract<DshEntry, { kind: "turn" }> }) {
  if (props.entry.state === "start") return <div className="border-t border-border" aria-hidden="true" />;
  return (
    <div className="flex items-center gap-2" title={absoluteTime(props.entry.at)}>
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0 text-ui-2xs text-slate-400">
        {props.entry.reason || t("mobile.agent.turnEnded")}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function EntryRow(props: { entry: DshEntry }) {
  const entry = props.entry;
  switch (entry.kind) {
    case "user":
      return <UserRow entry={entry} />;
    case "assistant":
      return <AssistantRow entry={entry} />;
    case "tool":
      return <ToolRow entry={entry} />;
    case "turn":
      return <TurnRow entry={entry} />;
  }
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

/* -------------------------------------------------------------------------
   Task page building blocks
   ------------------------------------------------------------------------- */

function TaskButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: "primary" | "neutral" | "danger";
}) {
  const tone = props.tone ?? "neutral";
  const palette =
    tone === "primary"
      ? "bg-primary text-primary-foreground active:bg-primary-hover"
      : tone === "danger"
        ? "border border-rose-200 bg-rose-50 text-rose-700 active:bg-overlay-soft"
        : "border border-border bg-surface text-slate-700 active:bg-overlay-soft";
  return (
    <button
      type="button"
      disabled={props.disabled || props.busy}
      onClick={props.onClick}
      className={`inline-flex min-h-11 flex-1 basis-24 items-center justify-center gap-1.5 rounded-lg px-3 text-ui-sm transition disabled:opacity-40 ${palette}`}
    >
      {props.busy ? <LoaderCircle size={13} className="animate-spin" /> : null}
      {props.label}
    </button>
  );
}

function DiffSheet(props: {
  open: boolean;
  diff: { text: string; truncated: boolean } | null;
  error: string | null;
  busy: boolean;
  onClose: () => void;
}) {
  if (!props.open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-canvas"
      style={{
        // The portal escapes #root's safe-area padding.
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-canvas px-2 py-2">
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={props.onClose}
          className="shrink-0 rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
        >
          <X size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-900">
          {t("mobile.agent.viewDiff")}
        </span>
        {props.diff?.truncated ? (
          <Badge tone="amber">{t("mobile.agent.diffTruncated")}</Badge>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain bg-surface">
        {props.busy ? (
          <p className="px-4 py-6 text-ui-caption text-slate-400">{t("common.reading")}</p>
        ) : props.error ? (
          <p
            className="px-4 py-6 text-ui-caption leading-5 text-rose-600"
            title={t("mobile.agent.diffFailed")}
          >
            {props.error}
          </p>
        ) : props.diff && props.diff.text ? (
          <pre className="w-max min-w-full px-3 py-3 font-mono text-ui-xs leading-5 break-normal whitespace-pre text-slate-700 select-text">
            {props.diff.text}
          </pre>
        ) : (
          <p className="px-4 py-6 text-ui-caption text-slate-400">
            {t("mobile.agent.diffEmpty")}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

function ApprovalCard(props: { request: ApprovalPending }) {
  const [busy, setBusy] = useState<DshApprovalOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const approval = props.request.request;

  const answer = async (outcome: DshApprovalOutcome) => {
    if (busy) return;
    setBusy(outcome);
    setError(null);
    try {
      await dshApi.approvalAnswer(props.request.rpcId, outcome);
      await refreshAgentFeed();
    } catch (err) {
      setError(asApiError(err).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-4 mt-3 rounded-lg border border-border bg-surface px-3 py-3">
      <p className="text-ui-xs text-slate-500">{t("mobile.agent.approvalRequest")}</p>
      <p className="mt-1.5 flex items-baseline gap-2">
        <span className="shrink-0 text-ui-2xs text-slate-400">
          {t("mobile.agent.approvalTool")}
        </span>
        <span className="min-w-0 flex-1 break-all font-mono text-ui-xs text-slate-900">
          {approval.toolName}
        </span>
      </p>
      {approval.reason ? (
        <p className="mt-1 flex items-baseline gap-2">
          <span className="shrink-0 text-ui-2xs text-slate-400">
            {t("mobile.agent.approvalTarget")}
          </span>
          <span className="min-w-0 flex-1 select-text break-words whitespace-pre-wrap text-ui-xs leading-5 text-slate-600">
            {approval.reason}
          </span>
        </p>
      ) : null}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void answer("allowed-once")}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-40"
        >
          {busy === "allowed-once" ? <LoaderCircle size={13} className="animate-spin" /> : null}
          {t("mobile.agent.allowOnce")}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void answer("rejected")}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 text-ui-sm text-rose-700 transition active:bg-overlay-soft disabled:opacity-40"
        >
          {busy === "rejected" ? <LoaderCircle size={13} className="animate-spin" /> : null}
          {t("mobile.agent.reject")}
        </button>
      </div>
      {error ? (
        <p
          className="mt-2 text-ui-xs leading-5 text-rose-600"
          title={t("mobile.agent.approvalFailed")}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function QuestionCard(props: { request: QuestionPending; onAnswer: () => void }) {
  const first = props.request.request.questions[0];
  return (
    <div className="mx-4 mt-3 rounded-lg border border-border bg-surface px-3 py-3">
      <p className="text-ui-xs text-slate-500">{t("mobile.agent.questionRequest")}</p>
      <p className="mt-1 line-clamp-3 select-text text-ui-caption leading-5 text-slate-900">
        {first?.question ?? t("common.empty")}
      </p>
      <button
        type="button"
        onClick={props.onAnswer}
        className="mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-3 text-ui-sm text-primary-foreground transition active:bg-primary-hover"
      >
        {t("mobile.agent.answerQuestion")}
      </button>
    </div>
  );
}

/**
 * One runtime question set. A single single-select question answers with one
 * tap; everything else walks question i/N with optional custom text. Closing
 * the sheet dismisses the request (`answers: null`), it never approves it.
 */
function QuestionSheet(props: { pending: QuestionPending; onClose: () => void }) {
  const request = props.pending.request;
  const questions = request.questions;
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = questions[index];
  const singleSelect = questions.length === 1 && !current?.multiSelect;
  const hasOptions = (current?.options?.length ?? 0) > 0;

  const answer = async (answers: DshAnswer[] | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await dshApi.questionAnswer(props.pending.rpcId, answers);
      await refreshAgentFeed();
      props.onClose();
    } catch (err) {
      setError(asApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const answersFor = (
    picked: Record<string, string[]>,
    texts: Record<string, string>,
    override?: { id: string; selected: string[] },
  ): DshAnswer[] =>
    questions.map((question) => {
      if (override && question.id === override.id) {
        return { id: question.id, selected: override.selected };
      }
      const value = picked[question.id] ?? [];
      const text = (texts[question.id] ?? "").trim();
      return text
        ? { id: question.id, selected: value, custom: text }
        : { id: question.id, selected: value };
    });

  const toggle = (label: string) => {
    if (!current) return;
    setSelected((prev) => {
      const value = prev[current.id] ?? [];
      if (!current.multiSelect) return { ...prev, [current.id]: [label] };
      return {
        ...prev,
        [current.id]: value.includes(label)
          ? value.filter((item) => item !== label)
          : [...value, label],
      };
    });
  };

  /** Skip clears the current question; on the last one it submits the set. */
  const skip = () => {
    if (!current || busy) return;
    const clearedSelected = { ...selected, [current.id]: [] };
    const clearedCustom = { ...custom, [current.id]: "" };
    setSelected(clearedSelected);
    setCustom(clearedCustom);
    if (index < questions.length - 1) {
      setIndex(index + 1);
      return;
    }
    void answer(answersFor(clearedSelected, clearedCustom));
  };

  const next = () => {
    if (busy) return;
    if (index < questions.length - 1) setIndex(index + 1);
    else void answer(answersFor(selected, custom));
  };

  const footer =
    questions.length === 0 ? (
      <button
        type="button"
        disabled={busy}
        onClick={() => void answer(null)}
        className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
      >
        {t("common.close")}
      </button>
    ) : singleSelect && hasOptions ? undefined : (
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || index === 0}
          onClick={() => setIndex(index - 1)}
          className="min-h-11 shrink-0 rounded-lg border border-border bg-surface px-3 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
        >
          {t("common.back")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={skip}
          className="min-h-11 shrink-0 rounded-lg border border-border bg-surface px-3 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
        >
          {t("common.skip")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={next}
          className="inline-flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-40"
        >
          {busy ? <LoaderCircle size={13} className="animate-spin" /> : null}
          {index < questions.length - 1 ? t("common.next") : t("common.submit")}
        </button>
      </div>
    );

  return (
    <BottomSheet
      open
      title={t("mobile.agent.questionRequest")}
      onClose={() => {
        if (!busy) void answer(null);
      }}
      footer={footer}
    >
      {current ? (
        <>
          {questions.length > 1 ? (
            <p className="text-ui-2xs text-slate-400">
              {t("mobile.agent.questionProgress", { i: index + 1, n: questions.length })}
            </p>
          ) : null}
          {current.header ? (
            <p className="text-ui-xs text-slate-500">{current.header}</p>
          ) : null}
          <p className="mt-1 select-text whitespace-pre-wrap text-ui-caption leading-5 text-slate-900">
            {current.question}
          </p>
          {current.detail ? (
            <p className="mt-2 max-h-60 select-text overflow-y-auto overscroll-contain rounded-lg border border-border bg-canvas px-2.5 py-2 text-ui-xs leading-5 whitespace-pre-wrap text-slate-600">
              {current.detail}
            </p>
          ) : null}
          {(current.options ?? []).length > 0 ? (
            <div className="mt-3 space-y-2">
              {(current.options ?? []).map((option) => {
                const picked = (selected[current.id] ?? []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    disabled={busy}
                    aria-pressed={picked}
                    onClick={() => {
                      if (singleSelect) {
                        void answer([{ id: current.id, selected: [option.label] }]);
                      } else {
                        toggle(option.label);
                      }
                    }}
                    className={`flex min-h-11 w-full flex-col items-start rounded-lg border px-3 py-2 text-left transition disabled:opacity-40 ${
                      picked
                        ? "border-sky-300 bg-sky-50"
                        : "border-border bg-surface active:bg-overlay-soft"
                    }`}
                  >
                    <span className="text-ui-caption text-slate-900">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 text-ui-xs leading-5 text-slate-500">
                        {option.description}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {singleSelect && hasOptions ? null : (
            <label className="mt-3 block">
              <span className="text-ui-sm text-slate-500">
                {t("mobile.agent.questionCustom")}
              </span>
              <input
                value={custom[current.id] ?? ""}
                onChange={(event) =>
                  setCustom((prev) => ({ ...prev, [current.id]: event.target.value }))
                }
                placeholder={t("mobile.agent.questionCustomPlaceholder")}
                className="mt-1.5 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-base text-slate-700 transition placeholder:text-slate-400 focus:border-sky-300 focus:outline-2 focus:outline-sky-200"
              />
            </label>
          )}
          {error ? (
            <p
              className="mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700"
              title={t("mobile.agent.questionFailed")}
            >
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-ui-caption text-slate-400">{t("common.empty")}</p>
      )}
    </BottomSheet>
  );
}

/* -------------------------------------------------------------------------
   Team board (docs/DSH.md §9.5)
   ------------------------------------------------------------------------- */

function TeamSwitch(props: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className={`relative h-6 w-10 shrink-0 rounded-full border transition ${
        props.checked ? "border-sky-300 bg-sky-100" : "border-border bg-slate-100"
      } ${props.disabled ? "opacity-40" : "active:bg-overlay-soft"}`}
    >
      <span
        className={`absolute top-1/2 h-4.5 w-4.5 -translate-y-1/2 rounded-full transition-all ${
          props.checked ? "left-[calc(100%-20px)] bg-sky-500" : "left-0.5 bg-slate-400"
        }`}
      />
    </button>
  );
}

/** Transcript/board choice; the board is the default while team mode is on. */
function ViewSwitch(props: {
  value: "chat" | "board";
  onChange: (value: "chat" | "board") => void;
}) {
  const options: ReadonlyArray<{ value: "chat" | "board"; label: MessageKey }> = [
    { value: "chat", label: "mobile.agent.viewChat" },
    { value: "board", label: "mobile.agent.viewBoard" },
  ];
  return (
    <div
      role="tablist"
      className="inline-flex shrink-0 items-center rounded-lg border border-border bg-surface p-0.5"
    >
      {options.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onChange(option.value)}
            className={`rounded-md px-2.5 py-1 text-ui-sm transition ${
              active ? "bg-slate-100 text-slate-900" : "text-slate-500 active:bg-overlay-soft"
            }`}
          >
            {t(option.label)}
          </button>
        );
      })}
    </div>
  );
}

function TeamCard(props: { task: DshTeamTask }) {
  const task = props.task;
  const scopes = task.writeScopes.slice(0, MAX_SCOPES);
  const hidden = task.writeScopes.length - scopes.length;
  return (
    <article className="rounded-lg border border-border bg-surface px-3 py-2">
      <p
        className="line-clamp-2 text-ui-caption leading-5 text-slate-900"
        title={task.description || undefined}
      >
        {task.subject}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-xs text-slate-500">
        <span className="max-w-full truncate">
          {task.ownerName || t("mobile.agent.teamUnassigned")}
        </span>
        {task.blockedBy.length > 0 ? (
          <span className="shrink-0 text-amber-700" title={task.blockedBy.join(", ")}>
            {t("mobile.agent.teamBlocked", { n: task.blockedBy.length })}
          </span>
        ) : null}
        {task.ready && task.status === "pending" ? (
          <span className="shrink-0 text-emerald-700">{t("mobile.agent.teamReady")}</span>
        ) : null}
      </p>
      {scopes.length > 0 ? (
        <p className="mt-1 flex flex-wrap gap-1">
          {scopes.map((scope) => (
            <span
              key={scope}
              title={scope}
              className="max-w-full truncate rounded-md border border-border px-1 font-mono text-ui-2xs text-slate-500"
            >
              {scope}
            </span>
          ))}
          {hidden > 0 ? (
            <span className="px-1 text-ui-2xs text-slate-400">
              {t("mobile.agent.teamMoreScopes", { n: hidden })}
            </span>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}

/** Vertical status groups; empty groups and an empty board carry no rows. */
function TeamBoard(props: { team: DshTeam | null; error: string | null }) {
  const team = props.team;
  if (!team) {
    return props.error ? (
      <p
        className="px-4 py-6 text-ui-caption leading-5 text-rose-600"
        title={t("mobile.agent.teamLoadFailed")}
      >
        {props.error}
      </p>
    ) : (
      <p className="px-4 py-6 text-ui-caption text-slate-400">{t("common.reading")}</p>
    );
  }

  return (
    <div>
      {team.failure ? (
        <p
          className="mx-4 mt-2 select-text truncate text-ui-xs leading-5 text-amber-700"
          title={team.failure}
        >
          {team.failure}
        </p>
      ) : null}

      {team.tasks.length === 0 ? (
        <p
          className="px-4 py-10 text-center text-ui-base text-slate-400"
          title={t("mobile.agent.teamEmptyHint")}
        >
          {t("mobile.agent.teamEmpty")}
        </p>
      ) : (
        TEAM_COLUMNS.map((column) => {
          const tasks = team.tasks.filter((task) => task.status === column.status);
          if (tasks.length === 0) return null;
          return (
            <section key={column.status}>
              <h2 className="mt-3 border-y border-border bg-overlay-soft px-4 py-1.5 text-ui-2xs text-slate-500">
                {t(column.label)}
              </h2>
              <div className="space-y-2 px-4 py-2">
                {tasks.map((task) => (
                  <TeamCard key={task.id} task={task} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

/**
 * One task: header (title + workflow chip), workflow actions, polled
 * transcript, answerable approvals/questions and the composer. No live token
 * streaming — the transcript is always the committed rows.
 */
export function AgentSessionPage(props: { id: string }) {
  const { id } = props;
  const feed = useAgentFeed();
  const task = useMemo(
    () => feed.tasks?.find((row) => row.id === id) ?? null,
    [feed.tasks, id],
  );
  const pending = useMemo(
    () => feed.pending.filter((item) => item.sessionId === id),
    [feed.pending, id],
  );
  const approvals = useMemo(
    () => pending.filter((item): item is ApprovalPending => item.kind === "approval"),
    [pending],
  );
  const questions = useMemo(
    () => pending.filter((item): item is QuestionPending => item.kind === "question"),
    [pending],
  );

  const [entries, setEntries] = useState<DshEntry[] | null>(null);
  /** `false` = the runtime has not seen this session yet (desktop restart). */
  const [entriesKnown, setEntriesKnown] = useState<boolean | null>(null);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const [taskBusy, setTaskBusy] = useState<TaskAction | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [activeQuestion, setActiveQuestion] = useState<number | null>(null);
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  /** Explicit pane; `null` follows the team mode default (board when on). */
  const [teamView, setTeamView] = useState<"chat" | "board" | null>(null);

  const alive = useRef(true);
  const entriesInFlight = useRef(false);
  const resumeTried = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadEntries = useCallback(
    async (poll: boolean) => {
      if (entriesInFlight.current) return;
      entriesInFlight.current = true;
      if (poll) setSyncing(true);
      // Incremental: the runtime already ships only rows past `sinceSeq`.
      // A poll without a cursor is the first read, which is a full snapshot.
      const from = poll && lastSeq.current > 0 ? lastSeq.current : undefined;
      try {
        const result = await dshApi.entries(id, from);
        if (!alive.current) return;
        // A restarted desktop answers with a smaller `lastSeq`; that
        // invalidates the suffix, so fall back to a full read.
        if (from !== undefined && result.known && result.lastSeq < lastSeq.current) {
          lastSeq.current = 0;
          entriesInFlight.current = false;
          void loadEntries(false);
          return;
        }
        if (from !== undefined && result.known) {
          const fresh = result.entries.filter((entry) => entry.seq > lastSeq.current);
          if (fresh.length > 0) {
            setEntries((current) => [...(current ?? []), ...fresh]);
          }
        } else {
          // `known: false` means the desktop restarted before the bridge saw
          // this session; the transcript is simply empty, not a failure.
          setEntries(result.entries);
        }
        lastSeq.current = result.lastSeq;
        setEntriesKnown(result.known);
        setEntriesError(null);
      } catch (err) {
        if (alive.current) setEntriesError(asApiError(err).message);
      } finally {
        entriesInFlight.current = false;
        if (alive.current && poll) setSyncing(false);
      }
    },
    [id],
  );

  useEffect(() => {
    const poll = () => {
      if (!isPageHidden()) void loadEntries(true);
    };
    void loadEntries(false);
    const timer = window.setInterval(poll, SESSION_POLL_MS);
    const off = onPageVisibilityChange(() => {
      if (isPageHidden()) return;
      void loadEntries(true);
      void refreshAgentFeed();
    });
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [loadEntries]);

  // Tool rows are merged in place (a result keeps the call's seq), so statuses
  // like `completed` only reach the phone with a full read. Do one at turn end.
  const sessionStatus = task?.status;
  useEffect(() => {
    if (sessionStatus && sessionStatus !== "running") void loadEntries(false);
  }, [sessionStatus, loadEntries]);

  // The app's only poller also refreshes this session's board while the page
  // is open, so the board never needs an interval of its own. Free chats have
  // no board, and a failed first task read simply leaves it unregistered.
  const hasTeam = Boolean(task && task.kind !== "chat");
  useEffect(() => {
    if (!hasTeam) return;
    watchAgentTeam(id);
    return () => watchAgentTeam(null);
  }, [id, hasTeam]);

  // A task restored from a previous desktop run has no live session until it
  // is resumed. Do that once, on open, so its persisted transcript appears.
  useEffect(() => {
    if (entriesKnown !== false || task === null || resumeTried.current) return;
    resumeTried.current = true;
    setResuming(true);
    setResumeError(null);
    void (async () => {
      try {
        const { task: resumed } = await dshApi.taskResume(id);
        applyAgentTask(resumed);
        await loadEntries(false);
        void refreshAgentFeed();
      } catch (err) {
        if (alive.current) setResumeError(asApiError(err).message);
      } finally {
        if (alive.current) setResuming(false);
      }
    })();
  }, [entriesKnown, task, id, loadEntries]);

  const runTaskAction = async (
    action: TaskAction,
    run: () => Promise<{ task: DshTask }>,
  ) => {
    if (taskBusy) return;
    setTaskBusy(action);
    setTaskError(null);
    try {
      const { task: updated } = await run();
      applyAgentTask(updated);
      // The workflow may have entered a new phase; the follow-up read also
      // refreshes pending and covers a lost response.
      void refreshAgentFeed();
    } catch (err) {
      if (alive.current) setTaskError(asApiError(err).message);
    } finally {
      if (alive.current) setTaskBusy(null);
    }
  };

  const approveTask = () => void runTaskAction("approve", () => dshApi.taskApprove(id));
  const mergeTask = () => void runTaskAction("merge", () => dshApi.taskMerge(id));
  const cancelTask = (stash: boolean) =>
    void runTaskAction("cancel", () => dshApi.taskCancel(id, stash));

  const openDiff = async () => {
    if (taskBusy) return;
    setTaskBusy("diff");
    setDiff(null);
    setDiffError(null);
    setDiffOpen(true);
    try {
      const result = await dshApi.taskDiff(id);
      if (alive.current) setDiff({ text: result.diff, truncated: result.truncated });
    } catch (err) {
      if (alive.current) setDiffError(asApiError(err).message);
    } finally {
      if (alive.current) setTaskBusy(null);
    }
  };

  const closeDiff = () => {
    setDiffOpen(false);
    setDiff(null);
    setDiffError(null);
  };

  const team = feed.teams[id];
  const teamEnabled = Boolean(team?.enabled);
  const boardView = teamEnabled && (teamView ?? "board") === "board";

  /** Team mode is per session; the returned board replaces the polled copy. */
  const toggleTeam = async (enabled: boolean) => {
    if (teamBusy) return;
    setTeamBusy(true);
    setTeamError(null);
    try {
      const { team: next } = await dshApi.teamSet(id, enabled);
      applyAgentTeam(id, next);
      // The new mode decides the default pane again.
      setTeamView(null);
      void refreshAgentFeed();
    } catch (err) {
      if (alive.current) setTeamError(asApiError(err).message);
    } finally {
      if (alive.current) setTeamBusy(false);
    }
  };

  const openQuestion = useMemo(
    () => questions.find((item) => item.rpcId === activeQuestion) ?? null,
    [questions, activeQuestion],
  );

  // Answered on the desktop (or cancelled by the runtime): close the sheet.
  useEffect(() => {
    if (activeQuestion !== null && openQuestion === null) setActiveQuestion(null);
  }, [activeQuestion, openQuestion]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await dshApi.prompt(id, text);
      if (!alive.current) return;
      setDraft("");
    } catch (err) {
      // The draft is kept so the message can be retried.
      if (alive.current) setSendError(asApiError(err).message);
      return;
    } finally {
      if (alive.current) setSending(false);
    }
    // The prompt is queued; entry polling picks the committed rows up.
    void loadEntries(true);
  }, [draft, sending, id, loadEntries]);

  // Composer grows with the draft up to a soft cap, then scrolls internally.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  const sorted = useMemo(
    () => (entries ? [...entries].sort((left, right) => left.seq - right.seq) : null),
    [entries],
  );

  // Follow new rows only when the reader was already at the bottom.
  useEffect(() => {
    if (!sorted || sorted.length === 0) return;
    const element = bottomRef.current;
    if (!element) return;
    const latest = sorted[sorted.length - 1].seq;
    const firstLoad = lastSeq.current === 0;
    const nearBottom = element.getBoundingClientRect().top <= window.innerHeight + 64;
    if (firstLoad || (latest > lastSeq.current && nearBottom)) {
      element.scrollIntoView({ block: "end" });
    }
    lastSeq.current = latest;
  }, [sorted]);

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Desktop keyboards send on Enter; the send button covers phones.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const title = task?.title || t("mobile.agent.untitledSession");

  /** Same cards in either pane; the board puts them above the groups. */
  const pendingCards = (
    <>
      {approvals.map((request) => (
        <ApprovalCard key={request.rpcId} request={request} />
      ))}
      {questions.map((request) => (
        <QuestionCard
          key={request.rpcId}
          request={request}
          onAnswer={() => setActiveQuestion(request.rpcId)}
        />
      ))}
    </>
  );

  return (
    <div>
      {/* Header and workflow actions share one sticky block: opening a task
          must never scroll its primary action out from under the title. */}
      <div className="sticky top-0 z-20 bg-canvas">
        <header className="flex items-center gap-1.5 border-b border-border bg-canvas px-2 py-2">
          <button
            type="button"
            aria-label={t("mobile.nav.back")}
            onClick={() => navigate("#/agent")}
            className="shrink-0 rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-900" title={title}>
            {title}
          </span>
          {task && task.kind !== "chat" ? <WorkflowChip workflow={task.workflow} /> : null}
        </header>

        {task && task.kind !== "chat" ? (
          <section className="border-b border-border bg-canvas px-4 py-1.5">
            <div className="flex items-center gap-2">
              <div
                className="inline-flex min-w-0 items-center gap-2 text-ui-xs text-slate-500"
                title={t("mobile.agent.teamToggleHint")}
              >
                <TeamSwitch
                  checked={teamEnabled}
                  disabled={teamBusy}
                  label={t("mobile.agent.teamToggle")}
                  onChange={(value) => void toggleTeam(value)}
                />
                <span className="truncate">{t("mobile.agent.teamToggle")}</span>
              </div>
              {teamEnabled ? (
                <div className="ml-auto">
                  <ViewSwitch
                    value={boardView ? "board" : "chat"}
                    onChange={(value) => setTeamView(value)}
                  />
                </div>
              ) : null}
            </div>
            {teamError ? (
              <p
                className="mt-1 text-ui-xs leading-5 text-rose-600"
                title={t("mobile.agent.teamToggleFailed")}
              >
                {teamError}
              </p>
            ) : null}
          </section>
        ) : null}

        {task && !isTerminalWorkflow(task.workflow) ? (
          <section className="border-b border-border px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {task.workflow === "awaiting_review" ? (
              <>
                <TaskButton
                  label={t("mobile.agent.approve")}
                  tone="primary"
                  busy={taskBusy === "approve"}
                  disabled={taskBusy !== null}
                  onClick={approveTask}
                />
                <TaskButton
                  label={t("mobile.agent.viewDiff")}
                  busy={taskBusy === "diff"}
                  disabled={taskBusy !== null}
                  onClick={() => void openDiff()}
                />
                <TaskButton
                  label={t("mobile.agent.stopAndStash")}
                  tone="danger"
                  busy={taskBusy === "cancel"}
                  disabled={taskBusy !== null}
                  onClick={() => cancelTask(true)}
                />
              </>
            ) : task.workflow === "awaiting_merge" ? (
              <>
                <TaskButton
                  label={t("mobile.agent.merge")}
                  tone="primary"
                  busy={taskBusy === "merge"}
                  disabled={taskBusy !== null}
                  onClick={mergeTask}
                />
                <TaskButton
                  label={t("mobile.agent.viewDiff")}
                  busy={taskBusy === "diff"}
                  disabled={taskBusy !== null}
                  onClick={() => void openDiff()}
                />
                <TaskButton
                  label={t("mobile.agent.cancelTask")}
                  tone="danger"
                  busy={taskBusy === "cancel"}
                  disabled={taskBusy !== null}
                  onClick={() => cancelTask(false)}
                />
              </>
            ) : task.workflow === "running" ? (
              <TaskButton
                label={t("mobile.agent.stop")}
                tone="danger"
                busy={taskBusy === "cancel"}
                disabled={taskBusy !== null}
                onClick={() => cancelTask(false)}
              />
            ) : null}
          </div>
          {task.workflow === "awaiting_merge" &&
          (task.merge?.error || task.merge?.instructions) ? (
            <div className="mt-2 space-y-1">
              {task.merge?.error ? (
                <p className="select-text text-ui-xs leading-5 text-rose-600">
                  {task.merge.error}
                </p>
              ) : null}
              {task.merge?.instructions ? (
                <pre className="select-text overflow-x-auto rounded-lg border border-border bg-surface px-2.5 py-2 font-mono text-ui-2xs leading-5 whitespace-pre-wrap text-slate-600">
                  {task.merge.instructions}
                </pre>
              ) : null}
            </div>
          ) : null}
          {taskError ? (
            <p
              className="mt-2 text-ui-xs leading-5 text-rose-600"
              title={t("common.actionFailed")}
            >
              {taskError}
            </p>
          ) : null}
        </section>
      ) : null}
      </div>

      {/* Fixed-height line so the poll indicator never shifts the transcript. */}
      <div className="h-5 px-4 text-ui-2xs leading-5 text-slate-400">
        {syncing || resuming ? t("mobile.agent.syncing") : ""}
      </div>

      {feed.tasksError ? (
        <p className="px-4 pb-1 text-ui-xs text-rose-600" title={t("mobile.agent.loadFailed")}>
          {feed.tasksError}
        </p>
      ) : null}

      {feed.pendingError && feed.pendingError !== feed.tasksError ? (
        <p
          className="px-4 pb-1 text-ui-xs text-rose-600"
          title={t("mobile.agent.pendingLoadFailed")}
        >
          {feed.pendingError}
        </p>
      ) : null}

      {resumeError ? (
        <p className="px-4 pb-1 text-ui-xs text-rose-600" title={t("mobile.agent.resumeFailed")}>
          {resumeError}
        </p>
      ) : null}

      {boardView ? (
        <>
          {/* A blocking ask wins over the board: the turn waits until it is
              answered, and the cards must not need a pane switch. */}
          {pendingCards}
          <TeamBoard team={team ?? null} error={feed.teamErrors[id] ?? null} />
        </>
      ) : (
        <>
          {entriesError ? (
            <p
              className="px-4 py-2 text-ui-xs text-rose-600"
              title={t("mobile.agent.entriesLoadFailed")}
            >
              {entriesError}
            </p>
          ) : null}

          {entries === null && !entriesError ? <TranscriptSkeleton /> : null}

          {sorted && sorted.length === 0 ? (
            <div className="grid place-items-center px-6 py-16 text-center">
              <p
                className="text-ui-base text-slate-400"
                title={t("mobile.agent.emptyTranscriptHint")}
              >
                {t("mobile.agent.emptyTranscript")}
              </p>
            </div>
          ) : null}

          {sorted && sorted.length > 0 ? (
            <div className="space-y-3 px-4 py-3">
              {sorted.map((entry) => (
                <EntryRow key={entry.seq} entry={entry} />
              ))}
            </div>
          ) : null}

          {pendingCards}
        </>
      )}

      <div className="sticky bottom-14 z-20 border-t border-border bg-canvas px-3 py-2">
        {sendError ? (
          <p className="mb-1 text-ui-xs leading-5 text-rose-600" title={t("mobile.agent.promptFailed")}>
            {sendError}
          </p>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={t("mobile.agent.composerPlaceholder")}
            title={t("mobile.agent.composerHint")}
            className="max-h-30 min-h-11 min-w-0 flex-1 resize-none rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-caption leading-5 text-slate-700 transition placeholder:text-slate-400 focus:border-sky-300 focus:outline-2 focus:outline-sky-200"
          />
          <button
            type="button"
            aria-label={t("common.send")}
            disabled={sending || draft.trim().length === 0}
            onClick={() => void send()}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition active:bg-primary-hover disabled:opacity-40"
          >
            {sending ? (
              <LoaderCircle size={16} className="animate-spin" />
            ) : (
              <ArrowUp size={16} />
            )}
          </button>
        </div>
      </div>

      <DiffSheet
        open={diffOpen}
        diff={diff}
        error={diffError}
        busy={taskBusy === "diff"}
        onClose={closeDiff}
      />

      {openQuestion ? (
        <QuestionSheet
          key={openQuestion.rpcId}
          pending={openQuestion}
          onClose={() => setActiveQuestion(null)}
        />
      ) : null}

      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
