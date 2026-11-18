import { memo, useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Maximize2, Minimize2 } from "lucide-react";

import { agentLabel } from "./labels";
import type { AgentLocale } from "./types";

/**
 * One card in the stream's attention corner (floating, top-right of the
 * transcript).
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

/**
 * The floating attention corner of the message stream: it is anchored to the
 * right end of the view-tab row, so a folded capsule never covers the
 * transcript. An open panel drops from the same anchor and overlays the stream.
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
        // Spans the view-tab row: the folded capsule sits at its right end, and
        // an open panel escapes below the row (`top-full` in the card), so the
        // tabs stay clickable and a folded card never covers the transcript.
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
 * One shell in the attention corner, modelled on ZCode's status panel: folded
 * it is a capsule just as wide as its summary, and opening it swaps in a fixed
 * width panel with a "collapse to capsule" control in the corner.
 *
 * A capsule never grows past the stream; the panel is capped at a share of the
 * viewport and scrolls inside. Both states keep the same rounded shell so the
 * swap reads as one object changing shape.
 */
export function StreamHudCard({
  summary,
  children,
  locale,
  panelLabel,
}: {
  /** Capsule content: the icon morphs into the expand glyph on hover. */
  summary: { icon: ReactNode; label: ReactNode };
  /** Panel body, rendered inside the card's scroll viewport. */
  children: ReactNode;
  locale: AgentLocale;
  /** Accessible name of the open panel; the region label by default. */
  panelLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const expandLabel = agentLabel("hud.expand", locale);
  const collapseLabel = agentLabel("hud.collapse", locale);

  // Escape folds it back; the card is a persistent overlay, so nothing else
  // closes it behind the reader's back.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        aria-expanded={false}
        aria-label={expandLabel}
        title={expandLabel}
        onClick={() => setOpen(true)}
        className="group flex h-8 max-w-full items-center gap-1.5 overflow-hidden rounded-2xl border border-border bg-surface pl-2 pr-3 text-left text-ui-caption text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-sky-200"
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
    );
  }

  return (
    <section
      aria-label={panelLabel ?? agentLabel("hud.region", locale)}
      className="pointer-events-auto absolute right-0 top-full z-10 mt-1.5 flex max-h-[min(60dvh,32rem)] w-80 max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface"
    >
      <button
        type="button"
        aria-label={collapseLabel}
        title={collapseLabel}
        onClick={() => setOpen(false)}
        className="absolute right-2 top-2 z-10 grid h-6 w-6 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-sky-200"
      >
        <Minimize2 size={14} />
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {children}
      </div>
    </section>
  );
}
