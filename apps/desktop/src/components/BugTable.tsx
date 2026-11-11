import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpNarrowWide,
  ChevronDown,
  Loader2,
  Sparkles,
  UserPlus,
  X,
} from "lucide-react";
import clsx from "clsx";

import {
  type BugListPage,
  type BugSummary,
} from "../lib/api";
import { bugTitle, isMyBug } from "../lib/bug";
import { useCurrentAgent } from "../lib/useCurrentAgent";
import {
  agentBugKey,
  type AgentInFlight,
  type ExternalClaim,
} from "../lib/agent";
import { AgentActivityLine } from "./AgentActivityLine";
import { TableFilter } from "./TableFilter";
import { Badge, PRIORITY_TONES, SEVERITY_TONES, STATUS_TONES } from "./ui";
import {
  ACTION_WIDTH,
  COLUMN_LABELS,
  COLUMN_WIDTHS,
  PRIORITIES,
  SEVERITIES,
  TITLE_MIN_WIDTH,
  type BugSort,
  type ColumnKey,
  type ColumnPref,
  type SortKey,
} from "./bugListPrefs";

/**
 * TAPD's built-in status order. Only a fallback: live responses carry the
 * workspace's own workflow order in `statusOrder`.
 */
const DEFAULT_STATUS_ORDER = [
  "new",
  "in_progress",
  "resolved",
  "verified",
  "reopened",
  "rejected",
  "closed",
  "open",
  "progressing",
  "done",
];

type Props = {
  page: BugListPage;
  loading: boolean;
  me: string | null;
  columns: ColumnPref[];
  hideOwner: boolean;
  agentInFlight?: Map<string, AgentInFlight>;
  /** Fresh external AI claims keyed by workspace + bug. */
  externalClaims?: Map<string, ExternalClaim>;
  claimingId: string | null;
  sort: BugSort | null;
  statusFilter: string[];
  priority: string;
  severity: string;
  ownerFilter: string;
  creatorFilter: string;
  peopleOptions: Array<{ value: string; label: string }>;
  onToggleSort: (name: SortKey) => void;
  onStatusChange: (values: string[]) => void;
  onPriorityChange: (value: string) => void;
  onSeverityChange: (value: string) => void;
  onOwnerChange: (value: string) => void;
  onCreatorChange: (value: string) => void;
  onOpenBug: (bug: BugSummary) => void;
  onRowContextMenu: (
    event: ReactMouseEvent<HTMLTableRowElement>,
    bug: BugSummary,
  ) => void;
  onAgentFix?: (bug: BugSummary) => void;
  onAgentCompose?: (bug: BugSummary) => void;
  onOpenAgentTask?: (taskId: string) => void;
  onClaim: (bug: BugSummary) => void;
  /** Cancel a local task (queued = remove, running = interrupt). */
  onCancelTask?: (taskId: string) => Promise<void> | void;
  /** Close an external AI claim. */
  onReleaseExternal?: (claim: ExternalClaim) => Promise<void> | void;
};

