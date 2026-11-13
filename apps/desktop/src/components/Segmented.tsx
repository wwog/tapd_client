import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import clsx from "clsx";

import { t } from "../lib/i18n";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Optional numeric suffix; rendered with a fixed width so it cannot jump. */
  count?: number;
  /** Disabled segments stay visible but cannot be selected. */
  disabled?: boolean;
};

type Props<T extends string> = {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  className?: string;
};

/**
 * Segmented control with a measured sliding indicator. The indicator follows
 * the actual button widths (labels differ), so switching animates instead of
 * replacing backgrounds.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: Props<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(
    null,
  );

  const measure = () => {
    const container = containerRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>(
      `[data-segment="${value}"]`,
    );
    if (!active) return;
    setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
  };

  useLayoutEffect(measure, [value, options.length]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [value, options.length]);

  return (
    <div
      ref={containerRef}
      role="tablist"
      className={clsx(
        "relative inline-flex items-center rounded-lg border border-border bg-slate-50 p-0.5",
        className,
      )}
    >
      {indicator ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-0.5 rounded-md bg-selected  transition-[left,width] duration-300 ease-out"
          style={{ left: indicator.left, width: indicator.width }}
        />
      ) : null}

      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            aria-disabled={option.disabled || undefined}
            data-segment={option.value}
            disabled={option.disabled}
            title={option.disabled ? t("app.segmented.unsupported") : undefined}
            onClick={() => {
              if (!option.disabled) onChange(option.value);
            }}
            className={clsx(
              "relative z-10 inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-ui-caption transition-colors disabled:cursor-not-allowed",
              active
                ? "text-slate-900"
                : option.disabled
                  ? "text-slate-300"
                  : "text-slate-500 hover:text-slate-700",
            )}
          >
            {option.icon}
            <span>{option.label}</span>
            {typeof option.count === "number" ? (
              <span
                className={clsx(
                  "inline-block min-w-[6ch] text-center tabular-nums",
                  active ? "text-slate-500" : "text-slate-400",
                )}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
