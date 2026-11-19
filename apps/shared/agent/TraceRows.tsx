import {
  memo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
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

import type { AgentLocale } from "./types";
import { agentLabel } from "./labels";
import { useAgentHost } from "./host";
import {
  describeTool,
  failedVerb,
  runningVerb,
  toolInput,
  type ToolAction,
} from "./actions";
import { Collapse } from "./Collapse";

/**
 * One height cap for every disclosure in the trace: a long result, a long
 * reasoning block and an image preview all scroll inside the same box, so the
 * timeline keeps one rhythm instead of three. A leaf block can be dragged
 * taller for the current mount; there is no reset gesture.
 */
export const TRACE_MAX_HEIGHT = "max-h-64";
const MIN_BLOCK_HEIGHT = 64;

/**
 * Timeline icon for one action. Errors win over the tool's own glyph so a
 * failed row reads at a glance; the running state is carried by the row's verb,
 * not by every icon.
 */
export function ActionKindIcon({
  kind,
  failed = false,
}: {
  kind: ToolAction["kind"];
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
  }[kind];

  return (
    <Icon
      size={12}
      className={clsx("shrink-0", failed ? "text-rose-500" : "text-slate-400")}
    />
  );
}

export function ActionIcon({
  action,
  failed = false,
}: {
  action: ToolAction;
  failed?: boolean;
}) {
  return <ActionKindIcon kind={action.kind} failed={failed} />;
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

/** Diff lines: additions green, removals red, the two headers muted. */
function DiffText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, index) => {
        const header = line.startsWith("---") || line.startsWith("+++");
        const removed = !header && line.startsWith("-");
        const added = !header && line.startsWith("+");
        return (
          <span
            key={`${index}-${line.slice(0, 8)}`}
            className={clsx(
              "block",
              header && "text-slate-400",
              removed && "text-rose-600",
              added && "text-emerald-600",
            )}
          >
            {line || " "}
          </span>
        );
      })}
    </>
  );
}

/**
 * One scroll box with a bottom drag strip. The height starts at the shared
 * cap; dragging the strip changes this block only (no double-click reset, no
 * persistence across a remount).
 */
function ResizableDetail({
  label,
  text,
  diff = false,
  children,
  height,
  onHeight,
  locale,
  tone = "normal",
}: {
  label?: string;
  text?: string;
  diff?: boolean;
  children?: ReactNode;
  height?: number;
  onHeight?: (height: number) => void;
  locale: AgentLocale;
  tone?: "normal" | "error" | "muted";
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ y: number; height: number } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = boxRef.current;
    if (!box) return;
    dragRef.current = { y: event.clientY, height: box.offsetHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !onHeight) return;
    const max = Math.max(MIN_BLOCK_HEIGHT, Math.round(window.innerHeight * 0.6));
    const next = Math.min(
      Math.max(drag.height + event.clientY - drag.y, MIN_BLOCK_HEIGHT),
      max,
    );
    onHeight(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div data-component="ResizableDetail" className="group/leaf flex min-w-0 flex-col">
      {label ? (
        <div className="mb-0.5 truncate text-ui-xs text-slate-400">{label}</div>
      ) : null}
      <div
        ref={boxRef}
        style={height !== undefined ? { height: `${height}px` } : undefined}
        className={clsx(
          "select-text overflow-auto whitespace-pre-wrap break-all rounded-lg border px-2.5 py-2 text-ui-xs leading-5",
          height === undefined && TRACE_MAX_HEIGHT,
          !children && "font-mono",
          tone === "error"
            ? "border-rose-200 bg-rose-50/40 text-rose-700"
            : tone === "muted"
              ? "border-border bg-surface text-slate-500"
              : "border-border bg-surface text-slate-600",
        )}
      >
        {children ?? (diff ? <DiffText text={text ?? ""} /> : text)}
      </div>
      {onHeight ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          title={agentLabel("leaf.resize", locale)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="mx-auto mt-0.5 h-1.5 w-10 shrink-0 touch-none cursor-ns-resize rounded-full bg-slate-200 opacity-0 transition group-hover/leaf:opacity-100 [@media(hover:none)]:opacity-60"
        />
      ) : null}
    </div>
  );
}

/**
 * One committed (or still running) tool call: a single line with the verb the
 * step state dictates, and — when opened — exactly two blocks, input and
 * output. The row itself never links to the trajectory and never scrolls
 * horizontally; the input block is where the full command lives.
 *
 * Memoized: an open flow re-renders on each token, but a committed leaf's
 * props stop changing, so its JSON parsing, diff counting and detail state are
 * not repeated.
 */
