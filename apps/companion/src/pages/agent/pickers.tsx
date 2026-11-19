/**
 * Composer session pickers — the phone version of the desktop composer's two
 * chips, each a bottom sheet instead of a portal menu: mode (plan plus the
 * three permission modes) and model (providers → models with a reasoning
 * slider). Both write per-session state that applies at the next tool call /
 * prompt, so nothing needs a restart.
 */
import { useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  HandHelping,
  ListTodo,
  ShieldCheck,
  ShieldOff,
  type LucideIcon,
} from "lucide-react";

import { BottomSheet } from "../../components/BottomSheet";
import {
  catalogGroups,
  compactTokens,
  effortStops,
  type ActiveRoute,
  type CatalogModel,
  type CatalogProvider,
  type DshModelsCatalog,
} from "../../lib/agentModels";
import type { ModelSelection } from "../../lib/dsh";
import { t, type MessageKey } from "../../lib/i18n";

/** Plan is a separate engine flag; the three modes are permission levels. */
export type ModeValue = "plan" | "notify" | "auto" | "full";

const MODE_OPTIONS: ReadonlyArray<{
  value: ModeValue;
  icon: LucideIcon;
  label: MessageKey;
  hint: MessageKey;
}> = [
  {
    value: "plan",
    icon: ListTodo,
    label: "mobile.agent.modePlan",
    hint: "mobile.agent.modePlanHint",
  },
  {
    value: "notify",
    icon: HandHelping,
    label: "mobile.agent.modeNotify",
    hint: "mobile.agent.modeNotifyHint",
  },
  {
    value: "auto",
    icon: ShieldCheck,
    label: "mobile.agent.modeAuto",
    hint: "mobile.agent.modeAutoHint",
  },
  {
    value: "full",
    icon: ShieldOff,
    label: "mobile.agent.modeFull",
    hint: "mobile.agent.modeFullHint",
  },
];

/** The trigger chip: icon plus the active mode's label. */
export function ModeChip(props: { value: ModeValue; onClick: () => void }) {
  const active =
    MODE_OPTIONS.find((option) => option.value === props.value) ?? MODE_OPTIONS[2];
  const Icon = active.icon;
  return (
    <button
      data-component="ModeChip"
      type="button"
      aria-haspopup="dialog"
      onClick={props.onClick}
      className="inline-flex min-h-9 min-w-0 shrink items-center gap-1 rounded-lg px-1.5 text-ui-xs text-slate-500 transition active:bg-overlay-soft"
    >
      <Icon size={13} className="shrink-0 text-slate-400" />
      <span className="min-w-0 truncate">{t(active.label)}</span>
    </button>
  );
}

/** The trigger chip: the effective route, `provider/model · effort`. */
export function ModelChip(props: { label: string; onClick: () => void }) {
  return (
    <button
      data-component="ModelChip"
      type="button"
      aria-haspopup="dialog"
      onClick={props.onClick}
      className="inline-flex min-h-9 min-w-0 max-w-[46%] shrink-0 items-center gap-1 rounded-lg px-1.5 text-ui-xs text-slate-500 transition active:bg-overlay-soft"
    >
      <span className="min-w-0 truncate">{props.label}</span>
    </button>
  );
}

