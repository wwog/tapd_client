/** shell catalogue: short semantic key -> [zh, en]. */
import type { Catalog } from "../types";

export const shell = {
  // App shell and view headers
  "app.startup.loading": ["正在启动客户端…", "Starting the app…"],
  "app.account.title": ["账户与会话", "Account & sessions"],
  "app.account.signedIn": ["已登录", "Signed in"],
  "app.projects.skeleton": ["正在加载项目…", "Loading projects…"],
  "app.projects.loadFailed": ["项目列表加载失败", "Couldn't load the project list"],
  "app.projects.reload": ["重新加载", "Reload"],
  "app.projects.keepOne": ["至少保留一个项目", "Keep at least one project"],
  "app.copy.failed": ["复制失败：{error}", "Copy failed: {error}"],

  // Project list column
  "app.sidebar.expand": ["展开项目列表", "Show project list"],
  "app.sidebar.collapse": ["收起项目列表", "Hide project list"],
  "app.sidebar.expandNarrow": [
    "展开项目列表（窗口过窄，会自动收起）",
    "Show project list (window too narrow, collapses automatically)",
  ],

  // Navigation rail
  "app.nav.agent": ["Agent", "Agent"],
  "app.nav.mcp": ["MCP", "MCP"],
  "app.nav.coworker": ["同事", "Coworkers"],
  "app.nav.companion": ["移动端伴侣", "Mobile companion"],

  // Title bar and update entry points
  "app.update.available": ["发现新版本 v{version}", "New version v{version} available"],
  "app.update.newVersion": ["新版本 v{version}", "New version v{version}"],
  "app.update.changelog": ["更新日志", "Changelog"],
  "app.update.openAccount": ["点击前往账户页更新", "Open the account page to update"],

  // Open-with split button (project folder and file viewer)
  "app.open.with": ["用{app}打开 {path}", "Open {path} with {app}"],
  "app.open.defaultApp": ["默认应用", "Default app"],
  "app.open.chooseAppFor": ["选择打开方式", "Choose how to open"],
  "app.open.withList": ["用以下应用打开", "Open with"],
  "app.open.noApps": ["没有可用的应用", "No apps available"],

  // Shared controls
  "app.dialog.close": ["关闭{title}", "Close {title}"],
  "app.avatar.alt": ["用户头像", "User avatar"],
  "app.avatar.namedAlt": ["{name} 的头像", "{name}'s avatar"],
  "app.segmented.unsupported": [
    "该运行时暂不支持对话视图",
    "Chat view is unavailable for this runtime",
  ],

  // Detail pane actions and toasts
  "app.claim.noUser": [
    "未能识别当前用户，无法认领",
    "Cannot identify the current user, so the bug cannot be claimed",
  ],
  "app.claim.done": ["已认领", "Claimed"],
  "app.comment.posted": ["评论已发表", "Comment posted"],
  "app.detail.developerUpdated": ["开发人员已更新", "Developer updated"],
  "app.detail.ownerUpdated": ["处理人已更新", "Owner updated"],
  "app.detail.statusChanged": ["状态已流转为「{label}」", 'Status changed to "{label}"'],

  // Native dialogs
  "app.export.chooseDir": ["选择导出目录", "Choose export folder"],

  // Island capsule
  "app.island.updateAvailable": ["可更新 v{version}", "Update available: v{version}"],
  "app.island.connecting": ["连接中", "Connecting"],
  "app.island.notificationsPaused": ["通知已暂停", "Notifications paused"],
  "app.island.syncError": ["同步异常", "Sync error"],
  "app.island.pending": ["待处理", "Pending"],
  "app.island.standby": ["待命", "Standby"],
  "app.island.tipNotifications": [
    "单击展开通知 · 双击打开客户端 · 可拖动",
    "Click to expand notifications, double-click to open the app, drag to move",
  ],
  "app.island.tipOpen": [
    "双击打开客户端 · 可拖动",
    "Double-click to open the app, drag to move",
  ],
  "app.island.empty": ["暂无待处理通知", "No pending notifications"],
  "app.island.dismiss": ["关闭（忽略）", "Close (ignore)"],
  "app.island.priority": ["{priority}优先级", "{priority} priority"],
  "app.island.creator": ["创建人 {creator}", "Creator {creator}"],
  "app.island.handle": ["处理", "Handle"],
  "app.island.fix": ["修复", "Fix"],
  "app.island.viewBug": ["查看缺陷", "View bug"],
  "app.island.progress": ["进度", "Progress"],
  "app.aiTone.info": ["提示信息", "Info"],
  "app.aiTone.warning": ["警告", "Warning"],
  "app.aiTone.progress": ["进行中", "In progress"],

  // Update capsule
  "app.update.failed": ["更新失败", "Update failed"],
  "app.update.failedDetail": [
    "下载或安装过程中出现错误。",
    "Something went wrong while downloading or installing.",
  ],
  "app.update.manual": ["手动下载", "Download manually"],
  "app.update.downloading": ["正在下载更新", "Downloading update"],
  "app.update.unpacking": ["正在解包并安装", "Unpacking and installing"],
  "app.update.installing": ["安装中", "Installing"],
  "app.update.done": ["更新完成", "Update complete"],
  "app.update.restartSoon": ["应用即将重启…", "The app will restart shortly…"],
  "app.update.verifying": [
    "校验更新包并写入应用目录…",
    "Verifying the update and writing it to the app folder…",
  ],
  "app.update.mainWindowLocked": [
    "更新期间主窗口不可打开",
    "The main window cannot be opened during the update",
  ],
} as const satisfies Catalog;
