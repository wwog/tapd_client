/**
 * Hover card behind a task list row: the session's basic facts plus a live
 * listing of its working directory. `TaskList` owns the hover timers and only
 * mounts this while open; the card cancels/resumes that pending close so the
 * pointer can travel onto it. The whole card is `select-text` — paths, names
 * and facts are frame-selectable for copying.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check, Copy, File, Folder, Workflow } from "lucide-react";

import { formatBytes, relativeTime } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { fsApi, SESSION_WORKSPACE_PREFIX, type FsListing } from "../lib/fs";
import {
  dshTaskApi,
  type DshSessionStatus,
  type DshTask,
} from "../lib/dsh";
import { t } from "../lib/i18n";
import { useDismiss } from "../hooks/useDismiss";
import { Spinner } from "../components/ui";
import { WORKFLOW, WORKFLOW_MARK, isWorkflowTask } from "./workflow";

/** Fixed card width; the row anchor only decides the side. */
const WIDTH = 320;
const GAP = 6;
const MARGIN = 8;
/** Height estimate used to keep the top edge inside the window. */
const EST_HEIGHT = 420;

type Props = {
  task: DshTask;
  status: DshSessionStatus;
  pending: number;
  /** Last reply's model, when the session has reported one. */
  model?: string;
  /** Live activity time (session registry wins over the persisted row). */
  updatedAt: string;
  anchor: DOMRect;
  onClose: () => void;
  /** Pointer moved onto the card: keep it open. */
  onEnter: () => void;
  /** Pointer left the card: resume the scheduled close. */
  onLeave: () => void;
};

const clampTop = (top: number): number =>
  Math.min(
    Math.max(MARGIN, top),
    Math.max(MARGIN, window.innerHeight - EST_HEIGHT - MARGIN),
  );

