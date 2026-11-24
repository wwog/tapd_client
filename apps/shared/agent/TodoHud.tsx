import { memo } from "react";
import clsx from "clsx";
import { ArrowRight, ListChecks } from "lucide-react";

import type { AgentLocale, AgentTodo } from "./types";
import { agentLabel } from "./labels";
import { TodoList } from "./TodoCard";
import { StreamHudCard } from "./StreamHud";

/**
 * The session's plan in the stream's attention corner. Folded it is a small
 * capsule that only carries the count — `任务 1/4` — with the glyph saying
 * whether one is running; the running task's own text belongs to the panel,
 * not to a capsule sitting beside the transcript. Open it lists every task
 * with the same rows the companion's inline `TodoCard` uses.
 */
export const TodoHud = memo(function TodoHud({
  todos,
  locale,
}: {
  todos: AgentTodo[];
  locale: AgentLocale;
}) {
  const done = todos.filter((todo) => todo.status === "completed").length;
  const total = todos.length;
  const active = todos.find((todo) => todo.status === "in_progress");
  if (total === 0) return null;

  const progress = agentLabel("todo.progress", locale, { done, total });

  return (
    <StreamHudCard
      locale={locale}
      panelLabel={agentLabel("todo.title", locale)}
      summary={{
        icon: active ? (
          <ArrowRight size={16} className="text-slate-700" />
        ) : (
          <ListChecks size={16} className="text-slate-400" />
        ),
        label: (
          <span className={done === total ? "text-emerald-600" : undefined}>
            {`${agentLabel("todo.title", locale)} ${progress}`}
          </span>
        ),
      }}
    >
      <div className="mb-0.5 flex h-8 min-w-0 items-center gap-1.5 px-2 pr-8">
        <span className="shrink-0 text-ui-caption text-slate-400">
          {agentLabel("todo.title", locale)}
        </span>
        <span
          className={clsx(
            "shrink-0 tabular-nums text-ui-caption",
            done === total ? "text-emerald-600" : "text-slate-400",
          )}
        >
          {progress}
        </span>
      </div>
      <TodoList todos={todos} />
    </StreamHudCard>
  );
});
