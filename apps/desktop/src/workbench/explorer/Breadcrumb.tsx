/**
 * Path breadcrumb shared by the explorer and the file viewer.
 *
 * `onNavigate` turns the segments into buttons; without it the trail is a
 * read-only label (the file panel shows its containing directory).
 */
import clsx from "clsx";
import { ChevronRight } from "lucide-react";

import { t } from "../../lib/i18n";

type Props = {
  /** Project name shown as the first crumb. */
  rootLabel: string;
  /** Relative directory ("/`-separated, "" at the root). */
  path: string;
  onNavigate?: (path: string) => void;
  className?: string;
};

export function Breadcrumb({ rootLabel, path, onNavigate, className }: Props) {
  const segments = path ? path.split("/").filter(Boolean) : [];
  const crumbs = segments.map((name, index) => ({
    name,
    path: segments.slice(0, index + 1).join("/"),
  }));

  const crumbClass =
    "min-w-0 truncate rounded-md px-1 py-0.5 text-ui-xs transition";

  return (
    <nav
      aria-label={t("explorer.root")}
      data-workbench-explorer="breadcrumb"
      className={clsx(
        "flex min-w-0 items-center gap-0.5 overflow-hidden text-slate-500",
        className,
      )}
    >
      {onNavigate ? (
        <button
          type="button"
          title={rootLabel}
          onClick={() => onNavigate("")}
          className={clsx(crumbClass, "shrink-0 hover:bg-overlay hover:text-slate-800")}
        >
          {rootLabel}
        </button>
      ) : (
        <span title={rootLabel} className={clsx(crumbClass, "shrink-0")}>
          {rootLabel}
        </span>
      )}
      {crumbs.map((crumb) => (
        <span key={crumb.path} className="flex min-w-0 items-center gap-0.5">
          <ChevronRight size={10} className="shrink-0 text-slate-300" />
          {onNavigate ? (
            <button
              type="button"
              title={crumb.path}
              onClick={() => onNavigate(crumb.path)}
              className={clsx(crumbClass, "hover:bg-overlay hover:text-slate-800")}
            >
              {crumb.name}
            </button>
          ) : (
            <span title={crumb.path} className={crumbClass}>
              {crumb.name}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
