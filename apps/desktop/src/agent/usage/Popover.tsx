/**
 * Anchored popover used by every usage figure. One shell owns the portal,
 * placement, outside-click/Escape dismissal and the card frame, so the chips
 * only describe their contents.
 *
 * The dock sits under the transcript and never scrolls with it, so it asks for
 * `scroll: false`; a chip inside the transcript keeps the scroll dismissal.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

import { useDismiss } from "../../hooks/useDismiss";
import { computeMenuPosition, type MenuPosition } from "../../lib/menuPosition";

type Props = {
  /** The chip body; the shell owns the button and its hover state. */
  trigger: ReactNode;
  /** Accessible name of the dialog and the chip. */
  title: string;
  hint?: string;
  /** Right-aligned summary in the card header. */
  meta?: ReactNode;
  minWidth?: number;
  /** Estimated full card height, used for up/down placement. */
  fullHeight?: number;
  /** The card sits outside the transcript, so streaming must not close it. */
  dismissOnScroll?: boolean;
  children: ReactNode;
};

export function UsagePopover({
  trigger,
  title,
  hint,
  meta,
  minWidth = 264,
  fullHeight = 210,
  dismissOnScroll = false,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, cardRef, close, {
    scroll: dismissOnScroll,
    resize: true,
  });

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(computeMenuPosition(rect, { placement: "up", minWidth, fullHeight }));
    setOpen(true);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={title}
        aria-expanded={open}
        title={hint}
        onClick={toggle}
        className={clsx(
          "inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-ui-xs text-slate-400 transition hover:bg-overlay hover:text-slate-600",
          open && "bg-overlay text-slate-600",
        )}
      >
        {trigger}
      </button>

      {open && position
        ? createPortal(
            <>
              <button
                type="button"
                aria-label={title}
                tabIndex={-1}
                className="fixed inset-0 z-[110] cursor-default"
                onClick={close}
              />
              <div
                ref={cardRef}
                role="dialog"
                aria-label={title}
                style={{
                  left: position.left,
                  top: position.top,
                  bottom: position.bottom,
                  width: position.width,
                  maxHeight: position.maxHeight,
                }}
                className="fixed z-[120] overflow-hidden rounded-xl border border-border bg-surface p-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-ui-sm text-slate-700">{title}</span>
                  {meta ? (
                    <span className="tabular-nums text-ui-xs text-slate-500">{meta}</span>
                  ) : null}
                </div>
                {children}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}

/** Label/value grid shared by every card. */
export function UsageRows({ children }: { children: ReactNode }) {
  return (
    <dl data-component="UsageRows" className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5">
      {children}
    </dl>
  );
}

export function UsageRow({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-ui-xs text-slate-400">{label}</dt>
      <dd className="min-w-0 text-right text-ui-xs tabular-nums text-slate-600">
        {children}
      </dd>
    </>
  );
}

/** Dot separating dock chips; also used between inline figures. */
export function Dot() {
  return <span data-component="Dot" className="shrink-0 text-slate-300">·</span>;
}
