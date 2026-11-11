import { listen } from "@tauri-apps/api/event";

import { agentApi, type AgentTasksState } from "./agent";
import { createExternalStore } from "./store";

/**
 * Shared `agent://state` snapshot. App and AgentPage both read this store, so
 * the app has one initial fetch and one event subscription in total.
 */
export const agentTasksStore = createExternalStore<AgentTasksState | null>(null);

let subscriberCount = 0;
let stopSubscription: (() => void) | null = null;

const startSubscription = (): (() => void) => {
  let cancelled = false;
  let unlisten: (() => void) | undefined;

  void agentApi
    .tasksList()
    .then((state) => {
      if (!cancelled) agentTasksStore.set(state);
    })
    .catch(() => {
      // Settle the UI instead of leaving it on the loading state; a focus or
      // any queue action retries through the normal refresh path.
      if (!cancelled) {
        agentTasksStore.set({ tasks: [], activeTaskId: null, queuePaused: false });
      }
    });

  void listen<AgentTasksState>("agent://state", (event) => {
    if (!cancelled) agentTasksStore.set(event.payload);
  }).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });

  return () => {
    cancelled = true;
    unlisten?.();
  };
};

/**
 * Ref-counted subscription: the first consumer starts the initial snapshot and
 * the event listener, and the last one releases them.
 */
export function acquireAgentTasksStore(): () => void {
  subscriberCount += 1;
  if (!stopSubscription) stopSubscription = startSubscription();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberCount -= 1;
    if (subscriberCount === 0) {
      stopSubscription?.();
      stopSubscription = null;
    }
  };
}

/** React binding for the shared agent task snapshot. */
export function useAgentTasksStore(): AgentTasksState | null {
  return agentTasksStore.use();
}
