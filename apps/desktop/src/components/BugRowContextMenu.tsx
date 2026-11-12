import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, ExternalLink, Fingerprint, FlaskConical, Hash, Hourglass, Play, Trash2, Type } from "lucide-react";
import clsx from "clsx";

import type { BugSummary } from "../lib/api";
import { bugRef } from "../lib/bug";
import { DEV_SIM, clearDevSim, setDevSim, type DevSimKind } from "../lib/devSim";
import { useDismiss } from "../hooks/useDismiss";

/** Anchor + target for the row's right-click menu. */
export type BugRowMenu = { x: number; y: number; bug: BugSummary };

/** Approximate row context menu box, used to keep it inside the window. */
const MENU_WIDTH = 168;
const MENU_HEIGHT = DEV_SIM ? 352 : 132;

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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  // Dismiss on any outside click, Escape, scroll, resize or blur.
  useDismiss(true, menuRef, onClose, { scroll: true, resize: true, blur: true });

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const copyFromMenu = (key: "id" | "longId" | "title", text: string) => {
    onCopy?.(text);
    setCopiedKey(key);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => {
      copiedTimerRef.current = null;
      setCopiedKey(null);
      onClose();
    }, 700);
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="缺陷快捷操作"
      style={{
        left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8)),
        top: Math.max(8, Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8)),
      }}
      className="fixed z-50 w-[168px] overflow-hidden rounded-lg border border-border bg-surface py-1 "
      onContextMenu={(event) => event.preventDefault()}
    >
      <RowMenuItem
        icon={<Hash size={12} />}
        label={copiedKey === "id" ? "已复制 ID" : "复制 ID"}
        done={copiedKey === "id"}
        onClick={() => copyFromMenu("id", bugRef(menu.bug))}
      />
      <RowMenuItem
        icon={<Fingerprint size={12} />}
        label={copiedKey === "longId" ? "已复制长 ID" : "复制长 ID"}
        done={copiedKey === "longId"}
        onClick={() => copyFromMenu("longId", menu.bug.id)}
      />
      <RowMenuItem
        icon={<Type size={12} />}
        label={copiedKey === "title" ? "已复制标题" : "复制标题"}
        done={copiedKey === "title"}
        onClick={() => copyFromMenu("title", menu.bug.title)}
      />
      {onOpenWeb ? (
        <RowMenuItem
          icon={<ExternalLink size={12} />}
          label="在 TAPD 中打开"
          onClick={() => {
            onOpenWeb(menu.bug.bugUrl);
            onClose();
          }}
        />
      ) : null}
      {DEV_SIM ? (
        <DevSimSection
          bug={menu.bug}
          onClose={onClose}
        />
      ) : null}
    </div>
  );
}

/** Development-only state injector for the activity row / cancel button. */
function DevSimSection(props: { bug: BugSummary; onClose: () => void }) {
  const { bug, onClose } = props;
  const apply = (kind: DevSimKind | null) => {
    if (kind) setDevSim(bug.workspaceId, bug.id, kind);
    else clearDevSim(bug.workspaceId, bug.id);
    onClose();
  };

  return (
    <>
      <div className="my-1 border-t border-border" />
      <div className="flex items-center gap-1 px-3 py-1 text-ui-2xs text-slate-400">
        <FlaskConical size={10} />
        开发测试
      </div>
      <RowMenuItem
        icon={<Hourglass size={12} />}
        label="模拟外部队列"
        onClick={() => apply("external-queued")}
      />
      <RowMenuItem
        icon={<Bot size={12} />}
        label="模拟外部运行"
        onClick={() => apply("external-running")}
      />
      <RowMenuItem
        icon={<Hourglass size={12} />}
        label="模拟本地排队 #1"
        onClick={() => apply("agent-queued")}
      />
      <RowMenuItem
        icon={<Play size={12} />}
        label="模拟队头执行"
        onClick={() => apply("agent-running")}
      />
      <RowMenuItem
        icon={<Trash2 size={12} />}
        label="清除模拟状态"
        onClick={() => apply(null)}
      />
    </>
  );
}

function RowMenuItem(props: {
  label: string;
  icon: ReactNode;
  done?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onClick}
      className={clsx(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui-sm transition",
        props.done
          ? "bg-emerald-50 text-emerald-700"
          : "text-slate-600 hover:bg-sky-50 hover:text-slate-900",
      )}
    >
      <span className={props.done ? "text-emerald-600" : "text-slate-400"}>{props.icon}</span>
      {props.label}
    </button>
  );
}
