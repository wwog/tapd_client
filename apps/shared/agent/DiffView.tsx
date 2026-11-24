import { useMemo } from "react";
import clsx from "clsx";

import { diffRows } from "./diff";
import { agentLabel } from "./labels";
import type { AgentLocale } from "./types";

/**
 * Rows rendered at once. Measured on a desktop WebView: 3k rows (the 120k-char
 * backend cap with ordinary lines) mount in ~48ms, while the pathological
 * 60k-row case (one-character lines) takes ~560ms and freezes the pane. 5k
 * keeps the worst case well under a frame budget's neighbourhood while every
 * real diff lands below it; past it the panel says what it left out.
 */
const MAX_ROWS = 5000;

/** Frame and shared cell chrome; the tints live per row below. */
const FRAME =
  "select-text overflow-auto overscroll-contain rounded-lg border border-border bg-surface font-mono text-ui-xs leading-5";
const GUTTER = "w-10 shrink-0 select-none pr-2 text-right tabular-nums";
const CONTENT = "whitespace-pre pr-4";

/**
 * Read-only unified diff with both line numbers and changed-line tinting.
 *
 * Rows keep their own background across the whole width, so an added block
 * reads as one band the way an editor's diff margin does; the two gutters are
 * the old and new line numbers, and the sign column carries `+` / `-`. The
 * signs stay selectable — a copied hunk keeps them — while the numbers are
 * skipped so a paste does not interleave two counters. Long lines scroll
 * horizontally instead of wrapping; a wrapped line no longer lines up with its
 * number.
 */
export function DiffView({
  text,
  locale,
  /** Shown when the diff has no rows at all (an empty or binary diff). */
  placeholder,
  className,
}: {
  text: string;
  locale: AgentLocale;
  placeholder?: string;
  className?: string;
}) {
  const rows = useMemo(() => diffRows(text), [text]);
  const capped = rows.length > MAX_ROWS;
  const shown = capped ? rows.slice(0, MAX_ROWS) : rows;

  if (rows.length === 0) {
    return (
      <div
        data-component="DiffView"
        className={clsx(FRAME, "px-3 py-2 text-slate-400", className)}
      >
        {placeholder ?? ""}
      </div>
    );
  }

  return (
    <div data-component="DiffView" className={clsx(FRAME, className)}>
      <div className="w-max min-w-full py-1">
        {shown.map((row, index) => (
          <div
            key={index}
            data-diff-row={row.kind}
            className={clsx(
              "flex border-l-2",
              row.kind === "add" && "border-emerald-400 bg-emerald-50",
              row.kind === "del" && "border-rose-400 bg-rose-50",
              row.kind === "hunk" && "border-transparent bg-overlay-soft",
              row.kind === "context" && "border-transparent",
              row.kind === "note" && "border-transparent",
            )}
          >
            <span
              aria-hidden
              className={clsx(
                GUTTER,
                row.kind === "del" ? "text-rose-600" : "text-slate-400",
              )}
            >
              {row.oldNo ?? ""}
            </span>
            <span
              aria-hidden
              className={clsx(
                GUTTER,
                row.kind === "add" ? "text-emerald-700" : "text-slate-400",
              )}
            >
              {row.newNo ?? ""}
            </span>
            <span
              className={clsx(
                "w-4 shrink-0 text-center",
                row.kind === "add" && "text-emerald-600",
                row.kind === "del" && "text-rose-600",
              )}
            >
              {row.kind === "add" ? "+" : row.kind === "del" ? "-" : ""}
            </span>
            <span
              className={clsx(
                CONTENT,
                row.kind === "add" || row.kind === "del"
                  ? "text-slate-700"
                  : row.kind === "hunk" || row.kind === "note"
                    ? "text-slate-400"
                    : "text-slate-600",
              )}
            >
              {row.text}
            </span>
          </div>
        ))}
        {capped ? (
          <div
            data-diff-row="note"
            className="flex border-l-2 border-transparent text-slate-400"
          >
            <span className={clsx(GUTTER, "text-slate-400")} />
            <span className={clsx(GUTTER, "text-slate-400")} />
            <span className="w-4 shrink-0" />
            <span className={CONTENT}>
              {agentLabel("diff.rowsCapped", locale, {
                shown: MAX_ROWS,
                total: rows.length,
              })}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
