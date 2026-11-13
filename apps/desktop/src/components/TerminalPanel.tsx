import clsx from "clsx";
import { PanelBottomClose, Plus, SquareTerminal, X } from "lucide-react";
import type { CSSProperties } from "react";

import type { TerminalPanelState } from "../hooks/useTerminalPanel";
import { t } from "../lib/i18n";
import type { TerminalMeta } from "../lib/terminal";
import { Button } from "./ui";
import { ShellTerminal } from "./ShellTerminal";

/** The card's `mb-2` bottom gap, mirrored in the animated wrapper's height. */
const PANEL_GAP = 8;

type Props = {
  panel: TerminalPanelState;
  /** Grid placement comes from `App`; the height is owned by the panel. */
  style?: CSSProperties;
};

/**
 * Bottom shell panel: tab strip, stacked xterm views and the drag handle.
 *
 * Every session stays mounted, hidden by `invisible` rather than unmounted, so
 * a tab switch keeps its scrollback and exact grid size. The outer wrapper
 * animates its height while the card keeps a fixed height, so the panel is
 * revealed from the bottom instead of reflowing the terminals every frame.
 */
export function TerminalPanel({ panel, style }: Props) {
  if (!panel.rendered) return null;

  const active = panel.sessions.find((session) => session.id === panel.activeId) ?? null;

  return (
    <div
      className={clsx(
        "relative flex w-full shrink-0 flex-col justify-end overflow-hidden",
        !panel.resizing && "transition-[height] duration-300 ease-out",
      )}
      style={{ ...style, height: panel.open ? panel.height + PANEL_GAP : 0 }}
    >
      <div
        className="mb-2 mr-2 flex flex-col overflow-hidden rounded-xl border border-border bg-surface"
        style={{ height: panel.height }}
      >
        <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2">
          <SquareTerminal size={14} className="shrink-0 text-slate-400" />
          <span className="shrink-0 text-ui-sm text-slate-500">{t("terminal.title")}</span>

          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1">
            {panel.sessions.map((session) => (
              <SessionTab
                key={session.id}
                session={session}
                active={session.id === panel.activeId}
                onSelect={() => panel.setActive(session.id)}
                onClose={() => panel.closeSession(session.id)}
              />
            ))}
          </div>

          <button
            type="button"
            aria-label={t("terminal.new")}
            title={t("terminal.newHint")}
            onClick={panel.create}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-overlay hover:text-slate-700"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            aria-label={t("terminal.closePanel")}
            title={t("terminal.closePanel")}
            onClick={panel.close}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-overlay hover:text-slate-700"
          >
            <PanelBottomClose size={14} />
          </button>
        </header>

        {panel.sessions.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
            <p className="text-ui-base text-slate-700">{t("terminal.empty")}</p>
            <Button
              size="sm"
              onClick={panel.create}
              title={t("terminal.newHint")}
              icon={<Plus size={13} />}
            >
              {t("terminal.new")}
            </Button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              {panel.sessions.map((session) => {
                const current = session.id === panel.activeId;
                return (
                  <div
                    key={session.id}
                    aria-hidden={!current}
                    // Inert keeps Tab/⌘-F from landing in a hidden emulator's
                    // textarea while the visible tab is the only live one.
                    inert={!current}
                    className={clsx(
                      "absolute inset-0 p-1.5",
                      !current && "invisible pointer-events-none",
                    )}
                  >
                    <ShellTerminal
                      sessionId={session.id}
                      active={current}
                      live={session.exited === null}
                    />
                  </div>
                );
              })}
            </div>

            {active && active.exited !== null ? (
              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-1.5">
                <span className="text-ui-sm text-slate-500">{t("terminal.exited")}</span>
                <Button size="sm" onClick={() => panel.restart(active)}>
                  {t("terminal.restart")}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {panel.open ? (
        <button
          type="button"
          aria-label={t("terminal.resize")}
          title={t("terminal.resize")}
          onMouseDown={panel.startResize}
          className={clsx(
            // The strip is 1.5px; `before:` widens the grab area into the card.
            "absolute inset-x-0 top-0 z-10 h-[1.5px] cursor-row-resize transition before:absolute before:inset-x-0 before:top-0 before:h-2",
            panel.resizing ? "bg-sky-400/60" : "bg-transparent hover:bg-overlay",
          )}
        />
      ) : null}
    </div>
  );
}

function SessionTab({
  session,
  active,
  onSelect,
  onClose,
}: {
  session: TerminalMeta;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const exited = session.exited !== null;
  return (
    <div
      className={clsx(
        "group flex h-6 shrink-0 items-center gap-0.5 rounded-md pl-2 pr-0.5 transition",
        active ? "bg-slate-100" : "hover:bg-overlay",
      )}
    >
      <button
        type="button"
        title={session.cwd}
        onClick={onSelect}
        className={clsx(
          "max-w-44 truncate text-ui-sm transition",
          exited ? "text-slate-400" : active ? "text-slate-700" : "text-slate-500",
        )}
      >
        {session.title || session.cwd}
        {exited ? ` · ${t("terminal.tabExited")}` : ""}
      </button>
      <button
        type="button"
        aria-label={t("terminal.closeTab")}
        title={t("terminal.closeTab")}
        onClick={onClose}
        className={clsx(
          "grid h-4 w-4 shrink-0 place-items-center rounded text-slate-400 transition hover:bg-overlay hover:text-slate-600 focus-visible:opacity-100",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <X size={10} />
      </button>
    </div>
  );
}
