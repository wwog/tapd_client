import { memo, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AlignLeft } from "lucide-react";

import { t } from "../lib/i18n";
import type { PromptNavItem } from "./promptNav";

/**
 * Floating prompt list for a conversation with more than one round. It sits in
 * the left gutter of the transcript: collapsed it is one icon, open it lists
 * the prompts newest-first with the turn's line stats. Picking a row scrolls
 * that prompt back to the top of the viewport.
 */
export const PromptNavigator = memo(function PromptNavigator({
  items,
  currentKey,
  onJump,
}: {
  items: readonly PromptNavItem[];
  /** Newest turn, drawn with the stronger text colour. */
  currentKey?: string;
  onJump: (item: PromptNavItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (items.length < 2) return null;

  const label = t("agent.stream.prompts");

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute left-2 top-2 z-30 hidden @min-[900px]:block"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
        className={clsx(
          "pointer-events-auto grid h-7 w-7 place-items-center rounded-md text-slate-400 transition-colors hover:bg-overlay hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-sky-200",
          open && "bg-overlay text-slate-700",
        )}
      >
        <AlignLeft size={16} />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={label}
          className="pointer-events-auto absolute left-9 top-0 w-[22rem] max-w-[calc(100vw-3rem)] overflow-hidden rounded-xl border border-border bg-surface"
        >
          <div className="max-h-[60vh] overflow-y-auto overscroll-contain p-1.5">
            {items.map((item) => (
              <button
                key={`${item.key}:${item.seq}`}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onJump(item);
                }}
                className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-overlay"
              >
                <span
                  className={clsx(
                    "line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words text-ui-caption leading-5",
                    item.key === currentKey ? "text-slate-900" : "text-slate-600",
                  )}
                >
                  {item.text}
                </span>
                {item.added > 0 || item.removed > 0 ? (
                  <span className="flex shrink-0 flex-col items-end gap-0.5 text-ui-sm leading-4 tabular-nums">
                    {item.added > 0 ? (
                      <span className="text-emerald-600">+{item.added}</span>
                    ) : null}
                    {item.removed > 0 ? (
                      <span className="text-rose-500">-{item.removed}</span>
                    ) : null}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
});
