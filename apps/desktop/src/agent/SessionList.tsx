import clsx from "clsx";
import { Plus } from "lucide-react";

import { relativeTime } from "../lib/api";
import { t } from "../lib/i18n";
import type { DshSessionStatus } from "../lib/dsh";
import { Button, Spinner } from "../components/ui";
import { ScrollingName } from "../components/ScrollingName";
import { agentActions, agentStore } from "./store";

const DOT: Record<DshSessionStatus, string> = {
  running: "bg-emerald-500",
  idle: "bg-slate-300",
  failed: "bg-rose-500",
};

function statusLabel(status: DshSessionStatus): string {
  switch (status) {
    case "running":
      return t("agent.session.statusRunning");
    case "idle":
      return t("agent.session.statusIdle");
    case "failed":
      return t("agent.session.statusFailed");
  }
}

/** Fixed-width session column: create, then the list of runtime sessions. */
export function SessionList() {
  const state = agentStore.use();
  const sessions = state.sessions;

  return (
    <aside className="flex h-full min-h-0 w-[248px] shrink-0 flex-col border-r border-border">
      <div className="p-2">
        <Button
          size="sm"
          className="w-full"
          icon={<Plus size={13} />}
          onClick={() => void agentActions.newSession()}
        >
          {t("agent.session.new")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {sessions === null ? (
          state.sessionsError ? (
            <div className="px-1 py-4 text-ui-caption text-slate-400">
              <div className="break-all" title={state.sessionsError}>
                {t("agent.session.loadFailed")}
              </div>
              <Button
                size="sm"
                className="mt-2"
                onClick={() => void agentActions.refreshSessions()}
              >
                {t("common.retry")}
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 py-6 text-ui-caption text-slate-400">
              <Spinner />
              {t("common.loading")}
            </div>
          )
        ) : sessions.length === 0 ? (
          <div
            className="px-2 py-8 text-center text-ui-caption text-slate-400"
            title={t("agent.session.emptyHint")}
          >
            {t("agent.session.empty")}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sessions.map((session) => {
              const selected = session.id === state.selectedId;
              return (
                <button
                  key={session.id}
                  type="button"
                  aria-current={selected}
                  onClick={() => agentActions.selectSession(session.id)}
                  className={clsx(
                    "w-full rounded-lg border px-2.5 py-1.5 text-left transition",
                    selected
                      ? "border-sky-200 bg-sky-50"
                      : "border-transparent hover:bg-slate-50",
                  )}
                >
                  <ScrollingName
                    text={session.title || t("agent.session.untitled")}
                    className="text-ui-caption text-slate-800"
                  />
                  <div className="mt-1 flex items-center gap-1.5 text-ui-xs text-slate-400">
                    <span
                      className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", DOT[session.status])}
                      title={statusLabel(session.status)}
                    />
                    {session.updatedAt ? (
                      <span className="truncate">{relativeTime(session.updatedAt)}</span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
