/**
 * Minimal JSON tree for the trajectory inspector: collapsible objects and
 * arrays, colored primitives, long strings collapsed behind 展开.
 *
 * The panel shows raw tool arguments and results, so this stays a viewer —
 * nothing is editable and nothing is re-serialized.
 */
import { useState } from "react";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";

import { t } from "../../lib/i18n";

const STRING_PREVIEW_CHARS = 240;

type Props = {
  value: unknown;
  /** Preview mode truncates long strings harder (the overview sections). */
  preview?: boolean;
  className?: string;
};

/** Renders any JSON value; objects/arrays start expanded. */
export function JsonTree({ value, preview = false, className }: Props) {
  return (
    <div
      className={clsx(
        "select-text whitespace-pre-wrap break-words font-mono text-ui-xs leading-5 text-slate-600",
        className,
      )}
    >
      <JsonNode value={value} depth={0} preview={preview} />
    </div>
  );
}

function JsonNode({ value, depth, preview }: { value: unknown; depth: number; preview: boolean }) {
  if (value === null) return <span className="text-slate-400">null</span>;
  if (typeof value === "string") return <JsonString value={value} preview={preview} />;
  if (typeof value === "number") return <span className="text-amber-600">{String(value)}</span>;
  if (typeof value === "boolean") {
    return <span className="text-violet-600">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <JsonBranch
        open={`[`}
        close={`]`}
        count={value.length}
        depth={depth}
        preview={preview}
        entries={value.map((item, index) => [String(index), item] as const)}
      />
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <JsonBranch
        open={`{`}
        close={`}`}
        count={entries.length}
        depth={depth}
        preview={preview}
        entries={entries}
      />
    );
  }
  return <span className="text-slate-400">{String(value)}</span>;
}

function JsonBranch({
  open,
  close,
  count,
  depth,
  preview,
  entries,
}: {
  open: string;
  close: string;
  count: number;
  depth: number;
  preview: boolean;
  entries: readonly (readonly [string, unknown])[];
}) {
  const [expanded, setExpanded] = useState(true);
  if (count === 0) return <span className="text-slate-400">{open + close}</span>;
  return (
    <span>
      <button
        type="button"
        className="-ml-3.5 inline-flex w-3.5 items-center align-middle text-slate-300 transition hover:text-slate-500"
        aria-expanded={expanded}
        title={expanded ? t("agent.traj.collapse") : t("agent.traj.expand")}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight size={10} className={clsx("transition-transform", expanded && "rotate-90")} />
      </button>
      <span className="text-slate-400">{open}</span>
      {expanded ? (
        <>
          <span className="block pl-4">
            {entries.map(([key, item], index) => (
              <span key={`${key}-${index}`} className="block">
                <span className="text-sky-700">{key}</span>
                <span className="text-slate-400">: </span>
                <JsonNode value={item} depth={depth + 1} preview={preview} />
                {index < entries.length - 1 ? <span className="text-slate-400">,</span> : null}
              </span>
            ))}
          </span>
          <span className="text-slate-400">{close}</span>
        </>
      ) : (
        <span className="text-slate-400">{`… ${count} ${close}`}</span>
      )}
    </span>
  );
}

function JsonString({ value, preview }: { value: string; preview: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const limit = preview ? 120 : STRING_PREVIEW_CHARS;
  const long = value.length > limit || value.split("\n").length > (preview ? 3 : 12);
  const shown = long && !expanded ? `${value.slice(0, limit)}…` : value;
  return (
    <span className="text-emerald-700">
      {JSON.stringify(shown)}
      {long ? (
        <button
          type="button"
          className="ml-1 rounded px-1 text-ui-2xs text-slate-400 transition hover:bg-overlay hover:text-slate-600"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t("agent.traj.collapse") : t("agent.traj.expand")}
        </button>
      ) : null}
    </span>
  );
}

/** Parses a raw payload; `undefined` when it is not a JSON object/array. */
export function parseJsonContainer(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}
