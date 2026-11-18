import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  Check,
  FolderOpen,
  GitBranch,
  RotateCcw,
  X,
} from "lucide-react";

import { api, relativeTime } from "../lib/api";
import {
  type DshFinalizeStep,
  type DshTask,
  type DshTaskFile,
  type DshTaskFileStatus,
} from "../lib/dsh";
import { t, type MessageKey } from "../lib/i18n";
import { showToast } from "../lib/toast";
import { Button, Spinner } from "../components/ui";
import { ScrollingName } from "../components/ScrollingName";
import { agentActions, agentStore, isSessionRunning, taskReviewable } from "./store";

/** Diff surface: monospace, read-only and copyable inside the cap the backend keeps. */
const DIFF_CLASS =
  "max-h-[45vh] select-text overflow-auto overscroll-contain whitespace-pre rounded-lg border border-border bg-slate-50 px-3 py-2 font-mono text-ui-xs leading-5 text-slate-700";

const STATUS: Record<DshTaskFileStatus, MessageKey> = {
  added: "agent.review.statusAdded",
  modified: "agent.review.statusModified",
  deleted: "agent.review.statusDeleted",
  renamed: "agent.review.statusRenamed",
  untracked: "agent.review.statusUntracked",
};

const STEPS: DshFinalizeStep[] = ["commit", "merge", "cleanup", "writeback"];

const STEP_LABEL: Record<DshFinalizeStep, MessageKey> = {
  commit: "agent.review.stepCommit",
  merge: "agent.review.stepMerge",
  cleanup: "agent.review.stepCleanup",
  writeback: "agent.review.stepWriteback",
};

/**
 * Resolves a worktree-relative path under `base`, refusing anything that would
 * climb out of it: absolute paths, drive roots and any `..` segment.
 */
