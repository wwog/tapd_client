import clsx from "clsx";
import type { ReactNode } from "react";
import {
  Bot,
  Bug,
  FolderGit2,
  Plug,
  Settings as SettingsIcon,
  Smartphone,
  Users,
} from "lucide-react";

import { AccountChip } from "./AccountChip";

export type View = "bugs" | "projects" | "agent" | "coworker" | "mcp" | "settings" | "account";

const RAIL_ANIM: Record<string, string> = {
  bugs: "rail-bug-jump",
  projects: "rail-folder-bounce",
  agent: "rail-bot-shake",
  coworker: "rail-users-wave",
  mcp: "rail-plug-rise",
  settings: "rail-settings-spin",
  account: "rail-avatar-pop",
};

const NAV: Array<{ id: View; label: string; icon: ReactNode }> = [
  { id: "bugs", label: "缺陷", icon: <Bug size={15} /> },
  { id: "projects", label: "项目", icon: <FolderGit2 size={15} /> },
  { id: "agent", label: "Agent", icon: <Bot size={15} /> },
  { id: "coworker", label: "同事", icon: <Users size={15} /> },
  { id: "mcp", label: "MCP", icon: <Plug size={15} /> },
  { id: "settings", label: "设置", icon: <SettingsIcon size={15} /> },
];

export type RailAnimation = { id: string; token: number } | null;

type Props = {
  view: View;
  railAnim: RailAnimation;
  /** The project column is out of layout, so the chip eases into the rail. */
  sidebarHidden: boolean;
  meAvatar: string | null;
  name: string | null;
  /** Companion enabled in Settings: show the phone scan entry. */
  showCompanion: boolean;
  onOpenCompanion: () => void;
  onActivate: (view: View) => void;
};

/** Icon rail: primary views, the account chip and Settings. */
export function NavRail({
  view,
  railAnim,
  sidebarHidden,
  meAvatar,
  name,
  showCompanion,
  onOpenCompanion,
  onActivate,
}: Props) {
  const accountAnim = railAnim?.id === "account" ? railAnim : null;

  return (
    <div className="flex w-[52px] shrink-0 flex-col items-center pb-2">
      <div className="flex flex-col items-center gap-1">
        {NAV.filter((item) => item.id !== "settings").map((item) => (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            onClick={() => onActivate(item.id)}
            className={clsx(
              "grid h-9 w-9 place-items-center rounded-xl transition",
              view === item.id
                ? "bg-overlay text-slate-900"
                : "text-slate-500 hover:bg-overlay-soft hover:text-slate-700",
            )}
          >
            <span
              key={railAnim?.id === item.id ? railAnim.token : "idle"}
              className={clsx(
                "inline-flex items-center justify-center",
                railAnim?.id === item.id && RAIL_ANIM[item.id],
              )}
            >
              {item.icon}
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
          title="移动端伴侣"
          aria-label="移动端伴侣"
          onClick={onOpenCompanion}
          className="mb-1 grid h-9 w-9 place-items-center rounded-xl text-slate-500 transition hover:bg-overlay-soft hover:text-slate-700"
        >
          <Smartphone size={15} />
        </button>
      ) : null}
      <button
        type="button"
        title="设置"
        aria-label="设置"
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
