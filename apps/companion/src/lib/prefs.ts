import { useSyncExternalStore } from "react";

import { applyLocale, resolveLocaleMode, type LocaleMode } from "./i18n";

export type ThemeMode = "system" | "light" | "dark";

export type Prefs = {
  theme: ThemeMode;
  /** Base UI font size in px; every text token derives from it. */
  fontSize: number;
  /** UI language; `system` follows the phone's language (Chinese: zh). */
  locale: LocaleMode;
};

/** Companion prefs live only on the phone; never synced with the desktop. */
const KEY = "companion.prefs";

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 17;

const DEFAULTS: Prefs = { theme: "system", fontSize: 14, locale: "system" };

let current: Prefs = DEFAULTS;
let media: MediaQueryList | null = null;
const listeners = new Set<() => void>();

function clampSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULTS.fontSize;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)));
}

function normalize(parsed: Partial<Prefs>): Prefs {
  const theme: ThemeMode =
    parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
      ? parsed.theme
      : DEFAULTS.theme;
  const locale: LocaleMode =
    parsed.locale === "zh" || parsed.locale === "en" ? parsed.locale : "system";
  return {
    theme,
    fontSize: clampSize(parsed.fontSize ?? DEFAULTS.fontSize),
    locale,
  };
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? normalize(JSON.parse(raw)) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private browsing: prefs stay session-local.
  }
}

const systemDark = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

export function resolvedTheme(prefs: Prefs = current): "light" | "dark" {
  return prefs.theme === "system" ? (systemDark() ? "dark" : "light") : prefs.theme;
}

function apply() {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolvedTheme();
  document.documentElement.style.setProperty("--ui-font-size", `${current.fontSize}px`);
  applyLocale(resolveLocaleMode(current.locale));
}

function emit() {
  for (const listener of listeners) listener();
}

function onSystemChange() {
  if (current.theme !== "system") return;
  apply();
  emit();
}

/** Applies stored prefs before the first React render, avoiding a theme flash. */
export function initPrefs(): void {
  if (typeof window === "undefined") return;
  current = load();
  apply();
  if (media) return;
  media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onSystemChange);
}

export function setPrefs(patch: Partial<Prefs>): void {
  current = {
    ...current,
    ...patch,
    fontSize: clampSize(patch.fontSize ?? current.fontSize),
  };
  persist();
  apply();
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getPrefs = (): Prefs => current;

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}
