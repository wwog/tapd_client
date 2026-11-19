/**
 * Persistence for the workbench split tree.
 *
 * The layout lives in the `config.json` preference blob (not WebView storage,
 * which is wiped on logout). `uiPrefs.writePref` already debounces writes, so
 * every layout change can call `savePrefs` directly.
 *
 * Loading is defensive: persisted JSON may predate the workbench, be hand
 * edited, or carry panels this build no longer knows. Anything structurally
 * broken returns `null` (the caller falls back to `initialPrefs`); individual
 * unknown panels are dropped by `normalize`.
 */
import { readPref, writePref } from "../../lib/uiPrefs.ts";
import { defaultLayout, defaultSidebarWidth } from "./defaults.ts";
import { normalize } from "./ops.ts";
import type { LayoutPrefs, LayoutState } from "./types.ts";

export const LAYOUT_PREF = "workbench.layout.v1";

/** Legacy bottom drawer prefs (`{ open, height }`), migrated once on first run. */
export const LEGACY_TERMINAL_PREF = "terminal.panel.v1";

/** Bottom dock share bounds used when migrating the legacy terminal height. */
const MIGRATED_BOTTOM_MIN = 0.15;
const MIGRATED_BOTTOM_MAX = 0.7;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Structural validation; panel contents are repaired by `normalize`. */
function isNodeShape(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  if (raw.kind === "group") {
    return typeof raw.id === "string" && Array.isArray(raw.panels);
  }
  if (raw.kind === "split") {
    if (typeof raw.id !== "string") return false;
    if (raw.direction !== "row" && raw.direction !== "column") return false;
    if (!Array.isArray(raw.children) || !Array.isArray(raw.sizes)) return false;
    return raw.children.every(isNodeShape);
  }
  return false;
}

function isLayoutShape(raw: unknown): raw is LayoutState {
  if (!isRecord(raw)) return false;
  if (raw.version !== 1) return false;
  if (!isNodeShape(raw.root)) return false;
  if (typeof raw.activeGroupId !== "string") return false;
  if (
    raw.maximizedGroupId !== null &&
    raw.maximizedGroupId !== undefined &&
    typeof raw.maximizedGroupId !== "string"
  ) {
    return false;
  }
  return true;
}

/**
 * Reads and repairs the persisted workbench prefs. Returns `null` when the key
 * is missing or the envelope/tree shape is unusable.
 */
export function loadPrefs(): LayoutPrefs | null {
  const raw = readPref<unknown>(LAYOUT_PREF);
  if (!isRecord(raw)) return null;
  if (raw.version !== 1) return null;
  if (!isFiniteNumber(raw.sidebarWidth)) return null;
  if (!isLayoutShape(raw.layout)) return null;
  return normalizePrefs({
    version: 1,
    layout: raw.layout,
    sidebarWidth: raw.sidebarWidth,
    // Pre-collapse envelopes predate the field.
    sidebarCollapsed: raw.sidebarCollapsed === true,
  });
}

/** Persists the prefs envelope; `writePref` debounces the actual config write. */
export function savePrefs(prefs: LayoutPrefs): void {
  writePref(LAYOUT_PREF, prefs);
}

/** Repairs a loaded envelope; sidebar clamping belongs to the hook. */
export function normalizePrefs(prefs: LayoutPrefs): LayoutPrefs {
  return {
    version: 1,
    layout: normalize(prefs.layout),
    sidebarWidth: isFiniteNumber(prefs.sidebarWidth) ? prefs.sidebarWidth : 0,
    sidebarCollapsed: prefs.sidebarCollapsed === true,
  };
}

/**
 * Fresh prefs for a window: the default tree plus the default sidebar width.
 *
 * One-time migration: the old bottom terminal drawer stored a pixel height.
 * Convert it to the bottom split fraction so the dock keeps roughly its old
 * size. No terminal panel is created — PTYs do not survive a restart, and the
 * session list repopulates the dock through `syncTerminalPanels`.
 */
export function initialPrefs(
  viewportWidth: number,
  viewportHeight: number,
): LayoutPrefs {
  const width =
    isFiniteNumber(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1280;
  const height =
    isFiniteNumber(viewportHeight) && viewportHeight > 0 ? viewportHeight : 900;
  const layout = defaultLayout();

  const legacy = readPref<unknown>(LEGACY_TERMINAL_PREF);
  if (isRecord(legacy) && isFiniteNumber(legacy.height)) {
    const fraction = Math.min(
      Math.max(legacy.height / height, MIGRATED_BOTTOM_MIN),
      MIGRATED_BOTTOM_MAX,
    );
    applyBottomFraction(layout.root, fraction);
  }

  return {
    version: 1,
    layout,
    sidebarWidth: defaultSidebarWidth(width),
    sidebarCollapsed: false,
  };
}

/** Gives the bottom role group `fraction` of the tree, scaling siblings. */
function applyBottomFraction(root: LayoutState["root"], fraction: number): void {
  if (root.kind !== "split" || root.direction !== "column") return;
  const bottomIndex = root.children.findIndex(
    (child) => child.kind === "group" && child.role === "bottom",
  );
  if (bottomIndex === -1) return;
  const rest = 1 - fraction;
  const othersTotal = root.sizes.reduce(
    (sum, value, index) => (index === bottomIndex ? sum : sum + value),
    0,
  );
  root.sizes = root.sizes.map((value, index) => {
    if (index === bottomIndex) return fraction;
    if (othersTotal > 0) return (value / othersTotal) * rest;
    return rest / Math.max(1, root.children.length - 1);
  });
}
