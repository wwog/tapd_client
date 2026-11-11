import clsx from "clsx";

/**
 * Loading placeholders shared by the bug list and detail drawer.
 *
 * Skeletons keep the layout stable while data is in flight: same slate palette
 * as the real content, one shared `animate-pulse`, no extra dependencies.
 */

/** A single pulsing block. Size it with Tailwind classes (`h-3 w-24`). */
export function SkeletonBlock(props: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={clsx("animate-pulse rounded-md bg-slate-200/80", props.className)}
    />
  );
}

type SkeletonRowsProps = {
  /** Number of placeholder rows. */
  rows?: number;
  /**
   * One Tailwind width class per column, e.g. `["w-2/5", "w-12", "w-24"]`.
   * The widest entry (usually the first) should use a percentage width.
   */
  columns?: string[];
  className?: string;
  rowClassName?: string;
  /** Announced to screen readers in place of the visual placeholders. */
  label?: string;
};

const DEFAULT_COLUMNS = ["w-2/5", "w-16", "w-12", "w-16", "w-20", "w-16", "w-24"];

/** A pulsing list of placeholder rows, one line per item. */
export function SkeletonRows(props: SkeletonRowsProps) {
  const {
    rows = 8,
    columns = DEFAULT_COLUMNS,
    className,
    rowClassName,
    label = "正在加载…",
  } = props;

  return (
    <div
      role="status"
      aria-busy="true"
      className={clsx("divide-y divide-slate-100", className)}
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: Math.max(1, rows) }, (_, row) => (
        <div
          key={row}
          className={clsx("flex items-center gap-4 px-4 py-3", rowClassName)}
        >
          {columns.map((width, column) => (
            <SkeletonBlock key={column} className={clsx("h-3", width)} />
          ))}
        </div>
      ))}
    </div>
  );
}
