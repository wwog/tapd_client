/**
 * What the primary dock shows when every tab is closed: a faint app mark plus
 * the everyday entry points, in the spirit of the VS Code welcome page.
 *
 * Every action opens an existing view (no hidden shortcuts are advertised);
 * the terminal row shows the real ⌘J binding.
 */
import { Bot, Bug, FolderGit2, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";

import appIcon from "../../assets/app-icon.png";
import { t } from "../../lib/i18n";
import { usePageHost } from "./pageContext";

type Row = {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  action: () => void;
};

export function WelcomeView({ onOpenTerminal }: { onOpenTerminal: () => void }) {
  const host = usePageHost();
  const project = host.workspace;

  const rows: Row[] = [
    // With a single visible project the side bar is hidden, so the welcome
    // page carries the one-click way back into its bug list.
    ...(project
      ? [
          {
            icon: <Bug size={15} />,
            label: t("welcome.openProject", { name: project.name }),
            action: () => host.onOpenProject(project.id, project.name),
          },
        ]
      : []),
    {
      icon: <Bot size={15} />,
      label: t("app.nav.agent"),
      action: () => host.onOpenView("agent"),
    },
    {
      icon: <FolderGit2 size={15} />,
      label: t("welcome.manageProjects"),
      action: () => host.onOpenView("projects"),
    },
    {
      icon: <SquareTerminal size={15} />,
      label: t("welcome.openTerminal"),
      shortcut: "⌘J",
      action: onOpenTerminal,
    },
  ];

  return (
    <div
      data-component="WelcomeView"
      className="flex h-full flex-col overflow-y-auto px-6 py-10"
    >
      {/* `m-auto` centres the block but keeps it reachable when the dock is
          shorter than the content (justify-center would clip the top). */}
      <div className="m-auto flex w-full flex-col items-center gap-9">
        <img
          src={appIcon}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="h-32 w-32 select-none opacity-[0.07]"
        />
        <div className="w-full max-w-[330px]">
          <p className="text-center text-ui-caption leading-6 text-slate-400">
            {t("welcome.hint")}
          </p>
          <div className="mt-6 flex flex-col gap-0.5">
            {rows.map((row) => (
              <button
                key={row.label}
                type="button"
                onClick={row.action}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui-base text-slate-500 transition hover:bg-overlay-soft hover:text-slate-700"
              >
                <span className="shrink-0 text-slate-400">{row.icon}</span>
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {row.shortcut ? (
                  <kbd className="shrink-0 rounded border border-border bg-surface px-1.5 py-0.5 text-ui-xs text-slate-400">
                    {row.shortcut}
                  </kbd>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
