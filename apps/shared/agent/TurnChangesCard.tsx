import { memo, useState } from "react";
import clsx from "clsx";
import { ChevronRight, FileDiff } from "lucide-react";

import type { TurnChanges } from "./changes";
import type { AgentLocale } from "./types";
import { agentLabel } from "./labels";
import { useAgentHost } from "./host";

/**
 * The turn's changed files, folded by default.
 *
 * One collapsed line answers "did this turn touch anything?" (`修改 3 个文件
 * +42 −7`); expanding lists the files with their own counts, and each row opens
 * the file through the host. It sits outside 已工作 on purpose: the fold hides
 * process, while "what changed on disk" is the outcome.
 */
export const TurnChangesCard = memo(function TurnChangesCard({
  changes,
  locale,
}: {
  changes: TurnChanges;
  locale: AgentLocale;
}) {
  const host = useAgentHost();
  const [open, setOpen] = useState(false);
  if (changes.files.length === 0) return null;

  return (
    <div
      data-component="TurnChangesCard"
      className="overflow-hidden rounded-lg border border-border"
    >
      <button
        type="button"
        aria-expanded={open}
        title={
          open
            ? agentLabel("turn.changesCollapse", locale)
            : agentLabel("turn.changesExpand", locale)
        }
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-ui-caption text-slate-600 transition-colors hover:bg-overlay-soft"
      >
        <FileDiff size={12} className="shrink-0 text-slate-400" />
        <span className="min-w-0 truncate">
          {agentLabel("turn.changes", locale, { count: String(changes.files.length) })}
        </span>
        <span className="shrink-0 tabular-nums text-emerald-600">+{changes.added}</span>
        <span className="shrink-0 tabular-nums text-rose-500">−{changes.removed}</span>
        <ChevronRight
          size={12}
          className={clsx(
            "ml-auto shrink-0 text-slate-300 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <div className="max-h-56 overflow-y-auto overscroll-contain border-t border-border">
          {changes.files.map((file) => {
            // A host that can diff opens the change; otherwise the file itself.
            const openDiff = host.openDiff;
            const openFile = openDiff ?? host.openPath;
            return (
              <button
                key={file.path}
                type="button"
                title={`${file.path} · ${
                  openDiff
                    ? agentLabel("turn.changesOpenDiff", locale)
                    : agentLabel("turn.changesOpen", locale)
                }`}
                onClick={() => openFile?.(file.path)}
                className={clsx(
                  "flex w-full items-center gap-2 px-2.5 py-1 text-left text-ui-2xs",
                  openFile ? "hover:bg-overlay-soft" : "cursor-default",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-slate-600">
                  {file.path}
                </span>
                <span className="shrink-0 tabular-nums text-emerald-600">+{file.added}</span>
                <span className="shrink-0 tabular-nums text-rose-500">−{file.removed}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});
