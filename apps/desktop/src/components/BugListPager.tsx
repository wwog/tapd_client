import type { Dispatch, SetStateAction } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import clsx from "clsx";

import type { BugListPage } from "../lib/api";
import { t } from "../lib/i18n";
import { Button } from "./ui";

/** Bottom pager; hidden while the list is empty. */
export function BugListPager(props: {
  page: BugListPage | null;
  pageNo: number;
  loading: boolean;
  onRefresh: () => void;
  onPageChange: Dispatch<SetStateAction<number>>;
}) {
  const { page, pageNo, loading, onRefresh, onPageChange } = props;
  if (!page || page.total <= 0) return null;

  const totalPages = Math.max(1, Math.ceil(page.total / Math.max(1, page.perpage)));

  return (
    <div className="flex shrink-0 items-center justify-between border-t border-border bg-surface px-5 py-2.5 text-ui-sm text-slate-500">
      <div className="flex items-center gap-2">
        <button
          type="button"
          title={t("bugs.refreshList")}
          aria-label={t("bugs.refreshList")}
          onClick={onRefresh}
          className={clsx(
            "text-slate-400 transition hover:text-slate-700",
            loading && "pointer-events-none animate-spin",
          )}
        >
          <RefreshCw size={13} />
        </button>
        <span className="tabular-nums">
          {t("bugs.pager.summary", {
            page: pageNo,
            total: totalPages,
            count: page.total,
          })}
        </span>
      </div>
      {/* A single page has nothing to page through: the buttons would only
          ever render disabled. */}
      {totalPages > 1 ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={pageNo <= 1 || loading}
            onClick={() => onPageChange((current) => Math.max(1, current - 1))}
            icon={<ChevronLeft size={13} />}
          >
            {t("bugs.pager.previous")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pageNo >= totalPages || loading}
            onClick={() => onPageChange((current) => Math.min(totalPages, current + 1))}
          >
            {t("bugs.pager.next")}
            <ChevronRight size={13} />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
