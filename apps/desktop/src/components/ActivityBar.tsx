import clsx from "clsx";
import type { ReactNode } from "react";
import {
  Bot,
  Bug,
  FolderGit2,
  ListTodo,
  Plug,
  Settings as SettingsIcon,
  Smartphone,
  SquareTerminal,
  Users,
} from "lucide-react";

import { AccountChip } from "./AccountChip";
import { t, type MessageKey } from "../lib/i18n";

export type View =
  | "bugs"
  | "queue"
  | "local"
  | "agent"
  | "projects"
  | "coworker"
  | "mcp"
  | "settings"
  | "account";

const RAIL_ANIM: Record<string, string> = {
  bugs: "rail-bug-jump",
  queue: "rail-bug-jump",
  agent: "rail-bot-shake",
  projects: "rail-folder-bounce",
  coworker: "rail-users-wave",
  mcp: "rail-plug-rise",
  settings: "rail-settings-spin",
  account: "rail-avatar-pop",
};

/**
 * Activity-bar tabs. Labels are catalogue keys rendered with `t()` at render
 * time, so a language switch never keeps the startup language.
 */
const NAV: Array<{ id: View; label: MessageKey; icon: ReactNode }> = [
  { id: "bugs", label: "common.bugs", icon: <Bug size={15} /> },
  // Global workflow queue, next to the bug list. It spans every project and is
  // where an interrupted task is continued.
  { id: "queue", label: "app.nav.queue", icon: <ListTodo size={15} /> },
  // 事项 has no rail entry: local projects open their own tab from the project
  // column (and the projects page), like TAPD projects do.
  { id: "agent", label: "app.nav.agent", icon: <Bot size={15} /> },
  { id: "projects", label: "common.projects", icon: <FolderGit2 size={15} /> },
  { id: "coworker", label: "app.nav.coworker", icon: <Users size={15} /> },
  { id: "mcp", label: "app.nav.mcp", icon: <Plug size={15} /> },
  { id: "settings", label: "common.settings", icon: <SettingsIcon size={15} /> },
];

export type RailAnimation = { id: string; token: number } | null;

type Props = {
  view: View;
  railAnim: RailAnimation;
  /** Queue activity mark: yellow while running, green until its report is read. */
  queueBadge: "running" | "done" | null;
  /** The project column is out of layout, so the chip eases into the rail. */
  sidebarHidden: boolean;
  meAvatar: string | null;
  name: string | null;
  /** Companion enabled in Settings: show the phone scan entry. */
  showCompanion: boolean;
  /** A paired phone is heartbeating: paint the entry green. */
  companionOnline: boolean;
  /** The bottom terminal panels are visible (paints the entry as active). */
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onOpenCompanion: () => void;
  onActivate: (view: View) => void;
};

/** Icon rail: primary views, the account chip and Settings. */
export function ActivityBar({
  view,
  railAnim,
  queueBadge,
  sidebarHidden,
  meAvatar,
  name,
  showCompanion,
  companionOnline,
  terminalOpen,
  onToggleTerminal,
  onOpenCompanion,
  onActivate,
}: Props) {
  const accountAnim = railAnim?.id === "account" ? railAnim : null;
  /**
   * Local projects have no rail entry of their own; their items page is the
   * local counterpart of the bug list, so the 缺陷 entry carries the focus
   * while one is open.
   */
  const railView: View = view === "local" ? "bugs" : view;

  return (
    <div data-component="ActivityBar" className="flex w-[52px] shrink-0 flex-col items-center pb-2">
      <div className="flex flex-col items-center gap-1">
        {NAV.filter((item) => item.id !== "settings").map((item) => (
          <button
            key={item.id}
            type="button"
            title={t(item.label)}
            aria-label={t(item.label)}
            onClick={() => onActivate(item.id)}
            className={clsx(
              "grid h-9 w-9 place-items-center rounded-xl transition",
              railView === item.id
                ? "bg-overlay text-slate-900"
                : "text-slate-500 hover:bg-overlay-soft hover:text-slate-700",
            )}
          >
            <span
              key={railAnim?.id === item.id ? railAnim.token : "idle"}
              className={clsx(
                "relative inline-flex items-center justify-center",
                railAnim?.id === item.id && RAIL_ANIM[item.id],
              )}
            >
              {item.icon}
              {item.id === "queue" && queueBadge ? (
                <span
                  aria-hidden="true"
                  data-queue-badge={queueBadge}
                  className={clsx(
                    "absolute -right-1.5 -top-1 h-2 w-2 rounded-full border-2 border-canvas",
                    queueBadge === "running" ? "bg-amber-400" : "bg-emerald-500",
                  )}
                />
              ) : null}
            </span>
          </button>
        ))}
      </div>
      <div className="flex-1" data-tauri-drag-region />
      {/* The user chip lives at the sidebar bottom; when the project list
          is collapsed it eases into the rail just above Settings. */}
      <div
        className={clsx(
          "grid h-9 w-9 place-items-center transition-all duration-300 ease-out",
          sidebarHidden
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-2 scale-75 opacity-0",
        )}
      >
        <AccountChip
          compact
          meAvatar={meAvatar}
          name={name}
          animToken={accountAnim?.token}
          animClass={accountAnim ? RAIL_ANIM.account : undefined}
          onClick={() => onActivate("account")}
        />
      </div>
      {showCompanion ? (
        <button
          type="button"
          title={t("app.nav.companion")}
          aria-label={t("app.nav.companion")}
          onClick={onOpenCompanion}
          className={clsx(
            "mb-1 grid h-9 w-9 place-items-center rounded-xl transition",
            companionOnline
              ? "text-emerald-500 hover:bg-emerald-50 hover:text-emerald-600"
              : "text-slate-500 hover:bg-overlay-soft hover:text-slate-700",
          )}
        >
          <Smartphone size={15} />
        </button>
      ) : null}
      <button
        type="button"
        title={t("terminal.shortcutHint")}
        aria-label={t(terminalOpen ? "terminal.toggleHide" : "terminal.toggleShow")}
        aria-pressed={terminalOpen}
        onClick={onToggleTerminal}
        className={clsx(
          "mb-1 grid h-9 w-9 place-items-center rounded-xl transition",
          terminalOpen
            ? "bg-overlay text-slate-900"
            : "text-slate-500 hover:bg-overlay-soft hover:text-slate-700",
        )}
      >
        <SquareTerminal size={15} />
      </button>
      <button
        type="button"
        title={t("common.settings")}
        aria-label={t("common.settings")}
        onClick={() => onActivate("settings")}
        className={clsx(
          "grid h-9 w-9 place-items-center rounded-xl transition",
          view === "settings"
            ? "bg-overlay text-slate-900"
            : "text-slate-500 hover:bg-overlay-soft hover:text-slate-700",
        )}
      >
        <span
          key={railAnim?.id === "settings" ? railAnim.token : "idle"}
          className={clsx(
            "inline-flex items-center justify-center",
            railAnim?.id === "settings" && RAIL_ANIM.settings,
          )}
        >
          <SettingsIcon size={15} />
        </span>
      </button>
    </div>
  );
}
