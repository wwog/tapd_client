import { Bug, Hourglass, Loader2, X } from "lucide-react";

import type { AgentTask } from "../lib/agent";
import { relativeTime } from "../lib/api";
import { bugTitle } from "../lib/bug";
import { t } from "../lib/i18n";
import { Badge, Button } from "./ui";

type Props = {
  task: AgentTask;
  /** Human-readable name of the runtime that will pick the task up. */
  runtimeName?: string;
  position: number;
  queuePaused: boolean;
  busy: string | null;
  onCancel: () => void;
  onOpenBug: () => void;
};

/** Right pane while the selected task is still waiting in the FIFO queue. */
export function AgentQueuedDetail(props: Props) {
  const { task, runtimeName, position } = props;
  const cancelKey = `cancel:${task.id}`;
  return (
    <>
      <div className="shrink-0 border-b border-slate-100 px-4 py-3">
        <div className="flex flex-wrap items-start gap-2.5">
          <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
            <Hourglass size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2
                className="truncate text-ui-base font-normal text-slate-900"
                title={bugTitle(task.title)}
              >
                {bugTitle(task.title) || t("agent.untitled")}
              </h2>
              <Badge tone="neutral">{t("agent.status.queued")}</Badge>
              {runtimeName ? <Badge tone="neutral">{runtimeName}</Badge> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui-xs text-slate-400">
              <span className="shrink-0">
                {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
              </span>
              {task.worktreeBranch ? (
                <span
                  className="min-w-0 max-w-full truncate font-mono text-sky-700"
                  title={task.worktreePath ?? task.worktreeBranch}
                >
                  ⎇ {task.worktreeBranch}
                </span>
              ) : (
                <span
                  className="min-w-0 max-w-full truncate font-mono"
                  title={task.repoPath}
                >
                  {task.repoPath || t("agent.noRepo")}
                </span>
              )}
              <span className="shrink-0">
                {t("agent.queue.enqueuedAt", { time: relativeTime(task.createdAt) })}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              icon={
                props.busy === cancelKey ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <X size={11} />
                )
              }
              disabled={props.busy !== null}
              onClick={props.onCancel}
            >
              {t("agent.queue.cancel")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Bug size={11} />}
              onClick={props.onOpenBug}
            >
              {t("agent.openBug")}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-slate-50/70 p-6 text-center">
        <div className="grid h-12 w-12 place-items-center theme-static-dark rounded-2xl bg-slate-900 text-sky-300">
          <Hourglass size={22} />
        </div>
        <div>
          <p
            className="text-ui-base text-slate-700"
            title={
              position > 1
                ? t("agent.queue.ahead", {
                    count: position - 1,
                  })
                : t("agent.queue.next")
            }
          >
            {t("agent.queue.position", { position })}
          </p>
          {props.queuePaused ? (
            <p className="mt-2 text-ui-sm text-amber-600">
              {t("agent.queue.pausedHint")}
            </p>
          ) : null}
          {task.worktreePath || task.repoPath ? (
            <p
              className="mt-2 break-all font-mono text-ui-xs text-slate-400"
              title={task.worktreePath || task.repoPath}
            >
              {task.worktreePath || task.repoPath}
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
