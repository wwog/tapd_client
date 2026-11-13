import { useEffect, useMemo, useRef } from "react";
import clsx from "clsx";
import { Activity, Loader2, X } from "lucide-react";

import type { AgentChat, AgentRuntimeStatus } from "../lib/agent";
import { projectTimeline, statusTimelineRow, type TimelineRow } from "../lib/agentChat";

type Props = {
  chat: AgentChat | null;
  error: string | null;
  status?: AgentRuntimeStatus;
  live: boolean;
};

/** 左栏队列下方的紧凑执行流程：与右侧 Chat 共用同一份 transcript。 */
export function AgentTimeline({ chat, error, status, live }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);

  // transcript 对象在未变化时由 hook 复用，投影结果可以放心缓存。
  const rows = useMemo(() => projectTimeline(chat?.messages ?? []), [chat]);
  const current = statusTimelineRow(status);
  const all = current ? [...rows, current] : rows;

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !nearBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [all.length]);

  return (
    <section className="flex min-h-0 shrink-0 flex-col border-t border-slate-100">
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-1.5">
        <Activity size={12} className="text-slate-400" />
        <span className="text-ui-xs text-slate-500">执行流程</span>
        {chat?.truncated ? (
          <span className="ml-auto text-ui-2xs text-amber-600">已截断</span>
        ) : null}
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          nearBottomRef.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
        className="max-h-56 min-h-[96px] overflow-y-auto px-1.5 pb-1.5"
      >
        {all.length === 0 ? (
          <div className="grid h-24 place-items-center px-3 text-center text-ui-xs text-slate-400">
            {error ?? (live ? "等待 Agent 输出…" : "暂无执行记录")}
          </div>
        ) : (
          <div className="space-y-0.5">
            {all.map((row) => (
              <TimelineLine key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TimelineLine({ row }: { row: TimelineRow }) {
  return (
    <div
      className="flex items-start gap-1.5 rounded px-1.5 py-1 text-ui-2xs leading-4 [content-visibility:auto]"
      title={row.detail || undefined}
    >
      <span className="mt-0.5 shrink-0 tabular-nums text-slate-400">
        {clock(row.at)}
      </span>
      <TimelineStatus tone={row.tone} status={row.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="shrink-0 text-slate-600">{row.label}</span>
          {typeof row.durationMs === "number" ? (
            <span className="ml-auto shrink-0 text-slate-400">
              {row.durationMs < 1000
                ? `${Math.round(row.durationMs)}ms`
                : `${(row.durationMs / 1000).toFixed(row.durationMs < 10_000 ? 1 : 0)}s`}
            </span>
          ) : null}
        </div>
        {row.detail ? (
          <div className="truncate font-mono text-slate-400">{row.detail}</div>
        ) : null}
      </div>
    </div>
  );
}

function TimelineStatus({
  tone,
  status,
}: {
  tone: TimelineRow["tone"];
  status?: string;
}) {
  if (status === "running") {
    return <Loader2 size={9} className="mt-1 shrink-0 animate-spin text-sky-500" />;
  }
  if (status === "waiting") {
    return <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />;
  }
  if (status === "failed") {
    return <X size={9} className="mt-1 shrink-0 text-rose-500" />;
  }
  return (
    <span
      className={clsx(
        "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
        tone === "user"
          ? "bg-sky-400"
          : tone === "assistant"
            ? "bg-emerald-400"
            : tone === "thinking"
              ? "bg-slate-300"
              : "bg-sky-300",
      )}
    />
  );
}

/** 时间戳 → `HH:mm:ss`；无时间时留空，避免展示 Invalid Date。 */
function clock(at: string): string {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
