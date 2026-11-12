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
import { Segmented } from "./Segmented";
import { cardClass, inputClass } from "./ui";

const THEMES: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

const ISLAND_THEMES: Array<{ value: IslandThemeMode; label: string }> = [
  { value: "follow", label: "跟随主题" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const ISLAND_DISPLAYS: Array<{ value: IslandDisplayMode; label: string }> = [
  { value: "always", label: "常驻" },
  { value: "activity", label: "仅通知" },
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
              {item.label}
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
  const { island, islandDisplay, font, customFont, fontSize } = appearance;

  return (
    <section className={cardClass}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
            <Palette size={15} className="text-slate-400" />
            外观
          </h2>
          <p className="mt-1 text-ui-caption leading-5 text-slate-500">
            系统字体与统一字号层级，设置立即生效。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAppearance(DEFAULT_APPEARANCE)}
          className="shrink-0 rounded-md px-2 py-1 text-ui-xs text-slate-400 transition hover:bg-overlay-soft hover:text-slate-600"
        >
          恢复默认
        </button>
      </header>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <div className="text-ui-xs font-normal text-slate-500">主题</div>
          <ThemePicker className="mt-2" />
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-ui-xs font-normal text-slate-500">字体</span>
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
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {font === "custom" ? (
            <label className="block">
              <span className="text-ui-xs font-normal text-slate-500">字体名称</span>
              <input
                value={customFont}
                onChange={(event) => setAppearance({ customFont: event.target.value })}
                placeholder="如 Inter, PingFang SC"
                className={clsx(inputClass, "mt-1.5")}
                spellCheck={false}
              />
            </label>
          ) : null}

          <label className="block">
            <span className="flex items-center justify-between text-ui-xs font-normal text-slate-500">
              字号
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
              <span>紧凑</span>
              <span>标准</span>
              <span>宽松</span>
            </span>
          </label>
        </div>
      </div>

      <div className="mt-4 space-y-2.5 border-t border-border pt-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className="text-ui-xs font-normal text-slate-500"
            title="顶部通知胶囊的外观。跟随主题时与应用一起切换，也可固定为浅色或深色。"
          >
            胶囊外观
          </span>
          <Segmented
            value={island}
            options={ISLAND_THEMES}
            onChange={(value) => setAppearance({ island: value })}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span
            className="text-ui-xs font-normal text-slate-500"
            title="常驻：始终显示胶囊；仅通知：有通知、Agent 运行/待审核/待合并、更新或异常时才出现。"
          >
            胶囊显示
          </span>
          <Segmented
            value={islandDisplay}
            options={ISLAND_DISPLAYS}
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
