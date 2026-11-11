import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpNarrowWide,
  Check,
  ChevronDown,
  Search,
} from "lucide-react";
import clsx from "clsx";

import { useDismiss } from "../hooks/useDismiss";

export type TableFilterOption = { value: string; label: string };

export type TableSortProps = {
  /** `null` when this column is not the active sort key. */
  direction: "asc" | "desc" | null;
  /** First click picks the column's natural direction, later clicks toggle. */
  onToggle: () => void;
};

type Props = {
  label: string;
  options: TableFilterOption[];
  selected: string[];
  /** Multi-select keeps the menu open; single-select applies and closes. */
  multiple?: boolean;
  onChange: (values: string[]) => void;
  /** Optional sort control, rendered before the filter toggle. */
  sort?: TableSortProps;
  className?: string;
};

/**
 * Header filter with an option list, an inline match box, multi or single
 * selection. The menu is portalled and fixed so the table's scroll container
 * cannot clip it.
 *
 * Sort/filter controls stay hidden until the header is hovered, or while one
 * of them is applied, so the normal table header stays quiet.
 */
export function TableFilter(props: Props) {
  const {
    label,
    options,
    selected,
    multiple = true,
    onChange,
    sort,
    className,
  } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** Multi-select edits are staged; 完成 applies them, closing discards them. */
  const [draft, setDraft] = useState<string[]>(selected);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null,
  );
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  // Registered as a dismiss layer so the bug drawer's page-level Escape
  // handler stands down instead of closing the panel too.
  useDismiss(open, menuRef, close);

  const openMenu = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 216)),
      top: rect.bottom + 4,
    });
    setQuery("");
    setDraft(selected);
    setOpen(true);
  };

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        option.value.toLowerCase().includes(needle),
    );
  }, [options, query]);

  const toggle = (value: string) => {
    if (multiple) {
      setDraft((current) =>
        current.includes(value)
          ? current.filter((item) => item !== value)
          : [...current, value],
      );
      return;
    }
    onChange(selected.includes(value) ? [] : [value]);
    close();
  };

  const active = selected.length > 0;
  const sorted = Boolean(sort?.direction);

  return (
    <>
      <div className={clsx("group/head flex w-full items-center", className)}>
        <button
          ref={anchorRef}
          type="button"
          title={`筛选${label}`}
          aria-label={`筛选${label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? close() : openMenu())}
          className={clsx(
            "flex min-w-0 flex-1 items-center gap-1 text-left transition",
            active || sorted
              ? "text-sky-700"
              : "text-slate-500 hover:text-slate-800",
          )}
        >
          <span className="truncate">{label}</span>
          {active ? (
            multiple ? (
              <span className="grid h-3.5 min-w-3.5 shrink-0 place-items-center rounded-full bg-sky-500 px-1 text-[9px] leading-none text-white tabular-nums">
                {selected.length}
              </span>
            ) : (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" />
            )
          ) : null}
        </button>

        {sort ? (
          <button
            type="button"
            title={
              sort.direction === "asc"
                ? `改为${label}降序`
                : sort.direction === "desc"
                  ? `取消${label}排序`
                  : `按${label}升序`
            }
            aria-label={`按${label}排序`}
            onClick={sort.onToggle}
            className={clsx(
              "grid h-5 w-4 shrink-0 place-items-center rounded transition focus-visible:opacity-100",
              sort.direction
                ? "text-sky-600"
                : "text-slate-400 opacity-0 group-hover/head:opacity-100",
            )}
          >
            {sort.direction === "asc" ? (
              <ArrowUpNarrowWide size={12} />
            ) : sort.direction === "desc" ? (
              <ArrowDownWideNarrow size={12} />
            ) : (
              <ArrowUpDown size={12} />
            )}
          </button>
        ) : null}

        <button
          type="button"
          title={open ? `收起${label}筛选` : `筛选${label}`}
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => (open ? close() : openMenu())}
          className={clsx(
            "ml-0.5 grid h-5 w-4 shrink-0 place-items-center rounded transition focus-visible:opacity-100",
            open || active
              ? "text-sky-600"
              : "text-slate-400 opacity-0 group-hover/head:opacity-100",
          )}
        >
          <ChevronDown
            size={12}
            className={clsx("transition", open && "rotate-180")}
          />
        </button>
      </div>

      {open && position
        ? createPortal(
            <>
              <button
                type="button"
                aria-label="关闭筛选"
                className="fixed inset-0 z-40 cursor-default"
                onClick={close}
              />
              <div
                ref={menuRef}
                role="dialog"
                aria-label={`筛选${label}`}
                style={{ left: position.left, top: position.top }}
                className="fixed z-50 w-[208px] overflow-hidden rounded-lg border border-border bg-surface"
              >
                <div className="border-b border-slate-100 p-1.5">
                  <div className="relative">
                    <Search
                      size={11}
                      className="absolute left-2 top-2 text-slate-400"
                    />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={`匹配${label}`}
                      className="h-7 w-full rounded-md border border-border bg-slate-50 pl-6 pr-2 text-ui-xs text-slate-700 transition placeholder:text-slate-300 focus:border-sky-300 focus:bg-surface focus:outline-2 focus:outline-sky-200"
                    />
                  </div>
                </div>

                <div className="max-h-64 overflow-y-auto p-1">
                  {shown.map((option) => {
                    const checked = multiple
                      ? draft.includes(option.value)
                      : selected.includes(option.value);
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => toggle(option.value)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-caption transition hover:bg-slate-50"
                      >
                        <span
                          className={clsx(
                            "grid h-4 w-4 shrink-0 place-items-center border",
                            multiple ? "rounded" : "rounded-full",
                            checked
                              ? "border-sky-500 bg-sky-500 text-white"
                              : "border-slate-300 text-transparent",
                          )}
                        >
                          {checked ? (
                            multiple ? (
                              <Check size={10} />
                            ) : (
                              <span className="h-1.5 w-1.5 rounded-full bg-white" />
                            )
                          ) : null}
                        </span>
                        <span
                          className={clsx(
                            "min-w-0 flex-1 truncate",
                            checked ? "text-slate-800" : "text-slate-600",
                          )}
                        >
                          {option.label}
                        </span>
                      </button>
                    );
                  })}
                  {shown.length === 0 ? (
                    <div className="px-2 py-3 text-center text-ui-xs text-slate-400">
                      没有匹配项
                    </div>
                  ) : null}
                </div>

                {multiple ? (
                  <div className="flex items-center justify-end border-t border-slate-100 px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        const changed =
                          draft.length !== selected.length ||
                          draft.some((value) => !selected.includes(value));
                        if (changed) onChange(draft);
                        close();
                      }}
                      className="text-ui-xs text-sky-600 transition hover:text-sky-700"
                    >
                      完成
                    </button>
                  </div>
                ) : null}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
