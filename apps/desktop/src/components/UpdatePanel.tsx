import { useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  CheckCircle2,
  CloudDownload,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";

import { api } from "../lib/api";
import { formatBytes } from "../lib/format";
import {
  formatCheckTime,
  getUpdateSnapshot,
  subscribeUpdate,
  UPDATE_PHASE_LABELS,
  updateApi,
  updateOwnsScreen,
} from "../lib/update";
import { Button, cardClass } from "./ui";

type Props = {
  toast?: (kind: "ok" | "error", text: string) => void;
};

/**
 * Version + release-notes card. Used by Settings, the account page and the
 * title-bar update dialog; all three share the same store.
 */
export function UpdatePanel({ toast }: Props) {
  const state = useSyncExternalStore(
    subscribeUpdate,
    getUpdateSnapshot,
    getUpdateSnapshot,
  );
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);

  const phase = state?.phase ?? "idle";
  const available = state?.available ?? null;
  const progress = state?.progress ?? null;
  const ownsScreen = updateOwnsScreen(phase);

  const check = async () => {
    setChecking(true);
    try {
      // The panel itself renders the new state ("可更新到 vX" / phase label),
      // so no success toast is needed.
      await updateApi.check();
    } catch (error) {
      toast?.("error", `检查更新失败：${String(error)}`);
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    setInstalling(true);
    try {
      await updateApi.install();
    } catch (error) {
      toast?.("error", `无法开始更新：${String(error)}`);
    } finally {
      setInstalling(false);
    }
  };

  const manual = async () => {
    try {
      await updateApi.openManual();
    } catch (error) {
      toast?.("error", String(error));
    }
  };

  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
          <CloudDownload size={15} className="text-slate-400" />
          版本更新
        </h2>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-ui-xs text-slate-500">
          v{state?.currentVersion ?? "—"}
        </span>
        {phase === "available" ? (
          <span className="rounded bg-sky-50 px-1.5 py-0.5 text-ui-xs font-normal text-sky-700">
            可更新到 v{available?.version}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={checking || phase === "checking"}
            onClick={() => void check()}
            disabled={ownsScreen}
            icon={<RefreshCw size={13} />}
          >
            检查更新
          </Button>
        </div>
      </div>

      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-sm text-slate-500">
        <span>
          {phase === "available" && available
            ? `新版本 v${available.version} 已于 ${available.date ?? "近期"} 发布`
            : UPDATE_PHASE_LABELS[phase]}
        </span>
        <span className="text-slate-300">·</span>
        <span>上次检查 {formatCheckTime(state?.checkedAt ?? null)}</span>
        <button
          type="button"
          onClick={() =>
            void api
              .openPath("https://github.com/wwog/tapd_client/releases")
              .catch((error) => toast?.("error", String(error)))
          }
          className="inline-flex items-center gap-1 text-sky-600 transition hover:text-sky-700"
        >
          <ExternalLink size={10} />
          历史更新日志
        </button>
      </p>

      {phase === "downloading" ? (
        <div className="mt-3">
          <div className="flex items-center justify-between text-ui-sm text-slate-500">
            <span>正在下载更新包…</span>
            <span className="tabular-nums">
              {progress?.percent != null ? `${progress.percent.toFixed(0)}%` : ""}
              {progress?.total
                ? ` · ${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
                : ""}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-sky-500 transition-[width] duration-200"
              style={{ width: `${progress?.percent ?? 3}%` }}
            />
          </div>
        </div>
      ) : null}

      {phase === "installing" || phase === "ready" ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-sky-50 px-3 py-2 text-ui-sm text-sky-700">
          {phase === "ready" ? (
            <CheckCircle2 size={13} />
          ) : (
            <Loader2 size={13} className="animate-spin" />
          )}
          {phase === "ready" ? "安装完成，应用即将重启…" : "下载完成，正在解包并安装…"}
        </div>
      ) : null}

      {phase === "error" && state?.error ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="select-text min-w-0 break-words">{state.error}</span>
        </div>
      ) : null}

      {available ? (
        <>
          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <h3 className="text-ui-sm font-normal text-slate-600">更新日志</h3>
              <span className="text-ui-xs text-slate-400">来自 GitHub Release</span>
            </div>
            <div className="select-text max-h-64 overflow-y-auto whitespace-pre-line rounded-xl bg-slate-50 px-3 py-2.5 font-mono text-ui-sm leading-5 text-slate-600 border border-slate-100">
              {available.notes}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => void install()}
              loading={installing}
              disabled={ownsScreen}
              icon={<Download size={13} />}
            >
              立即更新
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void manual()}
              icon={<ExternalLink size={13} />}
            >
              手动下载
            </Button>
            <span className="text-ui-xs text-slate-400">
              更新期间主窗口会隐藏，顶部胶囊显示下载与安装进度。
            </span>
          </div>
        </>
      ) : null}

      {!available && phase === "idle" && state?.error ? (
        <p className="mt-2 text-ui-sm leading-5 text-rose-600">
          检查更新失败：{state.error}
        </p>
      ) : null}
    </>
  );

  return (
    <section
      className={clsx(cardClass, phase === "available" && "border-sky-200")}
    >
      {body}
    </section>
  );
}
