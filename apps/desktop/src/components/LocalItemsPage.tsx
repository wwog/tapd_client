import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowRight,
  Check,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";

import { EnqueueSheet } from "../agent/EnqueueSheet";
import { t } from "../lib/i18n";
import {
  localApi,
  LOCAL_ITEMS_EVENT,
  type LocalItemsEvent,
  type LocalProject,
  type WorkItem,
  type WorkItemStatus,
} from "../lib/local";
import type { ToastFn } from "../lib/feature";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, ContextMenuItem } from "./ContextMenu";
import { LocalItemDialog } from "./LocalItemDialog";
import { ScrollingName } from "./ScrollingName";
import { Segmented } from "./Segmented";
import { SkeletonRows } from "./Skeleton";
import { Button } from "./ui";

type Props = {
  project: LocalProject;
  toast: ToastFn;
};

/**
 * Three-state work item list for one local project. Items are local-only: no
 * TAPD workspace, no export package, and no task link until the built-in agent
 * flow hands them over (P4).
 */
export function LocalItemsPage({ project, toast }: Props) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkItemStatus>("pending");
  const [dialog, setDialog] = useState<{ item: WorkItem | null } | null>(null);
  /** Item whose enqueue sheet is open; one sheet serves every row. */
  const [handOver, setHandOver] = useState<WorkItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  /** Row context menu: the item and the click position. */
  const [menu, setMenu] = useState<{ item: WorkItem; x: number; y: number } | null>(
    null,
  );

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
  }, [load]);

  // The task flow changes an item's status in the database (attach → in
  // progress, done → finished, cancel/delete → restored) and emits this event.
  // A quiet reload keeps the rows on screen; if the changed item is in the
  // visible tab, follow it into its new tab like the row actions do.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<LocalItemsEvent>(LOCAL_ITEMS_EVENT, (event) => {
      const data = event.payload ?? {};
      if (data.projectId && data.projectId !== project.id) return;
      const current = data.itemId
        ? itemsRef.current.find((item) => item.id === data.itemId)
        : undefined;
      const follow =
        current && current.status === tabRef.current && data.status
          ? data.status
          : null;
      void load(true).then(() => {
        if (!disposed && follow) setTab(follow);
      });
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Without the event bridge the page still loads on mount/project
        // switch; a missed refresh must not break the list.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [load, project.id]);

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
                busy={actionBusy === item.id}
                onSetStatus={(status) => void setStatus(item, status)}
                onHandOver={() => setHandOver(item)}
                onContextMenu={(x, y) => setMenu({ item, x, y })}
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

      {menu ? (
        <ContextMenu
          key={`${menu.item.id}-${menu.x}-${menu.y}`}
          x={menu.x}
          y={menu.y}
          label={t("local.items.menu")}
          onClose={() => setMenu(null)}
        >
          {(requestClose) => (
            <>
              <ContextMenuItem
                icon={<Pencil size={14} />}
                label={t("local.items.edit")}
                onClick={() => {
                  setDialog({ item: menu.item });
                  requestClose();
                }}
              />
              <ContextMenuItem
                icon={<Trash2 size={14} />}
                label={t("local.items.delete")}
                tone="danger"
                onClick={() => {
                  setDeleteTarget(menu.item);
                  requestClose();
                }}
              />
            </>
          )}
        </ContextMenu>
      ) : null}

      {handOver ? (
        <EnqueueSheet
          target={{
            kind: "local",
            projectId: project.id,
            itemId: handOver.id,
            title: handOver.title,
          }}
          onClose={() => setHandOver(null)}
        />
      ) : null}
    </div>
  );
}

function ItemRow(props: {
  item: WorkItem;
  busy: boolean;
  onSetStatus: (status: WorkItemStatus) => void;
  onHandOver: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { item, busy, onSetStatus, onHandOver, onContextMenu } = props;

  return (
    <li>
      <article
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(event.clientX, event.clientY);
        }}
        className="flex items-start gap-2 rounded-xl border border-border bg-surface p-3 transition hover:border-slate-300"
      >
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

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
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

          {item.status !== "done" ? (
            <button
              type="button"
              title={t("local.items.toAgentHint")}
              aria-label={t("local.items.toAgent")}
              disabled={busy}
              onClick={onHandOver}
              className="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface px-2.5 py-1 text-ui-sm font-normal text-slate-600 transition hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Sparkles size={12} />
              {t("local.items.toAgent")}
            </button>
          ) : null}
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
