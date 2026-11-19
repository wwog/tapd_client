import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

/**
 * Background services that boot asynchronously with the app (companion server,
 * built-in agent runtime). The Rust startup guard retries each one a few times
 * and, when it gives up, records the failure here so every surface can offer a
 * retry instead of silently running without the service.
 */

export type ServiceKey = "companion" | "agent";

export type ServiceFailure = {
  service: ServiceKey;
  /** Automatic attempts that already failed. */
  attempts: number;
  error: string;
  /** Folder holding the daily log the failure was written to. */
  logDir: string;
};

let failures: ServiceFailure[] = [];
let started = false;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function upsert(failure: ServiceFailure): void {
  const index = failures.findIndex((item) => item.service === failure.service);
  failures =
    index === -1
      ? [...failures, failure]
      : failures.map((item, position) => (position === index ? failure : item));
  publish();
}

function remove(service: ServiceKey): void {
  const next = failures.filter((item) => item.service !== service);
  if (next.length === failures.length) return;
  failures = next;
  publish();
}

/**
 * Loads the failures recorded before the window was ready (a first-run payload
 * error can happen while the webview is still loading) and keeps listening.
 * One subscription for the app session; StrictMode's second effect is a no-op.
 */
export function startServiceFailures(): void {
  if (started) return;
  started = true;
  void invoke<ServiceFailure[]>("service_failures")
    .then((records) => {
      failures = records;
      publish();
    })
    .catch(() => {
      // No Tauri runtime (browser preview): nothing to show.
    });
  void listen<ServiceFailure>("service://failed", (event) => {
    upsert(event.payload);
  }).catch(() => undefined);
  void listen<{ service: ServiceKey }>("service://ready", (event) => {
    remove(event.payload.service);
  }).catch(() => undefined);
}

/** One manual attempt, made from the failure modal. */
export async function retryService(service: ServiceKey): Promise<void> {
  await invoke("service_retry", { service });
}

/** Relaunches the app; the startup guards run again from scratch. */
export async function restartApp(): Promise<void> {
  await invoke("service_restart_app");
}

export function useServiceFailures(): ServiceFailure[] {
  return useSyncExternalStore(subscribe, () => failures, () => failures);
}
