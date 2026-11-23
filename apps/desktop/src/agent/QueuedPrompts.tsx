import { useState } from "react";
import clsx from "clsx";
import { ArrowUpRight, CirclePause, GripVertical, Pencil, X } from "lucide-react";

import { t } from "../lib/i18n";
import type { QueuePauseReason, QueuedPrompt } from "./store";

/**
 * The composer's send queue, modelled on ZCode's queue panel: messages typed
 * while a reply is streaming wait here instead of entering the turn, so they
 * can still be edited, reordered, sent at once or dropped. One row per prompt:
 * drag handle, the text (attachments on a second line), then 立即 / 编辑 / 移除.
 *
 * Reordering uses the native HTML5 drag gesture. Only the handle arms the row
 * (`draggable` flips on pointerdown), so selecting text never starts a drag.
 */
export function QueuedPrompts(props: {
  items: QueuedPrompt[];
  paused?: QueuePauseReason;
  editingId?: string;
  onMove: (id: string, beforeId: string | null) => void;
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onResume: () => void;
}) {
  const { items, paused, editingId } = props;
  const [dragId, setDragId] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  if (items.length === 0) return null;

  const pauseText =
    paused === "stopped"
      ? t("agent.queue.pausedStopped")
      : paused === "error"
        ? t("agent.queue.pausedError")
        : t("agent.queue.pausedGeneric");

  return (
    <div data-component="QueuedPrompts" className="border-b border-border px-1.5 py-1">
      {paused ? (
        <div
          data-component="QueuedPromptsPaused"
          className="mb-1 flex items-center gap-2 rounded-md bg-overlay-soft px-2 py-1 text-ui-2xs text-slate-500"
        >
          <CirclePause size={11} className="shrink-0" />
          <span className="min-w-0 flex-1">{pauseText}</span>
          <button
            type="button"
            title={t("agent.queue.resumeHint")}
            aria-label={t("agent.queue.resumeHint")}
            onClick={props.onResume}
            className="shrink-0 rounded-md px-1 text-ui-2xs text-slate-600 transition hover:bg-overlay-soft hover:text-slate-900"
          >
            {t("agent.queue.resume")}
          </button>
        </div>
      ) : null}
      <ul
        role="list"
        aria-label={t("agent.queue.title", { count: String(items.length) })}
        className="max-h-32 overflow-y-auto overscroll-contain"
      >
        {items.map((item) => {
          const editing = editingId === item.id;
          const dragging = dragId === item.id;
          const names = (item.images ?? [])
            .map((image) => image.name ?? t("agent.queue.image"))
            .join(", ");
          return (
            <li
              key={item.id}
              data-queue-item={item.id}
              draggable={armed === item.id}
              onDragStart={(event) => {
                setDragId(item.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", item.id);
              }}
              onDragOver={(event) => {
                if (dragId === null || dragId === item.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                props.onMove(dragId, item.id);
              }}
              onDrop={(event) => event.preventDefault()}
              onDragEnd={() => {
                setDragId(null);
                setArmed(null);
              }}
              className={clsx(
                "flex items-center gap-1.5 rounded-md px-1 py-1 transition-colors",
                dragging && "bg-overlay-soft",
                editing && "opacity-60",
                !editing && "hover:bg-overlay-soft",
              )}
            >
              <button
                type="button"
                title={t("agent.queue.drag")}
                aria-label={t("agent.queue.drag")}
                disabled={editing}
                onPointerDown={() => setArmed(item.id)}
                onPointerUp={() => setArmed(null)}
                className={clsx(
                  "grid h-6 w-5 shrink-0 place-items-center rounded-md text-slate-300 transition",
                  editing
                    ? "cursor-default"
                    : "cursor-grab hover:text-slate-500 active:cursor-grabbing",
                )}
              >
                <GripVertical size={12} />
              </button>
              <span
                className="min-w-0 flex-1 truncate text-ui-xs text-slate-600"
                title={item.text}
              >
                <span className="truncate">{item.text}</span>
                {names ? (
                  <span className="ml-1 text-slate-400">· {names}</span>
                ) : null}
              </span>
              {editing ? (
                // The item is loaded in the composer; its own actions would
                // fight the editor, so the row only points at it.
                <span className="inline-flex shrink-0 items-center gap-1 text-ui-2xs text-slate-400">
                  <Pencil size={11} />
                  {t("agent.queue.editingBelow")}
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    title={t("agent.queue.sendNow")}
                    aria-label={t("agent.queue.sendNow")}
                    onClick={() => props.onSendNow(item.id)}
                    className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-ui-2xs text-slate-500 transition hover:bg-overlay-soft hover:text-slate-700"
                  >
                    <ArrowUpRight size={11} />
                    {t("agent.queue.sendNow")}
                  </button>
                  <button
                    type="button"
                    title={t("agent.queue.edit")}
                    aria-label={t("agent.queue.edit")}
                    // One edit at a time: switching would drop the unsaved
                    // text that is currently in the composer.
                    disabled={editingId !== undefined}
                    onClick={() => props.onEdit(item.id)}
                    className={clsx(
                      "grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-400 transition",
                      editingId === undefined
                        ? "hover:bg-overlay-soft hover:text-slate-600"
                        : "cursor-default opacity-40",
                    )}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    title={t("agent.queue.remove")}
                    aria-label={t("agent.queue.remove")}
                    onClick={() => props.onRemove(item.id)}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-overlay-soft hover:text-rose-600"
                  >
                    <X size={12} />
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {dragId ? (
        <div
          aria-hidden
          className="h-3"
          onDragOver={(event) => {
            event.preventDefault();
            props.onMove(dragId, null);
          }}
        />
      ) : null}
    </div>
  );
}
