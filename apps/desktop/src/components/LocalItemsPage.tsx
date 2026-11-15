import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import clsx from "clsx";
import {
  ArrowRight,
  Check,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  isAgentTerminalStatus,
  type AgentTask,
} from "../lib/agent";
import { useAgentTasksStore } from "../lib/agentStore";
import { t } from "../lib/i18n";
import {
  localApi,
  type LocalProject,
  type WorkItem,
  type WorkItemStatus,
} from "../lib/local";
import type { ToastFn } from "../lib/feature";
import { ConfirmDialog } from "./ConfirmDialog";
import { LocalItemDialog } from "./LocalItemDialog";
import { ScrollingName } from "./ScrollingName";
import { Segmented } from "./Segmented";
import { SkeletonRows } from "./Skeleton";
import { Badge, Button } from "./ui";

type Props = {
  project: LocalProject;
  /** Bumped by App after an enqueue so the linked task id is refetched. */
  refreshToken: number;
  toast: ToastFn;
  onComposeAgent: (project: LocalProject, item: WorkItem) => void;
  onOpenAgentTask: (taskId: string) => void;
};

/** Delay before a task-finished reload, so a status burst reloads once. */
const TASK_REFRESH_DELAY_MS = 350;

/**
 * Three-state work item list for one local project. Items are local-only; the
 * only Agent link is the task id the backend stores when an item is handed
 * over. Task state is read from the shared queue snapshot, not refetched.
 */
