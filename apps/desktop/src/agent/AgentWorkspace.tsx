import { Segmented } from "../components/Segmented";
import { t } from "../lib/i18n";
import { AgentConfigTab } from "./AgentConfigTab";
import { Composer } from "./Composer";
import { MessageStream } from "./MessageStream";
import { RuntimeNotice } from "./RuntimeNotice";
import { SessionList } from "./SessionList";
import { agentActions, agentStore } from "./store";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
};

/**
 * Session sidebar + stream, with the configuration as the second tab. Runtime
 * facts stay in the configuration tab; the session tab only explains why it
 * cannot send right now.
 */
export function AgentWorkspace({ toast }: Props) {
  const state = agentStore.use();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <h2 className="text-ui-base text-slate-900">{t("app.nav.agent")}</h2>
        <Segmented
          value={state.tab}
          onChange={agentActions.setTab}
          options={[
            { value: "sessions", label: t("agent.tab.sessions") },
            { value: "config", label: t("agent.tab.config") },
          ]}
        />
      </header>

      {state.tab === "sessions" ? (
        <div className="flex min-h-0 flex-1">
          <SessionList />
          <div className="flex min-w-0 flex-1 flex-col">
            <MessageStream key={state.selectedId ?? "draft"} />
            <div className="shrink-0 border-t border-border">
              <RuntimeNotice />
              <Composer />
            </div>
          </div>
        </div>
      ) : (
        <AgentConfigTab toast={toast} />
      )}
    </div>
  );
}
