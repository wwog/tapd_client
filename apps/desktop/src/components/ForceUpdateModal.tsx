import { useState, useSyncExternalStore } from "react";
import { ArrowUpCircle, Download, ShieldAlert } from "lucide-react";

import { t } from "../lib/i18n";
import {
  forcedUpdateOf,
  getUpdateSnapshot,
  subscribeUpdate,
  updateApi,
} from "../lib/update";
import { Button, ModalDragStrip } from "./ui";

/**
 * Mandatory-update gate.
 *
 * Rendered above every view — the login screen and the onboarding included —
 * and intentionally impossible to dismiss: the release notes carried the force
 * marker, so the only ways forward are installing the update or quitting the
 * app. The requirement is recorded in `config.json` by the Rust side, so it
 * survives restarts and re-checks even when the machine is offline.
 */
export function ForceUpdateModal() {
  const state = useSyncExternalStore(
    subscribeUpdate,
    getUpdateSnapshot,
    getUpdateSnapshot,
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const update = forcedUpdateOf(state);
  if (!state || !update) return null;

  const installing =
    state.phase === "downloading" ||
    state.phase === "installing" ||
    state.phase === "ready";
  const failed = state.phase === "error";
  const percent = state.progress?.percent ?? null;

  const install = async () => {
    if (busy || installing) return;
    setBusy(true);
    setActionError(null);
    try {
      await updateApi.install();
    } catch (error) {
      setActionError(String(error));
    } finally {
      setBusy(false);
    }
  };

  const manual = () => {
    setActionError(null);
    void updateApi.openManual().catch((error) => setActionError(String(error)));
  };

  const message = actionError ?? (failed ? state.error : null);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="force-update-title"
      className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-900/55 p-6 backdrop-blur-sm"
    >
      <ModalDragStrip />
      <div className="relative z-10 w-full max-w-[460px] rounded-2xl border border-border bg-surface p-6">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-amber-50 text-amber-600">
            <ShieldAlert size={16} />
          </span>
          <h2 id="force-update-title" className="text-ui-lg text-slate-900">
            {t("settings.force.title")}
          </h2>
        </div>

        <p className="mt-3 text-ui-sm leading-5 text-slate-500">
          {t("settings.force.message", {
            current: state.currentVersion,
            version: update.version,
          })}
        </p>

        {update.notes ? (
          <div className="mt-3 max-h-[220px] select-text overflow-y-auto whitespace-pre-line rounded-xl border border-border bg-canvas/60 p-3 text-ui-sm leading-5 text-slate-600">
            {update.notes}
          </div>
        ) : null}

        {installing ? (
          <div className="mt-4">
            <div className="flex items-center justify-between text-ui-xs text-slate-500">
              <span>
                {state.phase === "downloading" ? t("settings.force.downloading") : t("settings.force.installing")}
              </span>
              {percent !== null ? (
                <span className="tabular-nums">{Math.round(percent)}%</span>
              ) : null}
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-sky-500 transition-[width] duration-300"
                style={{ width: `${percent === null ? 6 : Math.max(2, percent)}%` }}
              />
            </div>
          </div>
        ) : null}

        {message ? (
          <p
            className="mt-3 line-clamp-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm text-rose-600"
            title={message}
          >
            {message}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={manual}
            icon={<Download size={13} />}
          >
            {t("settings.update.manual")}
          </Button>
          <Button
            size="sm"
            onClick={() => void install()}
            loading={busy || installing}
            icon={<ArrowUpCircle size={13} />}
          >
            {failed ? t("settings.force.retry") : t("settings.force.upgrade")}
          </Button>
        </div>

        <p className="mt-3 text-center text-ui-xs text-slate-400">
          {t("settings.force.footer")}
        </p>
      </div>
    </div>
  );
}
