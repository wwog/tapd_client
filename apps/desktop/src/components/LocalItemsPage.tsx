import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowRight,
  Check,
  Pencil,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";

import { EnqueueControl } from "../agent/EnqueuePopover";
import { formatDateTime } from "../lib/format";
import { t } from "../lib/i18n";
import {
  localApi,
  LOCAL_ITEMS_EVENT,
  registerLocalItemCreate,
  type LocalItemsEvent,
  type LocalProject,
  type WorkItem,
  type WorkItemStatus,
} from "../lib/local";
import type { ToastFn } from "../lib/feature";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, ContextMenuItem } from "./ContextMenu";
import { ImportanceBadge } from "./ImportanceBadge";
import { LocalItemDialog, type LocalItemValues } from "./LocalItemDialog";
import { ScrollingName } from "./ScrollingName";
import { Segmented } from "./Segmented";
import { SkeletonRows } from "./Skeleton";
import { Badge, Button } from "./ui";

/** The list only splits by the user's two buckets; in-progress items stay with
 *  pending (they are not done) and are labelled with a status badge. */
type ItemTab = "pending" | "done";

const bucketOf = (status: WorkItemStatus): ItemTab =>
  status === "done" ? "done" : "pending";

type Props = {
  project: LocalProject;
  toast: ToastFn;
  /** Opens the item's detail panel without leaving the project page. */
  onOpenItem?: (item: WorkItem) => void;
};

/**
 * Work item list for one local project, split into 待处理 / 已完成. Items are
 * local-only: no TAPD workspace, no export package, and no task link until the
 * built-in agent flow hands them over. 处理中 is not a tab: an in-progress item
 * stays in 待处理 with a status mark, and its task lives in the global queue.
 */
