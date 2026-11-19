import { memo, useDeferredValue, useState } from "react";
import clsx from "clsx";
import { Check, Copy } from "lucide-react";

import type { AgentLocale, AgentUsage } from "./types";
import { agentLabel } from "./labels";
import { useAgentHost } from "./host";
import { copyText } from "./clipboard";
import { clock } from "./format";

export const UserBubble = memo(function UserBubble({
  text,
}: {
  text: string;
  locale: AgentLocale;
}) {
  return (
    <div data-component="UserBubble" className="ml-auto max-w-[80%] whitespace-pre-wrap break-words rounded-xl rounded-tr-[3px] border border-border bg-surface px-3.5 py-2.5 text-ui-caption leading-6 text-slate-800 select-text">
      {text}
    </div>
  );
});

/**
 * Rendered assistant answer. Markdown rendering is a host capability
 * (`renderMarkdown`); without one the text shows pre-wrapped and plain, which
 * keeps the block readable in any webview.
 *
 * While the note streams, the Markdown pass reads a deferred copy: token
 * deltas still land immediately in the store, but a long answer cannot make
 * every delta re-parse the whole document on the critical path.
 */
export const AnswerBlock = memo(function AnswerBlock({
  text,
  streaming = false,
}: {
  text: string;
  locale: AgentLocale;
  streaming?: boolean;
}) {
  const host = useAgentHost();
  const deferred = useDeferredValue(text);
  const shown = streaming ? deferred : text;
  return (
    <div data-component="AnswerBlock" className="min-w-0 break-words text-ui-caption leading-6 text-slate-700 select-text">
      {host.renderMarkdown ? (
        host.renderMarkdown(shown)
      ) : (
        <p className="whitespace-pre-wrap">{shown}</p>
      )}
    </div>
  );
});

/** Usage, time and copy under a message. Copy confirms in place, no toast. */
export const MessageMeta = memo(function MessageMeta({
  at,
  text,
  align,
  locale,
  usage,
  provider,
  model,
}: {
  at: string;
  text: string;
  align: "left" | "right";
  locale: AgentLocale;
  usage?: AgentUsage;
  provider?: string;
  model?: string;
}) {
  const host = useAgentHost();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div
      data-component="MessageMeta"
      className={clsx(
        "mt-1 flex items-center gap-2 text-ui-xs text-slate-400",
        align === "right" ? "justify-end" : "justify-start",
      )}
    >
      {usage && host.renderUsage ? host.renderUsage(usage, provider, model) : null}
      <span className="tabular-nums">{clock(at)}</span>
      <button
        type="button"
        title={copied ? agentLabel("meta.copied", locale) : agentLabel("meta.copy", locale)}
        onClick={() => void copy()}
        className="grid h-5 w-5 place-items-center rounded text-slate-300 transition-colors hover:bg-overlay hover:text-slate-600"
      >
        {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
      </button>
    </div>
  );
});
