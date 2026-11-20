import { memo } from "react";
import clsx from "clsx";

import { t } from "../lib/i18n";
import type { SlashCommand, SlashGroup } from "./slashCommands";

const GROUPS: SlashGroup[] = ["add", "command"];

const GROUP_LABEL = {
  add: "agent.cmd.groupAdd",
  command: "agent.cmd.groupCommand",
} as const;

/**
 * The `/` menu: one floating panel above the composer, grouped the way dsh
 * desktop groups it (添加 / 指令). Rows are icon + Chinese name + the command
 * name itself + the engine's description, so a reader who knows either the
 * label or the name can find it.
 *
 * Presentation only: the composer owns the draft, the index and the keys, so
 * the palette can never disagree with what the textarea will submit.
 */
export const SlashPalette = memo(function SlashPalette({
  items,
  index,
  onPick,
  onHover,
}: {
  items: readonly SlashCommand[];
  index: number;
  onPick: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}) {
  if (items.length === 0) {
    return (
      <div
        data-component="SlashPalette"
        role="listbox"
        aria-label={t("agent.cmd.title")}
        className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-border bg-surface"
      >
        <div className="px-3 py-2.5 text-ui-caption text-slate-400">
          {t("agent.cmd.empty")}
        </div>
      </div>
    );
  }

  let flat = 0;
  return (
    <div
      data-component="SlashPalette"
      role="listbox"
      aria-label={t("agent.cmd.title")}
      className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface p-1"
    >
      {GROUPS.map((group) => {
        const rows = items.filter((item) => item.group === group);
        if (rows.length === 0) return null;
        return (
          <div key={group} className="flex flex-col">
            <div className="px-2.5 pb-1 pt-1.5 text-ui-2xs text-slate-400">
              {t(GROUP_LABEL[group])}
            </div>
            {rows.map((command) => {
              const position = flat++;
              const active = position === index;
              const Icon = command.icon;
              return (
                <button
                  key={command.name}
                  type="button"
                  role="option"
                  aria-selected={active}
                  // The pointer must not move focus off the textarea, or the
                  // next keystroke would land nowhere.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => onHover(position)}
                  onClick={() => onPick(command)}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors",
                    active ? "bg-sky-50" : "hover:bg-overlay-soft",
                  )}
                >
                  <Icon
                    size={14}
                    className={clsx("shrink-0", active ? "text-sky-600" : "text-slate-400")}
                  />
                  <span className="flex min-w-0 shrink-0 items-baseline gap-1.5">
                    <span
                      className={clsx(
                        "text-ui-caption",
                        active ? "text-sky-700" : "text-slate-700",
                      )}
                    >
                      {t(command.label)}
                    </span>
                    <span className="font-mono text-ui-2xs text-slate-400">
                      {command.name}
                    </span>
                  </span>
                  <span className="ml-auto min-w-0 truncate pl-3 text-right text-ui-2xs text-slate-400">
                    {command.description ? (
                      // An engine row this build does not know has no localized
                      // copy; its own description is the only label there is.
                      <span title={command.description}>
                        {t(command.hint)}
                        {command.generic ? ` · ${command.description}` : ""}
                      </span>
                    ) : (
                      t(command.hint)
                    )}
                    {command.inputHint ? (
                      <span className="ml-1.5 font-mono text-slate-300">
                        {command.inputHint}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
});