function joinUnder(base: string, relative: string): string | null {
  if (!base) return null;
  const clean = relative.replace(/\\/g, "/");
  if (!clean || clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) return null;
  const segments: string[] = [];
  for (const segment of clean.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." || segment.includes("\u0000")) return null;
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${segments.join(separator)}`;
}

/** Project facts shared by the header and the review body. */
function reviewPaths(task: DshTask) {
  const worktreePath = task.worktreePath ?? "";
  const repoPath = task.repoPath ?? "";
  // Changes are made in the worktree when there is one; the repository is the
  // fallback for rows that have not moved into isolation yet.
  const base = worktreePath || repoPath;
  return { worktreePath, repoPath, base };
}

/**
 * The review surface of a task: what changed, what the model says about it,
 * and the three decisions a human owns (approve, keep editing, discard).
 * `finalizing` replaces the decisions with the host's step progress and a
 * retry, because the merge is already under way.
 */
export function ReviewView({ task }: { task: DshTask }) {
  const state = agentStore.use();
  const { worktreePath, repoPath, base } = reviewPaths(task);
  const [files, setFiles] = useState<{
    files: DshTaskFile[];
    truncated: boolean;
  } | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<
    Record<string, { text: string; truncated: boolean }>
  >({});

  const running = isSessionRunning(state, task.id);
  const finalizing = task.workflow === "finalizing";
  const review = task.review ?? null;
  const finalize = task.finalize ?? null;

  // The file list is per task; refreshing on workflow changes picks up the
  // post-approve state without polling during a run.
  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setFilesError(null);
    setExpanded(null);
    setDiffs({});
    agentActions
      .taskChanges(task.id)
      .then((result) => {
        if (!cancelled) setFiles(result);
      })
      .catch((error) => {
        if (!cancelled) setFilesError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, task.workflow, reload]);

  const openDirectory = async (path: string) => {
    if (!path) return;
    try {
      await api.openDirectory(path);
    } catch (error) {
      showToast("error", t("agent.review.openFailed", { error: String(error) }));
    }
  };

  const openInIde = async (relative: string) => {
    const absolute = joinUnder(base, relative);
    if (!absolute) {
      showToast("error", t("agent.review.noPath", { path: relative }));
      return;
    }
    try {
      await api.openFile(absolute, "file");
    } catch (error) {
      showToast("error", t("agent.review.openFailed", { error: String(error) }));
    }
  };

  const toggleDiff = async (file: DshTaskFile) => {
    if (expanded === file.path) {
      setExpanded(null);
      return;
    }
    setExpanded(file.path);
    if (diffs[file.path]) return;
    try {
      const result = await agentActions.taskDiff(task.id, file.path);
      setDiffs((current) => ({
        ...current,
        [file.path]: { text: result.diff, truncated: result.truncated },
      }));
    } catch (error) {
      setDiffs((current) => ({
        ...current,
        [file.path]: { text: String(error), truncated: false },
      }));
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
    agentActions.setReviewView(task.id, "chat");
    agentActions.focusComposer();
  };

  const disabled = busy !== null || running;
  const stepIndex = finalize?.step ? STEPS.indexOf(finalize.step) : -1;
  const shownFiles = files?.files ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-3">
      <div className="mx-auto flex max-w-[46rem] flex-col gap-3 pb-3">
        {/* Project, repository and branch: the facts every decision depends on. */}
        <section className="rounded-xl border border-border bg-surface px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <ScrollingName
              text={task.project?.name || t("agent.task.noProject")}
              className="max-w-[16rem] text-ui-caption text-slate-800"
            />
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
            ) : null}
            {task.branch ? (
              <span
                className="inline-flex min-w-0 items-center gap-1 text-ui-xs text-slate-500"
                title={t("agent.review.branch")}
              >
                <GitBranch size={12} className="shrink-0 text-slate-400" />
                <ScrollingName text={task.branch} className="max-w-[16rem]" />
              </span>
            ) : null}
            {task.changes ? (
              <span
                className="ml-auto shrink-0 text-ui-xs text-slate-500"
                title={t("agent.task.changesHint")}
              >
                {t("agent.task.changes", { files: task.changes.files })}
                <span className="ml-1 text-emerald-700">+{task.changes.additions}</span>
                <span className="ml-1 text-rose-600">−{task.changes.deletions}</span>
              </span>
            ) : null}
          </div>
        </section>

        {/* What the model reported when it asked for review. */}
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

        {/* Changed files: one row each, the diff expands in place. */}
        <section className="rounded-xl border border-border bg-surface">
          <div className="flex items-center gap-2 px-3 py-2">
            <h2 className="text-ui-sm text-slate-900" title={t("agent.review.filesHint")}>
              {t("agent.review.files")}
            </h2>
            {files ? (
              <span className="text-ui-xs tabular-nums text-slate-400">
                {files.files.length}
              </span>
            ) : null}
            {filesError ? (
              <button
                type="button"
                onClick={() => setReload((value) => value + 1)}
                className="ml-auto text-ui-xs text-rose-600 transition hover:text-rose-700"
                title={filesError}
              >
                {t("common.retry")}
              </button>
            ) : null}
          </div>
          {files === null ? (
            <div className="flex items-center gap-2 border-t border-border px-3 py-3 text-ui-xs text-slate-400">
              {filesError ? (
                <span className="min-w-0 flex-1 break-all" title={filesError}>
                  {t("agent.review.filesLoadFailed")}
                </span>
              ) : (
                <>
                  <Spinner />
                  {t("common.loading")}
                </>
              )}
            </div>
          ) : shownFiles.length === 0 ? (
            <div className="border-t border-border px-3 py-3 text-ui-xs text-slate-400">
              {t("agent.task.diffEmpty")}
            </div>
          ) : (
            <div className="border-t border-border">
              {shownFiles.map((file) => {
                const open = expanded === file.path;
                const diff = diffs[file.path];
                return (
                  <div key={file.path} className="border-t border-border first:border-t-0">
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <span className="w-10 shrink-0 text-ui-2xs text-slate-400">
                        {t(STATUS[file.status])}
                      </span>
                      <button
                        type="button"
                        onClick={() => void toggleDiff(file)}
                        title={file.path}
                        className="min-w-0 flex-1 text-left"
                      >
                        <ScrollingName
                          text={file.path}
                          className="font-mono text-ui-xs text-slate-700"
                        />
                      </button>
                      <span className="shrink-0 text-ui-xs tabular-nums">
                        {file.binary ? (
                          <span className="text-slate-400">{t("agent.review.binary")}</span>
                        ) : (
                          <>
                            <span className="text-emerald-700">+{file.additions}</span>
                            <span className="ml-1 text-rose-600">−{file.deletions}</span>
                          </>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => void toggleDiff(file)}
                        className="shrink-0 rounded px-1 py-0.5 text-ui-2xs text-slate-500 transition hover:bg-overlay-soft hover:text-slate-800"
                      >
                        {open ? t("agent.task.hideDiff") : t("agent.review.viewHere")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void openInIde(file.path)}
                        className="shrink-0 rounded px-1 py-0.5 text-ui-2xs text-slate-500 transition hover:bg-overlay-soft hover:text-slate-800"
                      >
                        {t("agent.review.openIde")}
                      </button>
                    </div>
                    {open ? (
                      <div className="px-2 pb-2">
                        {diff ? (
                          <>
                            <pre className={DIFF_CLASS}>
                              {diff.text || t("agent.task.diffEmpty")}
                            </pre>
                            {diff.truncated ? (
                              <div className="mt-1 text-ui-xs text-amber-700">
                                {t("agent.task.diffTruncated")}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div className="flex items-center gap-2 py-2 text-ui-xs text-slate-400">
                            <Spinner />
                            {t("common.loading")}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          {files?.truncated ? (
            <div className="border-t border-border px-3 py-1.5 text-ui-xs text-amber-700">
              {t("agent.review.truncated")}
            </div>
          ) : null}
        </section>

        {finalizing ? (
          <section className="rounded-xl border border-border bg-surface px-3 py-2.5">
            <h2 className="text-ui-sm text-slate-900" title={t("agent.review.finalizeHint")}>
              {t("agent.review.finalize")}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {STEPS.map((step, index) => {
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
                title={t("agent.review.approveHint")}
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
              onClick={() =>
                void run("retry", () => agentActions.retryFinalize(task.id))
              }
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
          <span className="ml-auto text-ui-2xs text-slate-300">
            {relativeTime(task.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}
