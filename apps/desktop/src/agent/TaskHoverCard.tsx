/**
 * Hover card behind a task list row: the session's basic facts plus the path of
 * its working directory, with copy and "open in the built-in explorer" actions.
 * `TaskList` owns the hover timers and only mounts this while open; the card
 * cancels/resumes that pending close so the pointer can travel onto it. The
 * whole card is `select-text` — paths, names and facts are selectable.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check, Copy, FolderTree, Workflow } from "lucide-react";

import { relativeTime } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { SESSION_WORKSPACE_PREFIX } from "../lib/fs";
import {
  dshTaskApi,
  type DshSessionStatus,
  type DshTask,
} from "../lib/dsh";
import { t } from "../lib/i18n";
import { useDismiss } from "../hooks/useDismiss";
import { usePanelServices } from "../workbench/panels/context";
import { WORKFLOW, WORKFLOW_MARK, isWorkflowTask } from "./workflow";

/** Fixed card width; the row anchor only decides the side. */
const WIDTH = 320;
const GAP = 6;
const MARGIN = 8;
/** Height estimate used to keep the top edge inside the window. */
const EST_HEIGHT = 260;

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

  // The session's working directory (worktree → project repo → chat scratch),
  // resolved fresh on every open. Empty when the host no longer has it.
  const [root, setRoot] = useState("");

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

  // Copy feedback resets itself; the timer dies with the card.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copyPath = useCallback(() => {
    void navigator.clipboard
      .writeText(root)
      .then(() => setCopied(true))
      .catch(() => {});
  }, [root]);

  // Open in the built-in explorer (the same read-only tree as the side bar's).
  const services = usePanelServices();
  const openDir = useCallback(() => {
    const workspaceId = `${SESSION_WORKSPACE_PREFIX}${task.id}`;
    services.open({
      resource: { type: "explorer", workspaceId },
      label: services.workspaceName(workspaceId),
      target: "secondary",
    });
    onClose();
  }, [onClose, services, task.id]);

  const top = clampTop(anchor.top - 4);
  const left =
    anchor.right + GAP + WIDTH + MARGIN <= window.innerWidth
      ? anchor.right + GAP
      : Math.max(MARGIN, anchor.left - WIDTH - GAP);

  return createPortal(
    <div
      data-component="TaskHoverCard"
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

      <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2">
        <span className="shrink-0 text-ui-xs text-slate-400">
          {t("agent.card.dir")}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-ui-2xs text-slate-500"
          title={root}
        >
          {root || "—"}
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
        {root ? (
          <button
            type="button"
            title={t("agent.card.openDir")}
            aria-label={t("agent.card.openDir")}
            onClick={openDir}
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-slate-400 transition hover:bg-overlay-soft hover:text-slate-700"
          >
            <FolderTree size={12} />
          </button>
        ) : null}
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
