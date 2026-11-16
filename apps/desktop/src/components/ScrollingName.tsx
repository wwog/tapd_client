import { useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";

/** Constant reading pace for the hover slide, in ms per overflow pixel. */
const MS_PER_PX = 16;
/** Floor so a tiny overflow still reads as a move, not a jump. */
const MIN_DURATION = 200;
/** Snapping back on mouseleave stays quick; only the reveal is paced. */
const RETURN_DURATION = 160;

type Props = {
  text: string;
  className?: string;
};

/**
 * One-line name/title. If it overflows, hovering scrolls it in place instead
 * of truncating. The duration is proportional to the overflow distance at a
 * constant speed, so long text never sprints and the tail never crawls.
 */
export function ScrollingName({ text, className }: Props) {
  const outerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const [hovered, setHovered] = useState(false);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = () =>
      setOverflow(Math.max(0, inner.scrollWidth - outer.clientWidth));
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [text]);

  const duration = Math.max(MIN_DURATION, overflow * MS_PER_PX);

  return (
    <span
      ref={outerRef}
      aria-label={text}
      className={clsx("relative block min-w-0 overflow-hidden", className)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        ref={innerRef}
        className="inline-block whitespace-nowrap transition-transform ease-linear"
        style={{
          transform:
            hovered && overflow > 0 ? `translateX(-${overflow}px)` : "translateX(0)",
          transitionDuration: `${hovered ? duration : RETURN_DURATION}ms`,
        }}
      >
        {text}
      </span>
    </span>
  );
}