export function LocalItemsPage({ project, toast, onOpenItem }: Props) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ItemTab>("pending");
  const [dialog, setDialog] = useState<{ item: WorkItem | null } | null>(null);
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
  const loadSeq = useRef(0);
  const load = useCallback(
    async (quiet = false) => {
      const seq = ++loadSeq.current;
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const { items: next } = await localApi.listItems(project.id);
        if (seq !== loadSeq.current) return;
        setItems(next);
        setError(null);
      } catch (cause) {
        if (seq !== loadSeq.current) return;
        if (quiet) toastRef.current("error", String(cause));
        else setError(String(cause));
      } finally {
        if (seq === loadSeq.current && !quiet) setLoading(false);
      }
    },
    [project.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The task flow changes an item's status in the database (attach → in
  // progress, done → finished, cancel/delete → restored) and emits this event.
  // A quiet reload keeps the rows on screen; the visible tab is never switched
  // for a background completion (that would yank the reader out of 待处理).
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<LocalItemsEvent>(LOCAL_ITEMS_EVENT, (event) => {
      const data = event.payload ?? {};
      if (data.projectId && data.projectId !== project.id) return;
      void load(true);
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

  // The tab strip's「新增事项」action is outside this component but belongs to
  // this page: the page lends its dialog out for the focused project tab.
  useEffect(
    () => registerLocalItemCreate(project.id, () => setDialog({ item: null })),
    [project.id],
  );

  // 处理中 is no longer its own tab: in-progress items are unfinished, so
  // they stay in the pending bucket with a status badge. Their agent tasks are
  // tracked in the global workflow queue.
  const open = items.filter((item) => item.status !== "done");
  const done = items.filter((item) => item.status === "done");
  const visible = tab === "pending" ? open : done;

  const saveItem = async (values: LocalItemValues) => {
    if (dialog?.item) {
      const { item } = await localApi.updateItem(dialog.item.id, {
        title: values.title,
        description: values.description,
        importance: values.importance,
      });
      setItems((current) =>
        current.map((candidate) => (candidate.id === item.id ? item : candidate)),
      );
      return;
    }
    const { item } = await localApi.createItem(project.id, {
      title: values.title,
      description: values.description,
      importance: values.importance,
    });
    // The command also emits a refresh; dedupe in case that list landed first.
    setItems((current) => [
      item,
      ...current.filter((candidate) => candidate.id !== item.id),
    ]);
    setTab(bucketOf(item.status));
  };

  /** Moves the item and follows it so the row does not just disappear. */
  const setStatus = async (item: WorkItem, status: WorkItemStatus) => {
    if (actionBusy) return;
    setActionBusy(item.id);
    try {
      const { item: next } = await localApi.updateItem(item.id, { status });
      setItems((current) =>
        current.map((candidate) => (candidate.id === next.id ? next : candidate)),
      );
      setTab(bucketOf(next.status));
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
    <div data-component="LocalItemsPage" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <Segmented<ItemTab>
          value={tab}
          onChange={setTab}
          options={[
            {
              value: "pending",
              label: t("local.items.pending"),
              count: open.length,
            },
            {
              value: "done",
              label: t("local.items.done"),
              count: done.length,
            },
          ]}
        />
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
              : t("local.items.emptyDone")}
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                projectId={project.id}
                busy={actionBusy === item.id}
                onOpen={() => onOpenItem?.(item)}
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
              {menu.item.status === "pending" ? (
                <ContextMenuItem
                  icon={<ArrowRight size={14} />}
                  label={t("local.items.moveToProgress")}
                  onClick={() => {
                    void setStatus(menu.item, "in_progress");
                    requestClose();
                  }}
                />
              ) : null}
              {menu.item.status === "in_progress" ? (
                <ContextMenuItem
                  icon={<Undo2 size={14} />}
                  label={t("local.items.moveToPending")}
                  onClick={() => {
                    void setStatus(menu.item, "pending");
                    requestClose();
                  }}
                />
              ) : null}
              {menu.item.status === "done" ? (
                <ContextMenuItem
                  icon={<Undo2 size={14} />}
                  label={t("local.items.reopen")}
                  onClick={() => {
                    void setStatus(menu.item, "pending");
                    requestClose();
                  }}
                />
              ) : null}
              {menu.item.status !== "done" ? (
                <ContextMenuItem
                  icon={<Check size={14} />}
                  label={t("local.items.markDone")}
                  onClick={() => {
                    void setStatus(menu.item, "done");
                    requestClose();
                  }}
                />
              ) : null}
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
    </div>
  );
}

function ItemRow(props: {
  item: WorkItem;
  projectId: string;
  busy: boolean;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { item, projectId, busy, onOpen, onContextMenu } = props;

  return (
    <li data-component="ItemRow">
      <article
        role="button"
        tabIndex={0}
        aria-label={item.title}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpen();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(event.clientX, event.clientY);
        }}
        className="flex cursor-pointer items-start gap-2 rounded-xl border border-border bg-surface p-3 transition hover:border-slate-300 focus-visible:outline-2 focus-visible:outline-sky-200"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <ImportanceBadge value={item.importance} className="shrink-0" />
            <ScrollingName
              text={item.title}
              className="min-w-0 flex-1 text-ui-caption text-slate-800"
            />
            {item.status === "in_progress" ? (
              <Badge tone="blue" className="shrink-0">
                {t("local.items.inProgress")}
              </Badge>
            ) : null}
          </div>
          {item.description ? (
            <ScrollingName
              text={item.description}
              className="mt-0.5 text-ui-sm text-slate-400"
            />
          ) : null}
          <div className="mt-1 text-ui-xs text-slate-400">
            {t("local.items.created", {
              time: formatDateTime(item.createdAt),
            })}
          </div>
        </div>

        {item.status !== "done" && !item.agentTaskId ? (
          // The row opens the detail panel; the compose sheet keeps its own
          // click without also opening the panel. An item that already owns a
          // task must not be handed over a second time.
          <div
            className="shrink-0"
            onClick={(event) => event.stopPropagation()}
          >
            <EnqueueControl
              target={{
                kind: "local",
                projectId,
                itemId: item.id,
                title: item.title,
              }}
              disabled={busy}
            />
          </div>
        ) : null}
      </article>
    </li>
  );
}
