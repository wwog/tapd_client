import { t } from "../lib/i18n";
import type { DshSessionUsage } from "../lib/dsh";
import { cacheHitPercent, compactCount, contextPercent } from "./usage";

/**
 * One quiet line under the composer: turns, steps, speed and the running
 * token/cache/context totals for the session on screen.
 */
export function SessionStats({ usage }: { usage?: DshSessionUsage }) {
  if (!usage || (usage.turns === 0 && usage.totalTokens === 0)) return null;

  const cache = cacheHitPercent(usage.inputTokens, usage.cacheReadTokens);
  const context = contextPercent(usage.totalTokens, usage.contextWindow);

  return (
    <div
      className="flex min-w-0 items-center gap-1.5 overflow-hidden text-ui-xs text-slate-400"
      title={t("agent.stats.hint")}
    >
      <span className="shrink-0 tabular-nums">
        {t("agent.stats.turns", { turns: usage.turns, steps: usage.steps })}
      </span>
      {usage.tokensPerSecond > 0 ? (
        <>
          <Separator />
          <span className="shrink-0 tabular-nums">
            {t("agent.stats.speed", { speed: usage.tokensPerSecond })}
          </span>
        </>
      ) : null}
      <Separator />
      <span className="shrink-0 tabular-nums">
        {t("agent.stats.tokens", { tokens: compactCount(usage.totalTokens) })}
      </span>
      <Separator />
      <span className="shrink-0 tabular-nums">
        {t("agent.stats.cache", { percent: cache })}
      </span>
      {usage.contextWindow > 0 ? (
        <>
          <Separator />
          <ContextRing percent={context} />
          <span className="shrink-0 tabular-nums">
            {t("agent.stats.percent", { percent: context })}
          </span>
        </>
      ) : null}
    </div>
  );
}

function Separator() {
  return <span className="shrink-0 text-slate-300">·</span>;
}

/** Filled share of the context window; the number beside it is the truth. */
function ContextRing({ percent }: { percent: number }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const filled = (circumference * percent) / 100;
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className="h-3 w-3 shrink-0 -rotate-90 text-slate-300"
    >
      <circle cx="6" cy="6" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        stroke="currentColor"
        className="text-sky-500"
        strokeDasharray={`${filled} ${circumference}`}
      />
    </svg>
  );
}
