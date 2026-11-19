import type { DshSessionUsage } from "../../lib/dsh";
import { Dot } from "./Popover";
import { ContextChip } from "./ContextChip";
import { SessionStatsChip } from "./SessionStatsChip";
import { TokenUsageChip } from "./TokenUsageChip";

/**
 * Zero-valued row used before the runtime reports anything. The dock is chrome
 * for a selected session, so it stays visible (with dashes) instead of popping
 * in and out as snapshots arrive.
 */
export const EMPTY_USAGE: DshSessionUsage = {
  turns: 0,
  steps: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  provider: "",
  model: "",
  contextWindow: 0,
  tokensPerSecond: 0,
  ttftMs: 0,
  modelMs: 0,
  contextUsedTokens: 0,
  systemTokens: 0,
  toolsTokens: 0,
  messageTokens: 0,
};

/**
 * The quiet instruments on the composer's toolbar. Every figure is a button:
 * the counts open the session timings, the token total opens the cost
 * breakdown, and the ring opens what fills the context window.
 */
export function SessionUsageBar({ usage }: { usage?: DshSessionUsage }) {
  const value = usage ?? EMPTY_USAGE;

  return (
    <div data-component="SessionUsageBar" className="flex min-w-0 items-center gap-1 overflow-hidden text-ui-xs text-slate-400">
      <SessionStatsChip usage={value} />
      <Dot />
      <TokenUsageChip usage={value} />
      <Dot />
      <ContextChip usage={value} />
    </div>
  );
}
