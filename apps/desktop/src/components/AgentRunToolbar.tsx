import { RefreshCw } from "lucide-react";
import clsx from "clsx";

import { Segmented } from "./Segmented";
import { Button } from "./ui";

export type AgentTab = "run" | "approval" | "history";

export type AgentCounts = {
  queued: number;
  active: number;
  waiting: number;
  awaiting: number;
  paused: boolean;
};

type Props = {
  tab: AgentTab;
  onTabChange: (tab: AgentTab) => void;
  counts: AgentCounts;
  actionBusy: string | null;
  onResumeQueue: () => void;
  onRefresh: () => void;
};

/** Tab switch, queue counters, pause/resume and manual refresh. */
export function AgentRunToolbar(props: Props) {
  const { tab, onTabChange, counts, actionBusy, onResumeQueue, onRefresh } = props;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <Segmented
        value={tab}
        onChange={onTabChange}
        options={[
          {
            value: "run",
            label: (
              <span className="inline-flex items-center gap-1.5">
                运行
                {counts.waiting > 0 ? (
                  <span className="inline-flex min-w-[2ch] justify-center rounded-full bg-rose-500 px-1.5 py-0.5 text-ui-2xs font-normal leading-none tabular-nums text-white">
                    {counts.waiting}
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            value: "approval",
            label: (
              <span className="inline-flex items-center gap-1.5">
                待审核
                {counts.awaiting > 0 ? (
                  <span className="inline-flex min-w-[2ch] justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-ui-2xs font-normal leading-none tabular-nums text-white">
                    {counts.awaiting}
                  </span>
                ) : null}
              </span>
            ),
          },
          { value: "history", label: "历史" },
        ]}
      />

      <span className="text-ui-sm text-slate-400">
        {counts.active} 运行 · {counts.queued} 排队 · {counts.waiting} 权限 ·{" "}
        {counts.awaiting} 待审核
        {counts.paused ? " · 队列已暂停" : ""}
      </span>

      {counts.paused ? (
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          loading={actionBusy === "queue:resume"}
          disabled={actionBusy !== null && actionBusy !== "queue:resume"}
          onClick={onResumeQueue}
        >
          继续队列
        </Button>
      ) : null}

      <button
        type="button"
        onClick={onRefresh}
        title="刷新任务状态"
        className={clsx(
          "grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700",
          !counts.paused && "ml-auto",
        )}
      >
        <RefreshCw size={13} />
      </button>
    </div>
  );
}
