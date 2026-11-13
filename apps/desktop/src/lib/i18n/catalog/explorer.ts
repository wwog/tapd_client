/** explorer / file viewer catalogue: short semantic key -> [zh, en]. */
import type { Catalog } from "../types";

export const explorer = {
  // ------------------------------------------------------------- explorer
  "explorer.title": ["资源管理器", "Explorer"],
  "explorer.fileFallback": ["文件", "File"],
  "explorer.noFolder": ["未配置本地文件夹", "No local folder configured"],
  "explorer.noFolderHint": [
    "先在项目设置里选择这个项目的本地文件夹，之后就能在这里浏览代码和图片。",
    "Choose this project's local folder in project settings to browse its code and images here.",
  ],
  "explorer.openFolder": ["选择文件夹", "Choose folder"],
  "explorer.refresh": ["刷新", "Refresh"],
  "explorer.showHidden": ["显示隐藏文件", "Show hidden files"],
  "explorer.loading": ["正在读取目录…", "Loading directory…"],
  "explorer.loadFailed": ["无法读取目录：{error}", "Could not read the directory: {error}"],
  "explorer.emptyDir": ["空文件夹", "Empty folder"],
  "explorer.truncated": [
    "目录条目过多，仅显示前 {n} 项",
    "Too many entries - showing the first {n}",
  ],
  "explorer.root": ["项目根目录", "Project root"],
  "explorer.goUp": ["上一级", "Up one level"],
  "explorer.copyPath": ["复制路径", "Copy path"],
  "explorer.openInApp": ["在编辑器中打开", "Open in editor"],
  "explorer.browse": ["浏览文件", "Browse files"],
  "explorer.browseHint": [
    "在右侧资源管理器中查看这个项目的代码与图片",
    "Browse this project's code and images in the explorer panel",
  ],

  // ----------------------------------------------------------------- file
  "file.loading": ["正在读取文件…", "Loading file…"],
  "file.loadFailed": ["无法读取文件：{error}", "Could not read the file: {error}"],
  "file.truncated": [
    "文件较大，仅显示前 2 MB",
    "Large file - showing the first 2 MB",
  ],
  "file.tooLarge": [
    "文件超过 50 MB，请用系统应用打开",
    "File is larger than 50 MB - open it in a system app",
  ],
  "file.binary": ["二进制文件，无法预览", "Binary file - no preview"],
  "file.wrap": ["自动换行", "Wrap lines"],
  "file.fit": ["适应窗口", "Fit to window"],
  "file.actualSize": ["原始尺寸", "Actual size"],
  "file.copyPath": ["复制路径", "Copy path"],
  "file.openExternal": ["用系统应用打开", "Open in a system app"],
  "file.readOnly": ["只读", "Read-only"],
  "file.markdown": ["预览", "Preview"],
  "file.source": ["源码", "Source"],
} as const satisfies Catalog;
