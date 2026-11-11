import { Bug, Hourglass, Loader2, X } from "lucide-react";

import type { AgentTask } from "../lib/agent";
import { relativeTime } from "../lib/api";
import { bugTitle } from "../lib/bug";
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
                {bugTitle(task.title) || "（无标题）"}
              </h2>
              <Badge tone="neutral">排队中</Badge>
              {runtimeName ? <Badge tone="neutral">{runtimeName}</Badge> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui-xs text-slate-400">
              <span className="shrink-0">
                {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
              </span>
              <span
                className="min-w-0 max-w-full truncate font-mono"
                title={task.repoPath}
              >
                {task.repoPath || "未配置仓库"}
              </span>
              <span className="shrink-0">入队 {relativeTime(task.createdAt)}</span>
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
              取消排队
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Bug size={11} />}
              onClick={props.onOpenBug}
            >
              打开缺陷
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
                ? `前面还有 ${position - 1} 个任务；开始后 opencode 终端会显示在这里。`
                : "下一个就轮到它；开始后 opencode 终端会显示在这里。"
            }
          >
            排队第 {position} 位
          </p>
          {props.queuePaused ? (
            <p className="mt-2 text-ui-sm text-amber-600">
              队列已暂停，点击右上角「继续队列」恢复执行。
            </p>
          ) : null}
          {task.repoPath ? (
            <p
              className="mt-2 break-all font-mono text-ui-xs text-slate-400"
              title={task.repoPath}
            >
              {task.repoPath}
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
