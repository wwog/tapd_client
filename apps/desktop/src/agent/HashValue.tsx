import { useState } from "react";
import clsx from "clsx";
import { Check, Copy } from "lucide-react";

import { copyText } from "../../../shared/agent/clipboard";
import { t } from "../lib/i18n";

/**
 * A git revision shown short with its full value on hover and copied on click.
 * The task pane and the done card share it so a hash never renders as a long
 * unreadable string in either place.
 */
export function HashValue({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyText(value))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={`${t("common.copy")}: ${value}`}
      className={clsx(
        "inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 font-mono text-ui-xs text-slate-600 transition hover:bg-overlay-soft hover:text-slate-900",
        className,
      )}
    >
      <span className="truncate">{value.slice(0, 7)}</span>
      {copied ? (
        <Check size={10} className="shrink-0 text-emerald-600" />
      ) : (
        <Copy size={10} className="shrink-0 text-slate-400" />
      )}
    </button>
  );
}
