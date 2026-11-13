/** workbench layout catalogue: short semantic key -> [zh, en]. */
import type { Catalog } from "../types";

export const layout = {
  // ------------------------------------------------------------ panel titles
  "layout.tab.bug": ["缺陷", "Bug"],
  "layout.tab.terminal": ["终端", "Terminal"],

  // ------------------------------------------------------------ tab actions
  "layout.closeTab": ["关闭标签", "Close tab"],
  "layout.closeOthers": ["关闭其他标签", "Close other tabs"],
  "layout.pinTab": ["保持打开", "Keep open"],
  "layout.previewHint": ["预览标签，双击可保持打开", "Preview tab - double-click to keep it open"],
  "layout.maximize": ["最大化组", "Maximize group"],
  "layout.restore": ["还原布局", "Restore layout"],
  "layout.sashReset": ["双击复位", "Double-click to reset"],
  "layout.cornerSash": ["拖动调整横向与纵向尺寸", "Drag to resize both axes"],
  "layout.noTabs": ["没有打开的标签", "No open tabs"],

  // ------------------------------------------------------------- tab drag
  "layout.dropCenter": ["放入标签栏", "Add to tab strip"],
  "layout.dropLeft": ["向左分屏", "Split left"],
  "layout.dropRight": ["向右分屏", "Split right"],
  "layout.dropTop": ["向上分屏", "Split up"],
  "layout.dropBottom": ["向下分屏", "Split down"],
  "layout.dragHint": ["拖动标签可移动到其他区域", "Drag the tab to move it to another area"],
} as const satisfies Catalog;
