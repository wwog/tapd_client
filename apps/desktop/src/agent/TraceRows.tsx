import clsx from "clsx";
import { AlertTriangle, Loader2 } from "lucide-react";

import { ScrollingName } from "../components/ScrollingName";
import { t } from "../lib/i18n";

/** Tool results arrive as a string or as the JSON value the host received. */
function resultText(result: unknown): string | undefined {
  if (result === undefined || result === null || result === "") return undefined;
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

/** Tool call status tint: running spins, errors tint the row, done stays quiet. */
export function ToolRow({
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
  const oneLine = args.replace(/\s+/g, " ").trim();
  const raw = resultText(result);
  const header = (
    <span className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
      {status === "running" ? (
        <Loader2 size={12} className="shrink-0 animate-spin text-slate-400" />
      ) : status === "error" ? (
        <AlertTriangle size={12} className="shrink-0 text-rose-500" />
      ) : (
        <span className="grid h-3 w-3 shrink-0 place-items-center">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
      )}
      <span
        className={clsx(
          "shrink-0 font-mono text-ui-xs",
          status === "error" ? "text-rose-700" : "text-slate-700",
        )}
        title={
          status === "running"
            ? t("agent.tool.running")
            : status === "error"
              ? t("agent.tool.failed")
              : undefined
        }
      >
        {name || t("agent.tool.calling")}
      </span>
      {oneLine ? (
        <ScrollingName
          text={oneLine}
          className="min-w-0 flex-1 font-mono text-ui-xs text-slate-400"
        />
      ) : null}
    </span>
  );

  const tone =
    status === "error"
      ? "border-rose-200 bg-rose-50/40"
      : "border-border bg-surface";

  if (!raw) {
    return <div className={clsx("rounded-lg border", tone)}>{header}</div>;
  }
  return (
    <details className={clsx("rounded-lg border", tone)}>
      <summary className="cursor-pointer">{header}</summary>
      <pre className="max-h-64 select-text overflow-auto whitespace-pre-wrap break-all border-t border-border px-2.5 py-2 font-mono text-ui-xs leading-5 text-slate-600">
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
