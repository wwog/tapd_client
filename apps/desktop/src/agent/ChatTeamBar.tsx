import { Users } from "lucide-react";

import { Segmented } from "../components/Segmented";
import { Switch } from "../components/ui";
import { t } from "../lib/i18n";
import { agentActions, agentStore, agentTeamView } from "./store";

/**
 * Composer bar for a free chat: the one place a session-local choice is made.
 * Free chats start with collaboration off even when the config default is on,
 * so the switch is honest before the first message (nothing is allocated yet;
 * the pick rides on the next allocation) and afterwards it edits that
 * session's durable team mode.
 */
export function ChatTeamBar() {
  const state = agentStore.use();
  const sessionId = state.selectedId;
  const enabled = sessionId
    ? Boolean(state.team[sessionId]?.enabled)
    : state.chatTeamDraft;
  const busy = sessionId ? Boolean(state.teamBusy[sessionId]) : false;
  const error = sessionId ? state.teamErrors[sessionId] : null;

  const toggle = (value: boolean) => {
    if (!sessionId) {
      agentActions.setChatTeamDraft(value);
      return;
    }
    void agentActions.setTeamEnabled(sessionId, value);
  };

  return (
    <div className="mb-1.5 flex items-center gap-2 px-0.5">
      <Users size={12} className="shrink-0 text-slate-400" />
      <span className="shrink-0 text-ui-xs text-slate-500" title={t("agent.chat.teamHint")}>
        {t("agent.chat.team")}
      </span>
      {error ? (
        <span className="min-w-0 flex-1 truncate text-ui-xs text-rose-600" title={error}>
          {error}
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {/* A chat keeps its transcript by default; the board is one tap away. */}
        {enabled && sessionId ? (
          <Segmented
            value={agentTeamView(state, sessionId)}
            onChange={(view) => agentActions.setTeamView(sessionId, view)}
            options={[
              { value: "chat", label: t("agent.team.viewChat") },
              { value: "board", label: t("agent.team.viewBoard") },
            ]}
          />
        ) : null}
        <Switch
          checked={enabled}
          disabled={busy}
          onChange={toggle}
          label={t("agent.chat.team")}
        />
      </div>
    </div>
  );
}
