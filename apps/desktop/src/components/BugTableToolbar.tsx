import {
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import {
  Check,
  Columns3,
  GripVertical,
  Search,
  Users,
  UserRound,
} from "lucide-react";
import clsx from "clsx";

import { useDismiss } from "../hooks/useDismiss";
import { Segmented } from "./Segmented";
import {
  COLUMN_LABELS,
  DEFAULT_COLUMNS,
  type ColumnKey,
  type ColumnPref,
} from "./bugListPrefs";

type Scope = "mine" | "all";

type Props = {
  scope: Scope;
  me: string | null;
  onScopeChange: (scope: Scope) => void;
  keyword: string;
  onKeywordChange: (value: string) => void;
  activeFilterCount: number;
  onClearFilters: () => void;
  columns: ColumnPref[];
  onColumnsChange: Dispatch<SetStateAction<ColumnPref[]>>;
  hideOwner: boolean;
};

/** Search, scope switch, column picker and refresh for the bug table. */
export function BugTableToolbar(props: Props) {
  const {
    scope,
    me,
    onScopeChange,
    keyword,
    onKeywordChange,
    activeFilterCount,
    onClearFilters,
    columns,
    onColumnsChange,
    hideOwner,
  } = props;

  const [columnsOpen, setColumnsOpen] = useState(false);
  const [draggingColumn, setDraggingColumn] = useState<ColumnKey | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<ColumnKey | null>(null);
  const columnsRef = useRef<HTMLDivElement | null>(null);

  // Dismiss the column popover on outside click or Escape.
  useDismiss(columnsOpen, columnsRef, () => setColumnsOpen(false));

  const toggleColumn = (key: ColumnKey) => {
    onColumnsChange((current) =>
      current.map((column) =>
        column.key === key ? { ...column, visible: !column.visible } : column,
      ),
    );
  };

  const moveColumnTo = (from: ColumnKey, to: ColumnKey) => {
    if (from === to) return;
    onColumnsChange((current) => {
      const next = [...current];
      const fromIndex = next.findIndex((column) => column.key === from);
      const toIndex = next.findIndex((column) => column.key === to);
      if (fromIndex < 0 || toIndex < 0) return current;
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  /** Pointer-based reorder, reliable inside the desktop webview. */
  const startColumnDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    key: ColumnKey,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setDraggingColumn(key);
    setDragOverColumn(null);
    let target: ColumnKey | null = null;

    const onMove = (moveEvent: PointerEvent) => {
      const element = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>("[data-column-key]");
      const next = element?.dataset.columnKey as ColumnKey | undefined;
      if (next && next !== key) {
        target = next;
        setDragOverColumn(next);
      } else {
        target = null;
        setDragOverColumn(null);
      }
    };

    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (target) moveColumnTo(key, target);
      setDraggingColumn(null);
      setDragOverColumn(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const resetColumns = () => {
    onColumnsChange(DEFAULT_COLUMNS.map((column) => ({ ...column })));
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-3">

      <Segmented
        value={scope}
        onChange={onScopeChange}
        options={[
          { value: "mine", label: "我负责的", icon: <UserRound size={12} /> },
          { value: "all", label: "全部", icon: <Users size={12} /> },
        ]}
      />

      {scope === "mine" && !me ? (
        <span className="text-ui-sm text-amber-600">未能识别当前用户，暂按全部查询</span>
      ) : null}

      <div className="relative ml-auto w-64">
        <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
        <input
          value={keyword}
          onChange={(event) => onKeywordChange(event.target.value)}
          placeholder="搜索标题"
          className="w-full rounded-lg border border-border bg-slate-50 py-2 pl-9 pr-3 text-ui-caption text-slate-800 transition focus:border-sky-400 focus:bg-surface focus:outline-2 focus:outline-sky-200"
        />
      </div>

      {activeFilterCount > 0 ? (
        <button
          type="button"
          onClick={onClearFilters}
          className="text-ui-sm text-slate-400 transition hover:text-slate-700"
        >
          清除筛选
        </button>
      ) : null}

      <div ref={columnsRef} className="relative">
        <button
          type="button"
          title="显示列与排序"
          aria-label="显示列与排序"
          aria-expanded={columnsOpen}
          onClick={() => setColumnsOpen((current) => !current)}
          className={clsx(
            "grid h-8 w-8 place-items-center rounded-lg border transition",
            columnsOpen
              ? "border-sky-300 bg-sky-50 text-sky-700"
              : "border-border bg-surface text-slate-500 hover:border-slate-300 hover:text-slate-800",
          )}
        >
          <Columns3 size={14} />
        </button>

        {columnsOpen ? (
          <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-surface p-1.5">
            <div className="flex items-center justify-between px-1.5 pb-1 pt-0.5">
              <span className="text-ui-xs text-slate-400">显示列 · 拖动排序</span>
              <button
                type="button"
                onClick={resetColumns}
                className="text-ui-xs text-slate-400 transition hover:text-slate-700"
              >
                恢复默认
              </button>
            </div>
            <div className="space-y-0.5">
              {columns
                .filter((column) => !(hideOwner && column.key === "owner"))
                .map((column) => {
                  const dragging = draggingColumn === column.key;
                  return (
                    <div
                      key={column.key}
                      data-column-key={column.key}
                      className={clsx(
                        "flex select-none items-center gap-2 rounded-md px-1.5 py-1.5 text-ui-caption transition",
                        dragging && "opacity-40",
                        dragOverColumn === column.key && !dragging && "bg-sky-50",
                      )}
                    >
                      <button
                        type="button"
                        title="拖动排序"
                        aria-label={`拖动排序${COLUMN_LABELS[column.key]}`}
                        onPointerDown={(event) =>
                          startColumnDrag(event, column.key)
                        }
                        className="grid h-5 w-4 shrink-0 cursor-grab place-items-center text-slate-300 active:cursor-grabbing"
                      >
                        <GripVertical size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleColumn(column.key)}
                        aria-label={`${column.visible ? "隐藏" : "显示"}${COLUMN_LABELS[column.key]}`}
                        className={clsx(
                          "grid h-4 w-4 shrink-0 place-items-center rounded border transition",
                          column.visible
                            ? "border-sky-500 bg-sky-500 text-white"
                            : "border-slate-300 bg-surface text-transparent",
                        )}
                      >
                        <Check size={11} />
                      </button>
                      <span className="min-w-0 flex-1 truncate text-slate-600">
                        {COLUMN_LABELS[column.key]}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
