import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
  Plus,
  Settings2,
  Trash2,
  Workflow,
} from "lucide-react";

import { api, relativeTime } from "../lib/api";
import { t } from "../lib/i18n";
import { showToast } from "../lib/toast";
import type {
  DshProject,
  DshSessionStatus,
  DshTask,
  DshTaskProject,
} from "../lib/dsh";
import { dshTaskApi } from "../lib/dsh";
import { readPref, writePref } from "../lib/uiPrefs";
import { Button, Spinner } from "../components/ui";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ContextMenu, ContextMenuItem } from "../components/ContextMenu";
import { ScrollingName } from "../components/ScrollingName";
import { agentActions, agentStore, taskActivityAt, taskLiveStatus } from "./store";
import { TaskHoverCard } from "./TaskHoverCard";
import { WORKFLOW, WORKFLOW_MARK, isWorkflowTask } from "./workflow";

/** Which project groups are folded shut, by group key. */
const COLLAPSED_PREF = "agent.collapsed-projects.v1";
/** The group that collects sessions without a project; always rendered last. */
const NO_PROJECT_KEY = "none";

type TaskGroup = {
  key: string;
  name: string;
  /** The project a header「+」creates in; `null` for「未关联项目」. */
  project: Pick<DshTaskProject, "kind" | "id"> | null;
  tasks: DshTask[];
};

const projectKey = (project: Pick<DshTaskProject, "kind" | "id">): string =>
  `${project.kind}:${project.id}`;

/**
 * One group per configured project, in the backend's order, plus a trailing
 * group for everything without a project. Empty projects still get their
 * header (and its +), which is how a project is picked for a new chat.
 */
function groupTasks(
  tasks: DshTask[],
  projects: DshProject[] | null,
): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  const ensure = (
    project: Pick<DshTaskProject, "kind" | "id"> | null,
    name: string,
  ): TaskGroup => {
    const key = project ? projectKey(project) : NO_PROJECT_KEY;
    let group = groups.get(key);
    if (!group) {
      group = { key, name, project, tasks: [] };
      groups.set(key, group);
    }
    return group;
  };

  for (const project of projects ?? []) {
    ensure({ kind: project.kind, id: project.id }, project.name);
  }
  for (const task of tasks) {
    const project = task.project;
    ensure(
      project,
      project?.name || t("agent.task.noProject"),
    ).tasks.push(task);
  }

  const ordered = [...groups.values()].filter(
    (group) => group.key !== NO_PROJECT_KEY,
  );
  ensure(null, t("agent.task.noProject"));
  const none = groups.get(NO_PROJECT_KEY);
  if (none) ordered.push(none);
  return ordered;
}

