import { ListOrdered, Loader2, ShieldAlert } from "lucide-react";
import clsx from "clsx";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  type AgentRuntimeStatus,
  type AgentTask,
} from "../lib/agent";
import { relativeTime } from "../lib/api";
import { bugTitle } from "../lib/bug";
import { Badge } from "./ui";

type Props = {
  loaded: boolean;
  runTasks: AgentTask[];
  activeRunTasks: AgentTask[];
  queuedTasks: AgentTask[];
  selectedId: string | null;
  queuePosition: (task: AgentTask) => number | null;
  /** 运行中 Agent 的当前状态，key 是 task id。 */
  runtimeStatus?: Record<string, AgentRuntimeStatus>;
  onSelect: (taskId: string) => void;
};

/** Fixed column width; the run split derives its auto-collapse threshold from it. */
export const QUEUE_PANE_WIDTH = 300;

/** Left column of the run tab: active work first, then the FIFO queue. */
export function AgentQueuePane(props: Props) {
  const {
    loaded,
    runTasks,
    activeRunTasks,
    queuedTasks,
    selectedId,
    queuePosition,
    runtimeStatus,
    onSelect,
  } = props;

  return (
    <aside
      className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-surface "
      style={{ width: QUEUE_PANE_WIDTH }}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 px-3 py-2">
        <ListOrdered size={13} className="text-slate-400" />
        <span className="text-ui-sm text-slate-500">执行队列</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {!loaded ? (
          <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-slate-400">
            <Loader2 size={14} className="animate-spin" />
            正在读取…
          </div>
        ) : runTasks.length === 0 ? (
          <div
            className="flex h-full items-center justify-center px-3 text-center text-ui-caption text-slate-400"
            title="在缺陷详情点击「用 Agent 修复」后会排在这里"
          >
            队列为空
          </div>
        ) : (
          <div className="space-y-1">
            {activeRunTasks.length > 0 ? (
              <QueueGroup label="正在运行" />
            ) : null}
            {activeRunTasks.map((task) => (
              <RunQueueRow
                key={task.id}
                task={task}
                status={runtimeStatus?.[task.id]}
                selected={task.id === selectedId}
                onSelect={() => onSelect(task.id)}
              />
            ))}

            {queuedTasks.length > 0 ? (
              <QueueGroup label={`排队中 ${queuedTasks.length}`} />
            ) : null}
            {queuedTasks.map((task) => (
              <RunQueueRow
                key={task.id}
                task={task}
                status={runtimeStatus?.[task.id]}
                position={queuePosition(task)}
                selected={task.id === selectedId}
                onSelect={() => onSelect(task.id)}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function QueueGroup({ label }: { label: string }) {
  return (
    <div className="px-1.5 pb-1 pt-2 text-ui-xs font-normal text-slate-400 first:pt-0.5">
      {label}
    </div>
  );
}

function RunQueueRow(props: {
  task: AgentTask;
  status?: AgentRuntimeStatus;
  position?: number | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const { task, position, status } = props;
  const spinning = task.status === "preparing" || task.status === "running";
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={clsx(
        "w-full rounded-lg px-2.5 py-2 text-left transition",
        props.selected ? "bg-sky-50 border border-sky-200" : "hover:bg-slate-50",
      )}
    >
      <div className="flex items-center gap-1.5">
        {position ? (
          <span
            className="grid h-4 min-w-4 place-items-center rounded bg-slate-100 px-1 font-mono text-ui-2xs text-slate-500"
            title={`排队第 ${position} 位`}
          >
            {position}
          </span>
        ) : spinning ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-sky-500" />
        ) : (
          <ShieldAlert size={11} className="shrink-0 text-rose-500" />
        )}
        <Badge tone={AGENT_STATUS_TONES[task.status]} dot={task.status === "queued"}>
          {AGENT_STATUS_LABELS[task.status]}
        </Badge>
        <span className="ml-auto shrink-0 text-ui-xs text-slate-400">
          {task.status === "queued"
            ? relativeTime(task.createdAt)
            : task.startedAt
              ? relativeTime(task.startedAt)
              : ""}
        </span>
      </div>
      <div
        className="mt-1 line-clamp-2 text-ui-caption font-normal leading-4 text-slate-700"
        title={bugTitle(task.title)}
      >
        {bugTitle(task.title) || "（无标题）"}
      </div>
      <div className="mt-0.5 truncate font-mono text-ui-xs text-slate-400">
        {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
      </div>
      {status ? (
        <div className="mt-0.5 truncate text-ui-xs text-sky-600" title={status.label}>
          {status.label}
          {status.tool ? ` · ${status.tool}` : ""}
        </div>
      ) : null}
    </button>
  );
}
