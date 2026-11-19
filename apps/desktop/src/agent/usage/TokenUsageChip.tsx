import { Database } from "lucide-react";

import { t } from "../../lib/i18n";
import type { DshSessionUsage } from "../../lib/dsh";
import { Dot, UsagePopover, UsageRow, UsageRows } from "./Popover";
import { cacheHitPercent, compactCount, exactCount } from "./format";

/**
 * Running token totals for the session: what the provider cached, what it had
 * to read again and what the model wrote back.
 */
export function TokenUsageChip({ usage }: { usage: DshSessionUsage }) {
  const cache = cacheHitPercent(usage.inputTokens, usage.cacheReadTokens);

  return (
    <UsagePopover
      title={t("agent.usage.sessionTitle")}
      hint={t("agent.usage.hint")}
      meta={t("agent.usage.tokens", { tokens: compactCount(usage.totalTokens) })}
      minWidth={264}
      fullHeight={196}
      trigger={
        <>
          <Database size={11} className="shrink-0" />
          <span className="tabular-nums">
            {t("agent.stats.tokens", { tokens: compactCount(usage.totalTokens) })}
          </span>
          <Dot />
          <span className="tabular-nums">
            {t("agent.stats.cache", { percent: cache })}
          </span>
        </>
      }
    >
      <UsageRows>
        <UsageRow label={t("agent.usage.cacheHit")}>
          {t("agent.stats.percent", { percent: cache })}
        </UsageRow>
        <UsageRow label={t("agent.usage.input")}>
          {t("agent.usage.tokens", { tokens: exactCount(usage.inputTokens) })}
        </UsageRow>
        <UsageRow label={t("agent.usage.cacheRead")}>
          {t("agent.usage.tokens", { tokens: exactCount(usage.cacheReadTokens) })}
        </UsageRow>
        <UsageRow label={t("agent.usage.output")}>
          {t("agent.usage.tokens", { tokens: exactCount(usage.outputTokens) })}
        </UsageRow>
      </UsageRows>
    </UsagePopover>
  );
}