export function TaskHoverCard({
  task,
  status,
  pending,
  model,
  updatedAt,
  anchor,
  onClose,
  onEnter,
  onLeave,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  useDismiss(true, cardRef, onClose, { scroll: true, resize: true });

  const workflow = WORKFLOW[task.workflow];
  const mark = WORKFLOW_MARK[task.workflow];
  const statusText =
    isWorkflowTask(task)
      ? t(workflow.label)
      : status === "running"
        ? t("agent.task.live")
        : status === "failed"
          ? t("agent.card.failed")
          : t("agent.card.idle");

  // Session root plus the live listing of the current relative dir. Both are
  // fetched fresh on every open and drill-down — nothing is cached.
  const [dirPath, setDirPath] = useState("");
  const [root, setRoot] = useState("");
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    dshTaskApi
      .sessionDir(task.id)
      .then(({ path, exists }) => {
        if (alive) setRoot(exists ? path : "");
      })
      .catch(() => {
        if (alive) setRoot("");
      });
    return () => {
      alive = false;
    };
  }, [task.id]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fsApi
      .list({
        workspaceId: `${SESSION_WORKSPACE_PREFIX}${task.id}`,
        path: dirPath,
      })
      .then((result) => {
        if (alive) setListing(result);
      })
      .catch((cause) => {
        if (!alive) return;
        setListing(null);
        setError(String(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [task.id, dirPath]);

  // Copy feedback resets itself; the timer dies with the card.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copyPath = useCallback(() => {
    void navigator.clipboard
      .writeText(dirPath ? `${root}/${dirPath}` : root)
      .then(() => setCopied(true))
      .catch(() => {});
  }, [root, dirPath]);

  const top = clampTop(anchor.top - 4);
  const left =
    anchor.right + GAP + WIDTH + MARGIN <= window.innerWidth
      ? anchor.right + GAP
      : Math.max(MARGIN, anchor.left - WIDTH - GAP);
  const segments = dirPath ? dirPath.split("/") : [];
  const rootName = root.split("/").filter(Boolean).pop() || "…";

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label={task.title || t("agent.task.untitled")}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        left,
        top,
        width: WIDTH,
        maxHeight: window.innerHeight - top - MARGIN,
      }}
      className="fixed z-[120] flex select-text flex-col overflow-hidden rounded-xl border border-border bg-surface p-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-ui-sm text-slate-700">
          {task.title || t("agent.task.untitled")}
        </span>
        <span
          className={clsx(
            "inline-flex shrink-0 items-center gap-1 text-ui-xs",
            isWorkflowTask(task) ? mark : "text-slate-400",
          )}
        >
          {isWorkflowTask(task) ? (
            <>
              <Workflow size={11} />
              {statusText}
            </>
          ) : (
            <>
              {t("agent.card.freeChat")}
              <span className="text-slate-300">·</span>
              {statusText}
            </>
          )}
        </span>
      </div>

      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1">
        {task.branch ? (
          <FactRow label={t("agent.card.branch")} value={task.branch} />
        ) : null}
        {model ? <FactRow label={t("agent.card.model")} value={model} /> : null}
        {isWorkflowTask(task) && task.changes ? (
          <FactRow
            label={t("agent.card.changes")}
            value={
              <>
                {t("agent.task.changes", { files: task.changes.files })}
                <span className="text-slate-400">
                  {" "}
                  +{task.changes.additions} −{task.changes.deletions}
                </span>
              </>
            }
          />
        ) : null}
        <FactRow
          label={t("agent.card.messages")}
          value={String(task.messageCount)}
        />
        {pending > 0 ? (
          <FactRow
            label={t("agent.card.pending")}
            value={t("agent.task.needsInput", { count: pending })}
          />
        ) : null}
        <FactRow
          label={t("agent.card.created")}
          value={formatDateTime(task.createdAt)}
        />
        <FactRow
          label={t("agent.card.updated")}
          value={relativeTime(updatedAt)}
        />
      </dl>

      <div className="mt-2 flex min-h-0 flex-col border-t border-border pt-2">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-ui-xs text-slate-400">
            {t("agent.card.dir")}
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-ui-xs text-slate-500">
            {segments.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={() => setDirPath("")}
                  className="max-w-24 truncate rounded px-0.5 transition hover:bg-overlay-soft hover:text-slate-700"
                >
                  {rootName}
                </button>
                {segments.map((segment, index) => (
                  <span
                    key={`${index}:${segment}`}
                    className="inline-flex items-center gap-0.5"
                  >
                    <span className="text-slate-300">/</span>
                    {index === segments.length - 1 ? (
                      <span className="max-w-24 truncate px-0.5">{segment}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          setDirPath(segments.slice(0, index + 1).join("/"))
                        }
                        className="max-w-24 truncate rounded px-0.5 transition hover:bg-overlay-soft hover:text-slate-700"
                      >
                        {segment}
                      </button>
                    )}
                  </span>
                ))}
              </>
            ) : null}
          </span>
          <button
            type="button"
            title={copied ? t("agent.card.copied") : t("agent.card.copyPath")}
            aria-label={t("agent.card.copyPath")}
            onClick={copyPath}
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-slate-400 transition hover:bg-overlay-soft hover:text-slate-700"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
        <div
          className="min-w-0 truncate text-ui-2xs text-slate-400"
          title={dirPath ? `${root}/${dirPath}` : root}
        >
          {root || "—"}
        </div>
        <div className="mt-1.5 min-h-[2rem] max-h-44 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-3 text-ui-caption text-slate-400">
              <Spinner />
            </div>
          ) : error ? (
            <div
              className="break-all px-1 py-2 text-ui-caption text-slate-400"
              title={error}
            >
              {t("agent.card.dirError")}
            </div>
          ) : listing && listing.entries.length === 0 ? (
            <div className="px-1 py-2 text-ui-caption text-slate-400">
              {t("agent.card.emptyDir")}
            </div>
          ) : listing ? (
            <div className="flex flex-col">
              {listing.entries.map((entry) =>
                entry.kind === "dir" ? (
                  <button
                    key={entry.path}
                    type="button"
                    onClick={() => setDirPath(entry.path)}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition hover:bg-overlay-soft"
                  >
                    <Folder size={12} className="shrink-0 text-slate-400" />
                    <span
                      className={clsx(
                        "min-w-0 truncate text-ui-xs text-slate-600",
                        entry.hidden && "opacity-60",
                      )}
                    >
                      {entry.name}
                    </span>
                  </button>
                ) : (
                  <div
                    key={entry.path}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-0.5"
                  >
                    <File size={12} className="shrink-0 text-slate-400" />
                    <span
                      className={clsx(
                        "min-w-0 truncate text-ui-xs text-slate-600",
                        entry.hidden && "opacity-60",
                      )}
                    >
                      {entry.name}
                    </span>
                    <span className="ml-auto shrink-0 text-ui-2xs tabular-nums text-slate-400">
                      {formatBytes(entry.size)}
                    </span>
                  </div>
                ),
              )}
              {listing.truncated ? (
                <div className="px-1 py-1 text-ui-2xs text-slate-400">
                  {t("agent.card.listTruncated", {
                    n: listing.entries.length,
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** One label/value line of the facts grid. */
function FactRow({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <>
      <dt className="shrink-0 text-ui-xs text-slate-400">{label}</dt>
      <dd className="min-w-0 break-all text-right text-ui-xs tabular-nums text-slate-600">
        {value}
      </dd>
    </>
  );
}
