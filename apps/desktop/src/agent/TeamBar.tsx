import { Segmented } from "../components/Segmented";
import { Switch } from "../components/ui";
import type { DshTask } from "../lib/dsh";
import { t } from "../lib/i18n";
import { agentActions, agentStore, agentTeamView } from "./store";

/**
 * Task header for team mode: the per-session switch and, once it is on, the
 * transcript/board choice. Both are view state; only the switch talks to the
 * runtime. A failed switch keeps its reason here instead of only a toast.
 */
export function TeamBar({ task }: { task: DshTask }) {
  const state = agentStore.use();
  const sessionId = task.id;
  const team = state.team[sessionId];
  const enabled = Boolean(team?.enabled);
  const busy = Boolean(state.teamBusy[sessionId]);
  const error = state.teamErrors[sessionId];

  return (
    <div className="shrink-0 border-b border-border px-5 py-2">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2">
        <div
          className="inline-flex items-center gap-2 text-ui-xs text-slate-500"
          title={t("agent.team.toggleHint")}
        >
          <Switch
            checked={enabled}
            disabled={busy}
            label={t("agent.team.toggle")}
            onChange={(value) => void agentActions.setTeamEnabled(sessionId, value)}
          />
          {t("agent.team.toggle")}
        </div>

        {enabled ? (
          <Segmented
            className="ml-auto"
            value={agentTeamView(state, sessionId)}
            onChange={(view) => agentActions.setTeamView(sessionId, view)}
            options={[
              { value: "chat", label: t("agent.team.viewChat") },
              { value: "board", label: t("agent.team.viewBoard") },
            ]}
          />
        ) : null}
      </div>

      {error ? (
        <div className="mx-auto mt-1 max-w-3xl select-text break-all text-ui-xs text-rose-600">
          {error}
        </div>
      ) : null}
    </div>
  );
}
