import { useState } from "react";
import clsx from "clsx";
import { Plus, Settings2, Trash2 } from "lucide-react";

import { relativeTime } from "../lib/api";
import { t, type MessageKey } from "../lib/i18n";
import type { DshSessionStatus, DshTask, DshTaskWorkflow } from "../lib/dsh";
import { Badge, Button, Spinner } from "../components/ui";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ScrollingName } from "../components/ScrollingName";
import { agentActions, agentStore, taskActivityAt, taskLiveStatus } from "./store";

const WORKFLOW: Record<
  DshTaskWorkflow,
  { label: MessageKey; tone: "neutral" | "blue" | "green" | "amber" | "red" | "cyan" }
> = {
  running: { label: "agent.task.workflowRunning", tone: "blue" },
  awaiting_review: { label: "agent.task.workflowAwaitingReview", tone: "amber" },
  awaiting_merge: { label: "agent.task.workflowAwaitingMerge", tone: "cyan" },
  done: { label: "agent.task.workflowDone", tone: "green" },
  failed: { label: "agent.task.workflowFailed", tone: "red" },
  canceled: { label: "agent.task.workflowCanceled", tone: "neutral" },
};

type TaskGroup = { key: string; name: string; tasks: DshTask[] };

/** Projects in first-seen (newest activity) order; chat rows come last. */
function groupTasks(tasks: DshTask[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const task of tasks) {
    const key = task.project ? `${task.project.kind}:${task.project.id}` : "none";
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: task.project?.name || t("agent.task.noProject"),
        tasks: [],
      };
      groups.set(key, group);
    }
    group.tasks.push(task);
  }
  const ordered = [...groups.values()].filter((group) => group.key !== "none");
  const none = groups.get("none");
  if (none) ordered.push(none);
  return ordered;
}

/** Fixed-width task column: create, then every task grouped by project. */
export function TaskList() {
  const state = agentStore.use();
  const [deleting, setDeleting] = useState<DshTask | null>(null);
  const tasks = state.tasks;
  // Live facts win over the persisted copy: the task list only re-emits on
  // workflow transitions, while session status/activity stream continuously.
  const ordered = tasks
    ? [...tasks].sort((a, b) =>
        taskActivityAt(state, b).localeCompare(taskActivityAt(state, a)),
      )
    : null;
  const pending = new Map<string, number>();
  for (const item of [...state.approvals, ...state.questions]) {
    pending.set(item.sessionId, (pending.get(item.sessionId) ?? 0) + 1);
  }

  return (
    <aside className="flex h-full min-h-0 w-[248px] shrink-0 flex-col border-r border-border">
      <div className="p-2">
        <Button
          size="sm"
          className="w-full"
          icon={<Plus size={13} />}
          onClick={() => void agentActions.newSession()}
        >
          {t("agent.session.new")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {tasks === null ? (
          state.tasksError ? (
            <div className="px-1 py-4 text-ui-caption text-slate-400">
              <div className="break-all" title={state.tasksError}>
                {t("agent.task.loadFailed")}
              </div>
              <Button
                size="sm"
                className="mt-2"
                onClick={() => void agentActions.refreshTasks()}
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 py-6 text-ui-caption text-slate-400">
              <Spinner />
              {t("common.loading")}
            </div>
          )
        ) : (ordered?.length ?? 0) === 0 ? (
          <div
            className="px-2 py-8 text-center text-ui-caption text-slate-400"
            title={t("agent.task.emptyHint")}
          >
            {t("agent.task.empty")}
          </div>
        ) : (
          groupTasks(ordered ?? []).map((group) => (
            <section key={group.key} className="mt-1 first:mt-0">
              <h3 className="truncate px-1 py-1 text-ui-xs text-slate-400" title={group.name}>
                {group.name}
              </h3>
              <div className="flex flex-col gap-0.5">
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    selected={task.id === state.selectedId}
                    status={taskLiveStatus(state, task)}
                    updatedAt={taskActivityAt(state, task)}
                    pending={pending.get(task.id) ?? 0}
                    onDelete={setDeleting}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
      {/* Settings are page-wide, not per session: the column footer is their
          one entry point, so the conversation keeps the whole pane. */}
      <div className="shrink-0 border-t border-border p-2">
        <button
          type="button"
          onClick={() => agentActions.openConfig()}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-caption text-slate-600 transition hover:bg-overlay-soft hover:text-slate-800"
        >
          <Settings2 size={13} className="shrink-0 text-slate-400" />
          {t("agent.tab.config")}
        </button>
      </div>
      {deleting ? (
        <ConfirmDialog
          title={t("agent.session.delete")}
          message={t("agent.session.deleteHint", {
            title: deleting.title || t("agent.task.untitled"),
          })}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            if (target) void agentActions.deleteChat(target.id);
          }}
        />
      ) : null}
    </aside>
  );
}

function TaskRow({
  task,
  selected,
  status,
  updatedAt,
  pending,
  onDelete,
}: {
  task: DshTask;
  selected: boolean;
  status: DshSessionStatus;
  updatedAt: string;
  pending: number;
  onDelete: (task: DshTask) => void;
}) {
  const workflow = WORKFLOW[task.workflow];

  return (
    <div className="group relative">
      <button
        type="button"
        aria-current={selected}
        onClick={() => agentActions.selectSession(task.id)}
        className={clsx(
          "w-full rounded-lg border px-2.5 py-1.5 text-left transition",
          task.kind === "chat" && "pr-8",
          selected
            ? "border-sky-200 bg-sky-50"
            : "border-transparent hover:bg-slate-50",
        )}
      >
        <ScrollingName
          text={task.title || t("agent.task.untitled")}
          className="text-ui-caption text-slate-800"
        />
        <div className="mt-1 flex items-center gap-1.5">
          {/* A chat has no deliverable workflow; its live dot is the state. */}
          {task.kind === "chat" ? null : (
            <Badge tone={workflow.tone}>{t(workflow.label)}</Badge>
          )}
          {status === "running" ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
              title={t("agent.task.live")}
            />
          ) : null}
          {/* Blocked on a person, not working: a separate mark, because the
              running dot would mean the opposite of what is happening. */}
          {pending > 0 ? (
            <span
              className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-100 px-1 text-ui-2xs tabular-nums text-amber-700"
              title={t("agent.task.needsInput", { count: pending })}
            >
              {pending}
            </span>
          ) : null}
          {updatedAt ? (
            <span className="ml-auto min-w-0 truncate text-ui-xs text-slate-400">
              {relativeTime(updatedAt)}
            </span>
          ) : null}
        </div>
      </button>
      {task.kind === "chat" ? (
        <button
          type="button"
          title={t("agent.session.delete")}
          aria-label={t("agent.session.delete")}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(task);
          }}
          className="absolute right-1.5 top-1.5 hidden rounded-md p-1 text-slate-400 transition hover:bg-overlay hover:text-rose-600 group-hover:block"
        >
          <Trash2 size={12} />
        </button>
      ) : null}
    </div>
  );
}
