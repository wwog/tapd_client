import { memo, useState } from "react";
import clsx from "clsx";
import { ChevronRight, CircleCheckBig, CircleDashed, Loader2 } from "lucide-react";

import type { AgentLocale, AgentTodo } from "./types";
import { agentLabel } from "./labels";
import { Collapse } from "./Collapse";

function TodoGlyph({ status }: { status: AgentTodo["status"] }) {
  if (status === "completed") {
    return <CircleCheckBig size={12} className="shrink-0 text-emerald-600" />;
  }
  if (status === "in_progress") {
    return <Loader2 size={12} className="shrink-0 animate-spin text-blue-600" />;
  }
  return <CircleDashed size={12} className="shrink-0 text-slate-400" />;
}

/**
 * The session's standing plan (`todo/write`). One card at the top of the
 * stream: folded it is one progress line with the active task, open it lists
 * every task. The list is session-level state, so it never lives inside one
 * turn block.
 */
export const TodoCard = memo(function TodoCard({
  todos,
  locale,
}: {
  todos: AgentTodo[];
  locale: AgentLocale;
}) {
  const [open, setOpen] = useState(false);
  const done = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  if (todos.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-ui-caption text-slate-500 transition-colors hover:text-slate-700"
      >
        <span className="shrink-0">{agentLabel("todo.title", locale)}</span>
        <span className="shrink-0 tabular-nums text-slate-400">
          {agentLabel("todo.progress", locale, { done, total: todos.length })}
        </span>
        {active ? (
          <span className="min-w-0 flex-1 truncate text-slate-600">
            {agentLabel("todo.current", locale, { content: active.content })}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <ChevronRight
          size={12}
          className={clsx(
            "shrink-0 text-slate-300 opacity-40 transition-[opacity,transform]",
            open && "rotate-90 opacity-100",
          )}
        />
      </button>
      <Collapse open={open}>
        <ul className="flex flex-col gap-1.5 border-t border-border px-3 py-2">
          {todos.map((todo, index) => (
            <li key={index} className="flex min-w-0 items-start gap-2 text-ui-caption">
              <TodoGlyph status={todo.status} />
              <span
                className={clsx(
                  "min-w-0 flex-1 break-words",
                  todo.status === "completed"
                    ? "text-slate-400 line-through"
                    : todo.status === "in_progress"
                      ? "text-slate-700"
                      : "text-slate-500",
                )}
              >
                {todo.content}
              </span>
            </li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
});
