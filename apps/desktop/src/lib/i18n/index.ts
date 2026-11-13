/**
 * Semantic-key i18n. Messages live in `./catalog`, keyed by short, namespaced
 * ids (`common.save`, `bugs.sortAscending`), each holding `[zh, en]`.
 *
 * A key is the stable identity: wording can change in either language without
 * touching call sites, and a missing pair is visible at review time because
 * both languages sit on the same line.
 *
 * `t()` is typed against the catalogue keys, so a typo is a compile error.
 */

import { invoke } from "@tauri-apps/api/core";

import { CATALOG, type MessageKey } from "./catalog";
import type { Entry, Locale, LocaleMode, MsgVars } from "./types";

export type { Catalog, Entry, Locale, LocaleMode, MsgVars } from "./types";
export type { MessageKey } from "./catalog";

const LOCALE_TAGS: Record<Locale, string> = { zh: "zh-CN", en: "en-US" };

const ZH = new Map<string, Entry>();
const EN = new Map<string, Entry>();
for (const [key, pair] of Object.entries(CATALOG)) {
  ZH.set(key, pair[0]);
  EN.set(key, pair[1]);
}

let current: Locale = "zh";
const listeners = new Set<() => void>();

/** First preferred language decides; Chinese systems get Chinese, the rest
 *  English. Unknown (no navigator, e.g. tests) stays Chinese. */
export function detectSystemLocale(): Locale {
  if (typeof navigator === "undefined") return "zh";
  const languages =
    navigator.languages && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  for (const language of languages) {
    const lower = (language ?? "").toLowerCase();
    if (lower.startsWith("zh")) return "zh";
    if (lower.length > 0) return "en";
  }
  return "zh";
}

export function resolveLocaleMode(mode: LocaleMode): Locale {
  return mode === "system" ? detectSystemLocale() : mode;
}

export function getLocale(): Locale {
  return current;
}

export function localeTag(locale: Locale = current): string {
  return LOCALE_TAGS[locale];
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Applies the locale decided by the appearance store. Re-rendering is the
 * caller's job (`main.tsx` re-renders both roots), and the Rust side gets the
 * resolved locale so backend messages match the UI.
 */
export function applyLocale(next: Locale): void {
  if (next === current) {
    // Still sync once on startup: Rust boots from the config/OS language and
    // may disagree with `navigator.language`.
    if (!pushed) pushLocaleToBackend();
    return;
  }
  current = next;
  if (typeof document !== "undefined") {
    document.documentElement.lang = LOCALE_TAGS[next];
  }
  for (const listener of listeners) listener();
  pushLocaleToBackend();
}

let pushed = false;

/** Mirrors the locale into Rust; harmless to repeat on every startup. */
export function pushLocaleToBackend(): void {
  pushed = true;
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  void invoke("set_locale", { locale: current }).catch(() => undefined);
}

/** True when a catalogue entry exists; used by the coverage checker. */
export function hasMessage(key: string): boolean {
  return ZH.has(key);
}

export function messageKeys(): string[] {
  return Object.keys(CATALOG);
}

function interpolate(template: string, vars?: MsgVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

function resolve(key: MessageKey): Entry {
  const primary = current === "en" ? EN : ZH;
  // Wrong-locale fallback keeps a half-finished translation readable instead of
  // rendering the key; a missing key shows the key itself (a bug worth seeing).
  return primary.get(key) ?? EN.get(key) ?? ZH.get(key) ?? key;
}

/**
 * Translates one key.
 *
 *   t("common.save")
 *   t("bugs.sortAscending", { label })
 */
export function t(key: MessageKey, vars?: MsgVars): string {
  const entry = resolve(key);
  if (typeof entry === "function") return entry(vars ?? {});
  return interpolate(entry, vars);
}