/** Fixed-width task column: every project group, then the unassigned chats. */
export function TaskList() {
  const state = agentStore.use();
  const [deleting, setDeleting] = useState<DshTask | null>(null);
  const [menu, setMenu] = useState<{ task: DshTask; x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(readPref<string[]>(COLLAPSED_PREF) ?? []),
  );
  const tasks = state.tasks;

  /** Opens the session's own directory (worktree, repo, or chat scratch dir). */
  const reveal = async (task: DshTask) => {
    try {
      const { path, exists } = await dshTaskApi.sessionDir(task.id);
      if (!exists) throw new Error(path);
      await api.openPath(path);
    } catch (error) {
      showToast("error", t("agent.session.revealFailed", { error: String(error) }));
    }
  };

  const toggleGroup = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
    writePref(COLLAPSED_PREF, [...next]);
  };
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

  const groups = ordered ? groupTasks(ordered, state.projects) : [];
  const empty = ordered !== null && ordered.length === 0 && !state.projects?.length;

  return (
    <aside data-component="TaskList" className="flex h-full min-h-0 w-[248px] shrink-0 flex-col border-r border-border">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 pt-2">
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
        ) : empty ? (
          <div
            className="px-2 py-8 text-center text-ui-caption text-slate-400"
            title={t("agent.task.emptyHint")}
          >
            {t("agent.task.empty")}
          </div>
        ) : (
          groups.map((group) => {
            const folded = collapsed.has(group.key);
            const rows = folded ? [] : group.tasks;
            return (
              <section key={group.key} className="mt-1 first:mt-0">
                {/* Hover and highlight belong to the whole group row: the
                    「+」is part of the header, not a second hit target. */}
                <div className="group/grp flex items-center gap-0.5 rounded px-1 py-1 transition hover:bg-overlay-soft">
                  <button
                    type="button"
                    aria-expanded={!folded}
                    onClick={() => toggleGroup(group.key)}
                    className="flex min-w-0 flex-1 items-center gap-1 text-left text-ui-xs text-slate-400 transition group-hover/grp:text-slate-600"
                  >
                    <ChevronRight
                      size={11}
                      className={clsx("shrink-0 transition-transform", !folded && "rotate-90")}
                    />
                    <Folder size={12} className="shrink-0" />
                    <ScrollingName text={group.name} className="min-w-0 flex-1" />
                    <span className="shrink-0 tabular-nums text-ui-2xs text-slate-300">
                      {group.tasks.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    title={t("agent.task.newInProject", { name: group.name })}
                    aria-label={t("agent.task.newInProject", { name: group.name })}
                    onClick={() => {
                      // The new row lands in this group; a folded group would
                      // hide the session the click just created.
                      if (collapsed.has(group.key)) toggleGroup(group.key);
                      void agentActions.newSession(group.project ?? undefined);
                    }}
                    className="grid h-5 w-5 shrink-0 place-items-center rounded text-slate-400 transition group-hover/grp:text-slate-600 hover:text-slate-800"
                  >
                    <Plus size={12} />
                  </button>
                </div>
                {rows.length > 0 ? (
                  // No guide line: the status glyph owns the left gutter, so
                  // the row text still lines up with the project name and a
                  // running spinner never shifts the title.
                  <div className="flex flex-col gap-0.5">
                    {rows.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        selected={task.id === state.selectedId}
                        status={taskLiveStatus(state, task)}
                        updatedAt={taskActivityAt(state, task)}
                        pending={pending.get(task.id) ?? 0}
                        model={state.sessions[task.id]?.usage.model || undefined}
                        onDelete={setDeleting}
                        onMenu={(target, x, y) => setMenu({ task: target, x, y })}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })
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
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.task.title || t("agent.task.untitled")}
          onClose={() => setMenu(null)}
        >
          {(close) => (
            <>
              <ContextMenuItem
                label={t("agent.session.reveal")}
                icon={<FolderOpen size={13} />}
                onClick={() => {
                  close();
                  void reveal(menu.task);
                }}
              />
              <ContextMenuItem
                label={t("agent.session.delete")}
                icon={<Trash2 size={13} />}
                tone="danger"
                onClick={() => {
                  close();
                  setDeleting(menu.task);
                }}
              />
            </>
          )}
        </ContextMenu>
      ) : null}
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
            if (target) void agentActions.deleteSession(target.id);
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
  model,
  onDelete,
  onMenu,
}: {
  task: DshTask;
  selected: boolean;
  status: DshSessionStatus;
  updatedAt: string;
  pending: number;
  model?: string;
  onDelete: (task: DshTask) => void;
  onMenu: (task: DshTask, x: number, y: number) => void;
}) {
  const workflow = WORKFLOW[task.workflow];
  const mark = WORKFLOW_MARK[task.workflow];

  // The hover card opens after a short dwell and closes after a short grace
  // period, so the pointer can travel onto the card through the gap.
  const [hoverOpen, setHoverOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const enterTimer = useRef<number | undefined>(undefined);
  const leaveTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(enterTimer.current);
      window.clearTimeout(leaveTimer.current);
    },
    [],
  );
  const openHover = () => {
    window.clearTimeout(leaveTimer.current);
    window.clearTimeout(enterTimer.current);
    enterTimer.current = window.setTimeout(() => {
      const rect = rowRef.current?.getBoundingClientRect();
      if (rect) setAnchor(rect);
      setHoverOpen(true);
    }, 250);
  };
  const closeHover = () => {
    window.clearTimeout(enterTimer.current);
    leaveTimer.current = window.setTimeout(() => setHoverOpen(false), 120);
  };
  const cancelClose = () => window.clearTimeout(leaveTimer.current);

  return (
    <div
      data-component="TaskRow"
      ref={rowRef}
      className="group relative"
      onMouseEnter={openHover}
      onMouseLeave={closeHover}
    >
      {/* Left gutter: blocked on a person wins over running, because the
          spinner would mean the opposite of what is happening. The workflow
          mark sits beside it; both stay out of the title's flow. */}
      <span className="pointer-events-none absolute left-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {pending > 0 ? (
          <span
            className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-100 px-1 text-ui-2xs tabular-nums text-amber-700"
            title={t("agent.task.needsInput", { count: pending })}
          >
            {pending}
          </span>
        ) : status === "running" ? (
          <span className="shrink-0" title={t("agent.task.live")}>
            <Loader2 size={12} className="animate-spin text-slate-400" />
          </span>
        ) : null}
        {isWorkflowTask(task) ? (
          <span className="shrink-0" title={t(workflow.label)}>
            <Workflow size={11} className={mark} />
          </span>
        ) : null}
      </span>
      <button
        type="button"
        aria-current={selected}
        onClick={() => agentActions.selectSession(task.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(task, event.clientX, event.clientY);
        }}
        className={clsx(
          // The status glyph lives in the left gutter, so the title starts at
          // the same x as the project name whether or not it is spinning.
          "flex w-full items-center gap-1.5 rounded-lg border py-1.5 pl-9 pr-2 text-left transition",
          selected
            ? "border-sky-200 bg-sky-50"
            : "border-transparent hover:bg-slate-50",
        )}
      >
        <ScrollingName
          text={task.title || t("agent.task.untitled")}
          className="min-w-0 flex-1 text-ui-caption text-slate-800"
        />
        {updatedAt ? (
          <span className="shrink-0 text-ui-2xs tabular-nums text-slate-400 transition group-hover:opacity-0">
            {relativeTime(updatedAt)}
          </span>
        ) : null}
      </button>
      {/* Row-end delete mirrors the screenshot's trailing action; the time
          yields its spot while hovering. */}
      <button
        type="button"
        title={t("agent.session.delete")}
        aria-label={t("agent.session.delete")}
        onClick={() => onDelete(task)}
        className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-slate-400 opacity-0 transition hover:bg-overlay-soft hover:text-rose-600 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 size={12} />
      </button>
      {hoverOpen && anchor ? (
        <TaskHoverCard
          task={task}
          status={status}
          pending={pending}
          model={model}
          updatedAt={updatedAt}
          anchor={anchor}
          onClose={() => setHoverOpen(false)}
          onEnter={cancelClose}
          onLeave={closeHover}
        />
      ) : null}
    </div>
  );
}
