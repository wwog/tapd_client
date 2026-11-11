import { useEffect, useRef, type RefObject } from "react";

export type DismissOptions = {
  /** Close when the page/window scrolls (capture phase, like a menu). */
  scroll?: boolean;
  /** Close when the window is resized. */
  resize?: boolean;
  /** Close when the window loses focus. */
  blur?: boolean;
};

/**
 * Dismissable layers (menus, popovers) currently open. A page-level Escape
 * handler reads this first: the same key must close the front layer only, and
 * the page's own listener is registered before the menu's, so it cannot learn
 * that answer from the event.
 */
let openLayers = 0;

export function hasOpenDismissLayer(): boolean {
  return openLayers > 0;
}

/**
 * Closes a popover on outside `mousedown` and Escape, with optional dismissal
 * on scroll, resize or window blur. `close` is read through a ref so callers
 * can pass an inline setter without re-registering listeners on every render.
 */
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
  options: DismissOptions = {},
): void {
  const { scroll = false, resize = false, blur = false } = options;
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;

    openLayers += 1;
    const dismiss = () => closeRef.current();
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    if (scroll) window.addEventListener("scroll", dismiss, true);
    if (resize) window.addEventListener("resize", dismiss);
    if (blur) window.addEventListener("blur", dismiss);

    return () => {
      openLayers -= 1;
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      if (scroll) window.removeEventListener("scroll", dismiss, true);
      if (resize) window.removeEventListener("resize", dismiss);
      if (blur) window.removeEventListener("blur", dismiss);
    };
  }, [open, ref, scroll, resize, blur]);
}
