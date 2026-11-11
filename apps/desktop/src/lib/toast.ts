import { createExternalStore } from "./store";
import type { ToastFn } from "./feature";

export type Toast = { kind: "ok" | "error"; text: string };

/** How long a toast stays on screen before it clears itself. */
const TOAST_DURATION_MS = 4200;

export const toastStore = createExternalStore<Toast | null>(null);

let dismissTimer: number | null = null;

const clearTimer = (): void => {
  if (dismissTimer !== null) {
    window.clearTimeout(dismissTimer);
    dismissTimer = null;
  }
};

/** Shows a toast and restarts the auto-dismiss timer (like the old effect). */
export const showToast: ToastFn = (kind, text) => {
  toastStore.set({ kind, text });
  clearTimer();
  dismissTimer = window.setTimeout(() => {
    dismissTimer = null;
    toastStore.set(null);
  }, TOAST_DURATION_MS);
};

/** Hides the toast immediately, without waiting for the timer. */
export const dismissToast = (): void => {
  clearTimer();
  toastStore.set(null);
};

/** Current toast, for the host that renders it. */
export function useToast(): Toast | null {
  return toastStore.use();
}

/** Toast state plus the stable actions shared by the app and its children. */
export function useToastStore(): {
  toast: Toast | null;
  show: ToastFn;
  dismiss: () => void;
} {
  const toast = toastStore.use();
  return { toast, show: showToast, dismiss: dismissToast };
}
