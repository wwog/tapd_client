import { useState } from "react";
import { Check, Eye, EyeOff, FolderOpen, GitBranch, X } from "lucide-react";

import { api } from "../lib/api";
import { dshTaskApi, type DshTask } from "../lib/dsh";
import { t } from "../lib/i18n";
import { Button, Spinner } from "../components/ui";
import { agentActions } from "./store";

/** Diff surface: monospace, read-only and copyable inside the cap the backend keeps. */
const DIFF_CLASS =
  "max-h-[45vh] select-text overflow-auto overscroll-contain whitespace-pre rounded-lg border border-border bg-slate-50 px-3 py-2 font-mono text-ui-xs leading-5 text-slate-700";

function dirName(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

/**
 * Workflow actions for the selected task. Chat tasks have no bar: they are a
 * plain conversation. Terminal tasks keep only their export folder.
 */
export function TaskActions({ task }: { task: DshTask }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | null>(null);

  const run = async (name: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(name);
    setError(null);
    try {
      await action();
      setDiffOpen(false);
      setDiff(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleDiff = async () => {
    if (busy) return;
    if (diffOpen) {
      setDiffOpen(false);
      return;
    }
    setDiffOpen(true);
    if (diff) return;
    setBusy("diff");
    setError(null);
    try {
      const result = await dshTaskApi.diff(task.id);
      setDiff({ text: result.diff, truncated: result.truncated });
    } catch (cause) {
      setError(String(cause));
      setDiffOpen(false);
    } finally {
      setBusy(null);
    }
  };

  const canViewDiff =
    task.workflow === "awaiting_review" || task.workflow === "awaiting_merge";
  const exportDir = task.jsonPath ? dirName(task.jsonPath) : "";
  const showExport =
    Boolean(exportDir) && (task.workflow === "failed" || task.workflow === "canceled");

  if (!canViewDiff && !showExport && !task.merge?.error && !task.merge?.instructions) {
    return null;
  }

  const disabled = busy !== null;

  return (
    <div className="shrink-0 border-b border-border px-5 py-2">
      <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {task.changes ? (
            <span className="text-ui-xs text-slate-500" title={t("agent.task.changesHint")}>
              {t("agent.task.changes", { files: task.changes.files })}
              <span className="ml-1 text-emerald-700">+{task.changes.additions}</span>
              <span className="ml-1 text-rose-600">−{task.changes.deletions}</span>
            </span>
          ) : null}

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {canViewDiff ? (
              <Button
                size="sm"
                icon={diffOpen ? <EyeOff size={13} /> : <Eye size={13} />}
                disabled={disabled}
                onClick={() => void toggleDiff()}
              >
                {diffOpen ? t("agent.task.hideDiff") : t("agent.task.viewDiff")}
              </Button>
            ) : null}

            {task.workflow === "awaiting_review" ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Check size={13} />}
                  loading={busy === "approve"}
                  disabled={disabled}
                  onClick={() => void run("approve", () => agentActions.approveTask(task.id))}
                >
                  {t("agent.task.approve")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<X size={13} />}
                  loading={busy === "stash"}
                  disabled={disabled}
                  onClick={() =>
                    void run("stash", () => agentActions.cancelTask(task.id, true))
                  }
                >
                  {t("agent.task.cancelStash")}
                </Button>
              </>
            ) : null}

            {task.workflow === "awaiting_merge" ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<GitBranch size={13} />}
                  loading={busy === "merge"}
                  disabled={disabled}
                  onClick={() => void run("merge", () => agentActions.mergeTask(task.id))}
                >
                  {t("agent.task.merge")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={<X size={13} />}
                  loading={busy === "cancel"}
                  disabled={disabled}
                  onClick={() => void run("cancel", () => agentActions.cancelTask(task.id))}
                >
                  {t("agent.task.cancel")}
                </Button>
              </>
            ) : null}

            {showExport ? (
              <Button
                size="sm"
                icon={<FolderOpen size={13} />}
                loading={busy === "export"}
                disabled={disabled}
                onClick={() => void run("export", () => api.openPath(exportDir))}
              >
                {t("agent.task.openExport")}
              </Button>
            ) : null}
          </div>
        </div>

        {task.merge?.error ? (
          <div className="select-text break-all text-ui-xs text-rose-600">{task.merge.error}</div>
        ) : null}
        {task.merge?.instructions ? (
          <div className="select-text whitespace-pre-wrap break-words text-ui-xs text-amber-700">
            {task.merge.instructions}
          </div>
        ) : null}
        {error ? (
          <div className="select-text break-all text-ui-xs text-rose-600">{error}</div>
        ) : null}

        {diffOpen ? (
          <div className="mt-1">
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
    </div>
  );
}
