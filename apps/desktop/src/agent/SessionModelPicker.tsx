/**
 * Composer model picker: the session's current model plus a menu of every
 * routable provider/model. A pick is session-local (dsh records it as a durable
 * `model/selection` event), so two chats can run on different models.
 *
 * The menu is a portal rather than `SelectPicker` because this trigger is a
 * chip on the composer's bottom row, not a form field, and the menu carries a
 * reasoning row and the 「管理模型」 entry below the list.
 */
import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";

import { ScrollingName } from "../components/ScrollingName";
import { useDismiss } from "../hooks/useDismiss";
import {
  compactTokens,
  resolveActiveModel,
  type DshModelEntry,
  type DshModelsConfig,
  type DshProvider,
  type ModelSelection,
} from "../lib/agentSettings";
import { t } from "../lib/i18n";
import { computeMenuPosition, type MenuPosition } from "../lib/menuPosition";
import { agentActions, agentStore } from "./store";

type Route = { provider: DshProvider; model: DshModelEntry };

/** One option line: context window and the capabilities worth knowing. */
function describeModel(model: DshModelEntry): string {
  return [
    compactTokens(model.contextWindow),
    model.input.includes("image") ? t("agent.model.inputImage") : null,
    model.reasoning.length > 0 ? t("agent.model.reasoning") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Resolves a recorded route against the current catalog. */
function routeOf(
  models: DshModelsConfig | null,
  selection: ModelSelection | null,
): Route | null {
  if (!models || !selection) return null;
  const provider = models.providers.find((item) => item.id === selection.provider);
  const model = provider?.models.find((item) => item.id === selection.model);
  return provider && model ? { provider, model } : null;
}

export function SessionModelPicker() {
  const state = agentStore.use();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, cardRef, close, { resize: true, blur: true });

  const models = state.config?.dshModels ?? null;
  const row = state.selectedId ? state.sessions[state.selectedId] : undefined;

  const active = resolveActiveModel(models);
  const configured: ModelSelection | null = active
    ? { provider: active.provider.id, model: active.model.id }
    : null;
  // The session's own choice wins; an old session without one still knows the
  // route of its last request. A chat that has not been allocated yet uses the
  // composer draft, then the configured default.
  const chosen: ModelSelection | null =
    row?.selection ??
    (row?.usage.provider && row.usage.model
      ? { provider: row.usage.provider, model: row.usage.model }
      : null) ??
    (!state.selectedId ? state.draftSelection : null) ??
    configured;
  const route = routeOf(models, chosen);
  // An effort left over from another model is not a choice this model offers.
  const effort =
    route && chosen?.reasoningEffort &&
    route.model.reasoning.some((item) => item.level === chosen.reasoningEffort)
      ? chosen.reasoningEffort
      : undefined;

  const groups = (models?.providers ?? [])
    .filter((provider) => provider.enabled && provider.baseUrl.trim())
    .map((provider) => ({
      provider,
      models: provider.models.filter((model) => model.enabled),
    }))
    .filter((group) => group.models.length > 0);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(
      computeMenuPosition(rect, {
        placement: "up",
        minWidth: 320,
        fullHeight: 420,
      }),
    );
    setOpen(true);
  };

  /** Keeps the current effort only when the target model declares it. */
  const pick = (provider: DshProvider, model: DshModelEntry) => {
    const keep =
      effort && model.reasoning.some((item) => item.level === effort)
        ? effort
        : undefined;
    void agentActions.selectModel(state.selectedId, {
      provider: provider.id,
      model: model.id,
      ...(keep ? { reasoningEffort: keep } : {}),
    });
    close();
  };

  const pickEffort = (level: string | undefined) => {
    if (!route) return;
    void agentActions.selectModel(state.selectedId, {
      provider: route.provider.id,
      model: route.model.id,
      ...(level ? { reasoningEffort: level } : {}),
    });
  };

  const manage = () => {
    close();
    agentActions.setTab("config");
  };

  const label = chosen?.model ?? t("agent.model.pick");
  const title = route
    ? `${route.provider.name} / ${route.model.id}`
    : chosen
      ? `${chosen.provider} / ${chosen.model}`
      : t("agent.model.pick");

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={toggle}
        className={clsx(
          "inline-flex min-w-0 max-w-[220px] shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-ui-xs transition",
          open
            ? "bg-overlay text-slate-700"
            : "text-slate-500 hover:bg-overlay hover:text-slate-700",
        )}
      >
        <ScrollingName text={label} className={clsx("min-w-0", chosen && "font-mono")} />
        <ChevronDown
          size={11}
          className={clsx("shrink-0 transition", open && "rotate-180")}
        />
      </button>

      {open && position
        ? createPortal(
            <>
              <button
                type="button"
                aria-label={t("common.picker.close")}
                tabIndex={-1}
                className="fixed inset-0 z-[110] cursor-default"
                onClick={close}
              />
              <div
                ref={cardRef}
                role="dialog"
                aria-label={t("agent.model.pickTitle")}
                style={{
                  left: position.left,
                  top: position.top,
                  bottom: position.bottom,
                  width: position.width,
                  maxHeight: position.maxHeight,
                }}
                className="fixed z-[120] flex flex-col overflow-hidden rounded-xl border border-border bg-surface"
              >
                <div className="flex shrink-0 items-baseline justify-between gap-3 border-b border-slate-100 px-3 py-2">
                  <span className="text-ui-sm text-slate-700">
                    {t("agent.model.pickTitle")}
                  </span>
                  <span className="min-w-0 truncate text-ui-xs text-slate-400">
                    {route?.provider.name ?? chosen?.provider ?? ""}
                  </span>
                </div>

                <div role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1">
                  {groups.length === 0 ? (
                    <div className="px-2 py-3 text-center text-ui-xs text-slate-400">
                      {t("agent.model.noAvailable")}
                    </div>
                  ) : (
                    groups.map(({ provider, models: entries }) => (
                      <div key={provider.id}>
                        <div className="px-2 pb-1 pt-2 text-ui-2xs text-slate-400">
                          {provider.name || provider.id}
                        </div>
                        {entries.map((model) => {
                          const selected =
                            chosen?.provider === provider.id &&
                            chosen.model === model.id;
                          return (
                            <button
                              key={model.id}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              onClick={() => pick(provider, model)}
                              className={clsx(
                                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition",
                                selected ? "bg-sky-50" : "hover:bg-slate-50",
                              )}
                            >
                              <span className="min-w-0 flex-1">
                                <ScrollingName
                                  text={model.id}
                                  className={clsx(
                                    "text-ui-caption",
                                    selected ? "text-sky-700" : "text-slate-700",
                                  )}
                                />
                                <span className="mt-0.5 block truncate text-ui-2xs text-slate-400">
                                  {describeModel(model)}
                                </span>
                              </span>
                              <span className="grid h-3 w-3 shrink-0 place-items-center">
                                {selected ? (
                                  <Check size={12} className="text-sky-500" />
                                ) : null}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>

                {route && route.model.reasoning.length > 0 ? (
                  <div className="shrink-0 border-t border-slate-100 px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-ui-xs text-slate-400">
                        {t("agent.model.reasoningEffort")}
                      </span>
                      <span className="text-ui-xs text-slate-600">
                        {effort ?? t("agent.model.reasoningAuto")}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <EffortButton
                        label={t("agent.model.reasoningAuto")}
                        active={effort === undefined}
                        onClick={() => pickEffort(undefined)}
                      />
                      {route.model.reasoning.map((item) => (
                        <EffortButton
                          key={item.level}
                          label={item.level}
                          active={effort === item.level}
                          onClick={() => pickEffort(item.level)}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="shrink-0 border-t border-slate-100 p-1">
                  <button
                    type="button"
                    onClick={manage}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-caption text-slate-600 transition hover:bg-slate-50 hover:text-slate-800"
                  >
                    {t("agent.model.manage")}
                  </button>
                </div>
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}

function EffortButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className={clsx(
        "rounded-md border px-2 py-0.5 text-ui-2xs transition",
        props.active
          ? "border-sky-200 bg-sky-50 text-sky-700"
          : "border-border text-slate-500 hover:bg-overlay",
      )}
    >
      {props.label}
    </button>
  );
}
