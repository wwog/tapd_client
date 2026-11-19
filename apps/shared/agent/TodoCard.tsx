import { memo, useState } from "react";
import clsx from "clsx";
import {
  ChevronRight,
  CircleCheckBig,
  CircleDashed,
  Loader2,
} from "lucide-react";

import type { AgentLocale, AgentTodo } from "./types";
import { agentLabel } from "./labels";
import { Collapse } from "./Collapse";

export function TodoGlyph({ status }: { status: AgentTodo["status"] }) {
  // 3px puts the 14px glyph on the centre of the first 20px text line; the
  // row is `items-start` so a two-line task keeps the icon on its first line.
  if (status === "completed") {
    return <CircleCheckBig size={14} className="mt-[3px] shrink-0 text-emerald-600" />;
  }
  if (status === "in_progress") {
    return <Loader2 size={14} className="mt-[3px] shrink-0 animate-spin text-blue-600" />;
  }
  return <CircleDashed size={14} className="mt-[3px] shrink-0 text-slate-400" />;
}

/**
 * The task rows on their own. Both the inline card (companion) and the
 * desktop's floating HUD render this list, so a row reads the same wherever
 * the plan is shown.
 */
export const TodoList = memo(function TodoList({ todos }: { todos: AgentTodo[] }) {
  return (
    <ul data-component="TodoList" className="flex flex-col gap-0.5">
      {todos.map((todo, index) => (
        <li
          key={index}
          className="flex min-h-8 items-start gap-2 rounded-lg px-2 py-1.5 text-ui-caption hover:bg-overlay"
        >
          <TodoGlyph status={todo.status} />
          <span
            title={todo.content}
            className={clsx(
              "line-clamp-2 min-w-0 flex-1 break-words leading-5",
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
  );
});

/**
 * The session's standing plan (`todo/write`) as the inline card the companion
 * puts above the turns: folded it is one progress line with the active task,
 * open it lists every task. The list is session-level state, so it never lives
 * inside one turn block. Desktop renders the same plan in `TodoHud` instead.
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
    <div data-component="TodoCard" className="overflow-hidden rounded-lg border border-border bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={active?.content}
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
        <div className="border-t border-border p-1">
          <TodoList todos={todos} />
        </div>
      </Collapse>
    </div>
  );
});
