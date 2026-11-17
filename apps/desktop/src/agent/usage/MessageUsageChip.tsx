import { Database } from "lucide-react";

import { t } from "../../lib/i18n";
import { UsagePopover, UsageRow, UsageRows } from "./Popover";
import { cacheHitPercent, compactCount, exactCount } from "./format";

/**
 * What one reply cost. dsh reports usage per assistant message, so these
 * numbers settle when the message commits — there is nothing to stream.
 *
 * The usage fields mirror the shared agent view's per-reply shape (cache
 * fields optional there), so the chip can be injected into the shared
 * `MessageMeta` through `AgentHostProvider.renderUsage`.
 */
export function MessageUsageChip({
  usage,
  provider,
  model,
}: {
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens: number;
  };
  provider?: string;
  model?: string;
}) {
  const cache = cacheHitPercent(usage.inputTokens, usage.cacheReadTokens ?? 0);

  return (
    <UsagePopover
      title={t("agent.usage.title")}
      hint={t("agent.usage.hint")}
      minWidth={264}
      fullHeight={228}
      dismissOnScroll
      trigger={
        <>
          <Database size={11} className="shrink-0" />
          <span className="tabular-nums">
            {t("agent.usage.chip", { tokens: compactCount(usage.totalTokens) })}
          </span>
        </>
      }
    >
      <UsageRows>
        <UsageRow label={t("agent.usage.route")}>
          <span className="font-mono text-ui-xs text-slate-600">
            {provider && model ? `${provider}/${model}` : (model ?? provider ?? "—")}
          </span>
        </UsageRow>
        <UsageRow label={t("agent.usage.cacheHit")}>
          {t("agent.stats.percent", { percent: cache })}
        </UsageRow>
        <UsageRow label={t("agent.usage.input")}>
          {t("agent.usage.tokens", { tokens: exactCount(usage.inputTokens) })}
        </UsageRow>
        <UsageRow label={t("agent.usage.cacheRead")}>
          {t("agent.usage.tokens", { tokens: exactCount(usage.cacheReadTokens ?? 0) })}
        </UsageRow>
        <UsageRow label={t("agent.usage.output")}>
          {t("agent.usage.tokens", { tokens: exactCount(usage.outputTokens) })}
        </UsageRow>
        <UsageRow label={t("agent.usage.total")}>
          {t("agent.usage.tokens", { tokens: exactCount(usage.totalTokens) })}
        </UsageRow>
      </UsageRows>
    </UsagePopover>
  );
}
