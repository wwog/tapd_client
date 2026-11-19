/**
 * One reusable model chip + two-level menu (providers, then that provider's
 * models) with the reasoning slider underneath.
 *
 * The presenter owns no store: the composer feeds it the session's route, the
 * enqueue sheet feeds it the choice for a task that does not exist yet. A pick
 * is a full `ModelSelection`, so both callers persist it the same way.
 */
import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import { ScrollingName } from "../components/ScrollingName";
import { useDismiss } from "../hooks/useDismiss";
import {
  compactTokens,
  effortStops,
  rememberedEffort,
  resolveActiveModel,
  type DshModelEntry,
  type DshModelsConfig,
  type DshProvider,
  type ModelSelection,
} from "../lib/agentSettings";
import { t } from "../lib/i18n";
import { computeMenuPosition, type MenuPosition } from "../lib/menuPosition";

type Route = { provider: DshProvider; model: DshModelEntry };
type Panel = "providers" | "models";

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

export type ModelPickerProps = {
  models: DshModelsConfig | null;
  /** The route to show; `null` falls back to the configured default. */
  value: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  /** Shows the 「默认模型」 shortcut when it differs from `value`. */
  defaultModel?: ModelSelection | null;
  /** Extra entry at the bottom of the first panel (the composer's「管理模型」). */
  onManage?: () => void;
  disabled?: boolean;
  className?: string;
  placement?: "up" | "down";
};

