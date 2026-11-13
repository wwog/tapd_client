/** workspace catalogue: mobile project file browser (read-only). */
import type { Catalog } from "../types";

export const workspace = {
  /* -- File browser -------------------------------------------------------- */
  "mobile.files.title": ["文件", "Files"],
  "mobile.files.showHidden": ["显示隐藏文件", "Show hidden files"],
  "mobile.files.parent": ["上一级", "Parent folder"],
  "mobile.files.root": ["项目根目录", "Project root"],
  "mobile.files.empty": ["这个文件夹是空的", "This folder is empty"],
  "mobile.files.emptyHint": [
    "换个目录或回到上一级",
    "Try another folder or go up one level",
  ],
  "mobile.files.emptyHidden": ["没有可见文件", "No visible files"],
  "mobile.files.emptyHiddenHint": [
    "打开「隐藏文件」查看以点开头的文件",
    'Turn on "Hidden files" to see dot-prefixed files',
  ],
  "mobile.files.truncated": [
    "目录条目过多，仅显示一部分",
    "Too many entries; only part of the folder is shown",
  ],
  "mobile.files.loadFailed": ["读取目录失败", "Couldn't load folder"],
  "mobile.files.noFolder": [
    "在桌面端项目设置里选择本地文件夹",
    "Choose a local folder in the desktop project settings",
  ],
  "mobile.files.noFolderHint": [
    "打开桌面端的项目设置，为这个项目选择本地文件夹后点刷新。",
    "Choose a local folder for this project in the desktop settings, then refresh.",
  ],
  "mobile.files.noProjects": ["还没有可浏览的项目", "No projects to browse"],
  "mobile.files.noProjectsHint": [
    "先在桌面端登录并选择项目",
    "Sign in on the desktop and pick a project first",
  ],
  "mobile.files.workspaceLoadFailed": [
    "读取项目列表失败",
    "Couldn't load projects",
  ],

  /* -- File preview -------------------------------------------------------- */
  "mobile.files.missingWorkspace": [
    "缺少项目参数",
    "Missing project parameter",
  ],
  "mobile.files.missingPath": ["缺少文件参数", "Missing file parameter"],
  "mobile.files.reading": ["正在读取文件…", "Reading file…"],
  "mobile.files.fileFailed": ["读取文件失败", "Couldn't load file"],
  "mobile.files.copyPath": ["复制路径", "Copy path"],
  "mobile.files.size": ["大小", "Size"],
  "mobile.files.modified": ["修改时间", "Modified"],
  "mobile.files.type": ["类型", "Type"],
  "mobile.files.contentTruncated": [
    "文件较大，仅显示前 2 MB",
    "Large file - showing the first 2 MB",
  ],
  "mobile.files.emptyFile": ["空文件", "Empty file"],
  "mobile.files.openRaw": ["用浏览器打开原文件", "Open raw file in browser"],
  "mobile.files.openImageHint": [
    "点按在新窗口打开原图",
    "Tap to open the original in a new tab",
  ],
  "mobile.files.noPreview": [
    "此文件无法直接预览",
    "This file can't be previewed here",
  ],
  "mobile.files.previewHint": [
    "用浏览器打开原文件查看",
    "Open the raw file in a browser to view it",
  ],
  "mobile.files.kindText": ["文本", "Text"],
  "mobile.files.kindMarkdown": ["Markdown", "Markdown"],
  "mobile.files.kindImage": ["图片", "Image"],
  "mobile.files.kindAudio": ["音频", "Audio"],
  "mobile.files.kindVideo": ["视频", "Video"],
  "mobile.files.kindBinary": ["二进制文件", "Binary file"],
  "mobile.files.kindTooLarge": ["文件过大", "File too large"],
} as const satisfies Catalog;
