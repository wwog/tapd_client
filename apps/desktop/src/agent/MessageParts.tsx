import { useState } from "react";
import clsx from "clsx";
import { Check, Copy } from "lucide-react";

import { Markdown } from "../components/Markdown";
import { copyText } from "../lib/desktop";
import { t } from "../lib/i18n";
import type { DshEntryUsage } from "../lib/dsh";
import { MessageUsageChip } from "./usage/MessageUsageChip";
import { clock } from "./usage/format";

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="ml-auto max-w-[80%] whitespace-pre-wrap break-words rounded-xl bg-slate-100 px-3 py-2 text-ui-caption leading-6 text-slate-800 select-text">
      {text}
    </div>
  );
}

/** Rendered assistant answer; Markdown itself lives in the shared component. */
export function AnswerBlock({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words text-ui-caption leading-6 text-slate-700 select-text">
      <Markdown source={text} />
    </div>
  );
}

/** Usage, time and copy under a message. Copy confirms in place, no toast. */
export function MessageMeta({
  at,
  text,
  align,
  usage,
  provider,
  model,
}: {
  at: string;
  text: string;
  align: "left" | "right";
  usage?: DshEntryUsage;
  provider?: string;
  model?: string;
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
        "mt-1 flex items-center gap-2 text-ui-xs text-slate-400",
        align === "right" ? "justify-end" : "justify-start",
      )}
    >
      {usage ? <MessageUsageChip usage={usage} provider={provider} model={model} /> : null}
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
