import { useSyncExternalStore } from "react";
import { emit as emitToAll } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemeMode = "light" | "dark" | "system";
/** The island capsule can follow the app theme or keep its own fixed theme. */
export type IslandThemeMode = "follow" | "light" | "dark";
/** Whether the idle capsule stays on screen or only appears on activity. */
export type IslandDisplayMode = "always" | "activity";
export type FontChoice = "system" | "pingfang" | "noto" | "yahei" | "custom";

export type Appearance = {
  mode: ThemeMode;
  /** Capsule (island window) theme: `follow` mirrors `mode`. */
  island: IslandThemeMode;
  /** `always` keeps the capsule resident; `activity` hides it while idle. */
  islandDisplay: IslandDisplayMode;
  font: FontChoice;
  /** Only used when `font` is `custom`; a comma-separated CSS font stack. */
  customFont: string;
  /** Base UI font size in px. Every text token is derived from this. */
  fontSize: number;
};

const STORAGE_KEY = "tapd.appearance.v1";

export const DEFAULT_APPEARANCE: Appearance = {
  mode: "system",
  island: "follow",
  islandDisplay: "always",
  font: "system",
  customFont: "",
  fontSize: 14,
};

/** System UI stack: no bundled font. */
const SYSTEM_STACK =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Segoe UI", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';

export const FONT_STACKS: Record<Exclude<FontChoice, "custom">, string> = {
  system: SYSTEM_STACK,
  pingfang:
    '"PingFang SC", ui-sans-serif, system-ui, -apple-system, "Hiragino Sans GB", sans-serif',
  noto: '"Noto Sans SC", "Source Han Sans SC", "Source Han Sans CN", "PingFang SC", ui-sans-serif, system-ui, sans-serif',
  yahei:
    '"Microsoft YaHei", "Microsoft YaHei UI", "PingFang SC", ui-sans-serif, system-ui, sans-serif',
};

export const FONT_OPTIONS: Array<{ value: FontChoice; label: string }> = [
  { value: "system", label: "系统" },
  { value: "pingfang", label: "苹方" },
  { value: "noto", label: "思源黑体" },
  { value: "yahei", label: "微软雅黑" },
  { value: "custom", label: "自定义…" },
];

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 17;

let current: Appearance = load();
let media: MediaQueryList | null = null;
/** Only the main window paints a native background; overlays stay transparent. */
let windowBackground = true;
/** The island window resolves its own theme instead of the app theme. */
let overlay = false;
const listeners = new Set<() => void>();

function clampSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_APPEARANCE.fontSize;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)));
}

function normalize(parsed: Partial<Appearance>): Appearance {
  const mode: ThemeMode =
    parsed.mode === "light" || parsed.mode === "dark" || parsed.mode === "system"
      ? parsed.mode
      : DEFAULT_APPEARANCE.mode;
  const island: IslandThemeMode =
    parsed.island === "light" || parsed.island === "dark" || parsed.island === "follow"
      ? parsed.island
      : DEFAULT_APPEARANCE.island;
  const islandDisplay: IslandDisplayMode =
    parsed.islandDisplay === "always" || parsed.islandDisplay === "activity"
      ? parsed.islandDisplay
      : DEFAULT_APPEARANCE.islandDisplay;
  const font: FontChoice =
    parsed.font === "pingfang" ||
    parsed.font === "noto" ||
    parsed.font === "yahei" ||
    parsed.font === "custom"
      ? parsed.font
      : "system";
  return {
    mode,
    island,
    islandDisplay,
    font,
    customFont:
      typeof parsed.customFont === "string" ? parsed.customFont.slice(0, 160) : "",
    fontSize: clampSize(parsed.fontSize ?? DEFAULT_APPEARANCE.fontSize),
  };
}

function load(): Appearance {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    return normalize(JSON.parse(raw) as Partial<Appearance>);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function persist() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Private mode / storage disabled: the theme still applies for this run.
  }
}

function systemDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function fontStack(appearance: Appearance): string {
  if (appearance.font === "custom") {
    const clean = appearance.customFont
      .replace(/[;{}<>]/g, "")
      .trim()
      .slice(0, 160);
    return clean ? `${clean}, ${SYSTEM_STACK}` : SYSTEM_STACK;
  }
  return FONT_STACKS[appearance.font];
}

function apply() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = overlay ? resolvedIslandTheme(current) : resolvedTheme(current);
  root.style.setProperty("--ui-font-size", `${current.fontSize}px`);
  if (current.font === "system") root.style.removeProperty("--font-sans");
  else root.style.setProperty("--font-sans", fontStack(current));

  // Match the native window background so rounded corners and resize frames
  // do not flash light while the webview paints. The transparent island window
  // must not get one, or its rounded capsule would sit on an opaque rectangle.
  if (!windowBackground) return;
  try {
    void getCurrentWindow()
      .setBackgroundColor(canvasRgba(root.dataset.theme === "dark" ? "dark" : "light"))
      .catch(() => undefined);
  } catch {
    // Browser preview outside Tauri.
  }
}

/**
 * Native window background, mirroring `styles.css` `--color-canvas` per theme.
 *
 * The Rust side reveals the window with this colour, so even a slow first
 * frame shows the theme instead of the window's configured light default.
 */
export function canvasRgba(
  theme: "light" | "dark" = resolvedTheme(),
): [number, number, number, number] {
  return theme === "dark" ? [14, 16, 20, 255] : [244, 244, 242, 255];
}

function emit() {
  for (const listener of listeners) listener();
}

/** Mirrors a change into the other webviews (main window <-> island). Only the
 *  main window broadcasts, so a replica can never bounce the event back. */
function broadcast() {
  if (!windowBackground) return;
  void emitToAll("appearance://changed", current).catch(() => undefined);
}

function onSystemChange() {
  if (current.mode !== "system") return;
  apply();
  emit();
  broadcast();
}

/** Applies the stored appearance before React renders, avoiding a flash. */
export function initAppearance(
  options: { windowBackground?: boolean; overlay?: boolean } = {},
) {
  if (typeof window === "undefined") return;
  windowBackground = options.windowBackground ?? true;
  overlay = options.overlay ?? false;
  apply();
  if (media) return;
  media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onSystemChange);
}

/** Applies an appearance pushed by the main window without persisting or
 *  re-broadcasting it. */
export function applyExternalAppearance(next: Partial<Appearance>) {
  current = normalize(next);
  apply();
  emit();
}

export function getAppearance(): Appearance {
  return current;
}

export function setAppearance(patch: Partial<Appearance>) {
  current = {
    ...current,
    ...patch,
    fontSize: clampSize(patch.fontSize ?? current.fontSize),
  };
  apply();
  persist();
  emit();
  broadcast();
}

export function resolvedTheme(appearance: Appearance = current): "light" | "dark" {
  return appearance.mode === "system"
    ? systemDark()
      ? "dark"
      : "light"
    : appearance.mode;
}

/** Theme the island window paints with: its own choice, or the app theme. */
export function resolvedIslandTheme(
  appearance: Appearance = current,
): "light" | "dark" {
  return appearance.island === "light" || appearance.island === "dark"
    ? appearance.island
    : resolvedTheme(appearance);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, getAppearance, getAppearance);
}

export function useResolvedTheme(): "light" | "dark" {
  const appearance = useAppearance();
  return resolvedTheme(appearance);
}
