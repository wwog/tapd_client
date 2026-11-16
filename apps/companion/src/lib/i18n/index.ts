/**
 * Semantic-key i18n. Messages live in `./catalog`, keyed by short, namespaced
 * ids (`common.save`, `mobile.bugs.title`), each holding `[zh, en]`.
 *
 * The desktop runtime works the same way; the phone keeps its own catalogue
 * because language is a per-device preference.
 */

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

export function applyLocale(next: Locale): void {
  if (next === current) return;
  current = next;
  if (typeof document !== "undefined") {
    document.documentElement.lang = LOCALE_TAGS[next];
  }
  for (const listener of listeners) listener();
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
  return primary.get(key) ?? EN.get(key) ?? ZH.get(key) ?? key;
}

/** `t("common.save")`, `t("mobile.bugs.count", { n })`. */
export function t(key: MessageKey, vars?: MsgVars): string {
  const entry = resolve(key);
  if (typeof entry === "function") return entry(vars ?? {});
  return interpolate(entry, vars);
}
