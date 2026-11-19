import { CheckCircle2, GitBranch } from "lucide-react";

import type { DshTask } from "../lib/dsh";
import { t } from "../lib/i18n";
import { Button } from "../components/ui";
import { ScrollingName } from "../components/ScrollingName";
import { HashValue } from "./HashValue";
import { agentActions } from "./store";
import { taskHashes } from "./workflow";

/**
 * The end-of-transcript receipt of a task that went through review and
 * finishing. It is deliberately a task-level card, not a turn: the model's
 * write-back answer stays above it, and this row is the facts (revisions,
 * changes, TAPD result) the user can trust.
 */
export function TaskDoneCard({ task }: { task: DshTask }) {
  const hashes = taskHashes(task);

  const writeback = task.writeback;
  const wroteStatus = Boolean(writeback.statusFrom || writeback.statusTo);
  const hint = task.direct
    ? t("agent.task.doneDirectHint")
    : task.worktreePath
      ? t("agent.task.doneKeptHint")
      : t("agent.task.doneCleanedHint");

  return (
    <section className="rounded-xl border border-border bg-surface px-3 py-2.5" data-component="TaskDoneCard">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <CheckCircle2 size={14} className="shrink-0 text-emerald-600" />
        <span className="text-ui-caption text-slate-800">
          {t("agent.task.doneTitle")}
        </span>
        {task.branch ? (
          <span className="inline-flex min-w-0 items-center gap-1 text-ui-xs text-slate-500 select-text">
            <GitBranch size={11} className="shrink-0 text-slate-400" />
            <ScrollingName text={task.branch} className="max-w-56" />
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

      {hashes.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
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

      {task.kind === "bug" && (writeback.comment || wroteStatus) ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs">
          {writeback.comment ? (
            <span className="text-emerald-700">{t("agent.task.writebackComment")}</span>
          ) : null}
          {wroteStatus ? (
            <span className="text-slate-500">
              {t("agent.task.writebackStatus", {
                from: writeback.statusFrom ?? "-",
                to: writeback.statusTo ?? "-",
              })}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <span className="text-ui-2xs leading-5 text-slate-500">{hint}</span>
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => agentActions.setTaskView(task.id, "task")}
        >
          {t("agent.task.viewTask")}
        </Button>
      </div>
    </section>
  );
}
