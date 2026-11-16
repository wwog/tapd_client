import { PanelLeftClose, PanelLeftOpen, RefreshCw } from "lucide-react";
import clsx from "clsx";

import { t, type MessageKey } from "../lib/i18n";
import { Segmented } from "./Segmented";
import { Button } from "./ui";

export type AgentTab = "run" | "approval" | "history" | "config";

/** Left list column names, used by the collapse toggle. */
const LIST_LABELS: Record<
  Exclude<AgentTab, "config">,
  { list: MessageKey; detail: MessageKey }
> = {
  run: { list: "agent.queue.title", detail: "agent.view.terminal" },
  approval: { list: "agent.approval.list", detail: "agent.approval.detail" },
  history: { list: "agent.history.list", detail: "agent.history.detail" },
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
  const listName = listLabels ? t(listLabels.list) : "";
  const detailName = listLabels ? t(listLabels.detail) : "";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {listLabels ? (
        <button
          type="button"
          aria-label={
            listCollapsed
              ? t("agent.toolbar.expand", { name: listName })
              : t("agent.toolbar.collapse", { name: listName })
          }
          title={
            listCollapsed
              ? t("agent.toolbar.expandAuto", { name: listName })
              : t("agent.toolbar.collapseDetail", {
                  name: listName,
                  detail: detailName,
                })
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
            label: t("agent.tab.run"),
          },
          {
            value: "approval",
            label: (
              <span className="inline-flex items-center gap-1.5">
                {t("agent.tab.pending")}
                {counts.awaiting > 0 ? (
                  <span className="inline-flex min-w-[2ch] justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-ui-2xs font-normal leading-none tabular-nums text-white">
                    {counts.awaiting}
                  </span>
                ) : null}
              </span>
            ),
          },
          { value: "history", label: t("agent.tab.history") },
          { value: "config", label: t("agent.tab.config") },
        ]}
      />

      <span className="text-ui-sm text-slate-400">
        {counts.paused
          ? t("agent.counts.runningPaused", {
              active: counts.active,
              queued: counts.queued,
              awaiting: counts.awaiting,
            })
          : t("agent.counts.running", {
              active: counts.active,
              queued: counts.queued,
              awaiting: counts.awaiting,
            })}
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
          {t("agent.queue.resume")}
        </Button>
      ) : null}

      <button
        type="button"
        onClick={onRefresh}
        title={t("agent.queue.refresh")}
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
