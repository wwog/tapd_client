import { Segmented } from "../components/Segmented";
import { t } from "../lib/i18n";
import { AgentConfigTab } from "./AgentConfigTab";
import { Composer } from "./Composer";
import { MessageStream } from "./MessageStream";
import { RuntimeNotice } from "./RuntimeNotice";
import { TaskActions } from "./TaskActions";
import { TaskList } from "./TaskList";
import { TeamBar } from "./TeamBar";
import { TeamBoard } from "./TeamBoard";
import { agentActions, agentStore, agentTeamView } from "./store";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
};

/**
 * Task list + stream, with the configuration as the second tab. Runtime facts
 * stay in the configuration tab; the task tab only explains why it cannot send
 * right now, plus the workflow actions of the selected task.
 */
export function AgentWorkspace({ toast }: Props) {
  const state = agentStore.use();
  const selected = state.tasks?.find((task) => task.id === state.selectedId) ?? null;
  const team = state.selectedId ? state.team[state.selectedId] : undefined;
  // The board replaces the transcript in the same pane, so the transcript stays
  // mounted (hidden) and keeps its scroll position.
  const showBoard = Boolean(
    selected &&
      selected.kind !== "chat" &&
      team?.enabled &&
      agentTeamView(state, state.selectedId) === "board",
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <h2 className="text-ui-base text-slate-900">{t("app.nav.agent")}</h2>
        <Segmented
          value={state.tab}
          onChange={agentActions.setTab}
          options={[
            { value: "tasks", label: t("agent.tab.tasks") },
            { value: "config", label: t("agent.tab.config") },
          ]}
        />
      </header>

      {state.tab === "tasks" ? (
        <div className="flex min-h-0 flex-1">
          <TaskList />
          <div className="flex min-w-0 flex-1 flex-col">
            {selected && selected.kind !== "chat" ? <TeamBar task={selected} /> : null}
            {selected && selected.kind !== "chat" ? (
              <TaskActions key={selected.id} task={selected} />
            ) : null}
            {showBoard ? <TeamBoard /> : null}
            <MessageStream
              key={state.selectedId ?? "draft"}
              visible={!showBoard}
            />
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
