/** bugs catalogue: short semantic key -> [zh, en]. */
import type { Catalog } from "../types";

export const bugs = {
  // ------------------------------------------------------------------ list
  "bugs.scopeMine": ["我负责的", "Mine"],
  "bugs.scopeProcessing": ["处理中", "In progress"],
  "bugs.noCurrentUser": [
    "未能识别当前用户，暂按全部查询",
    "Could not identify the current user, showing all bugs",
  ],
  "bugs.searchPlaceholder": ["搜索标题或 ID", "Search title or ID"],
  "bugs.searchHint": [
    "支持标题关键词、完整 ID 或列表里的短 ID",
    "Matches title keywords, a full ID, or the short ID shown in the list",
  ],
  "bugs.clearFilters": ["清除筛选", "Clear filters"],
  "bugs.columnsAndSort": ["显示列与排序", "Columns and sorting"],
  "bugs.columnsTitle": ["显示列 · 拖动排序", "Columns · Drag to reorder"],
  "bugs.dragToReorder": ["拖动排序", "Drag to reorder"],
  "bugs.reorderColumn": ["拖动排序 {label}", "Reorder {label}"],
  "bugs.hideColumn": ["隐藏 {label}", "Hide {label}"],
  "bugs.showColumn": ["显示 {label}", "Show {label}"],
  "bugs.refreshList": ["刷新列表", "Refresh list"],
  "bugs.pager.summary": [
    "第 {page} / {total} 页 · 共 {count} 条",
    ({ page, total, count }) =>
      `Page ${page} of ${total} · ${count} item${Number(count) === 1 ? "" : "s"}`,
  ],
  "bugs.pager.previous": ["上一页", "Previous"],
  "bugs.pager.next": ["下一页", "Next"],
  "bugs.offlineSnapshot": ["离线数据 · 上次同步 {time}", "Offline data · Last synced {time}"],
  "bugs.loadFailed": ["缺陷加载失败", "Failed to load bugs"],
  "bugs.loadingList": ["正在读取缺陷列表", "Loading bug list"],
  "bugs.processingLoadFailed": [
    "正在处理的缺陷加载失败，请稍后重试。",
    "Failed to load the bugs in progress. Try again later.",
  ],
  "bugs.emptyProcessing": ["当前没有正在处理的缺陷", "No bugs in progress"],
  "bugs.emptyMine": ["你名下没有符合条件的缺陷", "No bugs assigned to you match the filters"],
  "bugs.emptyAll": ["没有符合条件的缺陷", "No bugs match the filters"],
  "bugs.emptyHintFilters": ["试试清除部分筛选条件。", "Try clearing some filters."],
  "bugs.emptyProcessingHint": [
    "内部 Agent 开始处理后会出现在这里。",
    "Bugs appear here once the internal agent starts working on them.",
  ],
  "bugs.emptyHintFiltersAll": [
    "试试清除部分筛选条件，或切换到「全部」。",
    'Try clearing some filters, or switch to "All".',
  ],
  "bugs.emptyProject": [
    "当前项目的缺陷列表为空，或视图权限不足。",
    "This project has no bugs, or the view permission is insufficient.",
  ],

  // ------------------------------------------------------ status fallbacks
  "bugs.status.new": ["新", "New"],
  "bugs.status.inProgress": ["接受/处理", "Accepted/in progress"],
  "bugs.status.resolved": ["已解决", "Resolved"],
  "bugs.status.verified": ["已验证", "Verified"],
  "bugs.status.reopened": ["重新打开", "Reopened"],

  // -------------------------------------------------------- priorities etc.
  "bugs.priority.urgent": ["紧急", "Urgent"],
  "bugs.priority.high": ["高", "High"],
  "bugs.priority.medium": ["中", "Medium"],
  "bugs.priority.low": ["低", "Low"],
  "bugs.priority.insignificant": ["无关紧要", "Insignificant"],
  "bugs.severity.fatal": ["致命", "Fatal"],
  "bugs.severity.serious": ["严重", "Serious"],
  "bugs.severity.normal": ["一般", "Normal"],
  "bugs.severity.prompt": ["提示", "Prompt"],
  "bugs.severity.advice": ["建议", "Advice"],
  "bugs.foundVersion": ["发现版本 {version}", "Found in version {version}"],

  // ------------------------------------------------------------ sort/filter
  "bugs.sortDescending": ["改为 {label} 降序", "Sort {label} descending"],
  "bugs.sortClear": ["取消 {label} 排序", "Clear {label} sort"],
  "bugs.sortAscending": ["按 {label} 升序", "Sort {label} ascending"],
  "bugs.sortBy": ["按 {label} 排序", "Sort by {label}"],
  "bugs.filterBy": ["筛选 {label}", "Filter {label}"],
  "bugs.collapseFilter": ["收起 {label} 筛选", "Collapse {label} filter"],
  "bugs.closeFilter": ["关闭筛选", "Close filter"],
  "bugs.matchLabel": ["匹配 {label}", "Match {label}"],
  "bugs.noMatches": ["没有匹配项", "No matches"],

  // ----------------------------------------------------------- row actions
  "bugs.viewAgentTask": ["查看 Agent 任务", "View agent task"],
  "bugs.removeFromQueue": [
    "从 Agent 队列中移除这个任务",
    "Remove this task from the agent queue",
  ],
  "bugs.interruptAgentTask": ["中断当前 Agent 任务", "Interrupt the current agent task"],
  "bugs.cancelAgentTask": ["取消 Agent 任务", "Cancel agent task"],
  "bugs.claimHint": [
    "认领后可以修改处理人/开发人员与流转状态，评论不受限制",
    "Claim this bug to edit the owner/developer and change status; comments stay open",
  ],
  "bugs.claim": ["认领", "Claim"],
  "bugs.claiming": ["认领中", "Claiming"],
  "bugs.fixWith": ["用 {agent} 修复", "Fix with {agent}"],
  "bugs.fixWithAgent": ["用 Agent 修复", "Fix with agent"],
  "bugs.startWithNote": [
    "添加补充说明或资源后启动",
    "Add instructions or resources, then start",
  ],
  "bugs.openInTapd": ["在 TAPD 中打开", "Open in TAPD"],
  "bugs.quickActions": ["缺陷快捷操作", "Bug quick actions"],
  "bugs.copyShortId": ["复制 ID", "Copy ID"],
  "bugs.copiedShortId": ["已复制 ID", "ID copied"],
  "bugs.copyLongId": ["复制长 ID", "Copy long ID"],
  "bugs.copiedLongId": ["已复制长 ID", "Long ID copied"],
  "bugs.copyTitle": ["复制标题", "Copy title"],
  "bugs.copiedTitle": ["已复制标题", "Title copied"],

  // ---------------------------------------------------------------- drawer
  "bugs.copyId": ["复制缺陷 ID", "Copy bug ID"],
  "bugs.detailTitle": ["缺陷详情", "Bug details"],
  "bugs.closeDetail": ["关闭详情", "Close details"],
  "bugs.currentOwner": ["当前处理人：{owner}", "Current owner: {owner}"],
  "bugs.unassigned": ["未分配", "Unassigned"],
  "bugs.claimFirst": [
    "认领后才能修改处理人与开发人员、流转状态。",
    "Claim this bug to change the owner, developer and status.",
  ],
  "bugs.transitions": ["状态流转", "Status transition"],
  "bugs.loadingTransitions": ["正在读取可流转状态…", "Loading available transitions…"],
  "bugs.transitionsFailed": ["流转状态读取失败：{error}", "Failed to load transitions: {error}"],
  "bugs.noTransitions": [
    "当前状态没有可执行的流转",
    "No transitions available from the current status",
  ],
  "bugs.description": ["缺陷描述", "Description"],
  "bugs.noDescription": ["暂无文字描述", "No text description"],
  "bugs.noDescriptionVideo": [
    "暂无文字描述（包含视频，见资源）",
    "No text description (video included, see Resources)",
  ],
  "bugs.embeddedNotice": [
    "描述中包含内嵌图片/视频，已在下方「资源」列出；导出时会下载到 assets 目录。",
    'The description contains embedded images/videos, listed under "Resources" below; exports download them into the assets folder.',
  ],
  "bugs.loadingDetail": ["正在加载缺陷详情", "Loading bug details"],
  "bugs.lastModified": ["最后修改", "Last modified"],
  "bugs.foundVersionLabel": ["发现版本", "Found in version"],
  "bugs.iteration": ["迭代", "Iteration"],
  "bugs.module": ["模块", "Module"],
  "bugs.fixer": ["修复人", "Fixer"],
  "bugs.unspecified": ["未指定", "Not specified"],
  "bugs.chooseFromMembers": ["从项目成员中选择", "Choose from project members"],
  "bugs.customFields": ["自定义字段（{count}）", "Custom fields ({count})"],

  // ---------------------------------------------------------------- footer
  "bugs.exported": [
    "已导出 {count} 个资源 · {size}",
    ({ count, size }) =>
      `Exported ${count} resource${Number(count) === 1 ? "" : "s"} · ${size}`,
  ],
  "bugs.openFolder": ["打开目录", "Open folder"],
  "bugs.copyPath": ["复制路径", "Copy path"],
  "bugs.warningsMore": [
    "{first} 等 {count} 条",
    ({ first, count }) => `${first} and ${Number(count) - 1} more`,
  ],
  "bugs.agentQueued": [
    "该缺陷已在 Agent 队列中，点击查看任务",
    "This bug is already in the agent queue; click to view the task",
  ],
  "bugs.viewTaskLabel": ["{label} · 查看任务", "{label} · View task"],
  "bugs.currentAgent": ["当前 Agent：{name}（{binary}）", "Current agent: {name} ({binary})"],
  "bugs.loadingAgent": ["正在读取当前 Agent", "Loading the current agent"],
  "bugs.exporting": ["导出中…", "Exporting…"],
  "bugs.export": ["导出", "Export"],

  // -------------------------------------------------------------- comments
  "bugs.commentsCount": ["评论（{count}）", "Comments ({count})"],
  "bugs.noComments": ["还没有评论", "No comments yet"],
  "bugs.addComment": ["添加评论", "Add comment"],
  "bugs.commentPlaceholder": [
    "写评论（纯文本，⌘/Ctrl + Enter 发送）",
    "Write a comment (plain text, ⌘/Ctrl + Enter to send)",
  ],
  "bugs.commentChars": [
    "{count} 字",
    ({ count }) => `${count} character${Number(count) === 1 ? "" : "s"}`,
  ],
  "bugs.postComment": ["发表评论", "Post comment"],
  "bugs.deleted": ["已删除", "Deleted"],
  "bugs.emptyComment": ["（空评论）", "(Empty comment)"],

  // --------------------------------------------------------- change history
  "bugs.changesCount": ["变更记录（{count}）", "Change history ({count})"],
  "bugs.changesFailed": [
    "变更记录获取失败：{error}",
    "Failed to load change history: {error}",
  ],
  "bugs.noChanges": ["暂无变更记录", "No change history"],
  "bugs.changesTruncated": [
    "仅显示最近 {shown} 条，共 {total} 条。",
    ({ shown, total }) =>
      `Showing the latest ${shown} of ${total} ${Number(total) === 1 ? "entry" : "entries"}.`,
  ],
  "bugs.noFieldDetails": ["（无字段明细）", "(No field details)"],

  // ------------------------------------------------------------- resources
  "bugs.resourcesCount": ["资源（{count}）", "Resources ({count})"],
  "bugs.noResources": [
    "没有附件或内嵌图片/视频",
    "No attachments or embedded images/videos",
  ],
  "bugs.embeddedCount": [
    "描述 / 评论内嵌（{count}）",
    "Embedded in description / comments ({count})",
  ],
  "bugs.preview": ["预览", "Preview"],
  "bugs.openWith": ["用 {target} 打开", "Open with {target}"],
  "bugs.chooseDefaultApp": ["选择默认打开方式", "Choose default app"],
  "bugs.closeMenu": ["关闭菜单", "Close menu"],
  "bugs.defaultApp": ["默认打开方式", "Default app"],
  "bugs.app": ["应用", "App"],
  "bugs.noApps": ["没有可用的应用", "No apps available"],
  "bugs.image": ["图片", "Image"],
  "bugs.video": ["视频", "Video"],
  "bugs.file": ["文件", "File"],
  "bugs.embeddedResource": ["内嵌资源", "Embedded resource"],
  "bugs.embeddedKind": [
    "{kind} · 描述/评论内嵌",
    "{kind} · Embedded in description/comments",
  ],

  // ------------------------------------------------------------ transition
  "bugs.transitionTo": ["流转到「{label}」", 'Transition to "{label}"'],
  "bugs.transitionFormHint": [
    "按工作流填写本次流转字段。",
    "Fill in the fields this workflow transition requires.",
  ],
  "bugs.loadingForm": ["正在读取流转表单…", "Loading transition form…"],
  "bugs.noFields": ["本次流转无需填写字段。", "No fields are required for this transition."],
  "bugs.fillRequired": ["请填写：{fields}", "Required: {fields}"],
  "bugs.confirmTransition": ["确认流转", "Confirm transition"],
  "bugs.select": ["请选择", "Select"],
  "bugs.readOnly": ["只读", "Read-only"],
  "bugs.multiMembers": ["多个成员用 ; 分隔", "Separate multiple members with ;"],

  // --------------------------------------------------------- relative time
  "bugs.secondsAgo": ["{n} 秒前", "{n}s ago"],
  "bugs.minutesAgo": ["{n} 分钟前", "{n}m ago"],
  "bugs.hoursAgo": ["{n} 小时前", "{n}h ago"],

  // ------------------------------------------------------------- directory
  "bugs.membersFailed": ["处理人列表加载失败：{error}", "Failed to load owners: {error}"],

  // -------------------------------------------------------- dev-only sim
  "bugs.devTest": ["开发测试", "Dev test"],
  "bugs.simQueued": ["模拟本地排队 #1", "Simulate queued locally #1"],
  "bugs.simRunning": ["模拟队头执行", "Simulate running at queue head"],
  "bugs.simClear": ["清除模拟状态", "Clear simulated state"],
} as const satisfies Catalog;