export function LocalItemsPage({
  project,
  refreshToken,
  toast,
  onComposeAgent,
  onOpenAgentTask,
}: Props) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkItemStatus>("pending");
  const [dialog, setDialog] = useState<{ item: WorkItem | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const agentState = useAgentTasksStore();
  const tasks = useMemo(() => {
    const map = new Map<string, AgentTask>();
    for (const task of agentState?.tasks ?? []) map.set(task.id, task);
    return map;
  }, [agentState]);

  // The toast callback is not a dependency of `load`: App may hand a new
  // identity each render, which would restart the fetch on every render.
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  /**
   * `quiet` reloads keep the current list on screen: task completion refreshes
   * the rows in place instead of flashing the skeleton over them.
   */
  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const { items: next } = await localApi.listItems(project.id);
        setItems(next);
        setError(null);
      } catch (cause) {
        if (quiet) toastRef.current("error", String(cause));
        else setError(String(cause));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [project.id],
  );

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  /**
   * The backend marks a linked item done when its task succeeds, without a
   * push for the item itself. A signature of live tasks changes on that
   * transition; the reload is deferred so a burst of runtime updates does not
   * fetch the list repeatedly.
   */
  const liveTaskSignature = useMemo(() => {
    const live: string[] = [];
    for (const task of agentState?.tasks ?? []) {
      if (!isAgentTerminalStatus(task.status)) {
        live.push(`${task.id}:${task.status}`);
      }
    }
    live.sort();
    return live.join("|");
  }, [agentState]);

  const lastSignature = useRef<string | null>(null);
  useEffect(() => {
    if (lastSignature.current === null || lastSignature.current === liveTaskSignature) {
      lastSignature.current = liveTaskSignature;
      return;
    }
    lastSignature.current = liveTaskSignature;
    const timer = setTimeout(() => void load(true), TASK_REFRESH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [liveTaskSignature, load]);

  const pending = items.filter((item) => item.status === "pending");
  const inProgress = items.filter((item) => item.status === "in_progress");
  const done = items.filter((item) => item.status === "done");
  const visible =
    tab === "pending" ? pending : tab === "in_progress" ? inProgress : done;

  const saveItem = async (values: { title: string; description: string }) => {
    if (dialog?.item) {
      const { item } = await localApi.updateItem(dialog.item.id, {
        title: values.title,
        description: values.description,
      });
      setItems((current) =>
        current.map((candidate) => (candidate.id === item.id ? item : candidate)),
      );
      return;
    }
    const { item } = await localApi.createItem(project.id, {
      title: values.title,
      description: values.description,
    });
    setItems((current) => [item, ...current]);
    setTab(item.status);
  };

  /** Moves the item and follows it so the row does not just disappear. */
  const setStatus = async (item: WorkItem, status: WorkItemStatus) => {
    setActionBusy(item.id);
    try {
      const { item: next } = await localApi.updateItem(item.id, { status });
      setItems((current) =>
        current.map((candidate) => (candidate.id === next.id ? next : candidate)),
      );
      setTab(next.status);
    } catch (cause) {
      toast("error", String(cause));
    } finally {
      setActionBusy(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await localApi.deleteItem(deleteTarget.id);
      setItems((current) =>
        current.filter((candidate) => candidate.id !== deleteTarget.id),
      );
      setDeleteTarget(null);
    } catch (cause) {
      toast("error", String(cause));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Segmented<WorkItemStatus>
          value={tab}
          onChange={setTab}
          options={[
            {
              value: "pending",
              label: t("local.items.pending"),
              count: pending.length,
            },
            {
              value: "in_progress",
              label: t("local.items.inProgress"),
              count: inProgress.length,
            },
            {
              value: "done",
              label: t("local.items.done"),
              count: done.length,
            },
          ]}
        />
        <Button
          size="sm"
          variant="primary"
          className="ml-auto"
          icon={<Plus size={12} />}
          onClick={() => setDialog({ item: null })}
        >
          {t("local.items.create")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <SkeletonRows
            rows={6}
            columns={["w-2/5", "w-24", "w-16"]}
            label={t("common.loading")}
          />
        ) : error ? (
          <div className="rounded-xl border border-rose-100 bg-rose-50 p-4 text-ui-caption leading-6 text-rose-700">
            <div>{t("local.items.loadFailed")}</div>
            <div className="mt-1 break-all">{error}</div>
            <Button
              size="sm"
              className="mt-3"
              icon={<RefreshCw size={13} />}
              onClick={() => void load()}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div
            className="grid place-items-center py-16 text-ui-caption text-slate-400"
            title={t("local.items.emptyHint")}
          >
            {tab === "pending"
              ? t("local.items.emptyPending")
              : tab === "in_progress"
                ? t("local.items.emptyInProgress")
                : t("local.items.emptyDone")}
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                task={item.agentTaskId ? tasks.get(item.agentTaskId) ?? null : null}
                busy={actionBusy === item.id}
                onCompose={() => onComposeAgent(project, item)}
                onSetStatus={(status) => void setStatus(item, status)}
                onEdit={() => setDialog({ item })}
                onDelete={() => setDeleteTarget(item)}
                onOpenTask={(taskId) => onOpenAgentTask(taskId)}
              />
            ))}
          </ul>
        )}
      </div>

      {dialog ? (
        <LocalItemDialog
          key={dialog.item?.id ?? "new"}
          item={dialog.item}
          onClose={() => setDialog(null)}
          onSubmit={saveItem}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title={t("local.items.delete")}
          icon={<Trash2 size={15} className="text-rose-500" />}
          message={t("local.items.deleteConfirm", { title: deleteTarget.title })}
          busy={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </div>
  );
}

function ItemRow(props: {
  item: WorkItem;
  task: AgentTask | null;
  busy: boolean;
  onCompose: () => void;
  onSetStatus: (status: WorkItemStatus) => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { item, task, busy, onCompose, onSetStatus, onEdit, onDelete, onOpenTask } =
    props;

  return (
    <li>
      <article className="flex items-start gap-2 rounded-xl border border-border bg-surface p-3 transition hover:border-slate-300">
        <div className="min-w-0 flex-1">
          <ScrollingName
            text={item.title}
            className="text-ui-caption text-slate-800"
          />
          {item.description ? (
            <ScrollingName
              text={item.description}
              className="mt-0.5 text-ui-sm text-slate-400"
            />
          ) : null}
        </div>

        {task ? (
          <Badge tone={AGENT_STATUS_TONES[task.status]} className="mt-0.5">
            {t(AGENT_STATUS_LABELS[task.status])}
          </Badge>
        ) : null}

        <div className="flex shrink-0 items-center gap-0.5">
          {item.status !== "pending" && item.agentTaskId ? (
            <RowAction
              label={t("local.items.viewTask")}
              icon={<Eye size={13} />}
              onClick={() => onOpenTask(item.agentTaskId!)}
            />
          ) : null}

          {item.status !== "done" ? (
            <RowAction
              label={t("local.items.toAgent")}
              icon={<Sparkles size={13} />}
              onClick={onCompose}
            />
          ) : null}

          {item.status === "pending" ? (
            <RowAction
              label={t("local.items.moveToProgress")}
              icon={<ArrowRight size={13} />}
              disabled={busy}
              onClick={() => onSetStatus("in_progress")}
            />
          ) : null}

          {item.status === "in_progress" ? (
            <RowAction
              label={t("local.items.moveToPending")}
              icon={<Undo2 size={13} />}
              disabled={busy}
              onClick={() => onSetStatus("pending")}
            />
          ) : null}

          {item.status === "done" ? (
            <RowAction
              label={t("local.items.reopen")}
              icon={<Undo2 size={13} />}
              disabled={busy}
              onClick={() => onSetStatus("pending")}
            />
          ) : null}

          {item.status !== "done" ? (
            <RowAction
              label={t("local.items.markDone")}
              icon={<Check size={13} />}
              disabled={busy}
              onClick={() => onSetStatus("done")}
            />
          ) : null}

          <RowAction
            label={t("local.items.edit")}
            icon={<Pencil size={13} />}
            onClick={onEdit}
          />
          <RowAction
            label={t("local.items.delete")}
            icon={<Trash2 size={13} />}
            tone="danger"
            onClick={onDelete}
          />
        </div>
      </article>
    </li>
  );
}

/** Icon-only row action; the label lives in `title` and the accessible name. */
function RowAction(props: {
  label: string;
  icon: ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  onClick: () => void;
}) {
  const { label, icon, tone = "default", disabled = false, onClick } = props;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "grid h-7 w-7 place-items-center rounded-md transition focus-visible:outline-2 focus-visible:outline-sky-200",
        tone === "danger"
          ? "text-slate-400 hover:bg-rose-50 hover:text-rose-600"
          : "text-slate-400 hover:bg-overlay hover:text-slate-700",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {icon}
    </button>
  );
}
