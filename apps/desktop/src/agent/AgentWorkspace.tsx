import { Segmented } from "../components/Segmented";
import { t } from "../lib/i18n";
import { AgentConfigTab } from "./AgentConfigTab";
import { Composer } from "./Composer";
import { MessageStream } from "./MessageStream";
import { RuntimeNotice } from "./RuntimeNotice";
import { TaskActions } from "./TaskActions";
import { TaskList } from "./TaskList";
import { TrajectoryView } from "./trajectory/TrajectoryView";
import { agentActions, agentStore, agentTaskView } from "./store";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
};

/**
 * Task list + stream, with the configuration as the second tab. Runtime facts
 * stay in the configuration tab; the task tab only explains why it cannot send
 * right now, plus the workflow actions of the selected task.
 *
 * The pane header switches between the conversation and the trajectory ledger.
 * The transcript stays mounted (hidden) so a round trip keeps its scroll
 * position; the ledger keeps its own folds, selection and search.
 */
export function AgentWorkspace({ toast }: Props) {
  const state = agentStore.use();
  const selected = state.tasks?.find((task) => task.id === state.selectedId) ?? null;
  const view = agentTaskView(state, state.selectedId);

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
            {state.selectedId ? (
              <div className="shrink-0 border-b border-border px-5 py-2">
                <div className="mx-auto flex max-w-3xl items-center justify-center">
                  <Segmented
                    value={view}
                    onChange={(next) => agentActions.setTaskView(state.selectedId!, next)}
                    options={[
                      { value: "chat", label: t("agent.traj.viewChat") },
                      { value: "trajectory", label: t("agent.traj.viewTrajectory") },
                    ]}
                  />
                </div>
              </div>
            ) : null}
            {selected && selected.kind !== "chat" ? (
              <TaskActions key={selected.id} task={selected} />
            ) : null}
            <MessageStream key={state.selectedId ?? "draft"} visible={view === "chat"} />
            {state.selectedId && view === "trajectory" ? (
              <TrajectoryPane sessionId={state.selectedId} />
            ) : null}
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

/** The ledger pane reads the same committed history the transcript does. */
function TrajectoryPane({ sessionId }: { sessionId: string }) {
  const state = agentStore.use();
  const history = state.entries[sessionId];
  const live = state.live[sessionId];
  const items = history?.items ?? [];

  // Calls that already committed must not appear twice: the live overlay is
  // filtered down to what the log does not have yet.
  const committed = new Set(
    items.flatMap((entry) => (entry.kind === "tool" ? [entry.callId] : [])),
  );
  const tools = (live?.tools ?? []).filter((tool) => !tool.callId || !committed.has(tool.callId));
  const liveTrace =
    live && (live.text || live.reasoning || tools.length > 0)
      ? { text: live.text, reasoning: live.reasoning, tools }
      : undefined;

  return (
    <TrajectoryView
      entries={items}
      live={liveTrace}
      loading={history ? !history.loaded && items.length === 0 : true}
      failed={Boolean(history?.error) && items.length === 0}
      onRetry={() => agentActions.refreshEntries(sessionId)}
    />
  );
}
