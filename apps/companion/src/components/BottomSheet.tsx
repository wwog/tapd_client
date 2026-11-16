import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { t } from "../lib/i18n";

/**
 * Mobile bottom sheet for filters, forms and row actions: fixed scrim + a
 * panel that slides up from the bottom edge. Tapping the scrim or the X
 * closes it; body scroll lives in the middle section.
 */
export function BottomSheet(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Pinned above the scroll body (apply / save buttons). */
  footer?: ReactNode;
}) {
  if (!props.open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div
        className="sheet-backdrop absolute inset-0 bg-black/40"
        onClick={props.onClose}
      />
      <div className="sheet-panel sheet-safe absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl border-t border-border bg-surface">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h2 className="min-w-0 truncate text-ui-caption text-slate-900">{props.title}</h2>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={props.onClose}
            className="shrink-0 rounded-md p-1 text-slate-400 transition active:bg-overlay-soft"
          >
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          {props.children}
        </div>
        {props.footer ? (
          <div className="shrink-0 border-t border-border px-4 py-3">{props.footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
