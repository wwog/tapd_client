import { useEffect, useRef, useState } from "react";
import { ExternalLink, Fingerprint, FlaskConical, Hash, Hourglass, Play, Trash2, Type } from "lucide-react";

import type { BugSummary } from "../lib/api";
import { bugRef } from "../lib/bug";
import { DEV_SIM, clearDevSim, setDevSim, type DevSimKind } from "../lib/devSim";
import { t } from "../lib/i18n";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
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
            {DEV_SIM ? (
              <DevSimSection bug={menu.bug} requestClose={requestClose} />
            ) : null}
          </>
        );
      }}
    </ContextMenu>
  );
}

/** Development-only state injector for the activity row / cancel button. */
function DevSimSection(props: { bug: BugSummary; requestClose: () => void }) {
  const { bug, requestClose } = props;
  const apply = (kind: DevSimKind | null) => {
    if (kind) setDevSim(bug.workspaceId, bug.id, kind);
    else clearDevSim(bug.workspaceId, bug.id);
    requestClose();
  };

  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuLabel icon={<FlaskConical size={11} />}>
        {t("bugs.devTest")}
      </ContextMenuLabel>
      <ContextMenuItem
        icon={<Hourglass size={13} />}
        label={t("bugs.simQueued")}
        onClick={() => apply("agent-queued")}
      />
      <ContextMenuItem
        icon={<Play size={13} />}
        label={t("bugs.simRunning")}
        onClick={() => apply("agent-running")}
      />
      <ContextMenuItem
        icon={<Trash2 size={13} />}
        label={t("bugs.simClear")}
        onClick={() => apply(null)}
      />
    </>
  );
}
