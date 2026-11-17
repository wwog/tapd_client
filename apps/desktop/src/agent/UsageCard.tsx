import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Database } from "lucide-react";

import { useDismiss } from "../hooks/useDismiss";
import { computeMenuPosition, type MenuPosition } from "../lib/menuPosition";
import type { DshEntryUsage } from "../lib/dsh";
import { t } from "../lib/i18n";
import { cacheHitPercent, compactCount, exactCount } from "./usage";

/**
 * What one reply cost. dsh reports usage per assistant message, so these
 * numbers settle when the message commits — there is nothing to stream.
 */
export function UsageChip({
  usage,
  provider,
  model,
}: {
  usage: DshEntryUsage;
  provider?: string;
  model?: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, cardRef, close, { scroll: true, resize: true });

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(
      computeMenuPosition(rect, { placement: "up", minWidth: 264, fullHeight: 210 }),
    );
    setOpen(true);
  };

  const cache = cacheHitPercent(usage.inputTokens, usage.cacheReadTokens);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-expanded={open}
        title={t("agent.usage.hint")}
        onClick={toggle}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 text-ui-xs text-slate-400 transition hover:bg-overlay hover:text-slate-600"
      >
        <Database size={11} className="shrink-0" />
        <span className="tabular-nums">
          {t("agent.usage.chip", { tokens: compactCount(usage.totalTokens) })}
        </span>
      </button>

      {open && position
        ? createPortal(
            <>
              <button
                type="button"
                aria-label={t("common.close")}
                tabIndex={-1}
                className="fixed inset-0 z-[110] cursor-default"
                onClick={close}
              />
              <div
                ref={cardRef}
                role="dialog"
                aria-label={t("agent.usage.title")}
                style={{
                  left: position.left,
                  top: position.top,
                  bottom: position.bottom,
                  width: position.width,
                  maxHeight: position.maxHeight,
                }}
                className="fixed z-[120] overflow-hidden rounded-xl border border-border bg-surface p-3"
              >
                <div className="text-ui-sm text-slate-700">{t("agent.usage.title")}</div>
                <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5">
                  <Row label={t("agent.usage.route")}>
                    <span className="font-mono text-ui-xs text-slate-600">
                      {provider && model ? `${provider}/${model}` : (model ?? provider ?? "—")}
                    </span>
                  </Row>
                  <Row label={t("agent.usage.cacheHit")}>
                    {t("agent.stats.percent", { percent: cache })}
                  </Row>
                  <Row label={t("agent.usage.input")}>
                    {t("agent.usage.tokens", { tokens: exactCount(usage.inputTokens) })}
                  </Row>
                  <Row label={t("agent.usage.cacheRead")}>
                    {t("agent.usage.tokens", { tokens: exactCount(usage.cacheReadTokens) })}
                  </Row>
                  <Row label={t("agent.usage.output")}>
                    {t("agent.usage.tokens", { tokens: exactCount(usage.outputTokens) })}
                  </Row>
                  <Row label={t("agent.usage.total")}>
                    {t("agent.usage.tokens", { tokens: exactCount(usage.totalTokens) })}
                  </Row>
                </dl>
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}

function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-ui-xs text-slate-400">{props.label}</dt>
      <dd className="min-w-0 text-right text-ui-xs tabular-nums text-slate-600">
        {props.children}
      </dd>
    </>
  );
}
