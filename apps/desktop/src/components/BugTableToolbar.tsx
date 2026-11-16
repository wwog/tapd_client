import {
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import {
  Activity,
  Check,
  Columns3,
  GripVertical,
  Search,
  Users,
  UserRound,
} from "lucide-react";
import clsx from "clsx";

import { useDismiss } from "../hooks/useDismiss";
import { t } from "../lib/i18n";
import { Segmented, type SegmentedOption } from "./Segmented";
import {
  COLUMN_LABELS,
  DEFAULT_COLUMNS,
  type BugScope,
  type ColumnKey,
  type ColumnPref,
} from "./bugListPrefs";

/** Search field width; the row reserves this much before showing it. */
const SEARCH_WIDTH = 256;
/** Column picker trigger (`h-8 w-8`). */
const COLUMNS_BUTTON_WIDTH = 32;
/** Slack so sub-pixel rounding cannot push the search onto a second row. */
const ROW_SLACK = 4;

type Props = {
  scope: BugScope;
  me: string | null;
  onScopeChange: (scope: BugScope) => void;
  /** Show the 处理中 scope; only set while an agent works on the project. */
  showProcessing: boolean;
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
    showProcessing,
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
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const leadingRef = useRef<HTMLDivElement | null>(null);
  /**
   * Dropped rather than wrapped: on a narrow pane the scope switch and the
   * column button own the row, and the search field reappears as soon as the
   * row can hold it again.
   */
  const [showSearch, setShowSearch] = useState(true);

  // Measure against the real content, not a breakpoint: the scope switch grows
  // with a third segment and the UI font size is user-configurable.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const leading = leadingRef.current;
    if (!toolbar || !leading) return;

    const measure = () => {
      const style = getComputedStyle(toolbar);
      const gap = parseFloat(style.columnGap) || 0;
      const padding =
        (parseFloat(style.paddingLeft) || 0) +
        (parseFloat(style.paddingRight) || 0);
      const needed =
        padding +
        leading.offsetWidth +
        gap * 2 +
        SEARCH_WIDTH +
        COLUMNS_BUTTON_WIDTH +
        ROW_SLACK;
      setShowSearch(toolbar.clientWidth >= needed);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    observer.observe(leading);
    return () => observer.disconnect();
  }, []);

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

  // 处理中 is a live view over agent activity, so the segment only exists while
  // the local agent queue is working on this project.
  const scopeOptions: SegmentedOption<BugScope>[] = [
    { value: "mine", label: t("bugs.scopeMine"), icon: <UserRound size={12} /> },
    { value: "all", label: t("common.all"), icon: <Users size={12} /> },
  ];
  if (showProcessing) {
    scopeOptions.push({
      value: "processing",
      label: t("bugs.scopeProcessing"),
      icon: <Activity size={12} />,
    });
  }

  return (
    <div
      ref={toolbarRef}
      className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-3"
    >
      <div ref={leadingRef} className="flex items-center gap-2">
        <Segmented
          value={scope}
          onChange={onScopeChange}
          options={scopeOptions}
        />

        {scope === "mine" && !me ? (
          <span className="text-ui-sm text-amber-600">
            {t("bugs.noCurrentUser")}
          </span>
        ) : null}

        {activeFilterCount > 0 ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="text-ui-sm text-slate-400 transition hover:text-slate-700"
          >
            {t("bugs.clearFilters")}
          </button>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {showSearch ? (
          <div className="relative w-64">
            <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              value={keyword}
              onChange={(event) => onKeywordChange(event.target.value)}
              placeholder={t("bugs.searchPlaceholder")}
              title={t("bugs.searchHint")}
              className="w-full rounded-lg border border-border bg-slate-50 py-2 pl-9 pr-3 text-ui-caption text-slate-800 transition focus:border-sky-400 focus:bg-surface focus:outline-2 focus:outline-sky-200"
            />
          </div>
        ) : null}

        <div ref={columnsRef} className="relative">
          <button
            type="button"
            title={t("bugs.columnsAndSort")}
            aria-label={t("bugs.columnsAndSort")}
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
                <span className="text-ui-xs text-slate-400">
                  {t("bugs.columnsTitle")}
                </span>
                <button
                  type="button"
                  onClick={resetColumns}
                  className="text-ui-xs text-slate-400 transition hover:text-slate-700"
                >
                  {t("common.restoreDefaults")}
                </button>
              </div>
              <div className="space-y-0.5">
                {columns
                  .filter((column) => !(hideOwner && column.key === "owner"))
                  .map((column) => {
                    const dragging = draggingColumn === column.key;
                    const columnLabel = t(COLUMN_LABELS[column.key]);
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
                          title={t("bugs.dragToReorder")}
                          aria-label={t("bugs.reorderColumn", {
                            label: columnLabel,
                          })}
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
                          aria-label={
                            column.visible
                              ? t("bugs.hideColumn", { label: columnLabel })
                              : t("bugs.showColumn", { label: columnLabel })
                          }
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
                          {columnLabel}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
