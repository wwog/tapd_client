import { useSyncExternalStore } from "react";

export type ExternalStore<T> = {
  /** Current value, valid outside React. */
  get: () => T;
  /** Replaces the value and wakes every subscriber. */
  set: (next: T | ((current: T) => T)) => void;
  /** Subscribes to changes; the returned function unsubscribes. */
  subscribe: (listener: () => void) => () => void;
  /** React binding (`useSyncExternalStore`), stable across renders. */
  use: () => T;
};

/**
 * Minimal external store for state shared by windows/components. Values are
 * compared with `Object.is`, so publishing the same reference is a no-op.
 */
export function createExternalStore<T>(initial: T): ExternalStore<T> {
  let current = initial;
  const listeners = new Set<() => void>();

  const get = () => current;

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const set = (next: T | ((current: T) => T)): void => {
    const value =
      typeof next === "function"
        ? (next as (current: T) => T)(current)
        : next;
    if (Object.is(value, current)) return;
    current = value;
    for (const listener of listeners) listener();
  };

  const use = (): T => useSyncExternalStore(subscribe, get, get);

  return { get, set, subscribe, use };
}