export function ModelPicker({
  models,
  value,
  onChange,
  defaultModel,
  onManage,
  disabled = false,
  className,
  placement = "up",
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("providers");
  /** Provider whose models the second level lists. */
  const [providerId, setProviderId] = useState<string | null>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, cardRef, close, { resize: true, blur: true });

  const active = resolveActiveModel(models);
  const configured: ModelSelection | null = active
    ? { provider: active.provider.id, model: active.model.id }
    : null;
  const chosen = value ?? configured;
  const route = routeOf(models, chosen);
  // The session's own level wins; otherwise the level this model was last used
  // with. `off` is the floor, so a new model never silently thinks.
  const effort = route
    ? chosen?.reasoningEffort &&
      effortStops(route.model).includes(chosen.reasoningEffort)
      ? chosen.reasoningEffort
      : rememberedEffort(models, route.provider.id, route.model.id)
    : undefined;

  const groups = (models?.providers ?? [])
    .filter((provider) => provider.enabled && provider.baseUrl.trim())
    .map((provider) => ({
      provider,
      models: provider.models.filter((model) => model.enabled),
    }))
    .filter((group) => group.models.length > 0);

  /** `off` first, then every level the model declares. */
  const stops: string[] = route ? effortStops(route.model) : [];

  const toggle = () => {
    if (disabled) return;
    if (open) {
      close();
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(
      computeMenuPosition(rect, {
        placement,
        minWidth: 340,
        fullHeight: 460,
      }),
    );
    setPanel("providers");
    // Level two always starts at the provider the session runs on.
    setProviderId(route?.provider.id ?? null);
    setOpen(true);
  };

  /** A new route starts at the level that model last used. */
  const pick = (provider: DshProvider, model: DshModelEntry) => {
    onChange({
      provider: provider.id,
      model: model.id,
      reasoningEffort: rememberedEffort(models, provider.id, model.id),
    });
    close();
  };

  const pickEffort = (level: string) => {
    if (!route) return;
    onChange({
      provider: route.provider.id,
      model: route.model.id,
      reasoningEffort: level,
    });
  };

  const useDefault = () => {
    if (!defaultModel) return;
    const provider = models?.providers.find((item) => item.id === defaultModel.provider);
    const model = provider?.models.find((item) => item.id === defaultModel.model);
    if (provider && model) {
      pick(provider, model);
      return;
    }
    onChange(defaultModel);
    close();
  };

  const providerLabel = route?.provider.name || route?.provider.id || chosen?.provider || "";
  const modelLabel = route?.model.id ?? chosen?.model ?? t("agent.model.pick");
  const effortLabel = effort ?? t("agent.model.reasoningOff");
  const showsEffort = stops.length > 1;

  const currentGroup = groups.find((group) => group.provider.id === providerId);
  const defaultDifferent =
    Boolean(active) &&
    (chosen?.provider !== active?.provider.id || chosen?.model !== active?.model.id);

  const triggerText = providerLabel ? `${providerLabel}/${modelLabel}` : modelLabel;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={route ? `${route.provider.name} / ${route.model.id}` : triggerText}
        onClick={toggle}
        className={clsx(
          "inline-flex min-w-0 max-w-[280px] shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-ui-xs transition",
          disabled && "cursor-default opacity-60",
          open
            ? "bg-overlay text-slate-700"
            : "text-slate-500 hover:bg-overlay hover:text-slate-700",
          className,
        )}
      >
        <ScrollingName text={triggerText} className="min-w-0" />
        {showsEffort ? (
          <>
            <span className="shrink-0 text-slate-300">·</span>
            <span className="shrink-0 text-slate-400">{effortLabel}</span>
          </>
        ) : null}
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
                {panel === "providers" ? (
                  <>
                    <div className="flex shrink-0 items-baseline justify-between gap-3 border-b border-slate-100 px-3 py-2">
                      <span className="text-ui-sm text-slate-700">
                        {t("agent.model.pickTitle")}
                      </span>
                      <span className="min-w-0 truncate text-ui-xs text-slate-400">
                        {route?.provider.name ?? chosen?.provider ?? ""}
                      </span>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-1">
                      {groups.length === 0 ? (
                        <div className="px-2 py-3 text-center text-ui-xs text-slate-400">
                          {t("agent.model.noAvailable")}
                        </div>
                      ) : (
                        groups.map(({ provider, models: entries }) => {
                          const current = route?.provider.id === provider.id;
                          return (
                            <button
                              key={provider.id}
                              type="button"
                              onClick={() => {
                                setProviderId(provider.id);
                                setPanel("models");
                              }}
                              className={clsx(
                                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition",
                                current ? "bg-sky-50" : "hover:bg-slate-50",
                              )}
                            >
                              <span className="min-w-0 flex-1">
                                <ScrollingName
                                  text={provider.name || provider.id}
                                  className={clsx(
                                    "text-ui-caption",
                                    current ? "text-sky-700" : "text-slate-700",
                                  )}
                                />
                                <span className="mt-0.5 block truncate text-ui-2xs text-slate-400">
                                  {current && route
                                    ? route.model.id
                                    : t("agent.model.providerModels", {
                                        count: entries.length,
                                      })}
                                </span>
                              </span>
                              <span className="grid h-3 w-3 shrink-0 place-items-center">
                                {current ? (
                                  <Check size={12} className="text-sky-500" />
                                ) : null}
                              </span>
                              <ChevronRight size={12} className="shrink-0 text-slate-400" />
                            </button>
                          );
                        })
                      )}
                    </div>

                    {showsEffort ? (
                      <ReasoningSlider stops={stops} value={effort} onChange={pickEffort} />
                    ) : null}

                    {defaultDifferent || onManage ? (
                      <div className="shrink-0 border-t border-slate-100 p-1">
                        {defaultDifferent ? (
                          <button
                            type="button"
                            onClick={useDefault}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-caption text-slate-600 transition hover:bg-slate-50 hover:text-slate-800"
                          >
                            <span className="shrink-0">
                              {t("agent.model.defaultModel")}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-right text-ui-2xs text-slate-400">
                              {active?.model.id}
                            </span>
                          </button>
                        ) : null}
                        {onManage ? (
                          <button
                            type="button"
                            onClick={() => {
                              close();
                              onManage();
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-caption text-slate-600 transition hover:bg-slate-50 hover:text-slate-800"
                          >
                            {t("agent.model.manage")}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="flex shrink-0 items-center gap-1 border-b border-slate-100 px-1.5 py-1.5">
                      <button
                        type="button"
                        aria-label={t("common.back")}
                        title={t("common.back")}
                        onClick={() => setPanel("providers")}
                        className="grid h-5 w-5 shrink-0 place-items-center rounded text-slate-400 transition hover:bg-overlay hover:text-slate-700"
                      >
                        <ChevronLeft size={13} />
                      </button>
                      <span className="min-w-0 flex-1 truncate text-ui-sm text-slate-700">
                        {currentGroup?.provider.name || currentGroup?.provider.id}
                      </span>
                      <span className="min-w-0 shrink truncate text-ui-xs text-slate-400">
                        {route?.provider.id === providerId ? route.model.id : ""}
                      </span>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-1">
                      {(currentGroup?.models ?? []).map((model) => {
                        const selected =
                          chosen?.provider === providerId && chosen.model === model.id;
                        return (
                          <button
                            key={model.id}
                            type="button"
                            aria-current={selected}
                            onClick={() => {
                              const group = currentGroup;
                              if (group) pick(group.provider, model);
                            }}
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
                  </>
                )}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * Reasoning effort as a slider: the leftmost stop turns reasoning off, then
 * every level the model declares, in escalation order.
 */
function ReasoningSlider(props: {
  stops: string[];
  value: string | undefined;
  onChange: (level: string) => void;
}) {
  const { stops, value, onChange } = props;
  const index = Math.max(0, stops.indexOf(value ?? "off"));
  const label = value ?? t("agent.model.reasoningOff");

  return (
    <div data-component="ReasoningSlider" className="shrink-0 border-t border-slate-100 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 text-ui-xs">
        <span className="text-slate-400">{t("agent.model.reasoningEffort")}</span>
        <span className="truncate text-slate-600">{label}</span>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(0, stops.length - 1)}
        step={1}
        value={index}
        aria-label={t("agent.model.reasoningEffort")}
        aria-valuetext={label}
        onChange={(event) => onChange(stops[Number(event.target.value)])}
        className="mt-2 h-1.5 w-full cursor-pointer accent-sky-500"
      />
      <div className="mt-1 flex justify-between gap-1 text-ui-2xs">
        {stops.map((stop, position) => (
          <span
            key={stop}
            className={clsx(
              "min-w-0 truncate",
              position === index ? "text-slate-600" : "text-slate-400",
            )}
          >
            {stop}
          </span>
        ))}
      </div>
    </div>
  );
}
