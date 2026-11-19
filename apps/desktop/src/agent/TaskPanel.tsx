import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  Check,
  FolderOpen,
  GitBranch,
  RotateCcw,
  X,
} from "lucide-react";

import { api, relativeTime } from "../lib/api";
import type { DshFinalizeStep, DshTask } from "../lib/dsh";
import type { FileTabTarget } from "../lib/fs";
import { t, type MessageKey } from "../lib/i18n";
import { showToast } from "../lib/toast";
import { Badge, Button, Spinner } from "../components/ui";
import { ScrollingName } from "../components/ScrollingName";
import { HashValue } from "./HashValue";
import { AGENT_COLUMN } from "./layout";
import { TaskDetailLink } from "./TaskDetailLink";
import { TaskDiffSection } from "./TaskDiffSection";
import {
  agentActions,
  agentStore,
  isSessionRunning,
  taskActivityAt,
  taskReviewable,
} from "./store";
import { WORKFLOW, taskHashes } from "./workflow";

const STEP_ORDER: DshFinalizeStep[] = ["commit", "merge", "cleanup", "writeback"];

const STEP_LABEL: Record<DshFinalizeStep, MessageKey> = {
  commit: "agent.review.stepCommit",
  merge: "agent.review.stepMerge",
  cleanup: "agent.review.stepCleanup",
  writeback: "agent.review.stepWriteback",
};

