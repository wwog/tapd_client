import { useSyncExternalStore } from "react";

import { companionApi } from "./api";

/**
 * Whether the companion service is enabled. The rail entry only exists while
 * this is true, so both the settings card and the QR dialog write through the
 * same store instead of refetching status independently.
 */
let enabled = false;
/** Bounded retries for the app-start status call racing the backend boot. */
let retries = 0;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Reads the persisted switch once at app start (and after recovery). */
export async function refreshCompanionEnabled(): Promise<void> {
  try {
    const status = await companionApi.status();
    retries = 0;
    if (status.enabled === enabled) return;
    enabled = status.enabled;
    emit();
  } catch {
    // Keep the last known value: a transient status failure must not make the
    // rail entry disappear. Retry a few times, then wait for Settings/dialog
    // to refresh it.
    if (retries < 3) {
      retries += 1;
      window.setTimeout(() => void refreshCompanionEnabled(), 2_000);
    }
  }
}

/** Applies a value the user just changed (the command already persisted it). */
export function setCompanionEnabledLocal(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  emit();
}

export function useCompanionEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => enabled);
}
