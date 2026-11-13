import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Bot, Check, ChevronDown, Search } from "lucide-react";

import type { AgentRuntimeDescriptor, AgentScanResult } from "../lib/agent";
import { useDismiss } from "../hooks/useDismiss";
import { t } from "../lib/i18n";
import { AgentIcon } from "./AgentIcon";

type Props = {
  runtimes: AgentRuntimeDescriptor[];
  value: string;
  /** Detection results, used for version badges and grouping. */
  byRuntime: ReadonlyMap<string, AgentScanResult>;
  /** False before the first scan: skip grouping and "未检测到" marks. */
  hasScan: boolean;
  disabled?: boolean;
  /** Footer pickers open upward; the settings row opens downward. */
  placement?: "down" | "up";
  /** Single-line trigger for tight toolbars (compose sheet footer). */
  compact?: boolean;
  onChange: (runtimeId: string) => void;
  className?: string;
};

type MenuPosition = { left: number; width: number; top?: number; bottom?: number };

/**
 * 运行时选择器。样式与列表筛选 / 设置卡片一致：一个带边框的触发行 + 门户
 * 菜单。原生 `<select>` 在 macOS 上无法控制菜单样式，会显得和界面脱节。
 */
export function AgentPicker(props: Props) {
  const {
    runtimes,
    value,
    byRuntime,
    hasScan,
    disabled = false,
    placement = "down",
    compact = false,
    onChange,
    className,
  } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  useDismiss(open, menuRef, close, { resize: true, blur: true });

  const selected = runtimes.find((runtime) => runtime.id === value) ?? null;
  const selectedScan = selected ? byRuntime.get(selected.id) : undefined;

  const openMenu = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, 300);
    const left = Math.min(
      Math.max(8, rect.left),
      Math.max(8, window.innerWidth - width - 8),
    );
    // 空间不够时向上翻转，避免菜单被窗口底部裁掉。
    const spaceBelow = window.innerHeight - rect.bottom;
    const wantUp = placement === "up" ? spaceBelow < 320 : spaceBelow < 280;
    setPosition(
      wantUp
        ? { left, width, bottom: window.innerHeight - rect.top + 6 }
        : { left, width, top: rect.bottom + 6 },
    );
    setQuery("");
    setOpen(true);
  };

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = runtimes.filter((runtime) => {
      if (!needle) return true;
      return `${runtime.name} ${runtime.vendor} ${runtime.binary}`
        .toLowerCase()
        .includes(needle);
    });
    if (!hasScan) return [{ key: "all", label: "", items: matched }];
    const found: AgentRuntimeDescriptor[] = [];
    const missing: AgentRuntimeDescriptor[] = [];
    const custom: AgentRuntimeDescriptor[] = [];
    for (const runtime of matched) {
      if (runtime.id === "custom") custom.push(runtime);
      else if (byRuntime.get(runtime.id)?.found) found.push(runtime);
      else missing.push(runtime);
    }
    return [
      { key: "found", label: t("agent.picker.found"), items: found },
      { key: "missing", label: t("agent.picker.missing"), items: missing },
      { key: "custom", label: t("agent.picker.custom"), items: custom },
    ];
  }, [byRuntime, hasScan, query, runtimes]);

  const empty = groups.every((group) => group.items.length === 0);

  return (
    <div className={clsx("relative", className)}>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          selected
            ? `${selected.vendor} · ${selected.description}`
            : t("agent.picker.select")
        }
        onClick={() => (open ? close() : openMenu())}
        className={clsx(
          "flex w-full items-center gap-2.5 rounded-xl border bg-surface text-left transition disabled:cursor-not-allowed disabled:opacity-60",
          compact ? "px-2.5 py-1.5" : "px-3 py-2",
          open
            ? "border-sky-300 outline-2 outline-sky-100"
            : "border-border hover:border-slate-300",
        )}
      >
        {selected ? (
          <AgentIcon
            runtimeId={selected.id}
            name={selected.name}
            size={compact ? 24 : 32}
          />
        ) : (
          <span
            className={clsx(
              "grid shrink-0 place-items-center rounded-lg bg-sky-50 text-sky-600",
              compact ? "h-6 w-6" : "h-8 w-8",
            )}
          >
            <Bot size={compact ? 12 : 14} />
          </span>
        )}

        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-ui-caption text-slate-800">
              {selected?.name ?? t("agent.picker.select")}
            </span>
            {selected && selectedScan?.version?.trim() ? (
              <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 font-mono text-ui-2xs leading-none text-emerald-700">
                {selectedScan.version.trim()}
              </span>
            ) : selected && hasScan && selected.id !== "custom" && !selectedScan?.found ? (
              <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-ui-2xs leading-none text-amber-700">
                {t("agent.picker.missing")}
              </span>
            ) : null}
          </span>
          {compact ? null : (
            <span className="mt-0.5 block truncate font-mono text-ui-xs text-slate-400">
              {selected
                ? `${selected.vendor} · ${selectedScan?.resolvedPath || selected.binary}`
                : t("agent.picker.hint")}
            </span>
          )}
        </span>

        <ChevronDown
          size={14}
          className={clsx(
            "shrink-0 text-slate-400 transition",
            open && "rotate-180",
          )}
        />
      </button>

      {open && position
        ? createPortal(
            <>
              <button
                type="button"
                aria-label={t("agent.picker.close")}
                tabIndex={-1}
                className="fixed inset-0 z-[110] cursor-default"
                onClick={close}
              />
              <div
                ref={menuRef}
                role="listbox"
                aria-label={t("agent.picker.select")}
                style={{
                  left: position.left,
                  top: position.top,
                  bottom: position.bottom,
                  width: position.width,
                }}
                className="fixed z-[120] overflow-hidden rounded-xl border border-border bg-surface"
              >
                <div className="border-b border-slate-100 p-1.5">
                  <div className="relative">
                    <Search
                      size={11}
                      className="absolute left-2 top-2 text-slate-400"
                    />
                    <input
                      // 菜单刚打开就聚焦搜索框，43 个运行时可以直接键入过滤。
                      autoFocus
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t("agent.picker.search")}
                      className="h-7 w-full rounded-md border border-border bg-slate-50 pl-6 pr-2 text-ui-xs text-slate-700 transition placeholder:text-slate-300 focus:border-sky-300 focus:bg-surface focus:outline-2 focus:outline-sky-200"
                    />
                  </div>
                </div>

                <div className="max-h-72 overflow-y-auto p-1">
                  {groups.map((group) =>
                    group.items.length > 0 ? (
                      <div key={group.key}>
                        {group.label ? (
                          <div className="px-2 pb-1 pt-2 text-ui-2xs font-normal text-slate-400">
                            {group.label}
                          </div>
                        ) : null}
                        {group.items.map((runtime) => {
                          const checked = runtime.id === value;
                          const version = byRuntime.get(runtime.id)?.version?.trim();
                          return (
                            <button
                              key={runtime.id}
                              type="button"
                              role="option"
                              aria-selected={checked}
                              title={`${runtime.vendor} · ${runtime.description}`}
                              onClick={() => {
                                onChange(runtime.id);
                                close();
                              }}
                              className={clsx(
                                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition",
                                checked ? "bg-sky-50" : "hover:bg-slate-50",
                              )}
                            >
                              <span
                                className={clsx(
                                  "min-w-0 flex-1 truncate text-ui-caption",
                                  checked ? "text-sky-700" : "text-slate-700",
                                )}
                              >
                                {runtime.name}
                              </span>
                              {version ? (
                                <span className="shrink-0 font-mono text-ui-2xs text-slate-400">
                                  {version}
                                </span>
                              ) : null}
                              <span className="grid h-3 w-3 shrink-0 place-items-center">
                                {checked ? (
                                  <Check size={12} className="text-sky-500" />
                                ) : null}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null,
                  )}
                  {empty ? (
                    <div className="px-2 py-3 text-center text-ui-xs text-slate-400">
                      {t("agent.picker.noMatch")}
                    </div>
                  ) : null}
                </div>
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
