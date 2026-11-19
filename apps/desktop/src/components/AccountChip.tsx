import clsx from "clsx";
import { ChevronRight } from "lucide-react";

import { avatarSrc } from "../lib/api";
import { t } from "../lib/i18n";
import { Avatar } from "./Avatar";
import { ScrollingName } from "./ScrollingName";

type Props = {
  /** Signed-in avatar source (already resolved through `info.meAvatar`). */
  meAvatar: string | null;
  name: string | null;
  /** Second line, sidebar variant only. */
  company?: string;
  /** Rail chip instead of the sidebar footer. */
  compact?: boolean;
  /** Sidebar variant: highlights the account view. */
  active?: boolean;
  /** Rail variant: replays the avatar animation for this token. */
  animToken?: number;
  animClass?: string;
  onClick: () => void;
};

/**
 * Account chip shared by the icon rail (`compact`) and the project sidebar
 * footer. Both variants keep their original markup; only the trigger differs.
 */
export function AccountChip({
  meAvatar,
  name,
  company,
  compact = false,
  active = false,
  animToken,
  animClass,
  onClick,
}: Props) {
  if (compact) {
    return (
      <button
        data-component="AccountChip"
        type="button"
        title={t("settings.account.title")}
        aria-label={t("settings.account.title")}
        onClick={onClick}
        className="h-8 w-8 rounded-full transition hover:brightness-105"
      >
        <span
          key={animToken ?? "idle"}
          className={clsx("inline-flex items-center justify-center", animClass)}
        >
          <Avatar
            src={avatarSrc(meAvatar)}
            name={name}
            className="h-8 w-8 text-ui-sm"
          />
        </span>
      </button>
    );
  }

  return (
    <button
      data-component="AccountChip"
      type="button"
      onClick={onClick}
      title={t("settings.account.title")}
      className={clsx(
        "group flex w-full items-center gap-2.5 border-t border-border px-3 py-2.5 text-left transition",
        active ? "bg-overlay" : "hover:bg-overlay-soft",
      )}
    >
      <span className="shrink-0">
        <Avatar
          src={avatarSrc(meAvatar)}
          name={name}
          className="h-7 w-7 text-ui-xs "
        />
      </span>
      <span className="min-w-0 flex-1">
        <ScrollingName text={name ?? ""} className="text-ui-caption font-normal text-slate-700" />
        <ScrollingName text={company ?? ""} className="text-ui-xs text-slate-400" />
      </span>
      <ChevronRight
        size={13}
        className="shrink-0 text-slate-300 transition group-hover:text-slate-500"
      />
    </button>
  );
}
