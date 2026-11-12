/**
 * Durable UI preferences (theme, bug list layout) stored in `config.json`.
 *
 * The WebView's localStorage cannot hold them: logging out clears all WebView
 * browsing data, so the user's theme and list layout would disappear with the
 * TAPD session. The blob is read once before the first render (no theme flash)
 * and written back debounced, so rapid updates (dragging columns, typing a
 * filter) collapse into one config write.
 */

import { invoke } from "@tauri-apps/api/core";

type PrefBlob = Record<string, unknown>;

let prefs: PrefBlob = {};
let flushTimer: number | null = null;

/** Preference blob keys whose values used to live in WebView localStorage. */
const LEGACY_STORAGE: Array<[prefKey: string, storageKey: string]> = [
  ["appearance", "tapd.appearance.v1"],
  ["tapd.bug-columns.v1", "tapd.bug-columns.v1"],
  ["tapd.bug-filters.v1", "tapd.bug-filters.v1"],
  ["tapd.bug-sort.v1", "tapd.bug-sort.v1"],
];

/** Loads the stored blob. A preview or a fresh install keeps the defaults. */
export async function loadUiPrefs(): Promise<void> {
  try {
    const stored = await invoke<unknown>("ui_prefs_get");
    prefs =
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? { ...(stored as PrefBlob) }
        : {};
  } catch {
    prefs = {};
  }
  // One-time migration: versions before the config.json blob kept these in
  // WebView storage. Copy whatever is still there, then persist.
  let migrated = false;
  for (const [prefKey, storageKey] of LEGACY_STORAGE) {
    if (prefs[prefKey] !== undefined) continue;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) continue;
      prefs[prefKey] = JSON.parse(raw);
      migrated = true;
    } catch {
      // Malformed or unreadable legacy value: keep the defaults.
    }
  }
  if (migrated) {
    void invoke("ui_prefs_set", { prefs }).catch(() => undefined);
  }
}

export function readPref<T>(key: string): T | null {
  const value = prefs[key];
  return value === undefined || value === null ? null : (value as T);
}

export function writePref(key: string, value: unknown): void {
  prefs = { ...prefs, [key]: value };
  if (flushTimer !== null) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(flushPrefs, 150);
}

function flushPrefs(): void {
  flushTimer = null;
  void invoke("ui_prefs_set", { prefs }).catch(() => undefined);
}