/** The task's own spawn directory, for the failed/canceled export shortcut. */
function dirName(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

/**
 * The task's own pane: what the task is, the review that is waiting for the
 * human, and the finishing result.
 *
 * The pane is the permanent home of a workflow task: it exists from `queued`
 * to `done`, unlike the old review surface that disappeared after approval.
 */
export function TaskPanel({
  task,
  onOpenFile,
}: {
  task: DshTask;
  /** Opens one changed file in the workbench viewer. */
  onOpenFile: (target: FileTabTarget) => void;
}) {
  const state = agentStore.use();
  const rootRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Open on the facts, not on the scroll offset the previous pane happened to
  // leave behind (React can reuse this scroll container in place).
  useEffect(() => {
    if (rootRef.current) rootRef.current.scrollTop = 0;
  }, [task.id]);

  const running = isSessionRunning(state, task.id);
  const finalizing = task.workflow === "finalizing";
  const done = task.workflow === "done";
  const review = task.review ?? null;
  const finalize = task.finalize ?? null;
  const changes = task.changes ?? null;
  const worktreePath = task.worktreePath ?? "";
  const repoPath = task.repoPath ?? "";
  const workflow = WORKFLOW[task.workflow];

  const steps = task.direct
    ? STEP_ORDER.filter((step) => step !== "merge" && step !== "cleanup")
    : STEP_ORDER;
  const stepIndex = finalize?.step ? steps.indexOf(finalize.step) : -1;

  const hashes = taskHashes(task);

  const hint = task.direct
    ? t("agent.task.directHint")
    : !worktreePath && (done || finalizing)
      ? t("agent.task.cleanedHint")
      : null;
  const notice = done ? finalize?.notice : undefined;

  const exportDir = task.jsonPath ? dirName(task.jsonPath) : "";
  const showExport =
    Boolean(exportDir) && (task.workflow === "failed" || task.workflow === "canceled");

  const openDirectory = async (path: string) => {
    if (!path) return;
    try {
      await api.openDirectory(path);
    } catch (error) {
      showToast("error", t("agent.review.openFailed", { error: String(error) }));
    }
  };

  const run = async (name: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(name);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const continueEditing = () => {
    agentActions.setTaskView(task.id, "chat");
    agentActions.focusComposer();
  };

  const openExport = async () => {
    if (busy) return;
    setBusy("export");
    setActionError(null);
    try {
      await api.openPath(exportDir);
    } catch (cause) {
      setActionError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null || running;

  return (
    <div
      data-component="TaskPanel"
      ref={rootRef}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-3"
    >
      <div className={`${AGENT_COLUMN} flex flex-col gap-3 pb-3`}>
        {/* What the task is and where it works. */}
        <section className="rounded-xl border border-border bg-surface px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <ScrollingName
              text={task.project?.name || t("agent.task.noProject")}
              className="max-w-[16rem] text-ui-caption text-slate-800"
            />
            <Badge tone={workflow.tone}>{t(workflow.label)}</Badge>
            {task.branch ? (
              <span
                className="inline-flex min-w-0 items-center gap-1 text-ui-xs text-slate-500"
                title={t("agent.review.branch")}
              >
                <GitBranch size={12} className="shrink-0 text-slate-400" />
                <ScrollingName text={task.branch} className="max-w-[16rem]" />
              </span>
            ) : null}
            <TaskDetailLink task={task} />
            {changes ? (
              <span
                className="ml-auto shrink-0 text-ui-xs text-slate-500"
                title={t("agent.task.changesHint")}
              >
                {t("agent.task.changes", { files: changes.files })}
                <span className="ml-1 text-emerald-700">+{changes.additions}</span>
                <span className="ml-1 text-rose-600">−{changes.deletions}</span>
              </span>
            ) : null}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {repoPath ? (
              <span className="flex min-w-0 items-center gap-1 text-ui-xs text-slate-400">
                <button
                  type="button"
                  title={t("agent.review.openProject", { path: repoPath })}
                  onClick={() => void openDirectory(repoPath)}
                  className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 transition hover:bg-overlay-soft hover:text-slate-700"
                >
                  <FolderOpen size={12} />
                  {t("agent.review.projectDir")}
                </button>
                <ScrollingName text={repoPath} className="max-w-[20rem]" />
              </span>
            ) : null}
            {worktreePath ? (
              <span className="flex min-w-0 items-center gap-1 text-ui-xs text-slate-400">
                <button
                  type="button"
                  title={t("agent.review.openWorktree", { path: worktreePath })}
                  onClick={() => void openDirectory(worktreePath)}
                  className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 transition hover:bg-overlay-soft hover:text-slate-700"
                >
                  <FolderOpen size={12} />
                  {t("agent.review.worktreeDir")}
                </button>
                <ScrollingName
                  text={worktreePath}
                  className="max-w-[18rem] font-mono text-ui-2xs"
                />
              </span>
            ) : repoPath ? (
              <span className="inline-flex min-w-0 items-center gap-1 text-ui-xs text-slate-500">
                {t("agent.task.workspaceRepo")}
              </span>
            ) : null}
          </div>

          {hashes.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2">
              {hashes.map((row) => (
                <span
                  key={row.label}
                  className="inline-flex min-w-0 items-center gap-1 text-ui-2xs text-slate-400"
                >
                  {row.label}
                  <HashValue value={row.value} />
                </span>
              ))}
            </div>
          ) : null}

          {hint ? (
            <div className="mt-1.5 text-ui-xs leading-5 text-slate-500">{hint}</div>
          ) : null}
          {notice ? (
            <div className="mt-1.5 select-text whitespace-pre-wrap break-words text-ui-xs leading-5 text-amber-700">
              {notice}
            </div>
          ) : null}
        </section>

        {/* The AI summary is optional (a turn-end review has none), but the
            changed files are what the approval decision needs. */}
        {review ? (
          <section className="rounded-xl border border-border bg-surface px-3 py-2.5">
            <h2 className="text-ui-sm text-slate-900">{t("agent.review.summary")}</h2>
            <p className="mt-1.5 select-text whitespace-pre-wrap break-words text-ui-caption leading-6 text-slate-700">
              {review.summary}
            </p>
            {review.verification ? (
              <div className="mt-2 flex gap-2">
                <span className="w-14 shrink-0 text-ui-xs text-slate-400">
                  {t("agent.review.verification")}
                </span>
                <span className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words text-ui-caption leading-6 text-slate-600">
                  {review.verification}
                </span>
              </div>
            ) : null}
            {review.risks ? (
              <div className="mt-1.5 flex gap-2">
                <span className="w-14 shrink-0 text-ui-xs text-slate-400">
                  {t("agent.review.risks")}
                </span>
                <span className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words text-ui-caption leading-6 text-amber-700">
                  {review.risks}
                </span>
              </div>
            ) : null}
          </section>
        ) : null}

        {review || changes ? (
          <TaskDiffSection task={task} onOpenFile={onOpenFile} />
        ) : null}

        {finalizing ? (
          <section className="rounded-xl border border-border bg-surface px-3 py-2.5">
            <h2 className="text-ui-sm text-slate-900" title={t("agent.review.finalizeHint")}>
              {t("agent.review.finalize")}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {steps.map((step, index) => {
                const current = index === stepIndex;
                const failed = current && Boolean(finalize?.error);
                const passed = stepIndex >= 0 && index < stepIndex;
                return (
                  <span
                    key={step}
                    className={clsx(
                      "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-ui-xs",
                      failed
                        ? "border-rose-200 bg-rose-50 text-rose-700"
                        : current
                          ? "border-sky-200 bg-sky-50 text-sky-700"
                          : passed
                            ? "border-border text-slate-500"
                            : "border-transparent text-slate-300",
                    )}
                  >
                    {passed ? <Check size={11} /> : null}
                    {t(STEP_LABEL[step])}
                  </span>
                );
              })}
            </div>
            {finalize?.error ? (
              <div className="mt-2 select-text whitespace-pre-wrap break-words text-ui-xs text-rose-600">
                {finalize.error}
              </div>
            ) : null}
            {finalize?.instructions ? (
              <div className="mt-1.5 select-text whitespace-pre-wrap break-words text-ui-xs text-amber-700">
                {finalize.instructions}
              </div>
            ) : null}
            {finalize?.notice ? (
              <div className="mt-1.5 select-text whitespace-pre-wrap break-words text-ui-xs text-slate-500">
                {finalize.notice}
              </div>
            ) : null}
          </section>
        ) : null}

        {done &&
        task.kind === "bug" &&
        (task.git.commit ||
          task.writeback.comment ||
          task.writeback.statusFrom ||
          task.writeback.statusTo) ? (
          <section className="rounded-xl border border-border bg-surface px-3 py-2.5">
            <h2 className="text-ui-sm text-slate-900">{t("agent.task.writeback")}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs">
              {task.writeback.comment ? (
                <span className="text-emerald-700">
                  {t("agent.task.writebackComment")}
                </span>
              ) : null}
              {task.writeback.statusFrom || task.writeback.statusTo ? (
                <span className="text-slate-600">
                  {t("agent.task.writebackStatus", {
                    from: task.writeback.statusFrom ?? "-",
                    to: task.writeback.statusTo ?? "-",
                  })}
                </span>
              ) : null}
              {!task.writeback.comment &&
              !task.writeback.statusFrom &&
              !task.writeback.statusTo ? (
                <span className="text-slate-400">{t("agent.task.writebackPending")}</span>
              ) : null}
            </div>
          </section>
        ) : null}

        {actionError ? (
          <div className="select-text break-all text-ui-xs text-rose-600">{actionError}</div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {taskReviewable(task) && !finalizing ? (
            <>
              <Button
                size="sm"
                variant="primary"
                icon={<Check size={13} />}
                loading={busy === "approve"}
                disabled={disabled}
                title={
                  task.direct
                    ? t("agent.task.approveDirectHint")
                    : t("agent.review.approveHint")
                }
                onClick={() => void run("approve", () => agentActions.approveTask(task.id))}
              >
                {t("agent.review.approve")}
              </Button>
              <Button
                size="sm"
                disabled={busy !== null}
                title={t("agent.review.continueHint")}
                onClick={continueEditing}
              >
                {t("agent.review.continue")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={<X size={13} />}
                loading={busy === "discard"}
                disabled={disabled}
                title={t("agent.review.discardHint")}
                onClick={() =>
                  void run("discard", () => agentActions.cancelTask(task.id, true))
                }
              >
                {t("agent.review.discard")}
              </Button>
            </>
          ) : null}
          {finalizing && finalize?.error ? (
            <Button
              size="sm"
              icon={<RotateCcw size={13} />}
              loading={busy === "retry"}
              disabled={busy !== null}
              title={t("agent.review.retryHint")}
              onClick={() => void run("retry", () => agentActions.retryFinalize(task.id))}
            >
              {t("agent.review.retry")}
            </Button>
          ) : null}
          {finalizing && !finalize?.error ? (
            <span className="flex items-center gap-2 text-ui-xs text-slate-400">
              <Spinner />
              {t("agent.review.finalizing")}
            </span>
          ) : null}
          {showExport ? (
            <Button
              size="sm"
              icon={<FolderOpen size={13} />}
              loading={busy === "export"}
              disabled={busy !== null}
              onClick={() => void openExport()}
            >
              {t("agent.task.openExport")}
            </Button>
          ) : null}
          <span className="ml-auto text-ui-2xs text-slate-300">
            {relativeTime(taskActivityAt(state, task))}
          </span>
        </div>
      </div>
    </div>
  );
}
