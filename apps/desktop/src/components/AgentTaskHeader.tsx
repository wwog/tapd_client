import { Bug, FolderOpen, Loader2, Square, Terminal } from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  type AgentTask,
} from "../lib/agent";
import { relativeTime } from "../lib/api";
import { bugTitle } from "../lib/bug";
import { Badge, Button } from "./ui";

type Props = {
  task: AgentTask;
  /** Human-readable name of the runtime that owns this task. */
  runtimeName?: string;
  canCancel: boolean;
  actionBusy: string | null;
  live: boolean;
  onCancel: () => void;
  onOpenExportDir: () => void;
  onOpenBug: () => void;
};

/** Title, metadata and action buttons above the live terminal. */
export function AgentTaskHeader(props: Props) {
  const {
    task,
    runtimeName,
    canCancel,
    actionBusy,
    live,
    onCancel,
    onOpenExportDir,
    onOpenBug,
  } = props;

  return (
    <div className="shrink-0 border-b border-slate-100 px-3.5 py-2.5">
      <div className="flex flex-wrap items-start gap-2.5">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center theme-static-dark rounded-lg bg-slate-900 text-sky-300">
          <Terminal size={14} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2
              className="truncate text-ui-base font-normal text-slate-900"
              title={bugTitle(task.title)}
            >
              {bugTitle(task.title) || "（无标题）"}
            </h2>
            <Badge tone={AGENT_STATUS_TONES[task.status]}>
              {AGENT_STATUS_LABELS[task.status]}
            </Badge>
            {runtimeName ? <Badge tone="neutral">{runtimeName}</Badge> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui-xs text-slate-400">
            <span className="shrink-0">
              {task.workspaceName || task.workspaceId} · #
              {task.bugId.slice(-7)}
            </span>
            <span
              className="min-w-0 max-w-full truncate font-mono"
              title={task.repoPath}
            >
              {task.repoPath || "未配置仓库"}
            </span>
            {task.startedAt ? (
              <span className="shrink-0">
                开始于 {relativeTime(task.startedAt)}
              </span>
            ) : null}
            {live ? (
              <span className="shrink-0">Option+拖动选中文本</span>
            ) : null}
            {task.exitCode !== undefined ? (
              <span className="shrink-0">exit {task.exitCode}</span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            icon={
              actionBusy === `cancel:${task.id}` ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Square size={11} />
              )
            }
            disabled={!canCancel || actionBusy !== null}
            onClick={onCancel}
          >
            中断
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<FolderOpen size={11} />}
            disabled={!task.mdPath}
            onClick={onOpenExportDir}
          >
            打开导出目录
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Bug size={11} />}
            onClick={onOpenBug}
          >
            打开缺陷
          </Button>
        </div>
      </div>
    </div>
  );
}
