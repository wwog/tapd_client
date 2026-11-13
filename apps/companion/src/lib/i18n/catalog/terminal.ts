/** terminal catalogue: short semantic key -> [zh, en]. */
import type { Catalog } from "../types";

export const terminal = {
  "mobile.terminal.title": ["终端", "Terminal"],
  "mobile.terminal.new": ["新建终端", "New terminal"],
  "mobile.terminal.empty": ["还没有终端", "No terminals yet"],
  "mobile.terminal.emptyHint": [
    "在这里或桌面端新建一个",
    "Start one here or on the desktop",
  ],
  "mobile.terminal.loading": ["正在读取终端…", "Reading terminals…"],
  "mobile.terminal.loadFailed": ["读取终端失败", "Couldn't load terminals"],
  "mobile.terminal.createFailed": ["新建终端失败", "Couldn't start a terminal"],
  "mobile.terminal.closeFailed": ["关闭终端失败", "Couldn't close the terminal"],
  "mobile.terminal.close": ["关闭终端", "Close terminal"],
  "mobile.terminal.exited": ["进程已退出", "Process exited"],

  "mobile.terminal.connecting": ["连接中…", "Connecting…"],
  "mobile.terminal.connected": ["已连接", "Connected"],
  "mobile.terminal.reconnecting": ["重新连接中…", "Reconnecting…"],
  "mobile.terminal.disconnected": ["连接已断开", "Disconnected"],

  "mobile.terminal.keyboard": ["键盘", "Keyboard"],
  "mobile.terminal.ctrl": ["Ctrl", "Ctrl"],
  "mobile.terminal.keyEsc": ["Esc", "Esc"],
  "mobile.terminal.keyTab": ["Tab", "Tab"],
  "mobile.terminal.keyUp": ["上", "Up"],
  "mobile.terminal.keyDown": ["下", "Down"],
  "mobile.terminal.keyLeft": ["左", "Left"],
  "mobile.terminal.keyRight": ["右", "Right"],

  "mobile.terminal.composerPlaceholder": [
    "输入命令，回车发送",
    "Type a command, Enter to send",
  ],
  "mobile.terminal.send": ["发送", "Send"],
  "mobile.terminal.lineMode": ["行输入", "Line input"],
  "mobile.terminal.directMode": ["直通", "Direct"],
  "mobile.terminal.modeHint": [
    "行输入：在本机编辑整行，回车一次性发送，打字不受网络延迟影响；直通：按键实时发送，适合 vim 等全屏程序",
    "Line input: edit the whole line locally and send on Enter, so typing is unaffected by latency. Direct: send every key, for full-screen apps like vim.",
  ],

  "mobile.terminal.sessionEnded": ["终端已结束", "Terminal ended"],
  "mobile.terminal.sessionEndedHint": [
    "桌面端重启，或这个会话已经被关闭",
    "The desktop restarted, or this session was closed",
  ],
  "mobile.terminal.backToList": ["返回终端列表", "Back to terminals"],
  "mobile.terminal.hideInput": ["隐藏输入", "Hide input"],
  "mobile.terminal.showInput": ["显示输入", "Show input"],
  "mobile.terminal.keysCollapse": ["收起按键条", "Hide key row"],
  "mobile.terminal.keysExpand": ["展开按键条", "Show key row"],
  "mobile.terminal.chooseFolder": ["选择目录", "Choose folder"],
  "mobile.terminal.homeFolder": ["家目录", "Home folder"],
  "mobile.terminal.projectFolders": ["项目目录", "Project folders"],
  "mobile.terminal.sessionTerminated": [
    "无法连接这个终端",
    "Couldn't connect to this terminal",
  ],
} as const satisfies Catalog;
