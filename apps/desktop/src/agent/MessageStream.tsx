import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, Check, Copy, Loader2 } from "lucide-react";

import { Button, Spinner } from "../components/ui";
import { ScrollingName } from "../components/ScrollingName";
import { copyText } from "../lib/desktop";
import { t } from "../lib/i18n";
import type { DshEntry, DshEntryUsage } from "../lib/dsh";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { UsageChip } from "./UsageCard";
import { clock } from "./usage";
import { agentActions, agentStore } from "./store";

/** Tool results arrive as a string or as the JSON value the host received. */
function resultText(result: unknown): string | undefined {
  if (result === undefined || result === null || result === "") return undefined;
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

/** Tool call status tint: running spins, errors tint the row, done stays quiet. */
function ToolRow({
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

function Reasoning({ text }: { text: string }) {
  return (
    <details>
      <summary className="cursor-pointer select-none text-ui-xs text-slate-400">
        {t("agent.thinking")}
      </summary>
      <div className="mt-1 whitespace-pre-wrap break-words border-l border-border pl-2.5 text-ui-xs leading-5 text-slate-400 select-text">
        {text}
      </div>
    </details>
  );
}

function AssistantBlock({
  text,
  reasoning,
  usage,
  provider,
  model,
}: {
  text: string;
  reasoning?: string;
  usage?: DshEntryUsage;
  provider?: string;
  model?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {reasoning ? <Reasoning text={reasoning} /> : null}
      {text ? (
        <div className="whitespace-pre-wrap break-words text-ui-caption leading-6 text-slate-700 select-text">
          {text}
        </div>
      ) : null}
      {usage ? <UsageChip usage={usage} provider={provider} model={model} /> : null}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto max-w-[80%] whitespace-pre-wrap break-words rounded-xl bg-slate-100 px-3 py-2 text-ui-caption leading-6 text-slate-800 select-text">
      {text}
    </div>
  );
}

/** Time and copy under a message. Copy confirms in place, never with a toast. */
function MessageMeta({
  at,
  text,
  align,
}: {
  at: string;
  text: string;
  align: "left" | "right";
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div
      className={clsx(
        "mt-1 flex items-center gap-1 text-ui-xs text-slate-400",
        align === "right" ? "justify-end" : "justify-start",
      )}
    >
      <span className="tabular-nums">{clock(at)}</span>
      <button
        type="button"
        title={copied ? t("common.copied") : t("common.copy")}
        onClick={() => void copy()}
        className="grid h-5 w-5 place-items-center rounded text-slate-300 transition hover:bg-overlay hover:text-slate-600"
      >
        {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function entryKey(entry: DshEntry): string {
  if (entry.kind === "tool" && entry.callId) return `tool:${entry.callId}`;
  return `${entry.kind}:${entry.seq}`;
}

/**
 * Committed history plus the live attempt on top. The page remounts this per
 * session (`key`), which also resets the scroll position. `visible` hides the
 * pane for the team board without unmounting it, so the scroll position and the
 * live overlay survive a trip to the board and back.
 */
export function MessageStream({ visible = true }: { visible?: boolean }) {
  const state = agentStore.use();
  const sessionId = state.selectedId;
  const history = sessionId ? state.entries[sessionId] : undefined;
  const live = sessionId ? state.live[sessionId] : undefined;
  const pending = (sessionId ? state.pendingPrompts[sessionId] : undefined) ?? [];
  const approvals = state.approvals.filter((item) => item.sessionId === sessionId);
  const questions = state.questions.filter((item) => item.sessionId === sessionId);
  const items = history?.items ?? [];

  const committedCalls = new Set(
    items.flatMap((entry) => (entry.kind === "tool" ? [entry.callId] : [])),
  );
  const liveTools = (live?.tools ?? []).filter(
    (tool) => !tool.callId || !committedCalls.has(tool.callId),
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const signature = [
    items.length,
    live?.text.length ?? 0,
    live?.reasoning.length ?? 0,
    liveTools.length,
    pending.length,
    approvals.length,
    questions.length,
  ].join(":");

  useEffect(() => {
    if (!visible) return;
    const element = scrollRef.current;
    if (!element || !stickRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [signature, visible]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickRef.current = distance < 48;
  };

  if (!sessionId) {
    return (
      <div
        className={clsx(
          "grid min-h-0 flex-1 place-items-center px-6 text-ui-caption text-slate-400",
          !visible && "hidden",
        )}
        title={t("agent.stream.noSessionHint")}
      >
        {t("agent.stream.noSession")}
      </div>
    );
  }

  const hasContent =
    items.length > 0 ||
    pending.length > 0 ||
    Boolean(live?.text) ||
    Boolean(live?.reasoning) ||
    liveTools.length > 0 ||
    approvals.length > 0 ||
    questions.length > 0;

  const loading = history ? !history.loaded && items.length === 0 : true;
  const failed = Boolean(history?.error) && items.length === 0;
  const quiet = !hasContent && !loading && !failed;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={clsx(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4",
        !visible && "hidden",
      )}
    >
      <div
        className={clsx(
          "mx-auto flex w-full max-w-3xl flex-col gap-3",
          (quiet || loading || failed) && "min-h-full justify-center",
        )}
      >
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-ui-caption text-slate-400">
            <Spinner />
            {t("common.loading")}
          </div>
        ) : failed ? (
          <div className="flex items-center justify-center gap-3 py-8 text-ui-caption text-slate-400">
            <span className="min-w-0 truncate" title={history?.error ?? undefined}>
              {t("agent.stream.loadFailed")}
            </span>
            <Button size="sm" onClick={() => agentActions.refreshEntries(sessionId)}>
              {t("common.retry")}
            </Button>
          </div>
        ) : !hasContent ? (
          <div
            className="grid place-items-center py-8 text-ui-caption text-slate-400"
            title={t("agent.stream.emptyHint")}
          >
            {t("agent.stream.empty")}
          </div>
        ) : null}

        {items.map((entry) => {
          switch (entry.kind) {
            case "user":
              return (
                <div key={entryKey(entry)} className="flex flex-col">
                  <UserBubble text={entry.text} />
                  <MessageMeta at={entry.at} text={entry.text} align="right" />
                </div>
              );
            case "assistant":
              return (
                <div key={entryKey(entry)} className="flex flex-col">
                  <AssistantBlock
                    text={entry.text}
                    reasoning={entry.reasoning}
                    usage={entry.usage}
                    provider={entry.provider}
                    model={entry.model}
                  />
                  <MessageMeta at={entry.at} text={entry.text} align="left" />
                </div>
              );
            case "tool":
              return (
                <ToolRow
                  key={entryKey(entry)}
                  name={entry.name}
                  args={entry.args}
                  status={entry.status}
                  result={entry.result}
                />
              );
            case "turn":
              return entry.state === "start" ? (
                <div key={entryKey(entry)} aria-hidden="true" className="my-1 h-px w-full bg-border" />
              ) : null;
          }
        })}

        {pending.map((text, index) => (
          <UserBubble key={`pending-${index}-${text.length}`} text={text} />
        ))}

        {liveTools.map((tool, index) => (
          <ToolRow
            key={`live-${tool.callId || index}`}
            name={tool.name}
            args={tool.args}
            status="running"
          />
        ))}

        {live?.text || live?.reasoning ? (
          <AssistantBlock text={live?.text ?? ""} reasoning={live?.reasoning || undefined} />
        ) : null}

        {approvals.map((approval) => (
          <ApprovalCard key={approval.rpcId} approval={approval} />
        ))}

        {questions.map((question) => (
          <QuestionCard key={question.rpcId} pending={question} />
        ))}
      </div>
    </div>
  );
}
