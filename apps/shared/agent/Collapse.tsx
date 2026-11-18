import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";

/**
 * Height animation for the transcript's folds. The closed state unmounts the
 * subtree after the transition, so collapsed history keeps no DOM; while the
 * panel is open the content stays mounted and may grow (streaming) without
 * replaying the animation.
 *
 * `grid-template-rows: 1fr ↔ 0fr` animates the natural height without a
 * measuring pass or a fixed pixel height, which keeps the animation correct
 * across font-size and width changes. `prefers-reduced-motion` jumps straight
 * to the end state.
 */
const DEFAULT_DURATION_MS = 200;
/** A little slack so the timer never unmounts midway through a frame. */
const UNMOUNT_SLACK_MS = 60;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function Collapse({
  open,
  children,
  className,
  durationMs = DEFAULT_DURATION_MS,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
  durationMs?: number;
}) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  // Layout effect so the 0fr state is committed before the first paint of an
  // opening panel; the second rAF then guarantees that frame was painted, so
  // the browser has a real start value to interpolate from.
  useLayoutEffect(() => {
    const clear = () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    clear();

    if (open) {
      setMounted(true);
      if (prefersReducedMotion()) {
        setExpanded(true);
        return clear;
      }
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          setExpanded(true);
        });
      });
      return clear;
    }

    // Already fully closed: no timer or state write per mounted instance.
    if (!mountedRef.current) return clear;

    if (prefersReducedMotion()) {
      setExpanded(false);
      setMounted(false);
      return clear;
    }
    setExpanded(false);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setMounted(false);
    }, durationMs + UNMOUNT_SLACK_MS);
    return clear;
  }, [open, durationMs]);

  if (!mounted) return null;

  return (
    <div
      // Hidden content must not take focus or be read while the panel is
      // closing; `inert` covers both without changing the animated height.
      inert={!open}
      className={clsx(
        "grid transition-[grid-template-rows] ease-out motion-reduce:transition-none",
        expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
      style={{ transitionDuration: `${durationMs}ms` }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
