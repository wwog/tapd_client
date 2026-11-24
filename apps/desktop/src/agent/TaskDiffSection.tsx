import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { dshFileApi } from "../lib/dsh";
import type { DshTask, DshTaskFile, DshTaskFileStatus } from "../lib/dsh";
import type { FileTabTarget } from "../lib/fs";
import { t, useLocale, type MessageKey } from "../lib/i18n";
import { showToast } from "../lib/toast";
import { Spinner } from "../components/ui";
import { ScrollingName } from "../components/ScrollingName";
import { DiffView } from "../../../shared/agent/DiffView";
import { agentActions } from "./store";

/** The diff scrolls inside the pane; the backend's char cap is much taller. */
const DIFF_HEIGHT = "max-h-[45vh]";

const STATUS: Record<DshTaskFileStatus, MessageKey> = {
  added: "agent.review.statusAdded",
  modified: "agent.review.statusModified",
  deleted: "agent.review.statusDeleted",
  renamed: "agent.review.statusRenamed",
  untracked: "agent.review.statusUntracked",
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

/** Changes are made in the worktree when there is one; a finished task whose
 *  worktree was cleaned up reads the repository. */
function reviewBase(task: DshTask): string {
  return task.worktreePath || task.repoPath || "";
}

/**
 * The changed-file list of one task: one row each, the diff expands in place,
 * and a file can be opened in the saved editor. Shared by the task pane; the
 * review decision lives above it.
 */
export function TaskDiffSection({
  task,
  onOpenFile,
}: {
  task: DshTask;
  /** Opens the file in the workbench viewer instead of expanding a panel. */
  onOpenFile: (target: FileTabTarget) => void;
}) {
  const base = reviewBase(task);
  const locale = useLocale();
  const [files, setFiles] = useState<{
    files: DshTaskFile[];
    truncated: boolean;
  } | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** A failed fetch is kept apart from the diff text, so it never renders as content. */
  const [diffs, setDiffs] = useState<
    Record<string, { text: string; truncated: boolean; error?: string }>
  >({});

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

  /** 「应用内查看」: the viewer tab shows this file against the task baseline. */
  const openInViewer = async (relative: string) => {
    const absolute = joinUnder(base, relative);
    if (!absolute) {
      showToast("error", t("agent.review.noPath", { path: relative }));
      return;
    }
    try {
      const target = await dshFileApi.target(task.id, absolute);
      if (target.kind !== "file") {
        showToast("error", t("agent.file.missing", { path: relative }));
        return;
      }
      onOpenFile({
        workspaceId: target.workspaceId,
        path: target.path,
        label: target.label,
        // The tab diffs the file against the task's baseline itself; only the
        // file identity travels, never line numbers.
        review: { sessionId: task.id, file: relative },
      });
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
        [file.path]: { text: "", truncated: false, error: String(error) },
      }));
    }
  };

  const shownFiles = files?.files ?? [];

  return (
    <section data-component="TaskDiffSection" className="rounded-xl border border-border bg-surface">
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
                    title={open ? t("agent.task.hideDiff") : file.path}
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
                    onClick={() => void openInViewer(file.path)}
                    title={t("agent.review.viewHereHint")}
                    className="shrink-0 rounded px-1 py-0.5 text-ui-2xs text-slate-500 transition hover:bg-overlay-soft hover:text-slate-800"
                  >
                    {t("agent.review.viewHere")}
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
                        {diff.error ? (
                          // A failed read is not diff content: say so plainly
                          // instead of tinting the error like a removed line.
                          <p
                            className="select-text rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-xs leading-5 text-rose-700"
                            title={diff.error}
                          >
                            {t("agent.task.diffFailed")}
                          </p>
                        ) : (
                          <DiffView
                            text={diff.text}
                            locale={locale}
                            placeholder={t("agent.task.diffEmpty")}
                            className={DIFF_HEIGHT}
                          />
                        )}
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
  );
}
