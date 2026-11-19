import { useSyncExternalStore } from "react";

import { api } from "./api";
import { getSession, setMediaToken } from "./session";

/** What the phone knows about its link to the desktop. */
export type DesktopPresence = {
  online: boolean;
  deviceName: string | null;
  /** Server-side id of this phone's device record. */
  deviceId: string | null;
  /** Whether this phone may manage other paired devices. */
  canManage: boolean;
  version: string | null;
  /** Local timestamp of the last successful heartbeat. */
  lastSync: number | null;
};

const INTERVAL_MS = 20_000;

let presence: DesktopPresence = {
  online: false,
  deviceName: null,
  deviceId: null,
  canManage: false,
  version: null,
  lastSync: null,
};
let timer: number | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const update = (patch: Partial<DesktopPresence>): void => {
  presence = { ...presence, ...patch };
  emit();
};

async function beat(): Promise<void> {
  if (!getSession()) return;
  try {
    const data = await api.heartbeat();
    setMediaToken(data.mediaToken);
    update({
      online: true,
      deviceName: data.deviceName,
      deviceId: data.deviceId,
      canManage: data.canManage,
      version: data.version,
      lastSync: Date.now(),
    });
  } catch {
    // The request layer already flips the global connection state; this only
    // feeds the settings card.
    update({ online: false });
  }
}

const onVisible = (): void => {
  if (!document.hidden) void beat();
};

/**
 * Starts the 20s presence loop once a session exists. The desktop shows this
 * device online while heartbeats keep arriving; two missed beats (60s) make it
 * offline without requiring an explicit disconnect.
 */
export function startHeartbeat(): void {
  if (timer !== null) return;
  void beat();
  timer = window.setInterval(() => void beat(), INTERVAL_MS);
  document.addEventListener("visibilitychange", onVisible);
}

/** Stops the presence loop (session cleared / device unpaired on this end). */
export function stopHeartbeat(): void {
  if (timer === null) return;
  window.clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onVisible);
  update({ online: false });
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useDesktopPresence(): DesktopPresence {
  return useSyncExternalStore(subscribe, () => presence, () => presence);
}
