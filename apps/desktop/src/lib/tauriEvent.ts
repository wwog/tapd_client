import {
  useEffect,
  useRef,
  type DependencyList,
} from "react";
import {
  listen,
  type Event as TauriEvent,
  type UnlistenFn,
} from "@tauri-apps/api/event";

/**
 * Registers an async Tauri subscription and disposes it safely, including the
 * race where the component unmounts before `listen()` resolves.
 */
const useTauriRegistration = (
  subscribe: (() => Promise<UnlistenFn>) | null,
  deps: DependencyList,
): void => {
  useEffect(() => {
    if (!subscribe) return;

    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    const register = async () => {
      try {
        const fn = await subscribe();
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        // No Tauri runtime (browser preview): nothing to clean up.
      }
    };
    void register();

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // The caller owns the subscription identity; `deps` decides when to redo it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
};

/**
 * Subscribes to a Tauri event for the lifetime of the component (or until
 * `deps` changes). The handler always sees the latest render without causing
 * a resubscribe.
 */
export function useTauriEvent<T>(
  event: string,
  handler: (payload: T) => void,
  deps: DependencyList = [],
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useTauriRegistration(
    () => listen<T>(event, (payload: TauriEvent<T>) => handlerRef.current(payload.payload)),
    [event, ...deps],
  );
}

/**
 * Same lifetime handling for subscriptions that already wrap `listen()`, such
 * as `onNotificationShow`, window drag/drop or layout callbacks. Pass `null`
 * to stay unsubscribed (e.g. a closed sheet).
 */
export function useTauriSubscription(
  subscribe: (() => Promise<UnlistenFn>) | null,
  deps: DependencyList = [],
): void {
  useTauriRegistration(subscribe, deps);
}
