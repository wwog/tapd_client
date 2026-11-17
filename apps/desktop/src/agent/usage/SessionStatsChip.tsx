import { Activity } from "lucide-react";

import { t } from "../../lib/i18n";
import type { DshSessionUsage } from "../../lib/dsh";
import { Dot, UsagePopover, UsageRow, UsageRows } from "./Popover";
import { duration } from "./format";

/**
 * Turns, steps, speed and the timings behind them: how long the latest request
 * waited for its first token and how long the model took in total.
 */
export function SessionStatsChip({ usage }: { usage: DshSessionUsage }) {
  const turns = t("agent.stats.turns", { turns: usage.turns, steps: usage.steps });

  return (
    <UsagePopover
      title={t("agent.stats.title")}
      hint={t("agent.stats.hint")}
      meta={turns}
      minWidth={248}
      fullHeight={196}
      trigger={
        <>
          <Activity size={11} className="shrink-0" />
          <span className="tabular-nums">{turns}</span>
          {usage.tokensPerSecond > 0 ? (
            <>
              <Dot />
              <span className="tabular-nums">
                {t("agent.stats.speed", { speed: usage.tokensPerSecond })}
              </span>
            </>
          ) : null}
        </>
      }
    >
      <UsageRows>
        <UsageRow label={t("agent.stats.turnsLabel")}>{turns}</UsageRow>
        <UsageRow label={t("agent.stats.modelTime")}>
          {usage.modelMs > 0 ? duration(usage.modelMs) : "—"}
        </UsageRow>
        <UsageRow label={t("agent.stats.ttft")}>
          {usage.ttftMs > 0 ? duration(usage.ttftMs) : "—"}
        </UsageRow>
        <UsageRow label={t("agent.stats.tps")}>
          {usage.tokensPerSecond > 0
            ? t("agent.stats.speed", { speed: usage.tokensPerSecond })
            : "—"}
        </UsageRow>
      </UsageRows>
    </UsagePopover>
  );
}
