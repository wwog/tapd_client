import type { ReactNode } from "react";

import { t, type MessageKey } from "../lib/i18n";
import { navigate } from "../lib/router";

/**
 * The 缺陷/事项 pivot both views share. Local items live inside the bugs tab
 * now — the bottom bar has no 事项 entry — so switching is a route change
 * between `#/bugs` and `#/local`, and the bottom bar highlights 缺陷 for
 * either view (the route mapper folds them together). `actions` rides the
 * same row (page-level buttons, e.g. 新建项目) instead of stacking another
 * header row.
 */
export function BugsLocalPivot(props: { view: "bugs" | "local"; actions?: ReactNode }) {
  const tabs: ReadonlyArray<{ key: "bugs" | "local"; label: MessageKey; hash: string }> = [
    { key: "bugs", label: "common.bugs", hash: "#/bugs" },
    { key: "local", label: "mobile.local.title", hash: "#/local" },
  ];
  return (
    <div className="flex items-center gap-2 px-4 pt-3 pb-2">
      <div
        role="tablist"
        aria-label={t("mobile.nav.main")}
        className="flex min-w-0 flex-1 items-center rounded-lg border border-border bg-surface p-0.5"
      >
        {tabs.map((tab) => {
          const active = props.view === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                if (!active) navigate(tab.hash);
              }}
              className={`flex min-h-11 flex-1 items-center justify-center rounded-md text-ui-sm transition ${
                active ? "bg-slate-100 text-slate-900" : "text-slate-500"
              }`}
            >
              {t(tab.label)}
            </button>
          );
        })}
      </div>
      {props.actions}
    </div>
  );
}
