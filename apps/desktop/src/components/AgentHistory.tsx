import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type Ref } from "react";
import clsx from "clsx";
import {
  Bug,
  FolderOpen,
  Loader2,
  MessagesSquare,
  RotateCcw,
  Search,
  Terminal,
  Trash2,
} from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  agentApi,
  supportsAgentChat,
  type AgentRuntimeDescriptor,
  type AgentTask,
  type AgentTaskStatus,
  type AgentWorkspaceRef,
} from "../lib/agent";
import { relativeTime } from "../lib/api";
import { bugTitle } from "../lib/bug";
import { openTaskExportDir } from "../lib/desktop";
import { t } from "../lib/i18n";
import { useAgentChat } from "../hooks/useAgentChat";
import { useDismiss } from "../hooks/useDismiss";
import { AgentChatPane } from "./AgentChatPane";
import { AgentIcon } from "./AgentIcon";
import { Badge, Button, selectClass } from "./ui";
import { Dialog } from "./Dialog";

// History only contains terminal tasks; active ones live in the run tab.
const STATUS_OPTIONS: AgentTaskStatus[] = ["succeeded", "failed", "canceled"];
const PAGE_SIZE = 50;
/** Approximate row menu box, used to keep it inside the window. */
const MENU_WIDTH = 152;
const MENU_HEIGHT = 44;

/** Anchor + target for a history row's right-click menu. */
type HistoryRowMenu = { x: number; y: number; task: AgentTask };

type Props = {
  /** Changes when a task leaves the live queue, so the first page refreshes. */
  revision?: string;
  /** History row selected by the island capsule / enqueue flow. */
  focusTaskId?: string | null;
  onOpenBug: (workspaceId: string, bugId: string) => void;
  /** Called after a retry so the parent can focus the task in the run tab. */
  onQueued?: (taskId: string) => void;
  toast: (kind: "ok" | "error", text: string) => void;
  /** Split container, measured by the page to auto-collapse the list. */
  areaRef?: Ref<HTMLDivElement>;
  /** Leave the width to the record detail. */
  listCollapsed?: boolean;
};

