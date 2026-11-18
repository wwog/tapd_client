import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { Maximize2, Minimize2 } from "lucide-react";

import { agentLabel } from "./labels";
import type { AgentLocale } from "./types";

/**
 * One card in the stream's attention corner.
 *
 * `content` owns everything inside the card — its summary line, its counts and
 * its actions — so the region stays generic. `id` is the React key and is
 * meant to become the key for per-session dismissal memory (a terminal count
 * the user closed stays closed).
 *
 * Planned items besides the todo list: terminals currently running (closable,
 * gone once they exit) and sub-agents currently working (opens their list).
 * They only need to be pushed into `items`; each one is a [`StreamHudCard`].
 */
export type StreamHudItem = {
  id: string;
  content: ReactNode;
};

/** Shell grow/shrink duration. */
const HUD_MOTION_MS = 160;

/**
 * The floating attention corner of the message stream: it is anchored to the
 * right end of the view-tab row, so a folded capsule never covers the
 * transcript.
 *
 * The region is `pointer-events-none` everywhere no card covers, so the text
 * underneath still scrolls; cards re-enable pointer events for themselves.
 */
export const StreamHud = memo(function StreamHud({
  items,
  locale,
  className,
}: {
  items: readonly StreamHudItem[];
  locale: AgentLocale;
  className?: string;
}) {
  if (items.length === 0) return null;

  return (
    <div
      role="region"
      aria-label={agentLabel("hud.region", locale)}
      className={clsx(
        "pointer-events-none absolute inset-y-0 left-0 right-6 z-20 flex items-center justify-end gap-2",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.id} className="pointer-events-auto max-w-full">
          {item.content}
        </div>
      ))}
    </div>
  );
});

/**
 * One shell for both states, modelled on ZCode's status panel: folded it is a
 * capsule just as wide as its summary; opening it does not swap in a second
 * component — the same shell keeps its top-right corner and grows into the
 * panel, then shrinks back into the capsule.
 *
 * The shell is measured before and after the state change and animated
 * width/height between the two sizes, so the growth is the capsule itself and
 * never a separate block appearing below it. The panel is capped at a share of
 * the viewport and scrolls inside.
 */
export function StreamHudCard({
  summary,
  children,
  locale,
  panelLabel,
}: {
  /** Capsule content: the icon morphs into the expand glyph on hover. */
  summary: { icon: ReactNode; label: ReactNode };
  /** Panel body, rendered inside the shell's scroll viewport. */
  children: ReactNode;
  locale: AgentLocale;
  /** Accessible name of the open panel; the region label by default. */
  panelLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  /** Size of the shell just before the state change, for the grow animation. */
  const fromRef = useRef<{ width: number; height: number } | null>(null);
  const expandLabel = agentLabel("hud.expand", locale);
  const collapseLabel = agentLabel("hud.collapse", locale);

  const toggle = useCallback((next: boolean) => {
    const rect = shellRef.current?.getBoundingClientRect();
    fromRef.current = rect ? { width: rect.width, height: rect.height } : null;
    setOpen(next);
  }, []);

  // Runs before paint: the shell has already rendered at its new size, so
  // animating from the recorded size back to it shows one object growing.
  useLayoutEffect(() => {
    const element = shellRef.current;
    const from = fromRef.current;
    fromRef.current = null;
    if (!element || !from) return;
    const to = element.getBoundingClientRect();
    if (
      Math.abs(to.width - from.width) < 1 &&
      Math.abs(to.height - from.height) < 1
    ) {
      return;
    }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof element.animate !== "function") return;
    for (const animation of element.getAnimations()) animation.cancel();
    element.animate(
      [
        { width: `${from.width}px`, height: `${from.height}px` },
        { width: `${to.width}px`, height: `${to.height}px` },
      ],
      { duration: HUD_MOTION_MS, easing: "ease-out", fill: "none" },
    );
  }, [open]);

  // Escape folds it back; the card is a persistent overlay, so nothing else
  // closes it behind the reader's back.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") toggle(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, toggle]);

  return (
    <div
      ref={shellRef}
      className={clsx(
        // The shell's top-right corner is fixed: `top-1/2 -mt-4` centres the
        // folded 32px capsule on the tab row, and the open panel keeps that
        // corner and grows left/down from it.
        "pointer-events-auto absolute right-0 top-1/2 z-10 -mt-4 flex flex-col overflow-hidden rounded-2xl border border-border bg-surface",
        open
          ? "max-h-[min(60dvh,32rem)] w-80 max-w-full"
          : "h-8 w-max max-w-full",
      )}
    >
      {open ? (
        <>
          <button
            type="button"
            aria-label={collapseLabel}
            title={collapseLabel}
            onClick={() => toggle(false)}
            className="absolute right-2 top-2 z-10 grid h-6 w-6 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-sky-200"
          >
            <Minimize2 size={14} />
          </button>
          <div
            role="group"
            aria-label={panelLabel ?? agentLabel("hud.region", locale)}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
          >
            {children}
          </div>
        </>
      ) : (
        <button
          type="button"
          aria-expanded={false}
          aria-label={expandLabel}
          title={expandLabel}
          onClick={() => toggle(true)}
          className="group flex h-full w-full items-center gap-1.5 overflow-hidden pl-2 pr-3 text-left text-ui-caption text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-sky-200"
        >
          <span className="relative size-4 shrink-0">
            <span className="absolute inset-0 grid place-items-center transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
              {summary.icon}
            </span>
            <Maximize2
              size={14}
              className="absolute inset-0 m-auto text-slate-500 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            />
          </span>
          <span className="min-w-0 truncate">{summary.label}</span>
        </button>
      )}
    </div>
  );
}
