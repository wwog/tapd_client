/** shell catalogue: short semantic key -> [zh, en]. */
import type { Catalog } from "../types";

export const shell = {
  /* -- App shell / navigation --------------------------------------------- */
  "mobile.nav.main": ["主导航", "Main navigation"],
  "mobile.nav.back": ["返回", "Back"],
  "mobile.nav.pendingTasks": [
    "{n} 个待处理任务",
    ({ n }) => `${n} pending task${Number(n) === 1 ? "" : "s"}`,
  ],
  /** Product noun; identical in both languages. */
  "mobile.tab.agent": ["Agent", "Agent"],

  "mobile.gate.offlineTitle": ["桌面端掉线", "Desktop offline"],
  "mobile.gate.offlineHint": [
    "无法连接桌面端，恢复网络后重试。",
    "Cannot reach the desktop. Retry once the network is back.",
  ],
  "mobile.gate.notLoggedInHint": [
    "桌面端登录后本页会自动恢复。",
    "This page recovers automatically after you sign in on the desktop.",
  ],
  "mobile.desktop.notLoggedIn": ["桌面端未登录", "Desktop not signed in"],
  "mobile.desktop.offline": ["无法连接桌面端", "Cannot reach the desktop"],

  /* -- Settings ------------------------------------------------------------ */
  "mobile.settings.decrease": ["减小{label}", "Decrease {label}"],
  "mobile.settings.increase": ["增大{label}", "Increase {label}"],
  "mobile.settings.loadErrorHint": [
    "读取桌面端配置失败；改动会回滚并在这里保留错误。",
    "Could not read desktop settings; changes roll back and the error stays here.",
  ],
  "mobile.settings.loadingDesktop": [
    "正在读取桌面端配置…",
    "Reading desktop settings…",
  ],
  "mobile.settings.unpairConfirm": [
    "解除配对后需要重新扫码，确定解除？",
    "You will need to scan the QR code again. Unpair now?",
  ],
  "mobile.settings.desktop": ["桌面端", "Desktop"],
  "mobile.settings.heartbeatHint": [
    "手机每 20 秒向桌面端发送一次心跳；连续两次未送达即显示掉线。",
    "The phone sends a heartbeat to the desktop every 20 seconds; two missed beats in a row show it as offline.",
  ],
  "mobile.settings.presenceOnline": ["在线", "Online"],
  "mobile.settings.presenceOffline": ["掉线", "Offline"],
  "mobile.settings.device": ["设备", "Device"],
  "mobile.settings.desktopVersion": ["桌面版本", "Desktop version"],
  "mobile.settings.lastSync": ["最近同步", "Last sync"],
  "mobile.settings.desktopSettings": ["桌面端配置", "Desktop settings"],
  "mobile.settings.writeBackHint": [
    "改动会立即写回桌面端；失败时恢复原值并显示错误。",
    "Changes are written back to the desktop immediately; failures restore the previous value and show the error.",
  ],
  "mobile.settings.agentExecution": ["Agent 执行", "Agent execution"],
  "mobile.settings.worktreeIsolation": ["Worktree 隔离", "Worktree isolation"],
  "mobile.settings.worktreeBusyHint": [
    "有活跃任务时切换会被桌面端拒绝，等队列清空后再试。",
    "The desktop rejects switching while tasks are active; wait for the queue to clear.",
  ],
  "mobile.settings.worktreeHint": [
    "每个任务在独立 git worktree 中运行，完成后保留提交分支。",
    "Each task runs in its own git worktree and keeps its commit branch afterwards.",
  ],
  "mobile.settings.executionUnits": ["执行单元", "Execution units"],
  "mobile.settings.restoreQueued": ["启动恢复排队", "Resume queue on start"],
  "mobile.settings.restoreQueuedHint": [
    "桌面端重启后，之前排队的任务自动继续；关闭则保留队列但暂停，等你在桌面端手动继续。",
    "After a desktop restart, queued tasks resume automatically; when off, the queue stays but pauses until you resume it on the desktop.",
  ],
  "mobile.settings.defaultRuntime": ["默认运行时", "Default runtime"],
  "mobile.settings.runtimeListHint": [
    "只列出本机已安装（available）的运行时。",
    "Only runtimes installed (available) on this machine are listed.",
  ],
  "mobile.settings.worktreeLockHint": [
    "与桌面端一致的锁：等队列清空后再切换。",
    "Same lock as the desktop: wait for the queue to clear before switching.",
  ],
  "mobile.settings.worktreeQueueBusy": [
    "队列中有任务，完成后才能切换 Worktree。",
    "Tasks are queued. Worktree can be switched only after they finish.",
  ],
  "mobile.settings.newBugNotifications": [
    "新缺陷通知",
    "New bug notifications",
  ],
  "mobile.settings.enableNotifications": ["启用通知", "Enable notifications"],
  "mobile.settings.notificationsOffHint": [
    "关闭后桌面端停止轮询与弹窗，已有待处理通知仍保留。",
    "When off, the desktop stops polling and popups; existing pending notifications stay.",
  ],
  "mobile.settings.pollInterval": ["轮询间隔", "Poll interval"],
  "mobile.settings.newlyAssigned": ["新分配", "Newly assigned"],
  "mobile.settings.newlyAssignedHint": [
    "纯新建且分配给我的缺陷。",
    "Only newly created bugs assigned to me.",
  ],
  "mobile.settings.reassigned": ["转派", "Reassigned"],
  "mobile.settings.reassignedHint": [
    "非新建，但处理人刚刚变成我。",
    "Not new, but the owner just changed to me.",
  ],
  "mobile.settings.reopened": ["重新打开", "Reopened"],
  "mobile.settings.reopenedHint": [
    "状态从其它值变为重新打开。",
    "The status changed to reopened from another value.",
  ],
  "mobile.settings.quietHours": ["免打扰", "Quiet hours"],
  "mobile.settings.quietHoursHint": [
    "时段内只累计待处理通知，不弹窗；时段结束后自动显示。",
    "During these hours notifications only accumulate without popups; they appear when the window ends.",
  ],
  "mobile.settings.hours": ["时段", "Hours"],
  "mobile.settings.quietStart": ["免打扰开始", "Quiet hours start"],
  "mobile.settings.quietEnd": ["免打扰结束", "Quiet hours end"],
  "mobile.settings.to": ["至", "to"],
  "mobile.settings.maxVisible": ["胶囊最多显示", "Max visible in capsule"],
  "mobile.settings.unpairHint": [
    "清除本机的配对会话，桌面端设备列表仍保留记录。",
    "Clears the pairing session on this phone; the desktop device list keeps its record.",
  ],
  "mobile.settings.unpair": ["解除配对", "Unpair"],
  "mobile.settings.starOnGithub": [
    "喜欢的话，去 GitHub star 一下",
    "Like it? Star it on GitHub",
  ],

  /* -- Bug list ------------------------------------------------------------ */
  "mobile.sort.createdDesc": ["创建时间 ↓", "Created ↓"],
  "mobile.sort.createdAsc": ["创建时间 ↑", "Created ↑"],
  "mobile.sort.updatedDesc": ["更新时间 ↓", "Updated ↓"],
  "mobile.sort.updatedAsc": ["更新时间 ↑", "Updated ↑"],
  "mobile.bugs.scope": ["范围", "Scope"],
  "mobile.bugs.mine": ["我的", "Mine"],
  "mobile.bugs.search": ["搜索缺陷", "Search bugs"],
  "mobile.bugs.unresolvedOnly": ["仅未解决", "Unresolved only"],
  "mobile.bugs.filter": ["筛选", "Filter"],
  "mobile.bugs.filterCount": ["筛选 · {n}", "Filter · {n}"],
  "mobile.bugs.sort": ["排序", "Sort"],
  "mobile.bugs.sortHint": [
    "服务端排序：更新时间/创建时间，升/降序。",
    "Server-side sort: updated or created time, ascending or descending.",
  ],
  "mobile.bugs.emptyHint": [
    "调整关键词或筛选后再试。",
    "Change the keyword or filters and try again.",
  ],
  "mobile.bugs.empty": ["没有符合条件的缺陷", "No matching bugs"],
  "mobile.bugs.unassigned": ["未指派", "Unassigned"],
  "mobile.bugs.actionsHint": [
    "查看详情 / 用 Agent 修复",
    "View details / fix with Agent",
  ],
  "mobile.bugs.prevPage": ["上一页", "Previous"],
  "mobile.bugs.nextPage": ["下一页", "Next"],
  "mobile.bugs.totalPages": [
    "共 {n} 页",
    ({ n }) => `${n} page${Number(n) === 1 ? "" : "s"}`,
  ],
  "mobile.bugs.page": ["第 {n} 页", "Page {n}"],
  "mobile.bugs.apply": ["应用", "Apply"],
  "mobile.bugs.statusSelected": [
    "状态（已选 {n}）",
    "Status ({n} selected)",
  ],
  "mobile.bugs.ownerSelected": ["处理人（已选 {n}）", "Owner ({n} selected)"],
  "mobile.bugs.membersHint": [
    "处理人/创建人来自项目成员目录；「我的」范围固定为当前账号，处理人筛选仅在「全部」下生效。",
    'Owners and creators come from the project member directory. "Mine" is always the current account; owner filters only apply to "All".',
  ],
  "mobile.bugs.membersSource": [
    "选项来自项目成员",
    "Options come from project members",
  ],
  "mobile.bugs.viewDetail": ["查看详情", "View details"],
  "mobile.bugs.fixWithAgent": ["用 Agent 修复", "Fix with Agent"],
  "mobile.bugs.enqueueing": ["正在入队…", "Queueing…"],
  "mobile.bugs.enqueue": ["入队", "Queue"],
  "mobile.bugs.severityValue": ["严重程度 {value}", "Severity {value}"],
  "mobile.bugs.ownerValue": ["处理人 {owner}", "Owner {owner}"],
  "mobile.bugs.extraPrompt": ["附加说明", "Additional notes"],
  "mobile.bugs.extraPromptPlaceholder": [
    "给 Agent 的补充说明（可选，支持 Markdown）",
    "Extra instructions for the Agent (optional, Markdown supported)",
  ],
  "mobile.bugs.runtime": ["运行时", "Runtime"],
  "mobile.bugs.runtimeHint": [
    "默认跟随桌面端设置。",
    "Follows the desktop setting by default.",
  ],
  "mobile.bugs.enqueueFailedHint": [
    "入队失败，表单保留可重试。",
    "Queueing failed; your input is kept so you can retry.",
  ],

  /* -- Bug detail ---------------------------------------------------------- */
  "mobile.bugDetail.title": ["缺陷详情", "Bug details"],
  "mobile.bugDetail.deleted": ["已删除", "Deleted"],
  "mobile.bugDetail.missingWorkspace": [
    "缺少工作区参数，请从列表进入",
    "Missing workspace parameter. Open this bug from the list.",
  ],
  "mobile.bugDetail.copyFailed": [
    "复制失败，请手动复制",
    "Copy failed. Copy it manually.",
  ],
  "mobile.bugDetail.created": ["创建", "Created"],
  "mobile.bugDetail.updated": ["更新", "Updated"],
  "mobile.bugDetail.copyLink": ["复制链接", "Copy link"],
  "mobile.bugDetail.claim": ["认领", "Claim"],
  "mobile.bugDetail.changeStatus": ["状态流转", "Change status"],
  "mobile.bugDetail.comment": ["评论", "Comment"],
  "mobile.bugDetail.actionErrorHint": [
    "上一次操作失败的结果，重试成功后消失。",
    "The last action failed; this clears after a retry succeeds.",
  ],
  "mobile.bugDetail.description": ["描述", "Description"],
  "mobile.bugDetail.noDescription": ["暂无描述", "No description"],
  "mobile.bugDetail.comments": [
    "评论（{n}）",
    ({ n }) => `Comment${Number(n) === 1 ? "" : "s"} (${n})`,
  ],
  "mobile.bugDetail.noComments": ["还没有评论", "No comments yet"],
  "mobile.bugDetail.currentStatus": ["当前：{status}", "Current: {status}"],
  "mobile.bugDetail.currentStatusHint": [
    "当前状态 {status}",
    "Current status {status}",
  ],
  "mobile.bugDetail.refreshFailedHint": [
    "刷新失败；关闭后重开会重试。",
    "Refresh failed; close and reopen to retry.",
  ],
  "mobile.bugDetail.loadingTransitions": [
    "正在读取可流转状态…",
    "Reading available statuses…",
  ],
  "mobile.bugDetail.noTransitions": ["没有可流转的状态", "No statuses available"],
  "mobile.bugDetail.noTransitionsHint": [
    "当前状态下没有可流转的目标。",
    "No transitions from the current status.",
  ],
  "mobile.bugDetail.transitionFailedHint": [
    "流转失败，表单保留可重试。",
    "Transition failed; the form stays so you can retry.",
  ],
  "mobile.bugDetail.sending": ["正在发送…", "Sending…"],
  "mobile.bugDetail.commentPlaceholder": ["写下评论…", "Write a comment…"],

  /* -- Pairing ------------------------------------------------------------- */
  "mobile.pair.deviceFallback": ["移动设备", "Mobile device"],
  "mobile.pair.needCode": [
    "需要配对码：请在桌面端左侧栏「移动端伴侣」重新扫码，或先关闭配对码开关",
    'Pairing code required: scan again from "Mobile companion" in the desktop sidebar, or turn off the pairing code first.',
  ],
  "mobile.pair.pairing": ["配对中…", "Pairing…"],
  "mobile.pair.title": ["TAPD 伴侣", "TAPD Companion"],
  "mobile.pair.retry": ["重新配对", "Pair again"],

  /* -- Data layer / notifications ------------------------------------------ */
  "mobile.api.requestFailed": ["请求失败", "Request failed"],
  "mobile.api.badResponse": [
    "桌面端响应异常",
    "Unexpected response from the desktop",
  ],
  "mobile.api.pairingExpired": [
    "配对已失效，请重新扫码",
    "Pairing expired. Scan the code again.",
  ],

  /* -- Agent task statuses -------------------------------------------------- */
  "mobile.status.queued": ["排队中", "Queued"],
  "mobile.status.preparing": ["准备中", "Preparing"],
  "mobile.status.running": ["运行中", "Running"],
  "mobile.status.awaitingApproval": ["待审核", "Awaiting review"],
  "mobile.status.awaitingMerge": ["待合并", "Awaiting merge"],
  "mobile.status.merging": ["合并中", "Merging"],
  "mobile.status.succeeded": ["已完成", "Succeeded"],
  "mobile.status.failed": ["失败", "Failed"],
  "mobile.status.canceled": ["已取消", "Canceled"],

  "mobile.notif.manyWithTitle": [
    "{title} 等 {n} 条新通知",
    "{n} new notifications, including {title}",
  ],
  "mobile.notif.count": [
    "{n} 条新通知",
    ({ n }) => `${n} new notification${Number(n) === 1 ? "" : "s"}`,
  ],

  /* -- Formatting ---------------------------------------------------------- */
  "mobile.time.secondsAgo": ["{n} 秒前", "{n}s ago"],
  "mobile.time.minutesAgo": ["{n} 分钟前", "{n} min ago"],
  "mobile.time.hoursAgo": ["{n} 小时前", "{n}h ago"],
  "mobile.time.seconds": ["{n} 秒", "{n}s"],
  "mobile.time.minutesSeconds": ["{m} 分 {s} 秒", "{m}m {s}s"],
  "mobile.time.hoursMinutes": ["{h} 时 {m} 分", "{h}h {m}m"],
} as const satisfies Catalog;
