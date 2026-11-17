import { useState } from "react";
import clsx from "clsx";
import {
  Brain,
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
import { api } from "../lib/api";
import { ScrollingName } from "../components/ScrollingName";
import { describeTool, reasoningPreview, type ToolAction } from "./actions";

/**
 * One height cap for every disclosure in the trace: a long result, a long
 * reasoning block and an image preview all scroll inside the same box, so the
 * timeline keeps one rhythm instead of three.
 */
export const TRACE_MAX_HEIGHT = "max-h-64";

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
 * The image a `read_image`-shaped result points at. The tool reports a wrapper
 * (`<path>…</path><type>image</type><content>…`), so the path comes from the
 * call's arguments first and the wrapper second.
 */
function imagePath(args: string, result: string | undefined): string {
  try {
    const parsed = JSON.parse(args) as { file_path?: unknown; path?: unknown };
    const direct = [parsed.file_path, parsed.path].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (direct) return direct.trim();
  } catch {
    // Arguments may be partial while the call is still streaming.
  }
  return result?.match(/<path>([^<]+)<\/path>/)?.[1]?.trim() ?? "";
}

/**
 * One tool call as a timeline row: verb, the command or target, line delta and
 * outcome on a single line. The row itself opens the call in the trajectory;
 * the result is its own disclosure below, so a long output never pushes the
 * timeline apart.
 */
export function ActionRow({
  name,
  args,
  status,
  result,
  onOpenTrace,
}: {
  name: string;
  args: string;
  status: "running" | "ok" | "error";
  result?: unknown;
  /** Opens this call in the trajectory panel. */
  onOpenTrace?: () => void;
}) {
  const action = describeTool(name, args);
  const raw = resultText(result);
  const failed = status === "error";
  const image = action.kind === "image" ? imagePath(args, raw) : "";
  const [open, setOpen] = useState(failed);
  const [preview, setPreview] = useState<{ src?: string; error?: string } | null>(null);

  // The bytes are read on first open, not per render: a transcript can hold
  // dozens of image rows and each one is a file read.
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && image && preview === null) {
      void api
        .imageDataUrl(image)
        .then((src) => setPreview({ src }))
        .catch((error) => setPreview({ error: String(error) }));
    }
  };

  const detail = image || raw;

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 py-0.5">
        {onOpenTrace ? (
          <button
            type="button"
            title={t("agent.action.openTrace")}
            onClick={onOpenTrace}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left transition hover:bg-overlay-soft"
          >
            <ActionIcon action={action} failed={failed} />
            <span className="shrink-0 text-ui-xs text-slate-500">{action.verb}</span>
            <ScrollingName
              text={action.target}
              className={clsx(
                "min-w-0 flex-1 font-mono text-ui-xs",
                failed ? "text-rose-700" : "text-slate-600",
              )}
            />
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
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ActionIcon action={action} failed={failed} />
            <span className="shrink-0 text-ui-xs text-slate-500">{action.verb}</span>
            <ScrollingName
              text={action.target}
              className={clsx(
                "min-w-0 flex-1 font-mono text-ui-xs",
                failed ? "text-rose-700" : "text-slate-600",
              )}
            />
            {failed ? (
              <span className="shrink-0 text-ui-xs text-rose-600">
                {t("agent.action.failed")}
              </span>
            ) : null}
          </div>
        )}
        {detail ? (
          <button
            type="button"
            aria-expanded={open}
            title={t("agent.action.result")}
            onClick={toggle}
            className="shrink-0 rounded p-0.5 text-slate-300 transition hover:bg-overlay-soft hover:text-slate-500"
          >
            <ChevronRight
              size={12}
              className={clsx("transition-transform", open && "rotate-90")}
            />
          </button>
        ) : null}
      </div>

      {open && detail ? (
        image ? (
          <div
            className={clsx(
              "mt-1 overflow-auto rounded-lg border border-border bg-surface p-1.5",
              TRACE_MAX_HEIGHT,
            )}
          >
            {preview?.src ? (
              <img
                src={preview.src}
                alt={action.target}
                className="max-w-full rounded"
              />
            ) : (
              <span className="block px-1 py-0.5 text-ui-xs text-slate-400">
                {preview?.error ?? t("common.loading")}
              </span>
            )}
          </div>
        ) : (
          <pre
            className={clsx(
              "mt-1 select-text overflow-auto whitespace-pre-wrap break-all rounded-lg border px-2.5 py-2 font-mono text-ui-xs leading-5",
              TRACE_MAX_HEIGHT,
              failed
                ? "border-rose-200 bg-rose-50/40 text-rose-700"
                : "border-border bg-surface text-slate-600",
            )}
          >
            {raw}
          </pre>
        )
      ) : null}
    </div>
  );
}

/**
 * Reasoning inside the trace: folded by default, and while tokens are still
 * arriving the folded row itself is the live line — `思考中` plus the newest
 * sentence sliding through a single row. Opening it shows the whole text in the
 * same capped, scrolling box every other disclosure uses.
 */
export function ReasoningRow({ text, live = false }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = reasoningPreview(text);

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        title={open ? t("agent.turn.collapse") : t("agent.thinking")}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md py-0.5 text-left text-ui-xs text-slate-400 transition hover:bg-overlay-soft hover:text-slate-600"
      >
        <Brain size={12} className="shrink-0" />
        <span className="shrink-0">{t("agent.thinking")}</span>
        {live ? (
          <span className="shrink-0 text-slate-300">{t("agent.action.thinking")}</span>
        ) : null}
        <ScrollingName text={preview} className="min-w-0 flex-1 text-ui-xs text-slate-300" />
        <ChevronRight
          size={12}
          className={clsx("shrink-0 text-slate-300 transition-transform", open && "rotate-90")}
        />
      </button>
      {open ? (
        <div
          className={clsx(
            "mt-1 select-text overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-xs leading-5 text-slate-500",
            TRACE_MAX_HEIGHT,
          )}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

/** Kept for the older call sites; the fold is the same as {@link ReasoningRow}. */
export function TraceReasoning({ text }: { text: string }) {
  return <ReasoningRow text={text} />;
}
