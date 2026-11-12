import clsx from "clsx";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/** Shared settings modal: overlay, fixed header and a scrolling body. */
export function Dialog(props: {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  action?: ReactNode;
  size?: "default" | "wide";
  /**
   * `false` stops the body from scrolling as one block; the content then owns
   * its scroll areas (e.g. a fixed list beside a scrolling detail pane).
   */
  bodyScroll?: boolean;
  children: ReactNode;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/30 p-6 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        className={clsx(
          "flex flex-col overflow-hidden rounded-2xl bg-surface  border border-black/10",
          props.size === "wide"
            ? "h-[min(82vh,760px)] w-[min(1180px,94vw)]"
            : "max-h-[min(82vh,760px)] w-[min(560px,92vw)]",
        )}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-slate-100 px-4 py-3">
          {props.icon}
          <h2 className="text-ui-base font-normal text-slate-900">{props.title}</h2>
          {props.action ? (
            <div className="ml-auto flex items-center gap-2">{props.action}</div>
          ) : null}
          <button
            type="button"
            aria-label={`关闭${props.title}`}
            onClick={props.onClose}
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
