import { type MouseEvent as ReactMouseEvent } from "react";
import {
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpNarrowWide,
  Loader2,
  UserPlus,
} from "lucide-react";
import clsx from "clsx";

import {
  type BugListPage,
  type BugSummary,
} from "../lib/api";
import { bugRef, isMyBug } from "../lib/bug";
import { plainTitle } from "../lib/title";
import { t } from "../lib/i18n";
import { EnqueueControl } from "../agent/EnqueuePopover";
import { ScrollingName } from "./ScrollingName";
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
  /** Bug currently shown in the detail pane; its row stays highlighted. */
  activeBugId?: string | null;
  columns: ColumnPref[];
  hideOwner: boolean;
  claimingId: string | null;
  sort: BugSort | null;
  statusFilter: string[];
  priority: string;
  severity: string;
  ownerFilter: string[];
  creatorFilter: string;
  peopleOptions: Array<{ value: string; label: string }>;
  onToggleSort: (name: SortKey) => void;
  onStatusChange: (values: string[]) => void;
  onPriorityChange: (value: string) => void;
  onSeverityChange: (value: string) => void;
  onOwnerChange: (values: string[]) => void;
  onCreatorChange: (value: string) => void;
  onOpenBug: (bug: BugSummary) => void;
  onRowContextMenu: (
    event: ReactMouseEvent<HTMLTableRowElement>,
    bug: BugSummary,
  ) => void;
  onClaim: (bug: BugSummary) => void;
};

