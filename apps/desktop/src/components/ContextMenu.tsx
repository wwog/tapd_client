import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";

import { useDismiss } from "../hooks/useDismiss";
import { useLayerClose } from "../hooks/useLayerClose";

/** Keep at least this much space between the menu and the window edge. */
const EDGE = 8;

type Props = {
  x: number;
  y: number;
  /** Accessible name of the menu. */
  label: string;
  onClose: () => void;
  /** Width or other layout overrides; the default is 208px. */
  className?: string;
  children: (requestClose: () => void) => ReactNode;
};

/**
 * Cursor-anchored popup menu shared by the list rows (bug table, project
 * sidebar, agent history). It clamps itself into the window using its measured
 * size — menu height depends on the items, so callers do not pass estimates —
 * and dismisses like a native menu: outside click, Escape, scroll, resize or
 * window blur. Both entry and exit are animated; `useLayerClose` delays the
 * unmount so the exit can play.
 */
export function ContextMenu({ x, y, label, onClose, className, children }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { closing, requestClose, reset } = useLayerClose(onClose);
  useDismiss(true, ref, () => requestClose(), { scroll: true, resize: true, blur: true });

  const [pos, setPos] = useState({ left: x, top: y });

  // A different anchor means a new menu: drop any pending exit from the
  // previous one when the caller reuses this instance.
  useEffect(() => {
    reset();
  }, [x, y, reset]);

  // Measure after mount, then clamp. Layout effects re-render before paint, so
  // the menu never flashes outside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - el.offsetWidth - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - el.offsetHeight - EDGE)),
    });
  }, [x, y]);

  return (
    <div
      data-component="ContextMenu"
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(event) => event.preventDefault()}
      className={clsx(
        "context-menu fixed z-50 w-[208px] rounded-xl border border-border bg-surface p-1.5",
        closing && "context-menu-out",
        className,
      )}
    >
      {children(requestClose)}
    </div>
  );
}

type ItemTone = "default" | "danger";

export function ContextMenuItem(props: {
  label: string;
  icon?: ReactNode;
  /** Copy-style feedback: shows the confirmed state until the menu closes. */
  done?: boolean;
  tone?: ItemTone;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  const { label, icon, done = false, tone = "default", disabled, title, onClick } = props;
  return (
    <button
      data-component="ContextMenuItem"
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-ui-caption transition-colors",
        done
          ? "bg-emerald-50 text-emerald-700"
          : tone === "danger"
            ? "text-rose-600 hover:bg-rose-50"
            : "text-slate-600 hover:bg-overlay-soft hover:text-slate-900",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {icon ? (
        <span
          className={clsx(
            "shrink-0",
            done ? "text-emerald-600" : tone === "danger" ? "text-rose-500" : "text-slate-400",
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

export function ContextMenuSeparator() {
  return <div data-component="ContextMenuSeparator" className="my-1 border-t border-border" />;
}

/** Small caption used to group items (e.g. the dev-only simulation block). */
export function ContextMenuLabel({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div data-component="ContextMenuLabel" className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-ui-2xs text-slate-400">
      {icon}
      {children}
    </div>
  );
}
