import type { ReactNode } from "react";

/** Small icon + label heading shared by the drawer's collapsible sections. */
export function BugSectionTitle(props: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-1.5 text-ui-caption font-normal text-slate-700">
      <span className="text-slate-400">{props.icon}</span>
      {props.title}
    </div>
  );
}
