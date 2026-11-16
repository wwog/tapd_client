import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Check, ChevronDown, Copy, Loader2, RefreshCw } from "lucide-react";

import {
  agentApi,
  type AgentChangeKind,
  type AgentChangeSummary,
  type AgentDiffView,
} from "../lib/agent";
import { useAgentTaskChanges } from "../lib/agentStore";
import { copyText } from "../lib/desktop";
import { t, type MessageKey } from "../lib/i18n";

type Props = {
  taskId: string;
  /**
   * Expanded state. Controlled when `onToggle` is provided; otherwise it is
   * only the initial state and the panel toggles itself (merged/closed views).
   */
  open?: boolean;
  onToggle?: () => void;
  className?: string;
};

type FileDiffState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: AgentDiffView };

const STATUS_BADGES: Record<
  AgentChangeKind,
  { letter: string; className: string; label: MessageKey }
> = {
  added: {
    letter: "A",
    className: "bg-emerald-50 text-emerald-700",
    label: "agent.changes.added",
  },
  modified: {
    letter: "M",
    className: "bg-amber-50 text-amber-700",
    label: "agent.changes.modified",
  },
  deleted: {
    letter: "D",
    className: "bg-rose-50 text-rose-700",
    label: "agent.changes.deleted",
  },
};

/**
 * The single change view: running task, review, merge and history all mount
 * this. It fetches `agent_task_changes` on demand (expanded, once per task) and
 * one file diff at a time via `agent_task_diff`. Live pushes update the list
 * while the task runs; a manual refresh replaces them with the command result.
 */
