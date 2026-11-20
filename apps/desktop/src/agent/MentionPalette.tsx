import { memo } from "react";
import clsx from "clsx";
import {
  ArrowDown,
  FileCode,
  FileImage,
  FileText,
  FileType,
  FolderGit2,
  MessageSquare,
  Package,
} from "lucide-react";

import { t } from "../lib/i18n";
import { ScrollingName } from "../components/ScrollingName";
import {
  mentionDir,
  mentionName,
  mentionTone,
  type MentionKind,
  type MentionRow,
} from "./mentions";

const TONE_ICON = {
  code: { Icon: FileCode, className: "text-sky-600" },
  data: { Icon: FileType, className: "text-amber-500" },
  doc: { Icon: FileText, className: "text-slate-500" },
  image: { Icon: FileImage, className: "text-violet-500" },
  other: { Icon: FileCode, className: "text-slate-400" },
} as const;

const KIND_ICON: Partial<Record<MentionKind, { Icon: typeof Package; className: string }>> = {
  plugin: { Icon: Package, className: "text-slate-500" },
  conversation: { Icon: MessageSquare, className: "text-slate-500" },
};

/**
 * The `@` panel: a searchable list of what a mention can point at.
 *
 * One row per candidate — glyph, name, the dim directory it lives in, and the
 * workspace it belongs to on the right — with the query hint in the footer.
 * Files are the only kind a provider fills today; `plugin` and `conversation`
 * rows ride the same shape, so adding them needs no view change.
 */
export const MentionPalette = memo(function MentionPalette({
  items,
  index,
  root,
  onPick,
  onHover,
}: {
  items: readonly MentionRow[];
  index: number;
  /** The workspace the candidates came from (its name is the row's tag). */
  root: string;
  onPick: (row: MentionRow) => void;
  onHover: (index: number) => void;
}) {
  // A chat's scratch directory is a session id; naming it would only add noise.
  const name = root.split("/").filter(Boolean).pop() ?? "";
  const workspace = /^[0-9a-f]{8}-[0-9a-f]{4}-/u.test(name) ? "" : name;

  return (
    <div
      data-component="MentionPalette"
      role="listbox"
      aria-label={t("agent.mention.title")}
      className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-border bg-surface"
    >
      <div className="max-h-[min(48vh,20rem)] overflow-y-auto overscroll-contain p-1">
        {items.length === 0 ? (
          <div className="px-2.5 py-2 text-ui-caption text-slate-400">
            {t("agent.mention.empty")}
          </div>
        ) : (
          items.map((row, position) => {
            const active = position === index;
            const tone = row.kind === "file" ? mentionTone(row.path) : undefined;
            const { Icon, className } =
              (row.kind !== "file" && KIND_ICON[row.kind]) ||
              TONE_ICON[tone ?? "other"];
            return (
              <button
                key={`${row.kind}:${row.path}`}
                type="button"
                role="option"
                aria-selected={active}
                // Keep the caret: the next keystroke filters this panel.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHover(position)}
                onClick={() => onPick(row)}
                className={clsx(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                  active ? "bg-overlay" : "hover:bg-overlay-soft",
                )}
              >
                <Icon size={15} className={clsx("shrink-0", className)} />
                <span className="min-w-0 shrink-0 max-w-[60%] text-ui-caption text-slate-800">
                  <ScrollingName text={mentionName(row.path)} />
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-ui-2xs text-slate-400">
                  {row.kind === "file" ? mentionDir(row.path) : t("agent.mention.kind", { kind: row.kind })}
                </span>
                {workspace ? (
                  <span className="ml-auto flex shrink-0 items-center gap-1 pr-1 text-ui-2xs text-slate-400">
                    <FolderGit2 size={10} className="text-slate-300" />
                    {workspace}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-2.5 py-1.5 text-ui-2xs text-slate-400">
        <span className="min-w-0 truncate">{t("agent.mention.hint")}</span>
        <span className="ml-auto grid h-4 w-4 shrink-0 place-items-center">
          <ArrowDown size={11} />
        </span>
      </div>
    </div>
  );
});
