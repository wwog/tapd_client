import clsx from "clsx";
import {
  ChevronRight,
  FileText,
  Globe,
  Image as ImageIcon,
  PenLine,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";

import { t } from "../lib/i18n";
import { describeTool, type ToolAction } from "./actions";

/**
 * Timeline icon for one action. Errors win over the tool's own glyph so a
 * failed row reads at a glance; the running state is carried by the turn's
 * spinner, not by every row.
 */
export function ActionIcon({
  action,
  failed = false,
}: {
  action: ToolAction;
  failed?: boolean;
}) {
  const Icon = {
    bash: Terminal,
    read: FileText,
    write: PenLine,
    edit: PenLine,
    search: Search,
    web: Globe,
    image: ImageIcon,
    other: Wrench,
  }[action.kind];

  return (
    <Icon
      size={12}
      className={clsx("shrink-0", failed ? "text-rose-500" : "text-slate-400")}
    />
  );
}

/** Tool results arrive as a string or as the JSON value the host received. */
function resultText(result: unknown): string | undefined {
  if (result === undefined || result === null || result === "") return undefined;
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

/**
 * One tool call as a timeline row: verb, target, line delta and outcome on a
 * single line. The raw output is the row's own disclosure, so a long result
 * never pushes the timeline apart.
 */
export function ActionRow({
  name,
  args,
  status,
  result,
}: {
  name: string;
  args: string;
  status: "running" | "ok" | "error";
  result?: unknown;
}) {
  const action = describeTool(name, args);
  const raw = resultText(result);
  const failed = status === "error";
  const header = (
    <span className="flex min-w-0 items-center gap-2 py-0.5">
      <ActionIcon action={action} failed={failed} />
      <span className="shrink-0 text-ui-xs text-slate-500">{action.verb}</span>
      <span
        className={clsx(
          "min-w-0 truncate font-mono text-ui-xs",
          failed ? "text-rose-700" : "text-slate-600",
        )}
        title={action.target}
      >
        {action.target}
      </span>
      {action.added ? (
        <span className="shrink-0 tabular-nums text-ui-xs text-emerald-600">
          +{action.added}
        </span>
      ) : null}
      {action.removed ? (
        <span className="shrink-0 tabular-nums text-ui-xs text-rose-500">
          -{action.removed}
        </span>
      ) : null}
      {failed ? (
        <span className="shrink-0 text-ui-xs text-rose-600">
          {t("agent.action.failed")}
        </span>
      ) : null}
      {raw ? (
        <ChevronRight
          size={12}
          className="shrink-0 text-slate-300 transition-transform group-open:rotate-90"
        />
      ) : null}
    </span>
  );

  if (!raw) return <div className="min-w-0">{header}</div>;
  return (
    // A failed call opens itself: the reason is the point of the row.
    <details className="group min-w-0" open={failed}>
      <summary className="cursor-pointer list-none">{header}</summary>
      <pre
        className={clsx(
          "mt-1 max-h-64 select-text overflow-auto whitespace-pre-wrap break-all rounded-lg border px-2.5 py-2 font-mono text-ui-xs leading-5",
          failed
            ? "border-rose-200 bg-rose-50/40 text-rose-700"
            : "border-border bg-surface text-slate-600",
        )}
      >
        {raw}
      </pre>
    </details>
  );
}

/**
 * Reasoning inside an expanded turn trace: a quiet, labelled paragraph. The
 * trace already draws the indent rule, so this one keeps no border of its own.
 */
export function TraceReasoning({ text }: { text: string }) {
  return (
    <div className="min-w-0">
      <div className="text-ui-xs text-slate-400">{t("agent.thinking")}</div>
      <div className="mt-0.5 whitespace-pre-wrap break-words text-ui-xs leading-5 text-slate-400 select-text">
        {text}
      </div>
    </div>
  );
}
