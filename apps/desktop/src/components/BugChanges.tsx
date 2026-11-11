import { useEffect, useState } from "react";
import { ArrowRight, CalendarClock, ChevronDown, ChevronRight } from "lucide-react";

import type { BugDetail, ChangeEntry, ChangeField } from "../lib/api";
import { BugSectionTitle } from "./BugSectionTitle";

/** Collapsible TAPD change history; collapsed again on every drawer open. */
export function BugChanges(props: { detail: BugDetail; open: boolean }) {
  const { detail, open } = props;
  const [expanded, setExpanded] = useState(true);
  const changes = detail.changes;
  const changeCount = changes.total || changes.changes.length;

  // Reset the collapsible section each time the drawer is opened.
  useEffect(() => {
    if (!open) return;
    setExpanded(true);
  }, [open]);

  return (
    <section>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 text-left"
      >
        <BugSectionTitle
          icon={
            expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          }
          title={`变更记录（${changeCount}）`}
        />
      </button>
      {expanded ? (
        <div className="mt-2 space-y-2">
          {changes.error ? (
            <div className="break-all rounded-xl border border-amber-200 bg-amber-50 p-3 text-ui-sm leading-5 text-amber-700">
              变更记录获取失败：{changes.error}
            </div>
          ) : changes.changes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-3 text-ui-caption text-slate-400">
              暂无变更记录
            </div>
          ) : (
            <>
              {changes.changes.map((entry) => (
                <ChangeItem key={entry.seq} entry={entry} />
              ))}
              {changeCount > changes.changes.length ? (
                <p className="px-1 text-ui-xs text-slate-400">
                  仅显示最近 {changes.changes.length} 条，共 {changeCount} 条。
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ChangeItem({ entry }: { entry: ChangeEntry }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2 text-ui-sm text-slate-400">
        <span className="font-mono text-slate-500">#{entry.seq}</span>
        <span className="font-normal text-slate-600">{entry.author || "未知"}</span>
        <span className="inline-flex items-center gap-1">
          <CalendarClock size={10} />
          {entry.time}
        </span>
        {entry.kind ? (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-ui-xs text-slate-500">
            {entry.kind}
          </span>
        ) : null}
      </div>
      {entry.fields.length === 0 ? (
        <p className="mt-2 text-ui-sm text-slate-400">（无字段明细）</p>
      ) : (
        <dl className="mt-2 space-y-1">
          {entry.fields.map((field, index) => (
            <ChangeFieldLine key={`${field.field}-${index}`} field={field} />
          ))}
        </dl>
      )}
    </div>
  );
}

function ChangeFieldLine({ field }: { field: ChangeField }) {
  return (
    <div className="grid grid-cols-[minmax(56px,auto)_1fr_auto_1fr] items-baseline gap-2 text-ui-sm leading-5">
      <dt className="truncate text-slate-400" title={field.field}>
        {field.field}
      </dt>
      <dd
        className="break-words text-slate-400 line-through decoration-slate-300"
        title={field.before}
      >
        {field.before || "—"}
      </dd>
      <ArrowRight size={10} className="shrink-0 text-slate-300" />
      <dd className="break-words text-slate-700" title={field.after}>
        {field.after || "—"}
      </dd>
    </div>
  );
}
