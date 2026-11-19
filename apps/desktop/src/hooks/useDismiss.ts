import { useEffect, useRef, type RefObject } from "react";

export type DismissOptions = {
  /** Close when the page/window scrolls (capture phase, like a menu). */
  scroll?: boolean;
  /** Close when the window is resized. */
  resize?: boolean;
  /** Close when the window loses focus. */
  blur?: boolean;
  /** Element that toggles the layer: pressing it is not an outside click. */
  ignore?: RefObject<HTMLElement | null>;
};

/**
 * Dismissable layers (menus, popovers) currently open, in mount order. Only
 * the front one answers Escape or an outside click, so a picker opened from
 * inside a popover closes alone.
 */
let openLayers = 0;

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
  const { scroll = false, resize = false, blur = false, ignore } = options;
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;

    openLayers += 1;
    // Layers stack: a picker opened from inside a popover is a later layer.
    // Only the front one answers dismissal, otherwise a click inside the inner
    // card reads as "outside" for the outer one and both close at once.
    const depth = openLayers;
    const nested = () => openLayers > depth;
    const dismiss = () => closeRef.current();
    const dismissIfFront = () => {
      if (!nested()) dismiss();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (nested()) return;
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (ignore?.current?.contains(target)) return;
      dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissIfFront();
    };
    // Scrolling inside the layer (its own list, or a textarea following the
    // caret) is not "the page moved away"; only an outside scroll dismisses.
    const onScroll = (event: Event) => {
      if (ref.current?.contains(event.target as Node)) return;
      dismissIfFront();
    };

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    if (scroll) window.addEventListener("scroll", onScroll, true);
    if (resize) window.addEventListener("resize", dismiss);
    if (blur) window.addEventListener("blur", dismiss);

    return () => {
      openLayers -= 1;
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      if (scroll) window.removeEventListener("scroll", onScroll, true);
      if (resize) window.removeEventListener("resize", dismiss);
      if (blur) window.removeEventListener("blur", dismiss);
    };
  }, [open, ref, ignore, scroll, resize, blur]);
}