/** Execution records: server-filtered, paginated newest-first list plus detail. */
export function AgentHistory({
  revision,
  focusTaskId,
  onOpenBug,
  onQueued,
  toast,
  areaRef,
  listCollapsed = false,
}: Props) {
  const [workspaceFilter, setWorkspaceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | AgentTaskStatus>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [workspaces, setWorkspaces] = useState<AgentWorkspaceRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [terminalBusy, setTerminalBusy] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<HistoryRowMenu | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentTask | null>(null);
  const [chatTask, setChatTask] = useState<AgentTask | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);
  const appliedFocusRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  // 历史任务只读 transcript：打开弹窗时拉一次，不轮询。
  const historyChat = useAgentChat(chatTask?.id ?? null, false);

  // Debounce the keyword so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Runtime names for the detail pane; the catalog is static for the session.
  useEffect(() => {
    let cancelled = false;
    void agentApi
      .runtimes()
      .then((result) => {
        if (!cancelled) setRuntimes(result.runtimes);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchPage = useCallback(
    async (offset: number, focus?: string | null) => {
      const request = ++requestRef.current;
      if (offset === 0) {
        setLoading(true);
        setLoadingMore(false);
      } else {
        setLoadingMore(true);
      }
      try {
        const page = await agentApi.tasksHistory({
          workspaceId: workspaceFilter === "all" ? undefined : workspaceFilter,
          status: statusFilter === "all" ? undefined : statusFilter,
          keyword: debouncedQuery || undefined,
          taskId: focus || undefined,
          offset,
          limit: PAGE_SIZE,
        });
        if (request !== requestRef.current) return;
        setTasks((current) => (offset === 0 ? page.tasks : [...current, ...page.tasks]));
        setTotal(page.total);
        setHasMore(page.hasMore);
        setWorkspaces(page.workspaces);
        if (focus) setSelectedId(focus);
      } catch (error) {
        if (request === requestRef.current) toast("error", String(error));
      } finally {
        if (request === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [workspaceFilter, statusFilter, debouncedQuery, toast],
  );

  // First page on mount, filter change and whenever a task leaves the queue.
  useEffect(() => {
    void fetchPage(0);
  }, [fetchPage, revision]);

  // Keep a sensible selection as pages load or filters change.
  useEffect(() => {
    setSelectedId((current) => {
      if (current && tasks.some((task) => task.id === current)) return current;
      return tasks[0]?.id ?? null;
    });
  }, [tasks]);

  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  // A focus request from the island/enqueue flow wins over the current page.
  useEffect(() => {
    if (!focusTaskId || appliedFocusRef.current === focusTaskId) return;
    appliedFocusRef.current = focusTaskId;
    if (tasks.some((task) => task.id === focusTaskId)) {
      setSelectedId(focusTaskId);
      return;
    }
    void fetchPage(0, focusTaskId);
  }, [focusTaskId, tasks, fetchPage]);

  const runtimeName = (id?: string) =>
    runtimes.find((runtime) => runtime.id === id)?.name ?? id ?? "—";

  // Stable row callbacks: the list grows by 50 per "加载更多", so an inline
  // handler would recreate every row on each keystroke and each selection.
  const selectTask = useCallback((id: string) => setSelectedId(id), []);
  const openRowMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, task: AgentTask) => {
      event.preventDefault();
      setSelectedId(task.id);
      setRowMenu({ x: event.clientX, y: event.clientY, task });
    },
    [],
  );

  const retry = async (task: AgentTask) => {
    setRetryBusy(task.id);
    try {
      const { task: queued } = await agentApi.retry(task.id);
      // Jump to the run tab with the new task selected: that is the result,
      // and it is more useful than a toast saying where the task went.
      onQueued?.(queued.id);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setRetryBusy(null);
    }
  };

  /**
   * Hands the task over to a system terminal that resumes the agent session in
   * its repository. No success toast: the terminal window coming to the front
   * is the feedback.
   */
  const openTerminal = async (task: AgentTask) => {
    setTerminalBusy(task.id);
    try {
      await agentApi.openTerminal(task.id);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setTerminalBusy(null);
    }
  };

  /**
   * Deletes a finished record after the confirmation dialog. The row
   * disappearing is the feedback, so only failures toast. Export files, the bug
   * and any committed code stay untouched.
   */
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);
    try {
      await agentApi.deleteTask(target.id);
      setDeleteTarget(null);
      setTasks((current) => current.filter((task) => task.id !== target.id));
      setTotal((current) => Math.max(0, current - 1));
      void fetchPage(0);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <select
          value={workspaceFilter}
          onChange={(event) => setWorkspaceFilter(event.target.value)}
          className={selectClass}
          aria-label={t("agent.history.filterWorkspace")}
        >
          <option value="all">{t("agent.history.allWorkspaces")}</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(event) =>
            setStatusFilter(event.target.value as "all" | AgentTaskStatus)
          }
          className={selectClass}
          aria-label={t("agent.history.filterStatus")}
        >
          <option value="all">{t("agent.history.allStatuses")}</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {t(AGENT_STATUS_LABELS[status])}
            </option>
          ))}
        </select>

        <label className="relative min-w-[180px] flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("agent.history.search")}
            className="w-full rounded-lg border border-border bg-surface py-1.5 pl-8 pr-2.5 text-ui-caption text-slate-700 transition placeholder:text-slate-300 focus:border-sky-300 focus:outline-2 focus:outline-sky-200"
          />
        </label>

        <span className="shrink-0 text-ui-sm text-slate-400">
          {t("agent.history.recordCount", { count: total })}
        </span>
      </div>

      <div ref={areaRef} className="flex min-h-0 flex-1 gap-3">
        {listCollapsed ? null : (
          <div className="w-[300px] shrink-0 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 ">
            {tasks.length === 0 ? (
              <div className="grid place-items-center px-3 py-8 text-center text-ui-caption text-slate-400">
                {loading ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 size={13} className="animate-spin" />
                    {t("common.loadingEllipsis")}
                  </span>
                ) : (
                  t("agent.history.empty")
                )}
              </div>
            ) : (
              <div className="space-y-1">
                {tasks.map((task) => (
                  <HistoryRow
                    key={task.id}
                    task={task}
                    selected={task.id === selectedId}
                    onSelect={selectTask}
                    onMenu={openRowMenu}
                  />
                ))}
                {hasMore ? (
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={() => void fetchPage(tasks.length)}
                    className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-caption text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
                  >
                    {loadingMore ? <Loader2 size={12} className="animate-spin" /> : null}
                    {t("agent.history.loadMore", {
                      shown: tasks.length,
                      total,
                    })}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        )}

        <div className="min-w-0 flex-1 overflow-y-auto rounded-xl border border-border bg-surface ">
          {!selected ? (
            <div className="grid h-full place-items-center px-6 py-10 text-center text-ui-caption text-slate-400">
              {t("agent.history.selectHint")}
            </div>
          ) : (
            <div className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 flex-1 truncate text-ui-base font-normal text-slate-900">
                  {bugTitle(selected.title) || t("agent.untitled")}
                </h2>
                <Badge tone={AGENT_STATUS_TONES[selected.status]}>
                  {t(AGENT_STATUS_LABELS[selected.status])}
                </Badge>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Bug size={12} />}
                  onClick={() => onOpenBug(selected.workspaceId, selected.bugId)}
                >
                  {t("agent.openBug")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<FolderOpen size={12} />}
                  disabled={!selected.jsonPath}
                  onClick={() => openTaskExportDir(selected, toast)}
                >
                  {t("agent.header.openExport")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Terminal size={12} />}
                  disabled={
                    !(selected.worktreePath || selected.repoPath) ||
                    terminalBusy === selected.id
                  }
                  onClick={() => void openTerminal(selected)}
                >
                  {t("agent.history.openTerminal")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<MessagesSquare size={12} />}
                  disabled={
                    !supportsAgentChat(selected.runtimeId) || !selected.agentSessionId
                  }
                  onClick={() => setChatTask(selected)}
                >
                  {t("agent.history.viewChat")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={
                    retryBusy === selected.id ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RotateCcw size={12} />
                    )
                  }
                  disabled={retryBusy !== null}
                  onClick={() => void retry(selected)}
                >
                  {t("common.retry")}
                </Button>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-ui-sm sm:grid-cols-3">
                <Meta
                  label={t("agent.history.workspace")}
                  value={selected.workspaceName || selected.workspaceId}
                />
                <Meta label={t("agent.history.bugId")} value={selected.bugId} mono />
                <Meta label={t("agent.history.source")} value={selected.source || "—"} />
                <Meta label="Agent" value={runtimeName(selected.runtimeId)} />
                <Meta
                  label={t("common.created")}
                  value={relativeTime(selected.createdAt)}
                  title={selected.createdAt}
                />
                <Meta
                  label={t("agent.history.startedAt")}
                  value={selected.startedAt ? relativeTime(selected.startedAt) : "—"}
                  title={selected.startedAt}
                />
                <Meta
                  label={t("agent.history.finishedAt")}
                  value={selected.finishedAt ? relativeTime(selected.finishedAt) : "—"}
                  title={selected.finishedAt}
                />
                <Meta
                  label={t("agent.history.exitCode")}
                  value={selected.exitCode !== undefined ? String(selected.exitCode) : "—"}
                  mono
                />
                <Meta
                  label={
                    selected.worktreePath
                      ? t("agent.history.workdir")
                      : t("agent.history.repo")
                  }
                  value={selected.worktreePath || selected.repoPath || t("agent.noRepo")}
                  title={selected.worktreePath || selected.repoPath}
                  mono
                  wide
                />
                {selected.worktreeBranch ? (
                  <Meta label={t("agent.history.branch")} value={selected.worktreeBranch} mono />
                ) : null}
              </dl>

              {selected.error ? (
                <div className="select-text mt-3 break-all rounded-lg bg-rose-50 px-2.5 py-2 text-ui-sm leading-5 text-rose-700 border border-rose-100">
                  <div className="mb-0.5 font-normal">{t("agent.history.error")}</div>
                  {selected.error}
                </div>
              ) : null}

              <details className="mt-3 rounded-lg border border-slate-100 bg-slate-50/60">
                <summary className="cursor-pointer select-none px-2.5 py-1.5 text-ui-sm font-normal text-slate-600">
                  {t("agent.history.prompt")}
                </summary>
                <pre className="select-text max-h-64 overflow-auto whitespace-pre-wrap break-words px-2.5 pb-2.5 font-mono text-ui-sm leading-5 text-slate-600">
                  {selected.prompt || t("agent.history.emptyValue")}
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>

      {rowMenu ? (
        <HistoryRowContextMenu
          key={`${rowMenu.task.id}-${rowMenu.x}-${rowMenu.y}`}
          menu={rowMenu}
          onClose={() => setRowMenu(null)}
          onDelete={(task) => {
            setRowMenu(null);
            setDeleteTarget(task);
          }}
        />
      ) : null}

      {chatTask ? (
        <Dialog
          title={t("agent.history.chatTitle", {
            title: bugTitle(chatTask.title) || t("agent.untitled"),
          })}
          icon={
            <AgentIcon
              runtimeId={chatTask.runtimeId}
              name={runtimes.find((runtime) => runtime.id === chatTask.runtimeId)?.name}
              size={18}
            />
          }
          size="wide"
          bodyScroll={false}
          onClose={() => setChatTask(null)}
        >
          <div className="flex h-full min-h-0 flex-col">
            <AgentChatPane
              taskId={chatTask.id}
              runtimeId={chatTask.runtimeId}
              runtimeName={
                runtimes.find((runtime) => runtime.id === chatTask.runtimeId)?.name
              }
              chat={historyChat.data}
              chatError={historyChat.error}
              loading={historyChat.loading}
              live={false}
              onSwitchToTerminal={() => setChatTask(null)}
              toast={toast}
            />
          </div>
        </Dialog>
      ) : null}

      {deleteTarget ? (
        <Dialog
          title={t("agent.history.deleteTitle")}
          icon={<Trash2 size={15} className="text-rose-500" />}
          onClose={() => {
            if (!deleting) setDeleteTarget(null);
          }}
        >
          <p className="text-ui-caption leading-5 text-slate-600">
            {t("agent.history.deleteConfirm", {
              title: bugTitle(deleteTarget.title) || t("agent.untitled"),
            })}
          </p>
          <p className="mt-2 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-600">
            {t("agent.history.deleteHint")}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={deleting}
              onClick={() => setDeleteTarget(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={deleting}
              onClick={() => void confirmDelete()}
            >
              {t("common.delete")}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/** One history row. Memoized: only the two rows whose `selected` flips (and
 *  the row whose task object changed) re-render. */
const HistoryRow = memo(function HistoryRow(props: {
  task: AgentTask;
  selected: boolean;
  onSelect: (id: string) => void;
  onMenu: (event: ReactMouseEvent<HTMLButtonElement>, task: AgentTask) => void;
}) {
  const { task, selected, onSelect, onMenu } = props;
  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      onContextMenu={(event) => onMenu(event, task)}
      className={clsx(
        "w-full rounded-lg px-2.5 py-2 text-left transition",
        selected ? "bg-sky-50 border border-sky-200" : "hover:bg-slate-50",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Badge tone={AGENT_STATUS_TONES[task.status]} dot>
          {t(AGENT_STATUS_LABELS[task.status])}
        </Badge>
        <span className="ml-auto shrink-0 text-ui-xs text-slate-400">
          {relativeTime(task.createdAt)}
        </span>
      </div>
      <div className="mt-1 line-clamp-2 text-ui-caption font-normal leading-4 text-slate-700">
        {bugTitle(task.title) || t("agent.untitled")}
      </div>
      <div className="mt-0.5 truncate font-mono text-ui-xs text-slate-400">
        {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
      </div>
    </button>
  );
});

/** Right-click menu for a history row; dismisses like a native popup menu. */
function HistoryRowContextMenu(props: {
  menu: HistoryRowMenu;
  onClose: () => void;
  onDelete: (task: AgentTask) => void;
}) {
  const { menu, onClose, onDelete } = props;
  const menuRef = useRef<HTMLDivElement | null>(null);
  useDismiss(true, menuRef, onClose, { scroll: true, resize: true, blur: true });

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("agent.history.actions")}
      style={{
        left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8)),
        top: Math.max(8, Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8)),
      }}
      className="fixed z-50 w-[152px] overflow-hidden rounded-lg border border-border bg-surface py-1"
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => onDelete(menu.task)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui-sm text-rose-600 transition hover:bg-rose-50"
      >
        <Trash2 size={12} className="text-rose-500" />
        {t("agent.history.deleteRecord")}
      </button>
    </div>
  );
}

function Meta(props: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
  title?: string;
}) {
  return (
    <div className={clsx("min-w-0", props.wide && "col-span-2 sm:col-span-3")}>
      <dt className="text-ui-xs text-slate-400">
        {props.label}
      </dt>
      <dd
        title={props.title}
        className={clsx(
          "truncate text-slate-700",
          props.mono && "font-mono text-ui-xs",
        )}
      >
        {props.value}
      </dd>
    </div>
  );
}
