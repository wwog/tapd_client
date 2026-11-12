import type { ReactNode } from "react";

/** Badge tones mirror the desktop `ui.tsx` maps so status colors agree. */
export type BadgeTone = "neutral" | "blue" | "green" | "amber" | "red" | "cyan";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-600",
  blue: "bg-sky-50 text-sky-700",
  green: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-rose-50 text-rose-700",
  cyan: "bg-cyan-50 text-cyan-700",
};

export const STATUS_TONES: Record<string, BadgeTone> = {
  new: "blue",
  in_progress: "amber",
  resolved: "green",
  verified: "cyan",
  reopened: "red",
  rejected: "neutral",
  closed: "neutral",
  open: "blue",
  progressing: "amber",
  done: "green",
};

/** Solid dot colors for the priority marker on rows. */
const PRIORITY_DOTS: Record<string, string> = {
  urgent: "bg-rose-500",
  high: "bg-amber-500",
  medium: "bg-sky-500",
  low: "bg-slate-300",
  insignificant: "bg-slate-300",
};

export function Badge(props: { tone?: BadgeTone; children: ReactNode }) {
  const tone = props.tone ?? "neutral";
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-ui-xs ${BADGE_TONES[tone]}`}
    >
      {props.children}
    </span>
  );
}

export function PriorityDot(props: { priority: string }) {
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOTS[props.priority] ?? "bg-slate-300"}`}
    />
  );
}
