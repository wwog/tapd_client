/** terminal catalogue: short semantic key -> [zh, en]. */
import type { Catalog } from "../types";

export const terminal = {
  // ------------------------------------------------------------------ panel
  "terminal.toggleShow": ["打开终端", "Open terminal"],
  "terminal.toggleHide": ["收起终端", "Hide terminal"],
  "terminal.shortcutHint": ["终端（⌘J）", "Terminal (⌘J)"],
  "terminal.new": ["新建终端", "New terminal"],
  "terminal.exited": ["进程已退出", "Process exited"],
  "terminal.restart": ["重新启动", "Restart"],

  // ----------------------------------------------------------------- errors
  "terminal.loadFailed": ["读取终端列表失败", "Couldn't load terminals"],
  "terminal.limit": ["最多同时打开 8 个终端", "Up to 8 terminals can be open"],
  "terminal.replayFailed": ["读取终端输出失败", "Couldn't read the terminal output"],
} as const satisfies Catalog;
