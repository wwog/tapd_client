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

  // ------------------------------------------------------------- tab drag
  "layout.dropCenter": ["放入标签栏", "Add to tab strip"],
  "layout.unsavedTitle": ["未保存的修改", "Unsaved changes"],
  "layout.unsavedBody": [
    "{name} 有未保存的修改，关闭后会丢失。",
    "{name} has unsaved changes that will be lost when closed.",
  ],
  "layout.discardClose": ["放弃并关闭", "Discard and close"],
  "layout.keepEditing": ["继续编辑", "Keep editing"],
  "layout.unsavedLogout": [
    "退出登录会丢弃未保存的修改。",
    "Signing out will discard unsaved changes.",
  ],
  "layout.unsavedQuit": [
    "退出应用会丢弃未保存的修改。",
    "Quitting will discard unsaved changes.",
  ],
  "layout.logoutAnyway": ["仍要退出登录", "Sign out anyway"],
  "layout.quitAnyway": ["仍要退出", "Quit anyway"],

  // ---------------------------------------------------------- welcome page
  "welcome.hint": [
    "选择一个项目开始，标签都可以关闭。",
    "Pick a project to start. Every tab can be closed.",
  ],
  "welcome.openProject": ["打开 {name}", "Open {name}"],
  "welcome.manageProjects": ["项目管理", "Manage projects"],
  "welcome.openTerminal": ["打开终端", "Open terminal"],
} as const satisfies Catalog;
