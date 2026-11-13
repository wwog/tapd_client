import { useSyncExternalStore } from "react";
import { ArrowUpCircle, ShieldAlert } from "lucide-react";

import { getUpdateSnapshot, subscribeUpdate } from "../lib/update";
import { t } from "../lib/i18n";

type Props = {
  /** Tasks waiting for a review or merge decision; opens the 待处理 queue. */
  pendingReviews: number;
  onOpenReviews: () => void;
  onOpenAccount: () => void;
};

/**
 * Top drag strip: window dragging plus the pending review badge and the
 * "new version" entry point. List refreshes report progress in the table
 * footer instead, so the title bar stays quiet.
 */
export function TitleBar({ pendingReviews, onOpenReviews, onOpenAccount }: Props) {
  /** Background update state (checked every two hours by the Rust side). */
  const updateState = useSyncExternalStore(
    subscribeUpdate,
    getUpdateSnapshot,
    getUpdateSnapshot,
  );

  return (
    <div
      className="relative flex h-11 shrink-0 items-center gap-2 px-4"
      data-tauri-drag-region
    >
      <span className="ml-[62px] h-full flex-1" data-tauri-drag-region />

      {/* Pending reviews and merges stay visible until the user decides them. */}
      {pendingReviews > 0 ? (
        <button
          type="button"
          onClick={onOpenReviews}
          title={t("app.titleBar.pending", { n: pendingReviews })}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-amber-600 transition hover:bg-amber-50"
        >
          <span className="relative">
            <ShieldAlert size={16} />
            <span className="absolute -right-1.5 -top-1.5 min-w-[14px] rounded-full bg-amber-500 px-1 text-center text-ui-2xs font-normal leading-[14px] tabular-nums text-white">
              {pendingReviews}
            </span>
          </span>
        </button>
      ) : null}

      {/* The update icon only exists while a newer release is known. */}
      {updateState?.available ? (
        <div className="group relative shrink-0">
          <button
            type="button"
            onClick={onOpenAccount}
            title={t("app.update.available", { version: updateState.available.version })}
            className="grid h-7 w-7 place-items-center rounded-lg text-emerald-600 transition hover:bg-emerald-50"
          >
            <span className="relative">
              <ArrowUpCircle size={16} />
              <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-emerald-500 border-2 border-canvas" />
            </span>
          </button>

          <div className="pointer-events-none invisible absolute right-0 top-9 z-50 w-80 translate-y-1 theme-static-dark rounded-xl bg-slate-900/95 p-3 text-slate-200 opacity-0  border border-white/10 backdrop-blur-xl transition-all duration-150 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100">
            <div className="flex items-center gap-2 text-ui-sm">
              <ArrowUpCircle size={13} className="text-emerald-400" />
              <span className="font-normal text-slate-100">
                {t("app.update.newVersion", { version: updateState.available.version })}
              </span>
              <span className="ml-auto text-ui-xs text-slate-400">{t("app.update.changelog")}</span>
            </div>
            <p className="mt-2 max-h-56 overflow-y-auto whitespace-pre-line text-ui-sm leading-5 text-slate-300">
              {updateState.available.notes}
            </p>
            <p className="mt-2 border-t border-white/10 pt-2 text-ui-xs text-slate-400">
              {t("app.update.openAccount")}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
