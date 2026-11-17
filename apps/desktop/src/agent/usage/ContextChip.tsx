import { t } from "../../lib/i18n";
import type { DshSessionUsage } from "../../lib/dsh";
import { UsagePopover, UsageRow, UsageRows } from "./Popover";
import { compactCount, contextPercent } from "./format";

/**
 * How full the context window is and what fills it. `contextUsedTokens` is the
 * runtime's own prompt-side meter; until it reports, the cumulative total is
 * the best available estimate.
 */
export function ContextChip({ usage }: { usage: DshSessionUsage }) {
  const known = usage.contextWindow > 0;
  const used = usage.contextUsedTokens > 0 ? usage.contextUsedTokens : usage.totalTokens;
  const percent = contextPercent(used, usage.contextWindow);
  const composition = usage.systemTokens + usage.toolsTokens + usage.messageTokens;
  const hasBreakdown = composition > 0;

  return (
    <UsagePopover
      title={known ? t("agent.context.used", { percent }) : t("agent.context.title")}
      hint={t("agent.context.hint")}
      meta={
        known
          ? t("agent.context.window", {
              used: `~${compactCount(used)}`,
              window: compactCount(usage.contextWindow),
            })
          : "—"
      }
      minWidth={272}
      fullHeight={214}
      trigger={
        <>
          {known ? <ContextRing percent={percent} /> : <span className="h-3 w-3" />}
          <span className="tabular-nums">
            {known ? t("agent.stats.percent", { percent }) : "—"}
          </span>
        </>
      }
    >
      {known ? <CompositionBar usage={usage} percent={percent} /> : null}
      {hasBreakdown ? (
        <UsageRows>
          <UsageRow label={<Legend tone="bg-slate-400" text={t("agent.context.system")} />}>
            {`~${compactCount(usage.systemTokens)}`}
          </UsageRow>
          <UsageRow label={<Legend tone="bg-violet-400" text={t("agent.context.tools")} />}>
            {`~${compactCount(usage.toolsTokens)}`}
          </UsageRow>
          <UsageRow
            label={<Legend tone="bg-sky-400" text={t("agent.context.messages")} />}
          >
            {`~${compactCount(usage.messageTokens)}`}
          </UsageRow>
        </UsageRows>
      ) : (
        <div className="mt-2 text-ui-xs text-slate-400">
          {/* The total survives a restart (it is in the session log); the split
              only exists for a request the runtime actually served. */}
          {known ? t("agent.context.splitPending") : t("agent.context.pending")}
        </div>
      )}
    </UsagePopover>
  );
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

/** One track, three segments: the same order as the legend below it. */
function CompositionBar({ usage, percent }: { usage: DshSessionUsage; percent: number }) {
  const totals = [
    { key: "system", tokens: usage.systemTokens, tone: "bg-slate-400" },
    { key: "tools", tokens: usage.toolsTokens, tone: "bg-violet-400" },
    { key: "messages", tokens: usage.messageTokens, tone: "bg-sky-400" },
  ];
  const total = totals.reduce((sum, part) => sum + part.tokens, 0);

  return (
    <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className="flex h-full" style={{ width: `${percent}%` }}>
        {totals.map((part) => (
          <span
            key={part.key}
            className={part.tone}
            style={{ width: total > 0 ? `${(part.tokens / total) * 100}%` : "0%" }}
          />
        ))}
      </div>
    </div>
  );
}

function Legend({ tone, text }: { tone: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 shrink-0 rounded-[2px] ${tone}`} />
      {text}
    </span>
  );
}
