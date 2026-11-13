/** shell catalogue: short semantic key -> [zh, en]. */
import type { Catalog } from "../types";

export const shell = {
  // App shell and view headers
  "app.startup.loading": ["正在启动客户端…", "Starting the app…"],
  "app.account.title": ["账户与会话", "Account & sessions"],
  "app.account.signedIn": ["已登录", "Signed in"],
  "app.projects.title": ["项目管理", "Project management"],
  "app.projects.empty": ["选择左侧项目开始", "Select a project on the left to start"],
  "app.projects.loading": ["正在读取项目…", "Loading projects…"],
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

  // Agent folder prompt
  "app.agent.noFolder": ["没有配置项目目录", "No project folder configured"],
  "app.agent.noFolderHint": [
    "{name} 还没有设置本地仓库目录。选择后会自动加入 Agent 队列。",
    "{name} has no local repository folder yet. It joins the Agent queue automatically once you choose one.",
  ],
  "app.agent.useAndContinue": ["使用并继续", "Use and continue"],

  // Title bar and update entry points
  "app.titleBar.pending": [
    "{n} 个 Agent 任务待处理",
    ({ n }) => `${n} Agent task${Number(n) === 1 ? "" : "s"} pending`,
  ],
  "app.update.available": ["发现新版本 v{version}", "New version v{version} available"],
  "app.update.newVersion": ["新版本 v{version}", "New version v{version}"],
  "app.update.changelog": ["更新日志", "Changelog"],
  "app.update.openAccount": ["点击前往账户页更新", "Open the account page to update"],

  // Project open button
  "app.open.with": ["用{app}打开 {path}", "Open {path} with {app}"],
  "app.open.defaultApp": ["默认应用", "Default app"],
  "app.open.chooseApp": ["选择打开项目的应用", "Choose the app to open the project"],
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
  "app.detail.resize": ["调整详情面板宽度", "Resize detail pane"],
  "app.detail.resizeHint": ["拖动调整详情面板宽度", "Drag to resize the detail pane"],

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
  "app.export.noDir": ["该任务还没有导出目录", "This task has no export folder yet"],
  "app.export.chooseDir": ["选择导出目录", "Choose export folder"],

  // Island capsule
  "app.island.waitingPermission": ["Agent 等待权限", "Agent waiting for permission"],
  "app.island.waitingAnswer": ["Agent 等待回答", "Agent waiting for an answer"],
  "app.island.waitingConfirm": ["Agent 等待确认", "Agent waiting for confirmation"],
  "app.island.awaitingReview": ["Agent 待审核", "Agent awaiting review"],
  "app.island.awaitingMerge": ["Agent 待合并", "Agent awaiting merge"],
  "app.island.fixing": ["{runtime} 修复中", "{runtime} is fixing the bug"],
  "app.island.updateAvailable": ["可更新 v{version}", "Update available: v{version}"],
  "app.island.connecting": ["连接中", "Connecting"],
  "app.island.notificationsPaused": ["通知已暂停", "Notifications paused"],
  "app.island.syncError": ["同步异常", "Sync error"],
  "app.island.pending": ["待处理", "Pending"],
  "app.island.standby": ["待命", "Standby"],
  "app.island.tipTask": [
    "{status} · 单击打开任务 · 可拖动",
    "{status}: click to open the task, drag to move",
  ],
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
  "app.island.viewBug": ["查看缺陷", "View bug"],
  "app.island.progress": ["进度", "Progress"],
  "app.aiTone.info": ["提示信息", "Info"],
  "app.aiTone.warning": ["警告", "Warning"],
  "app.aiTone.progress": ["进行中", "In progress"],

  // Island Agent peek card
  "app.peek.permission": ["等待权限确认", "Waiting for permission"],
  "app.peek.answer": ["等待回答", "Waiting for an answer"],
  "app.peek.reviewAndMerge": [
    "待审核 {n} · 待合并 {m}",
    "{n} awaiting review, {m} awaiting merge",
  ],
  "app.peek.reviewCount": ["待审核 {n}", "{n} awaiting review"],
  "app.peek.review": ["待审核", "Awaiting review"],
  "app.peek.mergeCount": ["待合并 {n}", "{n} awaiting merge"],
  "app.peek.merge": ["待合并", "Awaiting merge"],
  "app.peek.fixing": ["修复中", "Fixing"],
  "app.peek.preparing": ["正在准备任务…", "Preparing the task…"],
  "app.peek.awaitingConfirm": [
    "Agent 正在等待你的确认。",
    "The Agent is waiting for your confirmation.",
  ],
  "app.peek.answerInTerminal": ["在 Agent 终端中回答", "Answer in the Agent terminal"],
  "app.peek.openDetail": ["打开详情", "Open details"],

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
