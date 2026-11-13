import { t } from "../../lib/i18n";
import { Button } from "../../components/ui";
import { ShellTerminal } from "../../components/ShellTerminal";
import { usePanelServices, type PanelProps } from "./context";

/**
 * One terminal tab = one PTY. The panel is mounted once by `PanelHost`; this
 * component only renders its session, so moving the tab keeps the emulator.
 */
export function TerminalPanel({ panel, active }: PanelProps) {
  const { terminal } = usePanelServices();
  const sessionId =
    panel.resource.type === "terminal" ? panel.resource.sessionId : null;
  const session = sessionId
    ? (terminal.sessions.find((item) => item.id === sessionId) ?? null)
    : null;

  if (!sessionId) return null;
  const exited = session?.exited ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1 p-1.5">
        <ShellTerminal
          sessionId={sessionId}
          active={active}
          live={exited === null}
        />
      </div>

      {exited !== null ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-1.5">
          <span className="text-ui-sm text-slate-500">{t("terminal.exited")}</span>
          <Button
            size="sm"
            onClick={() => {
              if (session) terminal.restart(session);
            }}
          >
            {t("terminal.restart")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