/** The bug table, its filter/sort headers and the row context menu. */
export function BugTable(props: Props) {
  const {
    page,
    loading,
    me,
    activeBugId,
    columns,
    hideOwner,
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
    onClaim,
  } = props;
  const visibleColumns = columns.filter(
    (column) => column.visible && !(hideOwner && column.key === "owner"),
  );
  const tableMinWidth =
    TITLE_MIN_WIDTH +
    ACTION_WIDTH +
    visibleColumns.reduce((sum, column) => sum + COLUMN_WIDTHS[column.key], 0);

  const statusOptions = getStatusEntries(page).map(([value, label]) => ({ value, label }));
  const priorityOptions = PRIORITIES.map(([value, label]) => ({
    value,
    label: t(label),
  }));
  const severityOptions = SEVERITIES.map(([value, label]) => ({
    value,
    label: t(label),
  }));

  const renderColumnHeader = (key: ColumnKey) => {
    switch (key) {
      case "status":
        return (
          <TableFilter
            label={t("common.status")}
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
            label={t("common.priority")}
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
            label={t("common.severity")}
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
            label={t("common.owner")}
            className="px-3 py-2.5"
            options={peopleOptions}
            selected={ownerFilter}
            onChange={onOwnerChange}
          />
        );
      case "creator":
        return (
          <TableFilter
            label={t("common.creator")}
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
            label={t("common.created")}
            className="px-4 py-2.5"
            direction={sort?.name === "created" ? sort.order : null}
            onToggle={() => onToggleSort("created")}
          />
        );
      default:
        return (
          <span className="block px-3 py-2.5">{t(COLUMN_LABELS[key])}</span>
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
        return ownerFilter.length > 0;
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
              {t("common.title")}
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
              {t("common.actions")}
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
            const active = activeBugId === bug.id;
            return (
            <tr
              key={bug.id}
              onClick={() => onOpenBug(bug)}
              onContextMenu={(event) => onRowContextMenu(event, bug)}
              aria-current={active ? "true" : undefined}
              className={clsx(
                "group cursor-pointer text-ui-base transition-colors",
                active ? "bg-sky-50 hover:bg-sky-100" : "bg-surface hover:bg-sky-50",
              )}
            >
              <td
                className="max-w-0 px-4 py-2.5"
                style={{ minWidth: TITLE_MIN_WIDTH }}
              >
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded bg-rose-50 px-1.5 py-0.5 text-ui-xs font-normal text-rose-600">
                    BUG
                  </span>
                  <ScrollingName
                    text={plainTitle(bug.title)}
                    className="min-w-0 flex-1 font-normal text-slate-800"
                  />
                </div>
                <div className="mt-0.5 flex items-center gap-2 overflow-hidden pl-9 text-ui-xs text-slate-400">
                  <span
                    className={clsx(
                      "shrink-0 font-mono transition-colors",
                      active && "text-sky-600",
                    )}
                  >#{bugRef(bug)}</span>
                  {bug.versionReport ? (
                    <span className="shrink-0">
                      {t("bugs.foundVersion", { version: bug.versionReport })}
                    </span>
                  ) : null}
                  {bug.iterationName ? <span className="truncate">{bug.iterationName}</span> : null}
                </div>
              </td>
              {visibleColumns.map((column) => (
                <BugColumnCell key={column.key} column={column.key} bug={bug} />
              ))}
              <td
                className={clsx(
                  "sticky right-0 z-10 px-2 py-2.5 transition-colors",
                  active
                    ? "bg-sky-50 group-hover:bg-sky-100"
                    : "bg-surface group-hover:bg-sky-50",
                )}
                onClick={(event) => event.stopPropagation()}
              >
                {!isMyBug(bug.owner, me) ? (
                  <div className="flex items-center justify-center">
                    <button
                      type="button"
                      title={t("bugs.claimHint")}
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
                      {claimingId === bug.id ? t("bugs.claiming") : t("bugs.claim")}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-center">
                    <EnqueueControl
                      target={{
                        kind: "bug",
                        workspaceId: bug.workspaceId,
                        bugId: bug.id,
                        title: bug.title,
                      }}
                    />
                  </div>
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
function BugColumnCell(props: { column: ColumnKey; bug: BugSummary }) {
  const { column, bug } = props;
  switch (column) {
    case "status":
      return (
        <td data-component="BugColumnCell" className="whitespace-nowrap px-3 py-2.5">
          <Badge tone={STATUS_TONES[bug.status] ?? "neutral"}>
            {bug.statusLabel || bug.status}
          </Badge>
        </td>
      );
    case "priority":
      return (
        <td data-component="BugColumnCell" className="whitespace-nowrap px-3 py-2.5">
          <Badge tone={PRIORITY_TONES[bug.priority] ?? "neutral"}>
            {bug.priorityLabel || bug.priority || "—"}
          </Badge>
        </td>
      );
    case "severity":
      return (
        <td data-component="BugColumnCell" className="whitespace-nowrap px-3 py-2.5">
          <Badge tone={SEVERITY_TONES[bug.severity] ?? "neutral"} dot>
            {bug.severityLabel || bug.severity || "—"}
          </Badge>
        </td>
      );
    case "owner":
      return (
        <td data-component="BugColumnCell" className="whitespace-nowrap px-3 py-2.5 text-slate-600">
          <span className="truncate">{bug.owner || "—"}</span>
        </td>
      );
    case "creator":
      return (
        <td data-component="BugColumnCell" className="whitespace-nowrap px-3 py-2.5 text-slate-500">
          <span className="line-clamp-1">{bug.creator || "—"}</span>
        </td>
      );
    case "created":
      return (
        <td data-component="BugColumnCell" className="whitespace-nowrap px-4 py-2.5 font-mono text-ui-sm text-slate-400">
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
    ["new", t("bugs.status.new")],
    ["in_progress", t("bugs.status.inProgress")],
    ["resolved", t("bugs.status.resolved")],
    ["verified", t("bugs.status.verified")],
    ["reopened", t("bugs.status.reopened")],
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
    <div data-component="SortHeader" className={clsx("group/head flex w-full items-center", props.className)}>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <button
        type="button"
        title={
          props.direction === "asc"
            ? t("bugs.sortDescending", { label: props.label })
            : props.direction === "desc"
              ? t("bugs.sortClear", { label: props.label })
              : t("bugs.sortAscending", { label: props.label })
        }
        aria-label={t("bugs.sortBy", { label: props.label })}
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
