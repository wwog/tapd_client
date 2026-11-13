import { useSyncExternalStore } from "react";

import { companionApi, type CompanionStatus } from "./api";

/**
 * Companion state shared by the rail entry, the settings card and the QR
 * dialog: whether the service is enabled, and whether any paired phone is
 * currently heartbeating. The rail icon is green while a phone is online.
 */
let enabled = false;
let online = false;
/** Last full snapshot, so Settings/Dialog render before the silent refresh. */
let lastStatus: CompanionStatus | null = null;
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

/** Reads the persisted switch and live presence (app start / periodic poll). */
export async function refreshCompanionStatus(): Promise<void> {
  try {
    const status = await companionApi.status();
    retries = 0;
    rememberCompanionStatus(status);
  } catch {
    // Keep the last known values: a transient status failure must not make the
    // rail entry disappear. Retry a few times, then wait for Settings/dialog
    // to refresh it.
    if (retries < 3) {
      retries += 1;
      window.setTimeout(() => void refreshCompanionStatus(), 2_000);
    }
  }
}

/** Last snapshot for the initial render; the caller still refreshes on mount. */
export function cachedCompanionStatus(): CompanionStatus | null {
  return lastStatus;
}

/** Stores a fresh snapshot and publishes the derived enabled/online flags. */
export function rememberCompanionStatus(status: CompanionStatus): void {
  lastStatus = status;
  const nextOnline = status.devices.some((device) => device.online);
  if (status.enabled === enabled && nextOnline === online) return;
  enabled = status.enabled;
  online = nextOnline;
  emit();
}

/** Applies a value the user just changed (the command already persisted it). */
export function setCompanionEnabledLocal(value: boolean): void {
  if (lastStatus) lastStatus = { ...lastStatus, enabled: value };
  if (enabled === value) return;
  enabled = value;
  if (!enabled) online = false;
  emit();
}

/** A pairing/presence event means a phone is online right now. */
export function markCompanionOnline(): void {
  if (online) return;
  online = true;
  emit();
}

export function useCompanionEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => enabled);
}

export function useCompanionOnline(): boolean {
  return useSyncExternalStore(subscribe, () => online, () => online);
}
