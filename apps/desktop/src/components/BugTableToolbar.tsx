import {
  useLayoutEffect,
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
/**
 * How long the row may stay too narrow before the search is dropped. A dock
 * expanding next to the table (or the window growing for it) narrows the row
 * for a few frames; toggle on that dip and the field blinks out and back.
 */
const HIDE_DELAY_MS = 300;

type Props = {
  scope: BugScope;
  me: string | null;
  onScopeChange: (scope: BugScope) => void;
  keyword: string;
  onKeywordChange: (value: string) => void;
  activeFilterCount: number;
  /** The empty state owns the clear-filters action; the header only adds it above results. */
  hasResults: boolean;
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
    hasResults,
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
  /** Latest measurement, re-checked when a pending hide fires. */
  const searchFitsRef = useRef(true);
  const hideTimerRef = useRef<number | null>(null);
  /** The first real measurement is a settled layout, not an animation frame. */
  const measuredRef = useRef(false);

  // Measure against the real content, not a breakpoint: the scope switch grows
  // with a third segment and the UI font size is user-configurable. The row
  // never wraps (a dock opening beside it would otherwise fold the field onto a
  // second line for a frame); it only drops the search once the width has
  // stayed too narrow, so a transient dip does not blink it.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const leading = leadingRef.current;
    if (!toolbar || !leading) return;

    const clearHideTimer = () => {
      if (hideTimerRef.current === null) return;
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    };

    const measure = () => {
      const width = toolbar.clientWidth;
      // Zero means the window/layout has not been measured yet.
      if (width <= 0) return;
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
      const fits = width >= needed;
      searchFitsRef.current = fits;

      if (fits) {
        clearHideTimer();
        setShowSearch(true);
      } else if (!measuredRef.current) {
        // Startup with a restricted pane: decide at once, nothing is animating.
        setShowSearch(false);
      } else if (hideTimerRef.current === null) {
        hideTimerRef.current = window.setTimeout(() => {
          hideTimerRef.current = null;
          if (!searchFitsRef.current) setShowSearch(false);
        }, HIDE_DELAY_MS);
      }
      measuredRef.current = true;
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    observer.observe(leading);
    return () => {
      observer.disconnect();
      clearHideTimer();
    };
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

  const scopeOptions: SegmentedOption<BugScope>[] = [
    { value: "mine", label: t("bugs.scopeMine"), icon: <UserRound size={12} /> },
    { value: "all", label: t("common.all"), icon: <Users size={12} /> },
  ];

  return (
    <div
      ref={toolbarRef}
      className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-5 py-3"
    >
      <div ref={leadingRef} className="flex shrink-0 items-center gap-2">
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

        {activeFilterCount > 0 && hasResults ? (
          <button
            type="button"
            onClick={onClearFilters}
            className="text-ui-sm text-slate-400 transition hover:text-slate-700"
          >
            {t("bugs.clearFilters")}
          </button>
        ) : null}
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2">
        {showSearch ? (
          <div className="relative w-64 min-w-24 shrink">
            <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              value={keyword}
              onChange={(event) => onKeywordChange(event.target.value)}
              placeholder={t("bugs.searchPlaceholder")}
              title={t("bugs.searchHint")}
              className="w-full rounded-lg border border-border bg-slate-50 py-2 pl-9 pr-3 text-ui-caption text-slate-800 transition focus:bg-surface"
            />
          </div>
        ) : null}

        <div ref={columnsRef} className="relative shrink-0">
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
