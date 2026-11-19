import clsx from "clsx";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

import { ModalDragStrip } from "./ui";
import { t } from "../lib/i18n";
import { useLayerClose } from "../hooks/useLayerClose";

/** Shared settings modal: overlay, fixed header and a scrolling body. */
export function Dialog(props: {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  action?: ReactNode;
  size?: "default" | "wide";
  /**
   * `wide` normally keeps a fixed height so split panes (list + detail) fill
   * the dialog. Set `fit` for content-shaped dialogs: the height hugs the
   * content and only caps at the viewport, so short content leaves no blank
   * space and tall content scrolls instead of overflowing.
   */
  fit?: boolean;
  /**
   * `false` stops the body from scrolling as one block; the content then owns
   * its scroll areas (e.g. a fixed list beside a scrolling detail pane).
   */
  bodyScroll?: boolean;
  children: ReactNode;
}) {
  // The parent owns "is this dialog open"; closing is a two-phase handoff so
  // the panel can play its exit animation before the parent unmounts it.
  const { closing, requestClose } = useLayerClose(props.onClose);

  return createPortal(
    <div
      data-component="Dialog"
      className={clsx(
        "modal-overlay fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/30 p-6 backdrop-blur-[1px]",
        closing && "modal-overlay-out",
      )}
    >
      <ModalDragStrip />
      <div
        className={clsx(
          "modal-panel relative z-10 flex flex-col overflow-hidden rounded-2xl bg-surface  border border-black/10",
          props.size === "wide"
            ? props.fit
              ? "max-h-[min(82vh,760px)] w-[min(1180px,94vw)]"
              : "h-[min(82vh,760px)] w-[min(1180px,94vw)]"
            : "max-h-[min(82vh,760px)] w-[min(560px,92vw)]",
          closing && "modal-panel-out",
        )}
      >
        <header
          data-tauri-drag-region
          className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 py-3"
        >
          {props.icon}
          <h2 data-tauri-drag-region className="text-ui-base font-normal text-slate-900">
            {props.title}
          </h2>
          {props.action ? (
            <div className="ml-auto flex items-center gap-2">{props.action}</div>
          ) : null}
          <button
            type="button"
            aria-label={t("app.dialog.close", { title: props.title })}
            onClick={() => requestClose()}
            className={clsx(
              "grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700",
              props.action ? "" : "ml-auto",
            )}
          >
            <X size={16} />
          </button>
        </header>
        <div
          className={clsx(
            "min-h-0 flex-1 p-4",
            props.bodyScroll === false ? "overflow-hidden" : "overflow-y-auto",
          )}
        >
          {props.children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
