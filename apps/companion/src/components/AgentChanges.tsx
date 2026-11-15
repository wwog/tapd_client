import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, LoaderCircle, RefreshCw } from "lucide-react";

import {
  api,
  asApiError,
  type AgentChangeKind,
  type AgentChangeSummary,
  type AgentDiffView,
} from "../lib/api";
import { copyText } from "../lib/clipboard";
import { t } from "../lib/i18n";
import { Badge, type BadgeTone } from "./Badge";
import { BottomSheet } from "./BottomSheet";

export const CHANGE_TONES: Record<AgentChangeKind, BadgeTone> = {
  added: "green",
  modified: "amber",
  deleted: "red",
};

export const CHANGE_LETTERS: Record<AgentChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};

type FileDiffState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: AgentDiffView };

/**
 * Short commit hash with click-to-copy. Local feedback only: the button shows
 * 「已复制」briefly instead of raising a toast.
 */
export function CommitHash(props: { hash: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = async () => {
    if (!(await copyText(props.hash))) return;
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={copied ? t("magent.changes.copied") : t("magent.changes.copyHash")}
      className="inline-flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 font-mono text-ui-xs transition active:bg-overlay-soft"
    >
      <span className={copied ? "truncate text-emerald-700" : "truncate text-slate-600"}>
        {props.hash.slice(0, 8)}
      </span>
      {copied ? (
        <Check size={11} className="shrink-0 text-emerald-700" />
      ) : (
        <Copy size={11} className="shrink-0 text-slate-400" />
      )}
    </button>
  );
}

/** One load of `agent_task_changes`, replaced when the task changes. */
export function useAgentChangeSummary(taskId: string): AgentChangeSummary | null {
  const [summary, setSummary] = useState<AgentChangeSummary | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    setSummary(null);
    void api
      .agentTaskChanges(taskId)
      .then((next) => {
        if (request === requestRef.current) setSummary(next);
      })
      .catch(() => {
        // Cards keep their coarse `approval.files` chips; the task page's
        // changes section reports the error.
      });
    return () => {
      requestRef.current += 1;
    };
  }, [taskId]);

  return summary;
}

/**
 * 变更区：文件列表 + 逐文件增删行数，点一行在底部弹层看该文件 diff。
 * 移动端没有实时推送，进入页面或任务状态变化时取一次，点刷新再取一次。
 */
