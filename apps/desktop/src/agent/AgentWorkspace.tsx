import { Segmented } from "../components/Segmented";
import { t } from "../lib/i18n";
import { AgentConfigTab } from "./AgentConfigTab";
import { Composer } from "./Composer";
import { MessageStream } from "./MessageStream";
import { RuntimeNotice } from "./RuntimeNotice";
import { TaskActions } from "./TaskActions";
import { TaskList } from "./TaskList";
import { TrajectoryView } from "./trajectory/TrajectoryView";
import { agentActions, agentStore, agentTaskView, isSessionRunning } from "./store";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
};

/**
 * Task list + stream. The page has no header of its own: the window tab already
 * names it, so the conversation starts at the top. Settings live in a dialog
 * opened from the task column's footer (and from the runtime notice / model
 * picker); the pane explains why it cannot send right now plus the workflow
 * actions of the selected task.
 *
 * The pane bar switches between the conversation and the trajectory ledger.
 * The transcript stays mounted (hidden) so a round trip keeps its scroll
 * position; the ledger keeps its own folds, selection and search.
 */
export function AgentWorkspace({ toast }: Props) {
  const state = agentStore.use();
  const selected = state.tasks?.find((task) => task.id === state.selectedId) ?? null;
  const view = agentTaskView(state, state.selectedId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One step up from the app scale (styles.css `.agent-type`): the session
          is read as prose, and the config dialog stays outside it. */}
      <div className="agent-type flex min-h-0 flex-1">
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
            <TrajectoryPane key={state.selectedId} sessionId={state.selectedId} />
          ) : null}
          <div className="shrink-0 border-t border-border">
            <RuntimeNotice />
            <Composer />
          </div>
        </div>
      </div>
      {state.configOpen ? (
        <AgentConfigTab toast={toast} onClose={agentActions.closeConfig} />
      ) : null}
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
  // filtered down to what the log does not have yet. A delta without a call id
  // can only be matched by name + arguments.
  const committedIds = new Set<string>();
  const committedCalls = new Set<string>();
  for (const entry of items) {
    if (entry.kind !== "tool") continue;
    if (entry.callId) committedIds.add(entry.callId);
    else committedCalls.add(`${entry.name}\u0000${entry.args}`);
  }
  const tools = (live?.tools ?? []).filter((tool) =>
    tool.callId
      ? !committedIds.has(tool.callId)
      : !committedCalls.has(`${tool.name}\u0000${tool.args}`),
  );
  // A cancelled or failed attempt can leave its buffer behind; only a running
  // session may draw the live tail.
  const running = isSessionRunning(state, sessionId);
  const liveTrace =
    running && live && (live.text || live.reasoning || tools.length > 0)
      ? { text: live.text, reasoning: live.reasoning, tools }
      : undefined;

  return (
    <TrajectoryView
      sessionId={sessionId}
      entries={items}
      live={liveTrace}
      loading={history ? !history.loaded && items.length === 0 : true}
      failed={Boolean(history?.error) && items.length === 0}
      onRetry={() => agentActions.refreshEntries(sessionId)}
    />
  );
}
