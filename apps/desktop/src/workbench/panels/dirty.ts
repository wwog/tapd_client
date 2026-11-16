/**
 * Unsaved-edit flags shared by the file panel and the workbench close guard.
 *
 * Kept outside React state because the tab strip (a different subtree) needs to
 * paint a dot and the close path needs a synchronous answer before it unmounts
 * the panel.
 */
import { useSyncExternalStore } from "react";

const dirty = new Set<string>();
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

export function isPanelDirty(panelId: string): boolean {
  return dirty.has(panelId);
}

/** Any editor currently holds unsaved text (logout / window close guard). */
export function hasDirtyPanels(): boolean {
  return dirty.size > 0;
}

/** Drops all flags after the user explicitly accepts losing the buffers. */
export function clearDirtyPanels(): void {
  if (dirty.size === 0) return;
  dirty.clear();
  emit();
}

export function setPanelDirty(panelId: string, value: boolean): void {
  if (dirty.has(panelId) === value) return;
  if (value) dirty.add(panelId);
  else dirty.delete(panelId);
  emit();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Reactive bit for the tab strip. */
export function usePanelDirty(panelId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => dirty.has(panelId),
    () => false,
  );
}
