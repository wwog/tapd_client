import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowRight,
  Check,
  ClipboardList,
  ExternalLink,
  Pencil,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";

import { EnqueueControl } from "../../agent/EnqueuePopover";
import { agentActions } from "../../agent/store";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ImportanceBadge } from "../../components/ImportanceBadge";
import { LocalItemDialog, type LocalItemValues } from "../../components/LocalItemDialog";
import { Badge, Button } from "../../components/ui";
import { formatDateTime } from "../../lib/format";
import { t } from "../../lib/i18n";
import {
  localApi,
  LOCAL_ITEMS_EVENT,
  type LocalItemsEvent,
  type WorkItem,
  type WorkItemStatus,
} from "../../lib/local";
import { usePanelServices, type PanelProps } from "./context";

const STATUS_TONE = {
  pending: "neutral",
  in_progress: "blue",
  done: "green",
} as const;

const STATUS_LABEL = {
  pending: "local.items.pending",
  in_progress: "local.items.inProgress",
  done: "local.items.done",
} as const;

/**
 * One local work item in the secondary dock, mirroring the bug detail panel:
 * facts and the actions that used to live on the list row. The list and this
 * panel both refresh from `local://items`, so a status change in one is visible
 * in the other without a shared React tree.
 */
export function LocalItemPanel({ panel }: PanelProps) {
  const services = usePanelServices();
  const resource = panel.resource.type === "local_item" ? panel.resource : null;
  const [item, setItem] = useState<WorkItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const itemId = resource?.itemId ?? "";
  const projectId = resource?.projectId ?? "";

  const loadSeq = useRef(0);
  const load = useCallback(
    async (quiet = false) => {
      if (!itemId) return;
      const seq = ++loadSeq.current;
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const { item: next } = await localApi.getItem(itemId);
        if (seq !== loadSeq.current) return;
        setItem(next);
        setError(null);
      } catch (cause) {
        if (seq !== loadSeq.current) return;
        // Keep the current item on a transient read failure: blanking it would
        // also unmount an open edit dialog and lose the user's text. Deletion
        // is handled explicitly by the event listener below.
        setError(String(cause));
      } finally {
        if (seq === loadSeq.current && !quiet) setLoading(false);
      }
    },
    [itemId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Changes made elsewhere (the list row, an agent task finishing) land here.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<LocalItemsEvent>(LOCAL_ITEMS_EVENT, (event) => {
      const data = event.payload ?? {};
      if (data.projectId && projectId && data.projectId !== projectId) return;
      if (data.itemId && data.itemId !== itemId) return;
      // A project-wide event is the project-delete cascade; an item event with
      // no status is a delete. Either way this panel's record is gone.
      if (
        (!data.itemId && data.projectId === projectId) ||
        (data.itemId === itemId && data.status == null)
      ) {
        loadSeq.current += 1;
        setItem(null);
        setError(t("local.items.notFound"));
        return;
      }
      void load(true);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Without the event bridge the panel still loads on mount.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [itemId, projectId, load]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  };

  const setStatus = (status: WorkItemStatus) =>
    run(status, async () => {
      const { item: next } = await localApi.updateItem(itemId, { status });
      setItem(next);
    });

  const save = async (values: LocalItemValues) => {
    const { item: next } = await localApi.updateItem(itemId, {
      title: values.title,
      description: values.description,
      importance: values.importance,
    });
    setItem(next);
  };

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await localApi.deleteItem(itemId);
      services.closePanel(panel.id);
    } catch (cause) {
      services.toast("error", String(cause));
      setDeleting(false);
    }
  };

  const openTask = (taskId: string) => {
    agentActions.selectSession(taskId);
    services.open({ resource: { type: "page", view: "agent" }, target: "primary" });
  };

  if (!resource) return null;
  if (loading) {
    return (
      <div
        data-component="LocalItemPanel"
        className="grid h-full place-items-center text-ui-caption text-slate-400"
      >
        <span className="inline-flex items-center gap-2">
          <RefreshCw size={13} className="animate-spin" />
          {t("common.loading")}
        </span>
      </div>
    );
  }
  if (!item) {
    return (
      <div
        data-component="LocalItemPanel"
        className="grid h-full place-items-center px-6 text-center text-ui-caption text-slate-400"
      >
        {error ?? t("local.items.notFound")}
      </div>
    );
  }

  const statusTone = STATUS_TONE[item.status];
  const disabled = busy !== null;

  return (
    <div
      data-component="LocalItemPanel"
      className="flex h-full min-h-0 flex-col bg-surface"
    >
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <ClipboardList size={13} className="shrink-0 text-slate-400" />
          <span className="text-ui-xs text-slate-400">{t("local.items.detail")}</span>
          <Badge tone={statusTone}>{t(STATUS_LABEL[item.status])}</Badge>
          <ImportanceBadge value={item.importance} />
        </div>
        <h1 className="mt-1.5 select-text text-ui-base text-slate-900">
          {item.title}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-ui-xs text-slate-400">
          <span className="truncate">{services.workspaceName(projectId)}</span>
          <span className="text-slate-300">·</span>
          <span>
            {t("local.items.created", { time: formatDateTime(item.createdAt) })}
          </span>
          <span className="text-slate-300">·</span>
          <span>
            {t("local.items.updated", { time: formatDateTime(item.updatedAt) })}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        <section className="rounded-xl border border-border bg-surface px-3 py-2.5">
          <div className="text-ui-xs text-slate-400">
            {t("local.items.description")}
          </div>
          <p className="mt-1 select-text whitespace-pre-wrap wrap-break-word text-ui-caption leading-6 text-slate-700">
            {item.description || t("local.items.noDescription")}
          </p>
        </section>

        {item.agentTaskId ? (
          <section className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-slate-400">
              {item.agentTaskId}
            </span>
            <Button
              size="sm"
              icon={<ExternalLink size={12} />}
              onClick={() => openTask(item.agentTaskId!)}
            >
              {t("local.items.viewTask")}
            </Button>
          </section>
        ) : null}

        {error ? (
          <p className="mt-3 break-all rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-600">
            {error}
          </p>
        ) : null}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
        {item.status === "pending" ? (
          <Button
            size="sm"
            icon={<ArrowRight size={13} />}
            disabled={disabled}
            onClick={() => void setStatus("in_progress")}
          >
            {t("local.items.moveToProgress")}
          </Button>
        ) : item.status === "in_progress" ? (
          <Button
            size="sm"
            icon={<Undo2 size={13} />}
            disabled={disabled}
            onClick={() => void setStatus("pending")}
          >
            {t("local.items.moveToPending")}
          </Button>
        ) : (
          <Button
            size="sm"
            icon={<Undo2 size={13} />}
            disabled={disabled}
            onClick={() => void setStatus("pending")}
          >
            {t("local.items.reopen")}
          </Button>
        )}
        {item.status !== "done" ? (
          <Button
            size="sm"
            icon={<Check size={13} />}
            disabled={disabled}
            onClick={() => void setStatus("done")}
          >
            {t("local.items.markDone")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          icon={<Pencil size={13} />}
          disabled={disabled}
          onClick={() => setDialog(true)}
        >
          {t("local.items.edit")}
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 size={13} />}
          disabled={disabled}
          onClick={() => setConfirmDelete(true)}
        >
          {t("local.items.delete")}
        </Button>
        {item.status !== "done" && !item.agentTaskId ? (
          <div className="ml-auto">
            <EnqueueControl
              target={{
                kind: "local",
                projectId,
                itemId: item.id,
                title: item.title,
              }}
              variant="primary"
              disabled={disabled}
            />
          </div>
        ) : null}
      </footer>

      {dialog ? (
        <LocalItemDialog
          item={item}
          onClose={() => setDialog(false)}
          onSubmit={save}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={t("local.items.delete")}
          icon={<Trash2 size={15} className="text-rose-500" />}
          message={t("local.items.deleteConfirm", { title: item.title })}
          busy={deleting}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      ) : null}
    </div>
  );
}
