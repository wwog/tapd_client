import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import clsx from "clsx";

import {
  DEFAULT_APPEARANCE,
  FONT_OPTIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  setAppearance,
  useAppearance,
  type IslandDisplayMode,
  type IslandThemeMode,
  type ThemeMode,
} from "../lib/appearance";
import { t, type LocaleMode, type MessageKey } from "../lib/i18n";
import { Segmented } from "./Segmented";
import { cardClass, inputClass } from "./ui";

const THEMES: Array<{ value: ThemeMode; label: MessageKey; icon: typeof Sun }> = [
  { value: "light", label: "common.light", icon: Sun },
  { value: "dark", label: "common.dark", icon: Moon },
  { value: "system", label: "common.system", icon: Monitor },
];

const ISLAND_THEMES: Array<{ value: IslandThemeMode; label: MessageKey }> = [
  { value: "follow", label: "common.followTheme" },
  { value: "light", label: "common.light" },
  { value: "dark", label: "common.dark" },
];

const ISLAND_DISPLAYS: Array<{ value: IslandDisplayMode; label: MessageKey }> = [
  { value: "always", label: "settings.capsule.always" },
  { value: "activity", label: "settings.capsule.activity" },
];

/** Three theme tiles; shared by the settings card and first-run onboarding. */
export function ThemePicker({ className }: { className?: string }) {
  const { mode } = useAppearance();

  return (
    <div className={clsx("grid grid-cols-3 gap-2", className)}>
      {THEMES.map((item) => {
        const selected = mode === item.value;
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={selected}
            onClick={() => setAppearance({ mode: item.value })}
            className={clsx(
              "group relative overflow-hidden rounded-xl border p-1.5 text-left transition",
              selected ? "border-sky-400" : "border-border hover:border-slate-300",
            )}
          >
            <ThemeThumb mode={item.value} />
            <span className="mt-1.5 flex items-center gap-1 px-0.5 pb-0.5 text-ui-xs text-slate-600">
              <Icon size={11} className="text-slate-400" />
              {t(item.label)}
              {selected ? <Check size={11} className="ml-auto text-sky-500" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Appearance card: theme mode, UI font and the shared base font size. */
export function AppearanceCard() {
  const appearance = useAppearance();
  const { island, islandDisplay, font, customFont, fontSize, locale } = appearance;

  // Language names stay in their own script, the way OS pickers show them.
  const languages: Array<{ value: LocaleMode; label: string }> = [
    { value: "system", label: t("common.system") },
    { value: "zh", label: "中文" }, // i18n-exempt: language endonym
    { value: "en", label: "English" }, // i18n-exempt: language endonym
  ];

  return (
    <section className={cardClass}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
            <Palette size={15} className="text-slate-400" />
            {t("settings.appearance.title")}
          </h2>
          <p className="mt-1 text-ui-caption leading-5 text-slate-500">
            {t("settings.appearance.description")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAppearance(DEFAULT_APPEARANCE)}
          className="shrink-0 rounded-md px-2 py-1 text-ui-xs text-slate-400 transition hover:bg-overlay-soft hover:text-slate-600"
        >
          {t("common.restoreDefaults")}
        </button>
      </header>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <div className="text-ui-xs font-normal text-slate-500">{t("common.theme")}</div>
          <ThemePicker className="mt-2" />
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-ui-xs font-normal text-slate-500">{t("common.font")}</span>
            <select
              value={font}
              onChange={(event) =>
                setAppearance({
                  font: event.target.value as typeof font,
                })
              }
              className={clsx(inputClass, "mt-1.5")}
            >
              {FONT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </label>

          {font === "custom" ? (
            <label className="block">
              <span className="text-ui-xs font-normal text-slate-500">{t("settings.font.name")}</span>
              <input
                value={customFont}
                onChange={(event) => setAppearance({ customFont: event.target.value })}
                placeholder={t("settings.font.placeholder")}
                className={clsx(inputClass, "mt-1.5")}
                spellCheck={false}
              />
            </label>
          ) : null}

          <label className="block">
            <span className="flex items-center justify-between text-ui-xs font-normal text-slate-500">
              {t("common.fontSize")}
              <span className="tabular-nums text-slate-400">{fontSize}px</span>
            </span>
            <input
              type="range"
              min={FONT_SIZE_MIN}
              max={FONT_SIZE_MAX}
              step={1}
              value={fontSize}
              onChange={(event) =>
                setAppearance({ fontSize: Number(event.target.value) })
              }
              className="mt-2 h-1.5 w-full cursor-pointer accent-sky-500"
            />
            <span className="mt-1 flex justify-between text-ui-2xs text-slate-400">
              <span>{t("settings.fontSize.compact")}</span>
              <span>{t("settings.fontSize.standard")}</span>
              <span>{t("settings.fontSize.relaxed")}</span>
            </span>
          </label>
        </div>
      </div>

      <div className="mt-4 space-y-2.5 border-t border-border pt-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className="text-ui-xs font-normal text-slate-500"
            title={t("settings.language.tooltip")}
          >
            {t("common.language")}
          </span>
          <Segmented
            value={locale}
            options={languages}
            onChange={(value) => setAppearance({ locale: value })}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className="text-ui-xs font-normal text-slate-500"
            title={t("settings.capsule.themeTooltip")}
          >
            {t("settings.capsule.theme")}
          </span>
          <Segmented
            value={island}
            options={ISLAND_THEMES.map((option) => ({
              value: option.value,
              label: t(option.label),
            }))}
            onChange={(value) => setAppearance({ island: value })}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className="text-ui-xs font-normal text-slate-500"
            title={t("settings.capsule.displayTooltip")}
          >
            {t("settings.capsule.display")}
          </span>
          <Segmented
            value={islandDisplay}
            options={ISLAND_DISPLAYS.map((option) => ({
              value: option.value,
              label: t(option.label),
            }))}
            onChange={(value) => setAppearance({ islandDisplay: value })}
          />
        </div>
      </div>

    </section>
  );
}

/** Small window preview; colors are fixed so each tile shows its own theme. */
function ThemeThumb(props: { mode: ThemeMode }) {
  if (props.mode === "system") {
    return (
      <div className="flex h-[54px] overflow-hidden rounded-lg border border-border">
        <div className="flex w-1/2 flex-col gap-1 bg-[#ffffff] p-2">
          <Bar className="w-2/3 bg-[#cbd5e1]" />
          <Bar className="w-full bg-[#e2e8f0]" />
          <Bar className="w-4/5 bg-[#e2e8f0]" />
        </div>
        <div className="flex w-1/2 flex-col gap-1 border-l border-[#3a404b] bg-[#17191e] p-2">
          <Bar className="w-2/3 bg-[#4f5866]" />
          <Bar className="w-full bg-[#2a2f38]" />
          <Bar className="w-4/5 bg-[#2a2f38]" />
        </div>
      </div>
    );
  }

  const dark = props.mode === "dark";
  return (
    <div
      className={clsx(
        "flex h-[54px] flex-col gap-1 rounded-lg border p-2",
        dark
          ? "border-[#3a404b] bg-[#17191e]"
          : "border-[#e2e8f0] bg-[#ffffff]",
      )}
    >
      <div className="mb-0.5 flex gap-1">
        <span className="h-1 w-1 rounded-full bg-rose-400" />
        <span className="h-1 w-1 rounded-full bg-amber-400" />
        <span className="h-1 w-1 rounded-full bg-emerald-400" />
      </div>
      <Bar className={clsx("w-2/3", dark ? "bg-[#4f5866]" : "bg-[#cbd5e1]")} />
      <Bar className={clsx("w-full", dark ? "bg-[#2a2f38]" : "bg-[#e2e8f0]")} />
      <Bar className={clsx("w-4/5", dark ? "bg-[#2a2f38]" : "bg-[#e2e8f0]")} />
    </div>
  );
}

function Bar(props: { className?: string }) {
  return <span className={clsx("block h-1 rounded-full", props.className)} />;
}
