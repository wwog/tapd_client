/**
 * Hand a bug or a local work item to the built-in agent — the phone version of
 * the desktop's enqueue popover. The record is read by the backend (repo,
 * prompt template, resources), so this sheet only carries the optional note
 * and the first-turn model route.
 */
import { useEffect, useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";

import { asApiError } from "../lib/api";
import {
  rememberedEffort,
  resolveActive,
  type DshModelsCatalog,
} from "../lib/agentModels";
import { dshApi, refreshAgentFeed, type ModelSelection } from "../lib/dsh";
import { t } from "../lib/i18n";
import { ModelSheet } from "../pages/agent/pickers";
import { BottomSheet } from "./BottomSheet";

export type EnqueueTarget =
  | { kind: "bug"; workspaceId: string; bugId: string; title: string }
  | { kind: "local"; projectId: string; itemId: string; title: string };

type Props = {
  target: EnqueueTarget | null;
  onClose: () => void;
  /** Called after the backend accepted the queue entry. */
  onDone: () => void;
};

const primaryButton =
  "min-h-11 w-full rounded-lg bg-primary px-3 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-50";

export function EnqueueSheet({ target, onClose, onDone }: Props) {
  const [note, setNote] = useState("");
  const [catalog, setCatalog] = useState<DshModelsCatalog | null>(null);
  const [model, setModel] = useState<ModelSelection | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh hand-over: clear the previous target's note and route, then read
  // the sanitized catalog for the first-turn picker.
  useEffect(() => {
    if (!target) return;
    setNote("");
    setModel(null);
    setCatalog(null);
    setError(null);
    let alive = true;
    void dshApi
      .agentModels()
      .then(({ models }) => {
        if (!alive) return;
        setCatalog(models);
        const active = resolveActive(models);
        if (!active) return;
        setModel({
          provider: active.provider.id,
          model: active.model.id,
          reasoningEffort: rememberedEffort(models, active.provider.id, active.model.id),
        });
      })
      .catch(() => {
        // The note-only path still works; the runtime keeps its default route.
      });
    return () => {
      alive = false;
    };
  }, [target]);

  const route = (() => {
    if (!catalog || !model) return null;
    const provider = catalog.providers.find((item) => item.id === model.provider);
    const picked = provider?.models.find((item) => item.id === model.model);
    return provider && picked ? { provider, model: picked } : null;
  })();

  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const options = {
        ...(note.trim() ? { extraPrompt: note.trim() } : {}),
        ...(model ? { model } : {}),
      };
      if (target.kind === "bug") {
        await dshApi.taskEnqueueBug(target.workspaceId, target.bugId, options);
      } else {
        await dshApi.taskEnqueueLocal(target.projectId, target.itemId, options);
      }
      // The feed polls slowly; one read makes the new queue row visible now.
      void refreshAgentFeed();
      onDone();
      onClose();
    } catch (cause) {
      setError(asApiError(cause).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <BottomSheet
        open={target !== null}
        title={t("mobile.enqueue.title")}
        onClose={onClose}
        footer={
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className={primaryButton}
          >
            {busy ? (
              <LoaderCircle size={14} className="mx-auto animate-spin" />
            ) : (
              t("mobile.enqueue.title")
            )}
          </button>
        }
      >
        <div className="flex min-w-0 items-center gap-2 text-ui-caption text-slate-900">
          <span className="min-w-0 flex-1 truncate">{target?.title ?? ""}</span>
        </div>

        <button
          data-component="EnqueueModelRow"
          type="button"
          disabled={!route}
          onClick={() => setModelOpen(true)}
          className="mt-3 flex min-h-11 w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 text-left text-ui-caption text-slate-700 transition active:bg-overlay-soft disabled:opacity-50"
        >
          <span className="shrink-0 text-slate-400">{t("mobile.agent.modelPickTitle")}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-ui-xs">
            {route ? `${route.provider.name} · ${route.model.id}` : t("mobile.agent.modelNoAvailable")}
          </span>
          {route ? <ChevronRight size={14} className="shrink-0 text-slate-400" /> : null}
        </button>

        <textarea
          rows={3}
          value={note}
          title={t("mobile.enqueue.noteHint")}
          placeholder={t("mobile.enqueue.note")}
          onChange={(event) => setNote(event.target.value)}
          className="mt-3 w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-ui-caption leading-6 text-slate-700 transition placeholder:text-slate-400"
        />

        {error ? (
          <p className="mt-2 text-ui-sm leading-5 text-rose-600" title={t("mobile.enqueue.failed")}>
            {error}
          </p>
        ) : null}
      </BottomSheet>

      {modelOpen && catalog ? (
        <ModelSheet
          catalog={catalog}
          route={route}
          chosen={model}
          effort={model?.reasoningEffort}
          onPick={(provider, picked) => {
            setModel({
              provider: provider.id,
              model: picked.id,
              reasoningEffort: rememberedEffort(catalog, provider.id, picked.id),
            });
          }}
          onEffort={(level) =>
            setModel((current) => (current ? { ...current, reasoningEffort: level } : current))
          }
          onClose={() => setModelOpen(false)}
        />
      ) : null}
    </>
  );
}
