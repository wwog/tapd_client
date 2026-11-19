import { useEffect, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import { Sparkles, X } from "lucide-react";

import { bugTitle } from "../lib/bug";
import {
  defaultSelection,
  type ModelSelection,
} from "../lib/agentSettings";
import { dshTaskApi } from "../lib/dsh";
import { t } from "../lib/i18n";
import { showToast } from "../lib/toast";
import { hasOpenDismissLayer } from "../hooks/useDismiss";
import { useLayerClose } from "../hooks/useLayerClose";
import { usePanelServices } from "../workbench/panels/context";
import { Button, ModalDragStrip, Switch } from "../components/ui";
import { ScrollingName } from "../components/ScrollingName";
import { ModelPicker } from "./ModelPicker";
import { agentActions, agentStore } from "./store";

/** A bug or a local work item; the sheet has no other targets. */
export type EnqueueTarget =
  | { kind: "bug"; workspaceId: string; bugId: string; title: string }
  | { kind: "local"; projectId: string; itemId: string; title: string };

type Props = {
  target: EnqueueTarget;
  onClose: () => void;
};

/**
 * One compact sheet for every hand-over entry point: an optional note, then
 * submit. On success it selects the returned task and reveals the Agent page;
 * only failures need a toast, because the new task is already on screen.
 */
export function EnqueueSheet({ target, onClose }: Props) {
  const services = usePanelServices();
  const { closing, requestClose } = useLayerClose(onClose);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // The task inherits the configured default; both start-only choices (team
  // and model) are offered here and fixed once the task is created. Read once
  // at mount: subscribing would re-render the sheet on every stream delta.
  const [team, setTeam] = useState(
    () => agentStore.get().config?.teamEnabled ?? false,
  );
  // The route this task starts on. It begins at the last choice (which is the
  // default for new sessions) and the task keeps its own copy once created.
  // Only the config slice is subscribed: the sheet must not re-render per
  // stream token while another session runs.
  const config = useSyncExternalStore(
    agentStore.subscribe,
    () => agentStore.get().config,
  );
  const models = config?.dshModels ?? null;
  const [model, setModel] = useState<ModelSelection | null>(() =>
    defaultSelection(models),
  );
  // The sheet opens from bug/local pages, which may never have visited the
  // Agent page (the only other bootstrap point).
  useEffect(() => {
    if (!agentStore.get().config) void agentActions.loadConfig();
  }, []);

  const heading =
    target.kind === "bug" ? t("bugs.fixWithAgent") : t("local.items.toAgent");
  const title = target.kind === "bug" ? bugTitle(target.title) : target.title;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || submitting) return;
      // The model menu is its own layer: Escape closes it, not the sheet.
      if (hasOpenDismissLayer()) return;
      event.preventDefault();
      requestClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [requestClose, submitting]);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    const extraPrompt = note.trim() || undefined;
    try {
      const { task } =
        target.kind === "bug"
          ? await dshTaskApi.enqueueBug(
              target.workspaceId,
              target.bugId,
              extraPrompt,
              undefined,
              team,
              model ?? undefined,
            )
          : await dshTaskApi.enqueueLocal(
              target.projectId,
              target.itemId,
              extraPrompt,
              undefined,
              team,
              model ?? undefined,
            );
      agentActions.adoptTask(task);
      // The pick is the default for the sessions that start next; this task
      // already carries its own copy from the enqueue payload.
      if (model) void agentActions.rememberModelDefault(model);
      // The backend emits the new list; one refetch keeps a dropped event from
      // leaving the sidebar stale.
      void agentActions.refreshTasks();
      services.open({ resource: { type: "page", view: "agent" }, target: "primary" });
      onClose();
    } catch (error) {
      showToast("error", String(error));
      setSubmitting(false);
    }
  };

  return (
    <div data-component="EnqueueSheet" className="fixed inset-0 z-[65]">
      {/* The sheet has explicit close/cancel: the backdrop never dismisses. */}
      <div
        aria-hidden="true"
        className={clsx(
          "modal-overlay absolute inset-0 bg-slate-900/15",
          closing && "modal-overlay-out",
        )}
      />
      <ModalDragStrip />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className={clsx(
          "agent-sheet-up absolute inset-x-0 bottom-0 flex max-h-[min(64vh,460px)] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface",
          closing && "modal-sheet-out",
        )}
      >
        <header
          data-tauri-drag-region
          className="flex shrink-0 items-center gap-2.5 border-b border-slate-100 px-5 py-3"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-600">
            <Sparkles size={15} />
          </span>
          <div className="min-w-0 flex-1" data-tauri-drag-region>
            <h2 data-tauri-drag-region className="text-ui-base text-slate-900">
              {heading}
            </h2>
            <ScrollingName text={title} className="text-ui-sm text-slate-500" />
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => requestClose()}
            disabled={submitting}
            className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 px-5 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-ui-xs text-slate-500">
            <span className="flex items-center gap-2" title={t("agent.enqueue.teamHint")}>
              <Switch
                checked={team}
                onChange={setTeam}
                disabled={submitting}
                label={t("agent.chat.team")}
              />
              {t("agent.chat.team")}
            </span>
            {/* Route and effort for this task's first turn; fixed once it runs. */}
            <span className="flex min-w-0 items-center gap-1">
              <span className="shrink-0 text-slate-400">
                {t("agent.model.pickTitle")}
              </span>
              <ModelPicker
                models={models}
                value={model}
                onChange={setModel}
                disabled={submitting}
                placement="up"
              />
            </span>
          </div>
          <textarea
            autoFocus
            rows={3}
            value={note}
            title={t("agent.enqueue.hint")}
            placeholder={t("agent.enqueue.placeholder")}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
              event.preventDefault();
              void submit();
            }}
            className="w-full resize-none rounded-xl border border-border bg-surface px-3 py-2 text-ui-caption leading-6 text-slate-700 transition placeholder:text-slate-300"
          />
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3">
          <Button size="sm" variant="ghost" disabled={submitting} onClick={() => requestClose()}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Sparkles size={13} />}
            loading={submitting}
            onClick={() => void submit()}
          >
            {t("common.submit")}
          </Button>
        </footer>
      </section>
    </div>
  );
}
