/**
 * Composer session-mode picker: plan mode plus the three permission modes.
 *
 * Both live on the session, not the runtime: the policy gate is evaluated per
 * tool call and the engine applies a queued plan selection at the next step, so
 * a pick takes effect without restarting anything. Plan is a separate engine
 * flag — picking a permission mode also leaves plan mode, while picking plan
 * keeps the permission mode underneath.
 */
import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import {
  Check,
  ChevronDown,
  HandHelping,
  ListTodo,
  ShieldCheck,
  ShieldOff,
  type LucideIcon,
} from "lucide-react";

import { useDismiss } from "../hooks/useDismiss";
import { t, type MessageKey } from "../lib/i18n";
import { computeMenuPosition, type MenuPosition } from "../lib/menuPosition";
import {
  agentActions,
  agentStore,
  sessionPermissionMode,
  sessionPlan,
} from "./store";

type ModeValue = "plan" | "notify" | "auto" | "full";

type Option = {
  value: ModeValue;
  icon: LucideIcon;
  label: MessageKey;
  hint: MessageKey;
};

/** Plan first, then the permission modes from most to least conservative. */
const OPTIONS: Option[] = [
  {
    value: "plan",
    icon: ListTodo,
    label: "agent.mode.plan",
    hint: "agent.mode.planHint",
  },
  {
    value: "notify",
    icon: HandHelping,
    label: "agent.config.permissionNotify",
    hint: "agent.config.permissionNotifyHint",
  },
  {
    value: "auto",
    icon: ShieldCheck,
    label: "agent.config.permissionAuto",
    hint: "agent.config.permissionAutoHint",
  },
  {
    value: "full",
    icon: ShieldOff,
    label: "agent.config.permissionFull",
    hint: "agent.config.permissionFullHint",
  },
];

export function SessionModePicker() {
  const state = agentStore.use();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, cardRef, close, { resize: true, blur: true });

  const sessionId = state.selectedId;
  if (!sessionId) return null;

  const plan = sessionPlan(state, sessionId);
  const mode = sessionPermissionMode(state, sessionId) ?? state.config?.permissionMode ?? "auto";
  const activeValue: ModeValue = plan ? "plan" : mode;
  const active = OPTIONS.find((option) => option.value === activeValue) ?? OPTIONS[2];
  const ActiveIcon = active.icon;

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(
      computeMenuPosition(rect, {
        placement: "up",
        minWidth: 300,
        fullHeight: 320,
      }),
    );
    setOpen(true);
  };

  const pick = (value: ModeValue) => {
    void agentActions.selectSessionMode(sessionId, value);
    close();
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t(active.hint)}
        onClick={toggle}
        className={clsx(
          "inline-flex min-w-0 max-w-[140px] shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-ui-xs transition",
          open
            ? "bg-overlay text-slate-700"
            : "text-slate-500 hover:bg-overlay hover:text-slate-700",
        )}
      >
        <ActiveIcon size={12} className="shrink-0 text-slate-400" />
        <span className="min-w-0 truncate">{t(active.label)}</span>
        <ChevronDown
          size={11}
          className={clsx("shrink-0 transition", open && "rotate-180")}
        />
      </button>

      {open && position
        ? createPortal(
            <>
              <button
                type="button"
                aria-label={t("common.picker.close")}
                tabIndex={-1}
                className="fixed inset-0 z-[110] cursor-default"
                onClick={close}
              />
              <div
                ref={cardRef}
                role="dialog"
                aria-label={t("agent.mode.title")}
                style={{
                  left: position.left,
                  top: position.top,
                  bottom: position.bottom,
                  width: position.width,
                  maxHeight: position.maxHeight,
                }}
                className="fixed z-[120] flex flex-col overflow-hidden rounded-xl border border-border bg-surface"
              >


                <div role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1">
                  {OPTIONS.map((option) => {
                    const selected = option.value === activeValue;
                    const Icon = option.icon;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => pick(option.value)}
                        className={clsx(
                          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition",
                          selected ? "bg-sky-50" : "hover:bg-slate-50",
                        )}
                      >
                        <Icon
                          size={14}
                          className={clsx(
                            "shrink-0",
                            selected ? "text-sky-600" : "text-slate-400",
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className={clsx(
                              "block text-ui-caption",
                              selected ? "text-sky-700" : "text-slate-700",
                            )}
                          >
                            {t(option.label)}
                          </span>
                          <span className="mt-0.5 block text-ui-2xs text-slate-400">
                            {t(option.hint)}
                          </span>
                        </span>
                        <span className="grid h-3 w-3 shrink-0 place-items-center">
                          {selected ? <Check size={12} className="text-sky-500" /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
