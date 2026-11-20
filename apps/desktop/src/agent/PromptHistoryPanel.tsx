import { memo } from "react";
import clsx from "clsx";
import { History } from "lucide-react";

import { t } from "../lib/i18n";

/**
 * The ↑ panel: what this conversation (and this machine) already sent.
 *
 * Picking a row fills the draft, it does not send: history is a shortcut for
 * editing an earlier prompt, so the user keeps the last word. Same panel shape
 * as the `/` menu, one row per prompt, newest first.
 */
export const PromptHistoryPanel = memo(function PromptHistoryPanel({
  items,
  index,
  onPick,
  onHover,
}: {
  items: readonly string[];
  index: number;
  onPick: (text: string) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div
      data-component="PromptHistoryPanel"
      role="listbox"
      aria-label={t("agent.history.title")}
      className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-[min(52vh,22rem)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface p-1"
    >
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-ui-2xs text-slate-400">
        <History size={11} className="shrink-0" />
        {items.length === 0 ? t("agent.history.empty") : t("agent.history.title")}
      </div>
      {items.map((text, position) => {
        const active = position === index;
        return (
          <button
            key={`${position}:${text.slice(0, 24)}`}
            type="button"
            role="option"
            aria-selected={active}
            // Keep the caret in the textarea: the next keystroke filters.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHover(position)}
            onClick={() => onPick(text)}
            title={text}
            className={clsx(
              "flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors",
              active ? "bg-sky-50" : "hover:bg-overlay-soft",
            )}
          >
            <span
              className={clsx(
                "line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words text-ui-caption leading-5",
                active ? "text-sky-700" : "text-slate-600",
              )}
            >
              {text}
            </span>
          </button>
        );
      })}
    </div>
  );
});
