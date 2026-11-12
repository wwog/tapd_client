import { PanelLeftClose, PanelLeftOpen, RefreshCw } from "lucide-react";
import clsx from "clsx";

import { Segmented } from "./Segmented";
import { Button } from "./ui";

export type AgentTab = "run" | "approval" | "history" | "config";

/** Left list column names, used by the collapse toggle. */
const LIST_LABELS: Record<Exclude<AgentTab, "config">, { list: string; detail: string }> = {
  run: { list: "执行队列", detail: "终端" },
  approval: { list: "待审核列表", detail: "审核详情" },
  history: { list: "执行记录列表", detail: "记录详情" },
};

export type AgentCounts = {
  queued: number;
  active: number;
  awaiting: number;
  paused: boolean;
};

type Props = {
  tab: AgentTab;
  onTabChange: (tab: AgentTab) => void;
  counts: AgentCounts;
  actionBusy: string | null;
  /** Current tab's left list column is currently out of layout. */
  listCollapsed: boolean;
  onToggleList: () => void;
  onResumeQueue: () => void;
  onRefresh: () => void;
};

/** Tab switch, queue counters, pause/resume and manual refresh. */
export function AgentRunToolbar(props: Props) {
  const {
    tab,
    onTabChange,
    counts,
    actionBusy,
    listCollapsed,
    onToggleList,
    onResumeQueue,
    onRefresh,
  } = props;
  const listLabels = tab === "config" ? null : LIST_LABELS[tab];

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {listLabels ? (
        <button
          type="button"
          aria-label={`${listCollapsed ? "展开" : "收起"}${listLabels.list}`}
          title={
            listCollapsed
              ? `展开${listLabels.list}（空间不足时会自动收起）`
              : `收起${listLabels.list}，把宽度留给${listLabels.detail}`
          }
          onClick={onToggleList}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
        >
          {listCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
      ) : null}

      <Segmented
        value={tab}
        onChange={onTabChange}
        options={[
          {
            value: "run",
            label: "运行",
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
          { value: "config", label: "配置" },
        ]}
      />

      <span className="text-ui-sm text-slate-400">
        {counts.active} 运行 · {counts.queued} 排队 · {counts.awaiting} 待审核
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
