/**
 * Flat renderer for the explorer's expanded directories.
 *
 * Rows are real `<div role="treeitem">` nodes rather than buttons: the whole
 * group owns keyboard focus, so arrow keys can move between rows without the
 * browser stealing focus. The chevron stays a separate click target for a
 * single-click expand/collapse.
 */
import clsx from "clsx";
import {
  ChevronRight,
  File as FileIcon,
  FileAudio,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
} from "lucide-react";
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import type { FsEntry } from "../../lib/fs";
import { t } from "../../lib/i18n";
import { visualKindForPath } from "./language";
import type { ExplorerRow } from "./useExplorerTree";

type Props = {
  rows: ExplorerRow[];
  expanded: Set<string>;
  selected: string | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onRowClick: (entry: FsEntry) => void;
  onRowDoubleClick: (entry: FsEntry) => void;
  onToggleDir: (path: string) => void;
};

function EntryIcon({ entry, expanded }: { entry: FsEntry; expanded: boolean }) {
  if (entry.kind === "symlink") {
    return <Link2 size={13} className="shrink-0 text-sky-500" />;
  }
  if (entry.kind === "dir") {
    return expanded ? (
      <FolderOpen size={13} className="shrink-0 text-amber-500" />
    ) : (
      <Folder size={13} className="shrink-0 text-amber-500" />
    );
  }
  switch (visualKindForPath(entry.name)) {
    case "image":
      return <FileImage size={13} className="shrink-0 text-violet-500" />;
    case "audio":
      return <FileAudio size={13} className="shrink-0 text-cyan-500" />;
    case "video":
      return <FileVideo size={13} className="shrink-0 text-rose-500" />;
    case "markdown":
    case "text":
      return <FileText size={13} className="shrink-0 text-slate-400" />;
    case "code":
      return <FileCode2 size={13} className="shrink-0 text-sky-500" />;
    default:
      return <FileIcon size={13} className="shrink-0 text-slate-400" />;
  }
}

export function ExplorerTree(props: Props) {
  const {
    rows,
    expanded,
    selected,
    containerRef,
    onKeyDown,
    onRowClick,
    onRowDoubleClick,
    onToggleDir,
  } = props;
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (!selected) return;
    rowRefs.current.get(selected)?.scrollIntoView({ block: "nearest" });
  }, [selected, rows]);

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label={t("explorer.title")}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-workbench-explorer="tree"
      className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1 outline-none focus-visible:outline-2 focus-visible:outline-sky-200"
    >
      {rows.map((row, index) => {
        if (row.kind === "note") {
          const isError = row.note === "error";
          const message =
            row.note === "empty"
              ? t("explorer.emptyDir")
              : row.note === "loading"
                ? t("explorer.loading")
                : t("explorer.loadFailed", { error: row.message ?? "" });
          return (
            <div
              key={`note:${row.path}:${row.note}`}
              className={clsx(
                "flex items-center gap-1 py-[3px] text-ui-xs",
                isError ? "text-rose-600" : "text-slate-400",
              )}
              style={{ paddingLeft: 8 + row.depth * 12 }}
              title={message}
            >
              {row.note === "loading" ? (
                <Loader2 size={10} className="shrink-0 animate-spin" />
              ) : null}
              <span className="truncate">{message}</span>
            </div>
          );
        }

        const { entry, depth } = row;
        const isDir = entry.kind === "dir";
        const isExpanded = isDir && expanded.has(entry.path);
        const isSelected = selected === entry.path;
        return (
          <div
            key={entry.path}
            ref={(node) => {
              if (node) rowRefs.current.set(entry.path, node);
              else rowRefs.current.delete(entry.path);
            }}
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={isDir ? isExpanded : undefined}
            data-workbench-explorer-row={entry.kind}
            data-path={entry.path}
            data-index={index}
            onClick={() => {
              containerRef.current?.focus();
              onRowClick(entry);
            }}
            onDoubleClick={(event) => {
              event.preventDefault();
              onRowDoubleClick(entry);
            }}
            className={clsx(
              "flex cursor-default select-none items-center gap-1 rounded-md py-[3px] pr-2 text-ui-sm transition",
              isSelected
                ? "bg-sky-50 text-slate-900"
                : "text-slate-600 hover:bg-overlay-soft",
            )}
            style={{ paddingLeft: 2 + depth * 12 }}
          >
            {isDir ? (
              <span
                role="button"
                tabIndex={-1}
                aria-label={entry.name}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleDir(entry.path);
                }}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-overlay"
              >
                <ChevronRight
                  size={11}
                  className={clsx(
                    "transition-transform",
                    isExpanded && "rotate-90",
                  )}
                />
              </span>
            ) : (
              <span className="h-4 w-4 shrink-0" />
            )}
            <EntryIcon entry={entry} expanded={isExpanded} />
            <span className="min-w-0 flex-1 truncate" title={entry.name}>
              {entry.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
