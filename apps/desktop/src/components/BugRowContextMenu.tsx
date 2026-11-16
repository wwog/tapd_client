import { useEffect, useRef, useState } from "react";
import { ExternalLink, Fingerprint, Hash, Type } from "lucide-react";

import type { BugSummary } from "../lib/api";
import { bugRef } from "../lib/bug";
import { t } from "../lib/i18n";
import {
  ContextMenu,
  ContextMenuItem,
} from "./ContextMenu";

/** Anchor + target for the row's right-click menu. */
export type BugRowMenu = { x: number; y: number; bug: BugSummary };

type Props = {
  menu: BugRowMenu;
  onClose: () => void;
  onCopy?: (text: string) => void;
  onOpenWeb?: (url: string) => void;
};

/** Right-click menu for a bug row; dismisses like a native popup menu. */
export function BugRowContextMenu(props: Props) {
  const { menu, onClose, onCopy, onOpenWeb } = props;
  const [copiedKey, setCopiedKey] = useState<"id" | "longId" | "title" | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      label={t("bugs.quickActions")}
      onClose={onClose}
    >
      {(requestClose) => {
        const copyFromMenu = (key: "id" | "longId" | "title", text: string) => {
          onCopy?.(text);
          setCopiedKey(key);
          if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
          copiedTimerRef.current = window.setTimeout(() => {
            copiedTimerRef.current = null;
            setCopiedKey(null);
            requestClose();
          }, 700);
        };

        return (
          <>
            <ContextMenuItem
              icon={<Hash size={13} />}
              label={copiedKey === "id" ? t("bugs.copiedShortId") : t("bugs.copyShortId")}
              done={copiedKey === "id"}
              onClick={() => copyFromMenu("id", bugRef(menu.bug))}
            />
            <ContextMenuItem
              icon={<Fingerprint size={13} />}
              label={copiedKey === "longId" ? t("bugs.copiedLongId") : t("bugs.copyLongId")}
              done={copiedKey === "longId"}
              onClick={() => copyFromMenu("longId", menu.bug.id)}
            />
            <ContextMenuItem
              icon={<Type size={13} />}
              label={copiedKey === "title" ? t("bugs.copiedTitle") : t("bugs.copyTitle")}
              done={copiedKey === "title"}
              onClick={() => copyFromMenu("title", menu.bug.title)}
            />
            {onOpenWeb ? (
              <ContextMenuItem
                icon={<ExternalLink size={13} />}
                label={t("bugs.openInTapd")}
                onClick={() => {
                  onOpenWeb(menu.bug.bugUrl);
                  requestClose();
                }}
              />
            ) : null}
          </>
        );
      }}
    </ContextMenu>
  );
}
