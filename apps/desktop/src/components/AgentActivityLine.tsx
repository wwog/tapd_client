import {
  agentInFlightLabel,
  externalClaimLabel,
  type AgentInFlight,
  type ExternalClaim,
} from "../lib/agent";
import { elapsedSince, formatElapsed, formatStartedAt } from "../lib/activity";
import { ActivityGlyph } from "./ActivityGlyph";

type Props = {
  task?: AgentInFlight;
  claim?: ExternalClaim;
  /** Shared 1s clock from the table; null when nothing is active. */
  now: number;
  onOpenTask?: () => void;
};

/**
 * Two compact lines under the bug title. Never overlays the title: line one is
 * who is working on it, line two is the created time plus the rolling elapsed
 * time (at most two units) with a 16px activity glyph in front.
 */
export function AgentActivityLine(props: Props) {
  const { task, claim, now, onOpenTask } = props;
  if (!claim && !task) return null;

  const created = claim ? claim.claimedAt : task!.task.createdAt;
  const started = claim
    ? claim.claimedAt
    : task!.task.startedAt ?? task!.task.createdAt;
  const label = claim
    ? externalClaimLabel(claim)
    : `桌面 Agent ${agentInFlightLabel(task!)}`;
  const seed = claim
    ? `${claim.workspaceId}:${claim.bugId}:external`
    : `${task!.task.workspaceId}:${task!.task.bugId}:agent`;

  const line = (
    <>
      <span className="block truncate text-ui-xs text-sky-700" title={label}>
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-slate-500">
        <ActivityGlyph seed={seed} />
        <span className="truncate">
          {formatStartedAt(created)} 创建 · 已用 {formatElapsed(elapsedSince(started, now))}
        </span>
      </span>
    </>
  );

  if (claim || !onOpenTask) {
    return <div className="mt-1 flex flex-col gap-0.5 pl-9">{line}</div>;
  }

  return (
    <button
      type="button"
      title="查看 Agent 任务"
      onClick={(event) => {
        event.stopPropagation();
        onOpenTask();
      }}
      className="mt-1 flex w-full flex-col gap-0.5 rounded pl-9 text-left transition hover:text-sky-800"
    >
      {line}
    </button>
  );
}
