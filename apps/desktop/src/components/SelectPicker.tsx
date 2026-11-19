import { Fragment, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check, ChevronDown, Search } from "lucide-react";

import { useDismiss } from "../hooks/useDismiss";
import { t } from "../lib/i18n";
import { computeMenuPosition, type MenuPosition } from "../lib/menuPosition";
import { ScrollingName } from "./ScrollingName";

export type SelectOption = {
  value: string;
  label: string;
  /** 触发行与菜单的副行说明（路径、权限说明等）。 */
  description?: string;
  /** 非空时在菜单里按值分组显示小标题（例如「最近使用」）。 */
  group?: string;
};

type Props = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** 没有选中项时触发行的副行提示。 */
  emptyHint?: string;
  /** 触发行左侧图标；紧凑模式下只显示图标本身。 */
  leadingIcon?: ReactNode;
  /** 单行紧凑触发行（模型 / 权限）；默认两行（项目）。 */
  compact?: boolean;
  /** 菜单顶部带搜索框。 */
  searchable?: boolean;
  /** 允许把搜索框里输入的内容作为新值（模型）。 */
  allowCustom?: boolean;
  /** 菜单底部提示（例如模型列表读取中 / 读取失败）。 */
  menuHint?: string;
  disabled?: boolean;
  placement?: "down" | "up";
  title?: string;
  className?: string;
};

/**
 * 与 `AgentPicker` 同一套视觉的门户选择器：触发行 + 固定定位菜单。
 *
 * 项目 / 权限 / 模型这类选项用原生 `<select>` 时，macOS 的弹层样式和界面
 * 完全脱节；这里统一成带图标、副行说明和选中标记的列表。
 */
export function SelectPicker(props: Props) {
  const {
    value,
    options,
    onChange,
    placeholder = t("common.select"),
    emptyHint,
    leadingIcon,
    compact = false,
    searchable = false,
    allowCustom = false,
    menuHint,
    disabled = false,
    placement = "down",
    title,
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

  // 自定义模型值不在选项里时，直接用值本身展示。
  const selected =
    options.find((option) => option.value === value) ??
    (value ? { value, label: value } : null);
  const description = selected?.description ?? emptyHint;

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      `${option.label} ${option.description ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [options, query]);

  const queryText = query.trim();
  const custom =
    allowCustom && queryText
      ? options.some(
          (option) =>
            option.label.toLowerCase() === queryText.toLowerCase() ||
            option.value.toLowerCase() === queryText.toLowerCase(),
        )
        ? null
        : queryText
      : null;

  const openMenu = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(computeMenuPosition(rect, { placement }));
    setQuery("");
    setOpen(true);
  };

  const choose = (next: string) => {
    onChange(next);
    close();
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (custom) {
      choose(custom);
      return;
    }
    if (shown[0]) choose(shown[0].value);
  };

  return (
    <div data-component="SelectPicker" className={clsx("relative", className)}>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected?.description ?? title}
        onClick={() => (open ? close() : openMenu())}
        className={clsx(
          "flex w-full items-center border bg-surface text-left transition disabled:cursor-not-allowed disabled:opacity-60",
          compact
            ? "h-9 gap-2 rounded-xl px-2.5"
            : "gap-2.5 rounded-xl px-3 py-2",
          open
            ? "border-sky-300 outline-2 outline-sky-100"
            : "border-border hover:border-slate-300",
        )}
      >
        {leadingIcon ? (
          <span
            className={clsx(
              "grid shrink-0 place-items-center",
              compact
                ? "text-slate-400"
                : "h-8 w-8 rounded-lg bg-slate-100 text-slate-500",
            )}
          >
            {leadingIcon}
          </span>
        ) : null}

        <span className="min-w-0 flex-1">
          <span
            className={clsx(
              "block truncate",
              compact
                ? "text-ui-caption text-slate-700"
                : "text-ui-caption text-slate-800",
            )}
          >
            {selected?.label ?? placeholder}
          </span>
          {!compact && description ? (
            <span className="mt-0.5 block truncate font-mono text-ui-xs text-slate-400">
              {description}
            </span>
          ) : null}
        </span>

        <ChevronDown
          size={compact ? 13 : 14}
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
                aria-label={t("common.picker.close")}
                tabIndex={-1}
                className="fixed inset-0 z-[110] cursor-default"
                onClick={close}
              />
              <div
                ref={menuRef}
                role="listbox"
                aria-label={placeholder}
                style={{
                  left: position.left,
                  top: position.top,
                  bottom: position.bottom,
                  width: position.width,
                  maxHeight: position.maxHeight,
                }}
                className="fixed z-[120] flex flex-col overflow-hidden rounded-xl border border-border bg-surface"
              >
                {searchable ? (
                  <div className="shrink-0 border-b border-slate-100 p-1.5">
                    <div className="relative">
                      <Search
                        size={11}
                        className="absolute left-2 top-2 text-slate-400"
                      />
                      <input
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={onSearchKeyDown}
                        placeholder={
                          allowCustom ? t("common.picker.searchOrTypeModel") : t("common.search")
                        }
                        className="h-7 w-full rounded-md border border-border bg-slate-50 pl-6 pr-2 text-ui-xs text-slate-700 transition placeholder:text-slate-300 focus:bg-surface"
                      />
                    </div>
                  </div>
                ) : null}

                <div className="min-h-0 flex-1 overflow-y-auto p-1">
                  {custom ? (
                    <button
                      type="button"
                      onClick={() => choose(custom)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-slate-50"
                    >
                      <ScrollingName
                        text={t("common.picker.useValue", { value: custom })}
                        className="min-w-0 flex-1 text-ui-caption text-slate-700"
                      />
                    </button>
                  ) : null}

                  {shown.map((option, index) => {
                    const active = option.value === value;
                    // 分组变化时插入小标题；搜索过滤后仍保持分组清晰。
                    const groupLabel =
                      option.group && option.group !== shown[index - 1]?.group
                        ? option.group
                        : null;
                    return (
                      <Fragment key={`${option.value}-${index}`}>
                        {groupLabel ? (
                          <div className="px-2 pb-1 pt-2 text-ui-2xs font-normal text-slate-400">
                            {groupLabel}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          onClick={() => choose(option.value)}
                          className={clsx(
                            "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition",
                            active ? "bg-sky-50" : "hover:bg-slate-50",
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <ScrollingName
                              text={option.label}
                              className={clsx(
                                "text-ui-caption",
                                active ? "text-sky-700" : "text-slate-700",
                              )}
                            />
                            {option.description ? (
                              <ScrollingName
                                text={option.description}
                                className="mt-0.5 text-ui-2xs text-slate-400"
                              />
                            ) : null}
                          </span>
                          <span className="grid h-3 w-3 shrink-0 place-items-center">
                            {active ? (
                              <Check size={12} className="text-sky-500" />
                            ) : null}
                          </span>
                        </button>
                      </Fragment>
                    );
                  })}

                  {shown.length === 0 && !custom ? (
                    <div className="px-2 py-3 text-center text-ui-xs text-slate-400">
                      {t("common.noMatch")}
                    </div>
                  ) : null}
                </div>

                {menuHint ? (
                  <div className="shrink-0 border-t border-slate-100 px-2 py-1.5 text-ui-2xs text-slate-400">
                    {menuHint}
                  </div>
                ) : null}
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