/** The bug table, its filter/sort headers and the row context menu. */
export function BugTable(props: Props) {
  const {
    page,
    loading,
    me,
    columns,
    hideOwner,
    agentInFlight,
    claimingId,
    sort,
    statusFilter,
    priority,
    severity,
    ownerFilter,
    creatorFilter,
    peopleOptions,
    onToggleSort,
    onStatusChange,
    onPriorityChange,
    onSeverityChange,
    onOwnerChange,
    onCreatorChange,
    onOpenBug,
    onRowContextMenu,
    onAgentFix,
    onAgentCompose,
    onOpenAgentTask,
    onClaim,
    externalClaims,
    onCancelTask,
    onReleaseExternal,
  } = props;

  /** Row whose 取消 request is in flight (local task id or `external:<key>`). */
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  /** Runtime the row action will launch, from Settings → Agent 管理. */
  const currentAgent = useCurrentAgent();

  // One clock for the whole table: only rows with an active claim/task show
  // elapsed time, so ticking stops when nothing is running.
  const hasActivity = page.bugs.some((bug) => {
    const bugKey = agentBugKey(bug.workspaceId, bug.id);
    return Boolean(externalClaims?.get(bugKey) || agentInFlight?.get(bugKey));
  });
  const now = useClock(hasActivity);

  const cancelActivity = async (claim?: ExternalClaim, agent?: AgentInFlight) => {
    const id = claim
      ? `external:${agentBugKey(claim.workspaceId, claim.bugId)}`
      : agent?.task.id;
    if (!id || cancelingId) return;
    setCancelingId(id);
    try {
      if (claim) await onReleaseExternal?.(claim);
      else if (agent) await onCancelTask?.(agent.task.id);
    } finally {
      setCancelingId(null);
    }
  };

  const visibleColumns = columns.filter(
    (column) => column.visible && !(hideOwner && column.key === "owner"),
  );
  const tableMinWidth =
    TITLE_MIN_WIDTH +
    ACTION_WIDTH +
    visibleColumns.reduce((sum, column) => sum + COLUMN_WIDTHS[column.key], 0);

  const statusOptions = getStatusEntries(page).map(([value, label]) => ({ value, label }));
  const priorityOptions = PRIORITIES.map(([value, label]) => ({ value, label }));
  const severityOptions = SEVERITIES.map(([value, label]) => ({ value, label }));

  const renderColumnHeader = (key: ColumnKey) => {
    switch (key) {
      case "status":
        return (
          <TableFilter
            label="状态"
            className="px-3 py-2.5"
            options={statusOptions}
            selected={statusFilter}
            sort={{
              direction: sort?.name === "status" ? sort.order : null,
              onToggle: () => onToggleSort("status"),
            }}
            onChange={onStatusChange}
          />
        );
      case "priority":
        return (
          <TableFilter
            label="优先级"
            className="px-3 py-2.5"
            options={priorityOptions}
            selected={priority ? [priority] : []}
            multiple={false}
            onChange={(values) => onPriorityChange(values[0] ?? "")}
          />
        );
      case "severity":
        return (
          <TableFilter
            label="严重程度"
            className="px-3 py-2.5"
            options={severityOptions}
            selected={severity ? [severity] : []}
            multiple={false}
            onChange={(values) => onSeverityChange(values[0] ?? "")}
          />
        );
      case "owner":
        return (
          <TableFilter
            label="处理人"
            className="px-3 py-2.5"
            options={peopleOptions}
            selected={ownerFilter ? [ownerFilter] : []}
            multiple={false}
            onChange={(values) => onOwnerChange(values[0] ?? "")}
          />
        );
      case "creator":
        return (
          <TableFilter
            label="创建人"
            className="px-3 py-2.5"
            options={peopleOptions}
            selected={creatorFilter ? [creatorFilter] : []}
            multiple={false}
            onChange={(values) => onCreatorChange(values[0] ?? "")}
          />
        );
      case "created":
        return (
          <SortHeader
            label="创建时间"
            className="px-4 py-2.5"
            direction={sort?.name === "created" ? sort.order : null}
            onToggle={() => onToggleSort("created")}
          />
        );
      default:
        return (
          <span className="block px-3 py-2.5">{COLUMN_LABELS[key]}</span>
        );
    }
  };

  /** Header gets a faint tint once a filter/sort makes it "active". */
  const headerTone = (active: boolean) =>
    active ? "bg-sky-50" : "bg-slate-50";
  const headerActive = (key: ColumnKey) => {
    switch (key) {
      case "status":
        return statusFilter.length > 0 || sort?.name === "status";
      case "priority":
        return Boolean(priority);
      case "severity":
        return Boolean(severity);
      case "owner":
        return Boolean(ownerFilter);
      case "creator":
        return Boolean(creatorFilter);
      case "created":
        return sort?.name === "created";
      default:
        return false;
    }
  };

  return (
    <>
      <table
        className="w-full border-separate border-spacing-0 text-left"
        style={{ minWidth: tableMinWidth }}
      >
        <thead className="text-ui-sm text-slate-500">
          <tr>
            <th
              className="sticky top-0 z-20 bg-slate-50 px-4 py-2.5 text-left font-normal"
              style={{ minWidth: TITLE_MIN_WIDTH }}
            >
              标题
            </th>
            {visibleColumns.map((column) => (
              <th
                key={column.key}
                className={clsx(
                  "sticky top-0 z-20 p-0 text-left font-normal transition-colors",
                  headerTone(headerActive(column.key)),
                )}
                style={{ width: COLUMN_WIDTHS[column.key] }}
              >
                {renderColumnHeader(column.key)}
              </th>
            ))}
            <th
              className="sticky top-0 right-0 z-30 bg-slate-50 px-2 py-2.5 text-right font-normal"
              style={{ width: ACTION_WIDTH }}
            >
              操作
            </th>
          </tr>
        </thead>
        <tbody
          className={clsx(
            "[&>tr+tr>td]:border-t [&>tr+tr>td]:border-slate-100",
            loading && "opacity-60",
          )}
        >
          {page.bugs.map((bug) => {
            const key = agentBugKey(bug.workspaceId, bug.id);
            const claim = externalClaims?.get(key);
            // A fresh external claim always wins; a queued/running local task
            // is cancelled or refused when the claim is registered.
            const agent = claim ? undefined : agentInFlight?.get(key);
            const activityId = claim ? `external:${key}` : agent?.task.id ?? null;
            return (
            <tr
              key={bug.id}
              onClick={() => onOpenBug(bug)}
              onContextMenu={(event) => onRowContextMenu(event, bug)}
              className="group cursor-pointer bg-surface text-ui-base hover:bg-sky-50"
            >
              <td
                className="max-w-0 px-4 py-2.5"
                style={{ minWidth: TITLE_MIN_WIDTH }}
              >
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded bg-rose-50 px-1.5 py-0.5 text-ui-xs font-normal text-rose-600">
                    BUG
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-normal text-slate-800"
                    title={bugTitle(bug.title)}
                  >
                    {bugTitle(bug.title)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 overflow-hidden pl-9 text-ui-xs text-slate-400">
                  <span className="shrink-0 font-mono">#{bug.shortId || bug.id.slice(-7)}</span>
                  {bug.versionReport ? (
                    <span className="shrink-0">发现版本 {bug.versionReport}</span>
                  ) : null}
                  {bug.iterationName ? <span className="truncate">{bug.iterationName}</span> : null}
                </div>
                {claim || agent ? (
                  <AgentActivityLine
                    claim={claim}
                    task={agent}
                    now={now}
                    onOpenTask={
                      agent && onOpenAgentTask
                        ? () => onOpenAgentTask(agent.task.id)
                        : undefined
                    }
                  />
                ) : null}
              </td>
              {visibleColumns.map((column) => (
                <BugColumnCell key={column.key} column={column.key} bug={bug} />
              ))}
              <td
                className="sticky right-0 z-10 bg-surface px-2 py-2.5 group-hover:bg-sky-50"
                onClick={(event) => event.stopPropagation()}
              >
                {claim || agent ? (
                  // Active rows only keep 取消: the bug is already owned by an
                  // external AI or the local queue, so it must not be enqueued,
                  // edited or claimed twice. Row click still opens the detail.
                  <div className="flex items-center justify-end">
                    <button
                      type="button"
                      disabled={cancelingId === activityId}
                      title={
                        claim
                          ? `取消外部占用（${claim.client} 下次心跳会收到冲突）`
                          : agent?.task.status === "queued"
                            ? "从 Agent 队列中移除这个任务"
                            : "中断当前 Agent 任务"
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        void cancelActivity(claim, agent);
                      }}
                      className={clsx(
                        "inline-flex items-center justify-center gap-1 rounded-md border border-border bg-slate-50 px-2 py-1 text-ui-sm font-normal text-slate-600 transition",
                        cancelingId === activityId
                          ? "cursor-not-allowed opacity-60"
                          : "hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700",
                      )}
                    >
                      {cancelingId === activityId ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <X size={11} />
                      )}
                      取消
                    </button>
                  </div>
                ) : !isMyBug(bug.owner, me) ? (
                  <div className="flex items-center justify-center">
                    <button
                      type="button"
                      title="认领后可以评论、修改处理人/开发人员与流转状态"
                      disabled={claimingId !== null}
                      onClick={() => onClaim(bug)}
                      className={clsx(
                        "inline-flex items-center justify-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-3 py-1 text-ui-sm font-normal text-sky-700 transition",
                        claimingId === null
                          ? "hover:border-sky-300 hover:bg-sky-100"
                          : "cursor-not-allowed opacity-60",
                      )}
                    >
                      {claimingId === bug.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <UserPlus size={12} />
                      )}
                      {claimingId === bug.id ? "认领中" : "认领"}
                    </button>
                  </div>
                ) : (
                  <AgentRowAction
                    agentName={currentAgent?.name}
                    onFix={() => onAgentFix?.(bug)}
                    onCompose={
                      onAgentCompose ? () => onAgentCompose(bug) : undefined
                    }
                  />
                )}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/**
 * Compact split action: the label launches the default prompt, the caret opens
 * the compose sheet for extra instructions or resources.
 */
function AgentRowAction(props: {
  agentName?: string;
  onFix: () => void;
  onCompose?: () => void;
}) {
  const label = props.agentName ? `用 ${props.agentName} 修复` : "用 Agent 修复";
  return (
    <div className="flex items-center justify-end whitespace-nowrap">
      <div className="inline-flex shrink-0 overflow-hidden rounded-lg border border-border bg-surface">
        <button
          type="button"
          title={label}
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation();
            props.onFix();
          }}
          className="grid h-7 w-9 place-items-center text-slate-500 transition hover:bg-sky-50 hover:text-sky-700"
        >
          <Sparkles size={13} />
        </button>
        {props.onCompose ? (
          <button
            type="button"
            title="添加补充说明或资源后启动"
            aria-label="添加补充说明或资源后启动"
            onClick={(event) => {
              event.stopPropagation();
              props.onCompose?.();
            }}
            className="grid h-7 w-7 place-items-center border-l border-border text-slate-400 transition hover:bg-sky-50 hover:text-sky-700"
          >
            <ChevronDown size={13} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function BugColumnCell(props: { column: ColumnKey; bug: BugSummary }) {
  const { column, bug } = props;
  switch (column) {
    case "status":
      return (
        <td className="whitespace-nowrap px-3 py-2.5">
          <Badge tone={STATUS_TONES[bug.status] ?? "neutral"}>
            {bug.statusLabel || bug.status}
          </Badge>
        </td>
      );
    case "priority":
      return (
        <td className="whitespace-nowrap px-3 py-2.5">
          <Badge tone={PRIORITY_TONES[bug.priority] ?? "neutral"}>
            {bug.priorityLabel || bug.priority || "—"}
          </Badge>
        </td>
      );
    case "severity":
      return (
        <td className="whitespace-nowrap px-3 py-2.5">
          <Badge tone={SEVERITY_TONES[bug.severity] ?? "neutral"} dot>
            {bug.severityLabel || bug.severity || "—"}
          </Badge>
        </td>
      );
    case "owner":
      return (
        <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">
          <span className="truncate">{bug.owner || "—"}</span>
        </td>
      );
    case "creator":
      return (
        <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">
          <span className="line-clamp-1">{bug.creator || "—"}</span>
        </td>
      );
    case "created":
      return (
        <td className="whitespace-nowrap px-4 py-2.5 font-mono text-ui-sm text-slate-400">
          {formatTs(bug.created)}
        </td>
      );
  }
  return null;
}

function getStatusEntries(page: BugListPage | null): Array<[string, string]> {
  const map = page?.statusMap ?? {};
  // The workflow order comes from TAPD, so custom statuses (未开始/进行中/
  // 已完成 …) and project-specific labels keep the same order as the workflow
  // settings page. Older cached pages have no order yet; use TAPD's default.
  const configured = page?.statusOrder?.length
    ? page.statusOrder
    : DEFAULT_STATUS_ORDER.filter((key) => map[key]);

  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const key of configured) {
    if (key === "start" || key === "end" || seen.has(key)) continue;
    seen.add(key);
    entries.push([key, map[key] || key]);
  }
  if (entries.length > 0) return entries;

  return [
    ["new", "新"],
    ["in_progress", "接受/处理"],
    ["resolved", "已解决"],
    ["verified", "已验证"],
    ["reopened", "重新打开"],
  ];
}

/** Sort-only header (no filter menu), e.g. 创建时间. */
function SortHeader(props: {
  label: string;
  className?: string;
  direction: "asc" | "desc" | null;
  onToggle: () => void;
}) {
  return (
    <div className={clsx("group/head flex w-full items-center", props.className)}>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <button
        type="button"
        title={
          props.direction === "asc"
            ? `改为${props.label}降序`
            : props.direction === "desc"
              ? `取消${props.label}排序`
              : `按${props.label}升序`
        }
        aria-label={`按${props.label}排序`}
        onClick={props.onToggle}
        className={clsx(
          "grid h-5 w-4 shrink-0 place-items-center rounded transition focus-visible:opacity-100",
          props.direction
            ? "text-sky-600"
            : "text-slate-400 opacity-0 group-hover/head:opacity-100",
        )}
      >
        {props.direction === "asc" ? (
          <ArrowUpNarrowWide size={12} />
        ) : props.direction === "desc" ? (
          <ArrowDownWideNarrow size={12} />
        ) : (
          <ArrowUpDown size={12} />
        )}
      </button>
    </div>
  );
}

function formatTs(value: string): string {
  if (!value) return "—";
  return value.length >= 16 ? value.slice(0, 16) : value;
}

/** 1s ticker shared by the activity lines; idle tables do not re-render. */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
