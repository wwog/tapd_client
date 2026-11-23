import type { ReactNode } from "react";

/**
 * One icon action in the tab strip's trailing slot (`ActiveTabExtra`). Sized
 * and bordered like the「打开」split button beside it so the slot reads as one
 * group; the label lives in the tooltip to keep the strip narrow.
 */
export function TabExtraAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      data-component="TabExtraAction"
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border bg-surface text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
    >
      {children}
    </button>
  );
}
