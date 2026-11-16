export type MenuPosition = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  /** 按锚点上下剩余空间收窄，菜单永远不会超出窗口。 */
  maxHeight: number;
};

type Options = {
  placement?: "down" | "up";
  /** 菜单最小宽度；锚点更宽时跟随锚点。 */
  minWidth?: number;
  /** 菜单完整高度估算（搜索栏 + 列表）。 */
  fullHeight?: number;
};

/**
 * 门户菜单的固定定位：先判断下方是否放得下，放不下且上方更宽裕时向上
 * 翻转，并把高度限制在可用范围内，避免被窗口边缘裁掉。
 */
export function computeMenuPosition(
  rect: DOMRect,
  options: Options = {},
): MenuPosition {
  const placement = options.placement ?? "down";
  const minWidth = options.minWidth ?? 300;
  const fullHeight = options.fullHeight ?? 340;
  const gap = 6;
  const margin = 8;

  const width = Math.min(
    Math.max(rect.width, minWidth),
    Math.max(0, window.innerWidth - margin * 2),
  );
  const left = Math.min(
    Math.max(margin, rect.left),
    Math.max(margin, window.innerWidth - width - margin),
  );

  const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;
  const wantUp =
    placement === "up"
      ? spaceBelow < Math.min(fullHeight, 320)
      : spaceBelow < fullHeight && spaceAbove > spaceBelow;
  const available = wantUp ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(0, Math.min(fullHeight, available));

  return wantUp
    ? { left, width, bottom: window.innerHeight - rect.top + gap, maxHeight }
    : { left, width, top: rect.bottom + gap, maxHeight };
}
