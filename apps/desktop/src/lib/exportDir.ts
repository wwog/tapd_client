import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { readPref, writePref } from "./uiPrefs";
import { t } from "./i18n";

/** Last directory picked for any export; shared by diagnostics and captures. */
const PREF_KEY = "export.lastDir";

/** Directory the native picker should start in. */
export function lastExportDir(fallback?: string | null): string | undefined {
  const stored = readPref<string>(PREF_KEY);
  if (typeof stored === "string" && stored.trim()) return stored;
  return fallback?.trim() || undefined;
}

/**
 * Asks for an export directory. The last choice wins over `fallback`, so a
 * repeated export opens where the previous one went. Returns null on cancel.
 */
export async function pickExportDir(
  fallback?: string | null,
): Promise<string | null> {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: t("app.export.chooseDir"),
    defaultPath: lastExportDir(fallback),
  });
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) return null;
  writePref(PREF_KEY, path);
  return path;
}