export const LeafRow = memo(function LeafRow({
  name,
  args,
  status,
  result,
  locale,
}: {
  name: string;
  args: string;
  status: "running" | "ok" | "error";
  result?: unknown;
  locale: AgentLocale;
}) {
  const host = useAgentHost();
  const action = describeTool(name, args, locale);
  const raw = resultText(result);
  const failed = status === "error";
  const running = status === "running";
  const image = action.kind === "image" ? imagePath(args, raw) : "";
  const input = toolInput(name, args);
  const [open, setOpen] = useState(failed);
  const [heights, setHeights] = useState<{ input?: number; output?: number }>({});
  const [preview, setPreview] = useState<{ src?: string; error?: string } | null>(null);

  const verb = running
    ? runningVerb(action.kind, locale)
    : failed
      ? failedVerb(action.kind, locale)
      : action.verb;
  // The latest activity reads as the raw command; once folded into a flow the
  // model's own description is the shorter, stable line.
  const target = running ? action.target : action.description || action.target;

  // The bytes are read on first open, not per render: a transcript can hold
  // dozens of image rows and each one is a file read.
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && image && preview === null && host.loadImage) {
      void host
        .loadImage(image)
        .then((src) => setPreview({ src }))
        .catch((error) => setPreview({ error: String(error) }));
    }
  };

  const outputLabel = agentLabel("leaf.output", locale);
  const outputText = raw ?? (running
    ? agentLabel("leaf.waitingOutput", locale)
    : agentLabel("leaf.noOutput", locale));

  return (
    <div data-component="LeafRow" className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="group/leaf-row -ml-1 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:text-slate-700"
      >
        <ActionIcon action={action} failed={failed} />
        <span
          className={clsx(
            "shrink-0 text-ui-xs",
            failed
              ? "text-rose-600"
              : "text-slate-500 transition-colors group-hover/leaf-row:text-slate-700",
          )}
        >
          {verb}
        </span>
        <span
          className={clsx(
            "min-w-0 flex-1 truncate font-mono text-ui-xs",
            failed
              ? "text-rose-700"
              : "text-slate-600 transition-colors group-hover/leaf-row:text-slate-800",
          )}
        >
          {target || name}
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
        <ChevronRight
          size={12}
          className={clsx(
            "shrink-0 text-slate-300 opacity-30 transition-[opacity,transform] group-hover/leaf-row:opacity-100 group-focus-visible/leaf-row:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      </button>

      <Collapse open={open}>
        <div className="mt-1 flex flex-col gap-1.5 pl-3">
          <ResizableDetail
            label={
              input.meta
                ? `${agentLabel("leaf.input", locale)} · ${input.meta}`
                : agentLabel("leaf.input", locale)
            }
            text={input.text}
            diff={input.diff}
            height={heights.input}
            onHeight={(next) => setHeights((prev) => ({ ...prev, input: next }))}
            locale={locale}
          />
          {image ? (
            <ResizableDetail
              label={outputLabel}
              height={heights.output}
              onHeight={(next) => setHeights((prev) => ({ ...prev, output: next }))}
              locale={locale}
              tone={failed ? "error" : "normal"}
            >
              {preview?.src ? (
                <img
                  src={preview.src}
                  alt={action.target}
                  className="max-w-full cursor-zoom-in rounded"
                  onClick={() =>
                    host.previewImage?.({ src: preview.src!, label: action.target })
                  }
                />
              ) : (
                <span className="block px-1 py-0.5 font-mono text-ui-xs text-slate-400">
                  {preview?.error ?? agentLabel("action.loading", locale)}
                </span>
              )}
            </ResizableDetail>
          ) : (
            <ResizableDetail
              label={outputLabel}
              text={outputText}
              height={heights.output}
              onHeight={(next) => setHeights((prev) => ({ ...prev, output: next }))}
              locale={locale}
              tone={failed ? "error" : "normal"}
            />
          )}
        </div>
      </Collapse>
    </div>
  );
});

/**
 * One thinking block inside a flow's 思考 group. Reasoning is only ever read at
 * this leaf, so the group header carries no preview.
 */
export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  locale,
}: {
  text: string;
  locale: AgentLocale;
}) {
  const [height, setHeight] = useState<number>();
  return (
    <ResizableDetail
      text={text}
      height={height}
      onHeight={setHeight}
      locale={locale}
      tone="muted"
    />
  );
});