export function AgentChanges(props: {
  taskId: string;
  /** Changes when the task id or its status does, which refetches. */
  refreshKey: string;
}) {
  const { taskId, refreshKey } = props;
  const [summary, setSummary] = useState<AgentChangeSummary | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileDiffState>>({});
  const requestRef = useRef(0);
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setBusy(true);
    setError(null);
    try {
      const next = await api.agentTaskChanges(taskId);
      if (request !== requestRef.current) return;
      setSummary(next);
    } catch (err) {
      if (request === requestRef.current) setError(asApiError(err).message);
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  }, [taskId]);

  useEffect(() => {
    setOpenPath(null);
    setDiffs({});
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [refreshKey, load]);

  const refresh = () => {
    if (busy) return;
    setOpenPath(null);
    setDiffs({});
    void load();
  };

  const openFile = (file: { path: string; binary: boolean }) => {
    if (file.binary) return;
    setOpenPath(file.path);
    const current = diffs[file.path];
    if (current && current.kind !== "error") return;
    const requestTaskId = taskIdRef.current;
    setDiffs((state) => ({ ...state, [file.path]: { kind: "loading" } }));
    void api
      .agentTaskDiff(taskId, file.path)
      .then((view) => {
        if (taskIdRef.current !== requestTaskId) return;
        setDiffs((state) => ({ ...state, [file.path]: { kind: "ready", view } }));
      })
      .catch((err: unknown) => {
        if (taskIdRef.current !== requestTaskId) return;
        setDiffs((state) => ({
          ...state,
          [file.path]: { kind: "error", message: asApiError(err).message },
        }));
      });
  };

  const files = summary?.files ?? [];
  const truncated = summary ? summary.fileCount > files.length : false;
  const openDiff = openPath ? diffs[openPath] : undefined;

  return (
    <section className="mx-3 mt-3 overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="shrink-0 text-ui-xs text-slate-500">{t("magent.changes.title")}</span>
        {summary ? (
          <>
            {summary.additions > 0 ? (
              <span className="inline-flex shrink-0 items-center rounded-md bg-emerald-50 px-1.5 py-0.5 text-ui-xs tabular-nums text-emerald-700">
                +{summary.additions}
              </span>
            ) : null}
            {summary.deletions > 0 ? (
              <span className="inline-flex shrink-0 items-center rounded-md bg-rose-50 px-1.5 py-0.5 text-ui-xs tabular-nums text-rose-700">
                −{summary.deletions}
              </span>
            ) : null}
            <span className="shrink-0 text-ui-xs tabular-nums text-slate-400">
              {t("magent.changes.files", { count: summary.fileCount })}
            </span>
          </>
        ) : null}
        <button
          type="button"
          aria-label={t("magent.changes.refresh")}
          title={t("magent.changes.refresh")}
          disabled={busy}
          onClick={refresh}
          className="ml-auto shrink-0 rounded-md p-1.5 text-slate-400 transition active:bg-overlay-soft disabled:opacity-50"
        >
          <RefreshCw size={13} className={busy ? "animate-spin" : undefined} />
        </button>
      </div>

      <div className="border-t border-border">
        {error ? (
          <div className="px-3 py-2">
            <p className="select-text break-words text-ui-xs leading-5 text-rose-700">
              {t("magent.changes.loadFailed", { error })}
            </p>
            <button
              type="button"
              onClick={refresh}
              className="mt-1 rounded-md px-1 py-0.5 text-ui-xs text-sky-700 transition active:bg-overlay-soft"
            >
              {t("common.retry")}
            </button>
          </div>
        ) : null}

        {!summary && !error ? (
          <div className="flex items-center gap-1.5 px-3 py-3 text-ui-xs text-slate-400">
            {busy ? <LoaderCircle size={12} className="animate-spin" /> : null}
            {busy ? t("magent.changes.loading") : t("magent.changes.empty")}
          </div>
        ) : null}

        {summary && files.length === 0 ? (
          <p className="px-3 py-3 text-ui-xs text-slate-400">{t("magent.changes.empty")}</p>
        ) : null}

        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            disabled={file.binary}
            onClick={() => openFile(file)}
            title={file.path}
            className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left transition last:border-b-0 active:bg-overlay-soft disabled:opacity-70"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-slate-600">
              {file.path}
            </span>
            <Badge tone={CHANGE_TONES[file.status]}>{CHANGE_LETTERS[file.status]}</Badge>
            {file.binary ? (
              <span className="shrink-0 text-ui-xs text-slate-400">
                {t("magent.changes.binary")}
              </span>
            ) : (
              <span className="flex shrink-0 items-center gap-1 tabular-nums text-ui-xs">
                {file.additions > 0 ? (
                  <span className="text-emerald-700">+{file.additions}</span>
                ) : null}
                {file.deletions > 0 ? (
                  <span className="text-rose-700">−{file.deletions}</span>
                ) : null}
              </span>
            )}
          </button>
        ))}

        {truncated ? (
          <p className="border-t border-border px-3 py-1.5 text-ui-xs text-slate-400">
            {t("magent.changes.truncated", { count: files.length })}
          </p>
        ) : null}

        {summary?.commit ? (
          <div className="flex items-center gap-1.5 border-t border-border px-3 py-1.5">
            <span className="shrink-0 text-ui-xs text-slate-400">{t("magent.changes.commit")}</span>
            <CommitHash hash={summary.commit} />
          </div>
        ) : null}
      </div>

      <BottomSheet
        open={openPath !== null}
        title={openPath ?? ""}
        onClose={() => setOpenPath(null)}
      >
        {!openDiff || openDiff.kind === "loading" ? (
          <div className="flex items-center gap-1.5 py-2 text-ui-sm text-slate-400">
            <LoaderCircle size={12} className="animate-spin" />
            {t("magent.changes.readingDiff")}
          </div>
        ) : openDiff.kind === "error" ? (
          <p className="select-text break-all text-ui-sm leading-5 text-rose-700">
            {openDiff.message}
          </p>
        ) : openDiff.view.empty ? (
          <p className="text-ui-sm text-slate-400">{t("magent.changes.noDiff")}</p>
        ) : (
          <>
            <pre className="select-text whitespace-pre overflow-auto font-mono text-ui-2xs leading-4 text-slate-700">
              {openDiff.view.text}
            </pre>
            {openDiff.view.truncated ? (
              <p className="mt-1 text-ui-xs text-slate-400">
                {t("magent.changes.diffTruncated")}
              </p>
            ) : null}
          </>
        )}
      </BottomSheet>
    </section>
  );
}