/** Plan + the three permission modes; one tap applies and closes. */
export function ModeSheet(props: {
  value: ModeValue;
  onPick: (value: ModeValue) => void;
  onClose: () => void;
}) {
  return (
    <BottomSheet open title={t("mobile.agent.modeTitle")} onClose={props.onClose}>
      <div className="space-y-2">
        {MODE_OPTIONS.map((option) => {
          const selected = option.value === props.value;
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => props.onPick(option.value)}
              className={`flex min-h-12 w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                selected
                  ? "border-sky-300 bg-sky-50"
                  : "border-border bg-surface active:bg-overlay-soft"
              }`}
            >
              <Icon
                size={16}
                className={`shrink-0 ${selected ? "text-sky-600" : "text-slate-400"}`}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-ui-caption ${
                    selected ? "text-sky-700" : "text-slate-700"
                  }`}
                >
                  {t(option.label)}
                </span>
                <span className="mt-0.5 block text-ui-xs leading-5 text-slate-500">
                  {t(option.hint)}
                </span>
              </span>
              {selected ? <Check size={14} className="shrink-0 text-sky-500" /> : null}
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );
}

/** One model line: context window plus the capabilities worth knowing. */
function describeModel(model: CatalogModel): string {
  return [
    compactTokens(model.contextWindow),
    model.input.includes("image") ? t("mobile.agent.modelImage") : null,
    model.reasoning.length > 0 ? t("mobile.agent.modelReasoningTag") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Two-level catalog browser: providers first, then that provider's models;
 * the reasoning slider rides along on the provider panel while the current
 * route declares more than one stop.
 */
export function ModelSheet(props: {
  catalog: DshModelsCatalog | null;
  route: ActiveRoute | null;
  chosen: ModelSelection | null;
  effort: string | undefined;
  onPick: (provider: CatalogProvider, model: CatalogModel) => void;
  onEffort: (level: string) => void;
  onClose: () => void;
}) {
  const [panel, setPanel] = useState<"providers" | "models">("providers");
  // Level two always starts at the provider the session runs on.
  const [providerId, setProviderId] = useState<string | null>(
    props.route?.provider.id ?? null,
  );

  const groups = catalogGroups(props.catalog);
  const stops = props.route ? effortStops(props.route.model) : [];
  const showsEffort = stops.length > 1;
  const currentGroup = groups.find((group) => group.provider.id === providerId);

  return (
    <BottomSheet
      open
      title={
        panel === "providers"
          ? t("mobile.agent.modelPickTitle")
          : (currentGroup?.provider.name || currentGroup?.provider.id || "")
      }
      onClose={props.onClose}
    >
      {panel === "providers" ? (
        <>
          {groups.length === 0 ? (
            <p className="py-6 text-center text-ui-xs text-slate-400">
              {t("mobile.agent.modelNoAvailable")}
            </p>
          ) : (
            <div className="space-y-2">
              {groups.map(({ provider, models }) => {
                const current = props.route?.provider.id === provider.id;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => {
                      setProviderId(provider.id);
                      setPanel("models");
                    }}
                    className={`flex min-h-12 w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition ${
                      current
                        ? "border-sky-300 bg-sky-50"
                        : "border-border bg-surface active:bg-overlay-soft"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block text-ui-caption ${
                          current ? "text-sky-700" : "text-slate-700"
                        }`}
                      >
                        {provider.name || provider.id}
                      </span>
                      <span className="mt-0.5 block truncate text-ui-2xs text-slate-400">
                        {current && props.route
                          ? props.route.model.id
                          : t("mobile.agent.modelProviderModels", {
                              count: models.length,
                            })}
                      </span>
                    </span>
                    {current ? (
                      <Check size={14} className="shrink-0 text-sky-500" />
                    ) : null}
                    <ChevronRight size={14} className="shrink-0 text-slate-400" />
                  </button>
                );
              })}
            </div>
          )}
          {showsEffort ? (
            <ReasoningSlider
              stops={stops}
              value={props.effort}
              onChange={props.onEffort}
            />
          ) : null}
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setPanel("providers")}
            className="mb-2 inline-flex min-h-9 items-center gap-1 rounded-lg px-1 text-ui-xs text-slate-500 transition active:bg-overlay-soft"
          >
            <ChevronLeft size={14} className="shrink-0" />
            {t("common.back")}
          </button>
          <div className="space-y-2">
            {(currentGroup?.models ?? []).map((model) => {
              const selected =
                props.chosen?.provider === currentGroup?.provider.id &&
                props.chosen?.model === model.id;
              return (
                <button
                  key={model.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    if (currentGroup) props.onPick(currentGroup.provider, model);
                  }}
                  className={`flex min-h-12 w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition ${
                    selected
                      ? "border-sky-300 bg-sky-50"
                      : "border-border bg-surface active:bg-overlay-soft"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block break-all text-ui-caption ${
                        selected ? "text-sky-700" : "text-slate-700"
                      }`}
                    >
                      {model.id}
                    </span>
                    <span className="mt-0.5 block truncate text-ui-2xs text-slate-400">
                      {describeModel(model)}
                    </span>
                  </span>
                  {selected ? (
                    <Check size={14} className="shrink-0 text-sky-500" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </>
      )}
    </BottomSheet>
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
  const label = value ?? t("mobile.agent.modelReasoningOff");

  return (
    <div data-component="ReasoningSlider" className="mt-4 border-t border-border pt-3">
      <div className="flex items-baseline justify-between gap-2 text-ui-xs">
        <span className="text-slate-400">{t("mobile.agent.modelReasoningEffort")}</span>
        <span className="truncate text-slate-600">{label}</span>
      </div>
      <input
        type="range"
        min={0}
        max={Math.max(0, stops.length - 1)}
        step={1}
        value={index}
        aria-label={t("mobile.agent.modelReasoningEffort")}
        aria-valuetext={label}
        onChange={(event) => onChange(stops[Number(event.target.value)])}
        className="mt-2 h-1.5 w-full accent-sky-500"
      />
      <div className="mt-1 flex justify-between gap-1 text-ui-2xs">
        {stops.map((stop, position) => (
          <span
            key={stop}
            className={`min-w-0 truncate ${
              position === index ? "text-slate-600" : "text-slate-400"
            }`}
          >
            {stop}
          </span>
        ))}
      </div>
    </div>
  );
}
