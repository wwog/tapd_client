import clsx from "clsx";

import { Button, Spinner } from "../components/ui";
import { ScrollingName } from "../components/ScrollingName";
import type { DshTeam, DshTeamTask, DshTeamTaskStatus } from "../lib/dsh";
import { t, type MessageKey } from "../lib/i18n";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { agentActions, agentStore } from "./store";

/** Scope chips per card; the rest collapse into a `+n` chip. */
const MAX_SCOPES = 3;

const COLUMNS: ReadonlyArray<{ status: DshTeamTaskStatus; label: MessageKey }> = [
  { status: "pending", label: "agent.team.colPending" },
  { status: "in_progress", label: "agent.team.colInProgress" },
  { status: "completed", label: "agent.team.colCompleted" },
];

function ScopeChips({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return null;
  const shown = scopes.slice(0, MAX_SCOPES);
  const hidden = scopes.length - shown.length;

  return (
    <div data-component="ScopeChips" className="mt-1 flex flex-wrap gap-1">
      {shown.map((scope) => (
        <span
          key={scope}
          title={scope}
          className="max-w-full truncate rounded-md border border-border px-1 font-mono text-ui-2xs text-slate-500"
        >
          {scope}
        </span>
      ))}
      {hidden > 0 ? (
        <span className="px-1 text-ui-2xs text-slate-400">
          {t("agent.team.moreScopes", { n: hidden })}
        </span>
      ) : null}
    </div>
  );
}

function TeamCard({ task }: { task: DshTeamTask }) {
  return (
    <article data-component="TeamCard" className="rounded-xl border border-border bg-surface px-2.5 py-2">
      <div
        className="line-clamp-2 text-ui-caption leading-5 text-slate-800"
        title={task.description || undefined}
      >
        {task.subject}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-xs text-slate-400">
        <span className="max-w-full truncate">
          {task.ownerName || t("agent.team.unassigned")}
        </span>
        {task.blockedBy.length > 0 ? (
          <span
            className="shrink-0 text-amber-700"
            title={task.blockedBy.join(", ")}
          >
            {t("agent.team.blocked", { n: task.blockedBy.length })}
          </span>
        ) : null}
        {task.ready && task.status === "pending" ? (
          <span className="shrink-0 text-emerald-700">{t("agent.team.ready")}</span>
        ) : null}
      </div>

      <ScopeChips scopes={task.writeScopes} />
    </article>
  );
}

function Board(props: { team: DshTeam; title: string }) {
  const { team, title } = props;

  if (team.tasks.length === 0) {
    return (
      <div
        data-component="Board"
        className="grid place-items-center text-ui-caption text-slate-400"
        title={t("agent.team.emptyHint")}
      >
        {t("agent.team.empty")}
      </div>
    );
  }

  return (
    <div data-component="Board" className="mx-auto flex w-full max-w-5xl flex-col gap-3">
      {team.failure ? (
        <div
          className="select-text truncate border-l-2 border-amber-300 pl-2 text-ui-xs leading-5 text-amber-700"
          title={team.failure}
        >
          {team.failure}
        </div>
      ) : null}

      <div className="flex items-center gap-2 text-ui-xs text-slate-500">
        <span className="shrink-0">{t("agent.team.lead")}</span>
        <ScrollingName
          text={title || t("agent.task.untitled")}
          className="min-w-0 flex-1 text-ui-caption text-slate-800"
        />
      </div>

      <div className="grid gap-3 @3xl:grid-cols-3">
        {COLUMNS.map((column) => {
          const tasks = team.tasks.filter((task) => task.status === column.status);
          return (
            <section key={column.status} className="flex min-w-0 flex-col gap-1.5">
              <h3 className="text-ui-xs text-slate-400">{t(column.label)}</h3>
              {tasks.map((task) => (
                <TeamCard key={task.id} task={task} />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Board pane of the selected task. It replaces the transcript, so a blocking
 * approval or question is repeated above it: those would otherwise be one
 * segmented-control tap away while the turn waits.
 */
export function TeamBoard() {
  const state = agentStore.use();
  const sessionId = state.selectedId;
  const team = sessionId ? state.team[sessionId] : undefined;
  const error = sessionId ? state.teamErrors[sessionId] : null;
  const title = state.tasks?.find((task) => task.id === sessionId)?.title ?? "";
  const approvals = state.approvals.filter((item) => item.sessionId === sessionId);
  const questions = state.questions.filter((item) => item.sessionId === sessionId);
  const empty = Boolean(team && team.tasks.length === 0);
  const quiet = empty && approvals.length === 0 && questions.length === 0;

  return (
    <div data-component="TeamBoard" className="@container min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3">
      <div
        className={clsx(
          "mx-auto flex w-full max-w-5xl flex-col gap-3",
          quiet && "min-h-full justify-center",
        )}
      >
        {approvals.map((approval) => (
          <ApprovalCard key={approval.rpcId} approval={approval} />
        ))}
        {questions.map((question) => (
          <QuestionCard key={question.rpcId} pending={question} />
        ))}

        {team ? (
          <Board team={team} title={title} />
        ) : error ? (
          <div className="flex items-center justify-center gap-3 py-8 text-ui-caption text-slate-400">
            <span className="min-w-0 truncate" title={error}>
              {t("agent.team.loadFailed")}
            </span>
            {sessionId ? (
              <Button size="sm" onClick={() => agentActions.refreshTeam(sessionId)}>
                {t("common.retry")}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 py-8 text-ui-caption text-slate-400">
            <Spinner />
            {t("common.loading")}
          </div>
        )}
      </div>
    </div>
  );
}
