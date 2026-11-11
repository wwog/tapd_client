import clsx from "clsx";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";

import { dismissToast, useToast } from "../lib/toast";

/** Fixed toast in the bottom-right corner; renders nothing while idle. */
export function ToastHost() {
  const toast = useToast();

  if (!toast) return null;

  return (
    <div
      className={clsx(
        "theme-static-dark fixed bottom-5 right-5 z-[60] flex max-w-md items-start gap-2 rounded-xl px-4 py-3 text-ui-base ",
        toast.kind === "ok" ? "bg-slate-900 text-slate-100" : "bg-rose-500 text-white",
      )}
    >
      {toast.kind === "ok" ? (
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" />
      ) : (
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      )}
      <span className="break-all">{toast.text}</span>
      <button
        type="button"
        onClick={dismissToast}
        className="ml-2 shrink-0 opacity-60 transition hover:opacity-100"
      >
        <X size={14} />
      </button>
    </div>
  );
}