export function TaskChangesPanel({
  taskId,
  open,
  onToggle,
  className,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(open ?? true);
  const expanded = onToggle ? (open ?? true) : internalOpen;

  const [snapshot, setSnapshot] = useState<{
    taskId: string;
    summary: AgentChangeSummary;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileDiffState>>({});

  const requestRef = useRef(0);
  const loadedTaskRef = useRef<string | null>(null);
  const lastPushedRef = useRef<AgentChangeSummary | undefined>(undefined);
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;
  const initialOpenRef = useRef(open);
  initialOpenRef.current = open;

  const pushed = useAgentTaskChanges(taskId);
  const local = snapshot && snapshot.taskId === taskId ? snapshot.summary : null;
  // A command snapshot wins over the last push; a newer push wins again.
  const summary = local ?? pushed;

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    loadedTaskRef.current = taskId;
    setBusy(true);
    setError(null);
    try {
      const next = await agentApi.taskChanges(taskId);
      if (request !== requestRef.current) return;
      setSnapshot({ taskId, summary: next });
    } catch (err) {
      if (request === requestRef.current) setError(String(err));
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  }, [taskId]);

  // Keep per-file state with its task; the snapshot itself is keyed by taskId.
  useEffect(() => {
    setOpenPath(null);
    setDiffs({});
    setError(null);
    setBusy(false);
    setInternalOpen(initialOpenRef.current ?? true);
    requestRef.current += 1;
    loadedTaskRef.current = null;
  }, [taskId]);

  // Fetch the full summary the first time the panel is opened for a task.
  useEffect(() => {
    if (!expanded) return;
    if (loadedTaskRef.current === taskId) return;
    void load();
  }, [expanded, taskId, load]);

  // Adopt every pushed summary, so a live task keeps updating the open list;
  // a manual refresh then wins until the next push arrives.
  useEffect(() => {
    if (!pushed || pushed === lastPushedRef.current) return;
    lastPushedRef.current = pushed;
    setSnapshot({ taskId, summary: pushed });
  }, [pushed, taskId]);

  const toggle = () => {
    if (onToggle) onToggle();
    else setInternalOpen((current) => !current);
  };

  const refresh = () => {
    if (busy) return;
    setOpenPath(null);
    setDiffs({});
    loadedTaskRef.current = null;
    void load();
  };

  const toggleFile = (path: string, binary: boolean) => {
    if (binary) return;
    const next = openPath === path ? null : path;
    setOpenPath(next);
    if (next === null) return;
    const current = diffs[path];
    if (current && current.kind !== "error") return;

    const requestTaskId = taskIdRef.current;
    setDiffs((state) => ({ ...state, [path]: { kind: "loading" } }));
    void agentApi
      .taskDiff(taskId, path)
      .then((view) => {
        if (taskIdRef.current !== requestTaskId) return;
        setDiffs((state) => ({ ...state, [path]: { kind: "ready", view } }));
      })
      .catch((err) => {
        if (taskIdRef.current !== requestTaskId) return;
        setDiffs((state) => ({
          ...state,
          [path]: { kind: "error", message: String(err) },
        }));
      });
  };

  const files = summary?.files ?? [];
  const truncated = summary ? summary.fileCount > files.length : false;

  return (
    <section className={clsx("min-w-0", className)}>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          title={t("agent.changes.toggle")}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronDown
            size={12}
            className={clsx(
              "shrink-0 text-slate-400 transition",
              !expanded && "-rotate-90",
            )}
          />
          <span className="shrink-0 text-ui-xs text-slate-500">
            {t("agent.changes.title")}
          </span>
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
                {t("agent.changes.files", { count: summary.fileCount })}
              </span>
            </>
          ) : null}
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          title={t("agent.changes.refresh")}
          aria-label={t("agent.changes.refresh")}
          className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-60"
        >
          <RefreshCw size={12} className={clsx(busy && "animate-spin")} />
        </button>
      </div>

      {expanded ? (
        <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-surface">
          {error ? (
            <div className="select-text break-all px-2.5 py-2 text-ui-xs text-rose-600">
              {error}
            </div>
          ) : null}

          {!summary ? (
            error ? null : (
              <div className="flex items-center gap-1.5 px-2.5 py-2 text-ui-xs text-slate-400">
                {busy ? <Loader2 size={11} className="animate-spin" /> : null}
                {busy ? t("agent.changes.loading") : t("agent.changes.empty")}
              </div>
            )
          ) : files.length === 0 ? (
            <div className="px-2.5 py-2 text-ui-xs text-slate-400">
              {t("agent.changes.empty")}
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              <div className="divide-y divide-slate-100">
                {files.map((file) => {
                  const badge = STATUS_BADGES[file.status];
                  const diff = diffs[file.path];
                  const isOpen = openPath === file.path;
                  return (
                    <div key={file.path} className="min-w-0">
                      <button
                        type="button"
                        disabled={file.binary}
                        onClick={() => toggleFile(file.path, file.binary)}
                        className={clsx(
                          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition",
                          !file.binary && "hover:bg-slate-50",
                        )}
                      >
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-ui-xs text-slate-600"
                          title={file.path}
                        >
                          {file.path}
                        </span>
                        <span
                          title={t(badge.label)}
                          className={clsx(
                            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-md text-ui-2xs",
                            badge.className,
                          )}
                        >
                          {badge.letter}
                        </span>
                        {file.binary ? (
                          <span className="shrink-0 text-ui-xs text-slate-400">
                            {t("agent.changes.binary")}
                          </span>
                        ) : (
                          <span className="flex shrink-0 items-center gap-1 tabular-nums text-ui-xs">
                            {file.additions > 0 ? (
                              <span className="text-emerald-600">
                                +{file.additions}
                              </span>
                            ) : null}
                            {file.deletions > 0 ? (
                              <span className="text-rose-600">
                                −{file.deletions}
                              </span>
                            ) : null}
                          </span>
                        )}
                      </button>
                      {isOpen && !file.binary ? (
                        <div className="bg-zinc-950 p-2.5">
                          <FileDiff state={diff} />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {truncated ? (
                <div className="border-t border-slate-100 px-2.5 py-1.5 text-ui-xs text-slate-400">
                  {t("agent.changes.truncated", { count: files.length })}
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function FileDiff({ state }: { state?: FileDiffState }) {
  if (!state || state.kind === "loading") {
    return (
      <div className="flex items-center gap-1.5 py-1 text-ui-xs text-zinc-400">
        <Loader2 size={11} className="animate-spin" />
        {t("agent.changes.readingDiff")}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="select-text break-all py-1 text-ui-xs text-rose-300">
        {state.message}
      </div>
    );
  }
  if (state.view.empty) {
    return (
      <div className="py-1 text-ui-xs text-zinc-400">
        {t("agent.changes.noDiff")}
      </div>
    );
  }
  return (
    <>
      <pre className="select-text max-h-72 overflow-auto whitespace-pre font-mono text-ui-xs leading-4 text-zinc-200">
        {state.view.text}
      </pre>
      {state.view.truncated ? (
        <div className="mt-1 text-ui-xs text-zinc-500">
          {t("agent.changes.diffTruncated")}
        </div>
      ) : null}
    </>
  );
}

/**
 * Short commit hash with click-to-copy. Used by the merge card and history;
 * the copied check is local feedback, so no toast.
 */
export function CommitHash({
  hash,
  className,
}: {
  hash: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = async () => {
    if (!(await copyText(hash))) return;
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={copied ? t("agent.changes.copied") : t("agent.changes.copyHash")}
      className={clsx(
        "inline-flex items-center gap-1 rounded-md px-1 py-0.5 font-mono text-ui-xs transition hover:bg-slate-100",
        copied ? "text-emerald-600" : "text-slate-600",
        className,
      )}
    >
      {hash.slice(0, 7)}
      {copied ? (
        <Check size={11} className="shrink-0" />
      ) : (
        <Copy size={11} className="shrink-0 text-slate-400" />
      )}
    </button>
  );
}
