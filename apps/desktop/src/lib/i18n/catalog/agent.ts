/** agent catalogue: short semantic key -> [zh, en]. */
import type { Catalog } from "../types";

export const agent = {
  // Task status labels.
  "agent.status.queued": ["排队中", "Queued"],
  "agent.status.queuedPosition": ["排队中 #{position}", "Queued #{position}"],
  "agent.status.preparing": ["准备中", "Preparing"],
  "agent.status.running": ["运行中", "Running"],
  "agent.status.awaitingApproval": ["待审核", "Pending review"],
  "agent.status.awaitingMerge": ["待合并", "Pending merge"],
  "agent.status.merging": ["合并中", "Merging"],
  "agent.status.succeeded": ["已完成", "Completed"],
  "agent.status.canceled": ["已取消", "Canceled"],
  "agent.status.fixing": ["修复中", "Fixing"],
  "agent.status.desktop": ["桌面 Agent {status}", "Desktop agent {status}"],

  // Elapsed time (lib/activity.ts).
  "agent.elapsed.daysHours": ["{days}天 {hours}小时", "{days}d {hours}h"],
  "agent.elapsed.days": ["{days}天", "{days}d"],
  "agent.elapsed.hoursMinutes": ["{hours}小时 {minutes}分钟", "{hours}h {minutes}m"],
  "agent.elapsed.hours": ["{hours}小时", "{hours}h"],
  "agent.elapsed.minutesSeconds": ["{minutes}分钟 {seconds}秒", "{minutes}m {seconds}s"],
  "agent.elapsed.seconds": ["{seconds}秒", "{seconds}s"],
  "agent.activity.createdElapsed": [
    "{time} 创建 · 已用 {elapsed}",
    "Created {time}, elapsed {elapsed}",
  ],

  // Shared labels.
  "agent.untitled": ["（无标题）", "(Untitled)"],
  "agent.noRepo": ["未配置仓库", "No repository configured"],
  "agent.openBug": ["打开缺陷", "Open bug"],
  "agent.view.chat": ["对话", "Chat"],
  "agent.view.terminal": ["终端", "Terminal"],

  // Queue pane and toolbar.
  "agent.queue.title": ["执行队列", "Queue"],
  "agent.queue.empty": ["队列为空", "Queue is empty"],
  "agent.queue.emptyHint": [
    "在缺陷详情点击「用 Agent 修复」后会排在这里",
    'Tasks queued by "Fix with agent" in bug details appear here',
  ],
  "agent.queue.running": ["正在运行", "Running"],
  "agent.queue.queuedCount": ["排队中 {count}", "Queued {count}"],
  "agent.queue.position": ["排队第 {position} 位", "Queue position {position}"],
  "agent.queue.enqueuedAt": ["入队 {time}", "Queued {time}"],
  "agent.queue.cancel": ["取消排队", "Cancel queued task"],
  "agent.queue.ahead": [
    "前面还有 {count} 个任务；开始后 opencode 终端会显示在这里。",
    ({ count }) =>
      `${count} task${Number(count) === 1 ? "" : "s"} ahead; the opencode terminal appears here once it starts.`,
  ],
  "agent.queue.next": [
    "下一个就轮到它；开始后 opencode 终端会显示在这里。",
    "It is next; the opencode terminal appears here once it starts.",
  ],
  "agent.queue.pausedHint": [
    "队列已暂停，点击右上角「继续队列」恢复执行。",
    'The queue is paused; click "Resume queue" at the top right to continue.',
  ],
  "agent.queue.resume": ["继续队列", "Resume queue"],
  "agent.queue.refresh": ["刷新任务状态", "Refresh task status"],

  "agent.toolbar.expand": ["展开{name}", "Expand {name}"],
  "agent.toolbar.collapse": ["收起{name}", "Collapse {name}"],
  "agent.toolbar.expandAuto": [
    "展开{name}（空间不足时会自动收起）",
    "Expand {name} (auto-collapses when space runs out)",
  ],
  "agent.toolbar.collapseDetail": [
    "收起{name}，把宽度留给{detail}",
    "Collapse {name} to give {detail} the width",
  ],
  "agent.tab.run": ["运行", "Run"],
  "agent.tab.pending": ["待处理", "Pending"],
  "agent.tab.history": ["历史", "History"],
  "agent.tab.config": ["配置", "Config"],
  "agent.counts.running": [
    "{active} 运行 · {queued} 排队 · {awaiting} 待处理",
    "{active} running, {queued} queued, {awaiting} pending",
  ],
  "agent.counts.runningPaused": [
    "{active} 运行 · {queued} 排队 · {awaiting} 待处理 · 队列已暂停",
    "{active} running, {queued} queued, {awaiting} pending, queue paused",
  ],

  // Timeline.
  "agent.timeline.title": ["执行流程", "Timeline"],
  "agent.timeline.truncated": ["已截断", "Truncated"],
  "agent.timeline.waiting": ["等待 Agent 输出…", "Waiting for agent output…"],
  "agent.timeline.empty": ["暂无执行记录", "No execution records"],

  // Agent page.
  "agent.page.noRunning": ["当前没有运行中的任务", "No task is running"],
  "agent.page.notStarted": ["任务尚未开始", "Task has not started"],
  "agent.page.pendingCount": [
    "有 {count} 个任务待处理",
    ({ count }) => `${count} task${Number(count) === 1 ? "" : "s"} waiting`,
  ],
  "agent.page.emptyHint": [
    "在缺陷详情点击「用 Agent 修复」后，任务会出现在这里；已结束的任务在「历史」里可以打开系统终端继续处理。",
    'Tasks appear here after you click "Fix with agent" in bug details; finished tasks can be continued in a system terminal from History.',
  ],
  "agent.page.stdinHint": [
    "任务开始后，opencode TUI 会直接显示在这里，可以像命令行一样操作。",
    "Once the task starts, the opencode TUI shows here and works like a command line.",
  ],
  "agent.storage.warning": [
    "任务变更会保留在内存中并在下次写入时重试，但重启前可能丢失。",
    "Task changes stay in memory and are retried on the next write, but may be lost before a restart.",
  ],
  "agent.merge.commitFailed": [
    "提交轮失败，请查看执行记录",
    "Commit round failed, check the execution record",
  ],
  "agent.review.stoppedStashed": ["已停止并储藏改动", "Stopped and stashed changes"],

  // Config pane.
  "agent.config.defaultAgent": ["默认 Agent", "Default agent"],
  "agent.config.defaultAgentHint": [
    "缺陷详情的「用 Agent 修复」与修复队列默认使用这个运行时。",
    '"Fix with agent" in bug details and the fix queue use this runtime by default.',
  ],
  "agent.config.lastChecked": ["上次检测 {time}", "Last checked {time}"],
  "agent.config.neverChecked": ["尚未检测本机 Agent", "Local agents not checked yet"],
  "agent.config.check": ["检测", "Check"],
  "agent.config.readingRuntimes": ["正在读取运行时…", "Reading runtimes…"],
  "agent.config.loadingRuntimes": ["读取 Agent 运行时…", "Reading agent runtimes…"],
  "agent.config.notFound": [
    "该 Agent 未在本机 PATH 中检测到。安装后点「刷新检测」，或把下方的可执行路径改成绝对路径。",
    'This agent was not found on your PATH. Install it and click "Refresh check", or set the executable path below to an absolute path.',
  ],
  "agent.config.runtimeOptions": ["运行参数", "Run settings"],
  "agent.config.runtimeOptionsHint": [
    "默认模型与访问权限；提交任务时仍可按任务覆盖，留空表示用 CLI 默认值。",
    "Default model and access level; per-task overrides still apply, and empty means the CLI default.",
  ],
  "agent.config.model": ["默认模型", "Default model"],
  "agent.config.modelPlaceholder": [
    "留空使用运行时的默认模型",
    "Leave empty for the runtime default",
  ],
  "agent.config.permission": ["访问权限", "Access level"],
  "agent.config.lifecycle": ["生命周期", "Lifecycle"],
  "agent.config.needsHuman": ["需人工", "Needs a human"],
  "agent.config.terminalStage": ["终态", "Terminal"],
  "agent.config.capabilities": ["能力声明", "Capabilities"],
  "agent.config.interactiveTerminal": ["终端交互", "Terminal interaction"],
  "agent.config.interactiveTerminalHint": [
    "PTY 输出与键盘输入",
    "PTY output and keyboard input",
  ],
  "agent.config.permissionPrompt": ["权限请求", "Permission prompts"],
  "agent.config.permissionPromptHint": [
    "运行时可暂停等待授权",
    "The runtime can pause for approval",
  ],
  "agent.config.desktopReply": ["桌面回执", "Desktop replies"],
  "agent.config.desktopReplyHint": [
    "桌面/通知窗口的确认能被运行时接受",
    "Confirmations from the desktop or notification window are accepted",
  ],
  "agent.config.commitReview": ["提交前审核", "Pre-commit review"],
  "agent.config.commitReviewHint": [
    "复杂改动可暂停等待审核",
    "Complex changes can pause for review",
  ],
  "agent.config.limitations": ["互通限制", "Interop limits"],
  "agent.config.fallback": ["无法互操作时", "When interop fails"],

  // Runtime settings form.
  "agent.settings.autoSave": ["{name} · 修改后自动保存", "{name} - saved automatically"],
  "agent.settings.title": ["运行时参数", "Runtime settings"],
  "agent.settings.detectVersion": ["检测版本", "Detect version"],
  "agent.settings.binaryPath": ["{name} 可执行路径", "{name} executable path"],
  "agent.settings.launch": ["启动方式", "Launch command"],
  "agent.settings.promptPlaceholder": ["<提示词>", "<prompt>"],
  "agent.settings.promptInjected": [
    "（启动后注入提示词）",
    "(prompt injected after launch)",
  ],
  "agent.settings.promptTemplate": ["提示词模板", "Prompt template"],
  "agent.settings.promptVarsHint": [
    "变量会替换为缺陷信息；{{coworker}} 来自同事页启用的同事（没有插槽时自动追加）。",
    "Variables are replaced with bug data; {{coworker}} comes from the coworkers enabled on that page (appended when the template has no slot).",
  ],
  "agent.settings.variableSupport": [
    "支持变量：{variables}",
    "Supported variables: {variables}",
  ],
  "agent.settings.coworkersEnabled": [
    "当前启用 {count} 位同事，任务开始时填入",
    ({ count }) =>
      `${count} coworker${Number(count) === 1 ? "" : "s"} enabled, filled in when a task starts`,
  ],
  "agent.settings.coworkerAutoAppend": [
    "；模板没有该变量时自动追加。",
    "; appended automatically when the template omits it",
  ],
  "agent.settings.advanced": ["高级", "Advanced"],
  "agent.settings.readyQuiet": ["就绪静默（ms）", "Ready quiet (ms)"],
  "agent.settings.readyQuietHint": [
    "输出静默达到该时长后注入任务",
    "Inject the task after output is quiet for this long",
  ],
  "agent.settings.readyTimeout": ["就绪超时（ms）", "Ready timeout (ms)"],
  "agent.settings.readyTimeoutHint": ["超时后强制注入", "Inject anyway after the timeout"],
  "agent.settings.idleComplete": ["静默完成（ms）", "Idle complete (ms)"],
  "agent.settings.idleCompleteHint": [
    "TUI 运行时输出静默多久视为本轮结束；0 表示关闭",
    "How long TUI output silence ends the round; 0 disables it",
  ],

  // Runtime picker.
  "agent.picker.found": ["已检测到", "Detected"],
  "agent.picker.missing": ["未检测到", "Not detected"],
  "agent.picker.custom": ["自定义", "Custom"],
  "agent.picker.select": ["选择 Agent", "Select agent"],
  "agent.picker.hint": [
    "运行时决定用哪个 Agent 修复缺陷",
    "The runtime decides which agent fixes the bug",
  ],
  "agent.picker.close": ["关闭 Agent 选择", "Close agent picker"],
  "agent.picker.search": ["搜索 Agent", "Search agents"],
  "agent.picker.noMatch": ["没有匹配项", "No matches"],

  // Execution card.
  "agent.exec.title": ["Agent 执行", "Agent execution"],
  "agent.exec.hint": [
    "控制本地 Agent 任务的并行方式与代码隔离。",
    "Controls parallelism and code isolation for local agent tasks.",
  ],
  "agent.exec.reading": ["正在读取配置…", "Reading config…"],
  "agent.exec.worktreeHint": [
    "每个任务在独立 git worktree 中运行，完成后保留提交分支。",
    "Each task runs in its own git worktree and keeps its commit branch.",
  ],
  "agent.exec.worktree": ["Worktree 隔离", "Worktree isolation"],
  "agent.exec.worktreeOnHint": [
    "允许 1–8 个任务并行，默认 2。",
    "Run 1-8 tasks in parallel, 2 by default.",
  ],
  "agent.exec.worktreeOffHint": ["关闭 Worktree 时固定为 1。", "Fixed at 1 when worktree is off."],
  "agent.exec.units": ["执行单元", "Execution units"],
  "agent.exec.restoreHint": [
    "客户端重启后，之前排队的任务自动继续；关闭则保留队列但暂停，等你手动继续。",
    "Queued tasks resume after a restart; when off, the queue is kept but paused until you resume it.",
  ],
  "agent.exec.restore": ["启动恢复排队", "Resume queue on launch"],
  "agent.exec.queueBusy": [
    "队列中有任务，完成后才能切换 Worktree。",
    "Tasks are queued; finish them before switching worktree.",
  ],

  // Task header.
  "agent.header.startedAt": ["开始于 {time}", "Started {time}"],
  "agent.header.selectionHint": ["Option+拖动选中文本", "Option+drag to select text"],
  "agent.header.subagents": [
    "{count} 个子 Agent",
    ({ count }) => `${count} subagent${Number(count) === 1 ? "" : "s"}`,
  ],
  "agent.header.stop": ["中断", "Stop"],
  "agent.header.openExport": ["打开导出目录", "Open export folder"],

  // Approval queue.
  "agent.approval.list": ["待处理列表", "Pending list"],
  "agent.approval.detail": ["处理详情", "Pending details"],
  "agent.approval.banner": [
    "有待处理任务。Worktree 任务不会阻塞新任务；停止审核会储藏改动并暂停队列。",
    "Tasks are pending. Worktree tasks do not block new tasks; stopping a review stashes changes and pauses the queue.",
  ],
  "agent.approval.pausedHint": [
    "队列已暂停：审核任务不会自动继续。处理完后可手动恢复。",
    "Queue paused: reviews do not resume automatically. Resume manually when done.",
  ],
  "agent.approval.title": ["待处理任务", "Pending tasks"],
  "agent.approval.count": ["{count} 个", "{count}"],
  "agent.approval.empty": ["没有待处理的任务", "No pending tasks"],
  "agent.approval.files": [
    "{count} 个文件",
    ({ count }) => `${count} file${Number(count) === 1 ? "" : "s"}`,
  ],
  "agent.approval.emptyHint": [
    "Worktree 任务的改动会在这里等待审核，通过后再确认合并；停止会把本次涉及的文件储藏到 git stash 并暂停队列，代码不会丢。",
    "Worktree changes wait here for review, then for merge confirmation; stopping stashes the files in git stash and pauses the queue, so no code is lost.",
  ],
  "agent.approval.hideDiff": ["收起改动", "Hide changes"],
  "agent.approval.viewDiff": ["查看改动", "View changes"],
  "agent.approval.exportDir": ["导出目录", "Export folder"],
  "agent.approval.reviewSummaryWorktree": [
    "Agent 已完成修改，等待审核后合并。",
    "The agent finished its changes and waits for review before merging.",
  ],
  "agent.approval.reviewSummary": [
    "Agent 已暂停，等待确认后提交。",
    "The agent is paused, waiting for confirmation to commit.",
  ],
  "agent.approval.filesChanged": ["涉及文件 {count} 个", "Files changed: {count}"],
  "agent.approval.risk": ["风险：{risk}", "Risk: {risk}"],
  "agent.approval.diffTitle": ["相对任务起点的差异", "Diff since the task started"],
  "agent.approval.diffHint": [
    "只包含已跟踪文件；未跟踪文件见上方列表",
    "Tracked files only; untracked files are listed above",
  ],
  "agent.approval.readingDiff": ["正在读取差异…", "Reading diff…"],
  "agent.approval.approveHintWorktree": [
    "通过后进入合并确认，再用原 Agent 合并回主仓库；停止会取消任务，未提交改动存入 git stash，已提交分支保留。",
    "Approving moves to merge confirmation, then the original agent merges into the main repo; stopping cancels the task, stashes uncommitted changes in git stash and keeps the committed branch.",
  ],
  "agent.approval.approveHint": [
    "通过会重新入队，Agent 只做核对、提交与 TAPD 回写；停止会把本次涉及的文件储藏到 git stash 并暂停队列。",
    "Approving requeues the task so the agent only verifies, commits and writes back to TAPD; stopping stashes the files in git stash and pauses the queue.",
  ],
  "agent.approval.approveMerge": ["通过并进入合并", "Approve and merge"],
  "agent.approval.approveCommit": ["通过并提交", "Approve and commit"],
  "agent.approval.stopTask": ["停止任务", "Stop task"],
  "agent.approval.stopStash": ["停止并储藏", "Stop and stash"],
  "agent.approval.mergeSummary": [
    "审核已通过。确认后会使用原 Agent 把分支合并到主仓库；合并成功才算完成。",
    "Review passed. Confirming merges the branch into the main repo with the original agent; the task is done only after a successful merge.",
  ],
  "agent.approval.mergeSteps": ["手动合并步骤", "Manual merge steps"],
  "agent.approval.mergeHint": [
    "合并由原 Agent 在主仓库执行；分支尚未合并时可用「我已手动合并」校验。",
    'The original agent merges in the main repo; use "I merged manually" to verify when the branch is not merged yet.',
  ],
  "agent.approval.mergeWithAgent": ["用原 Agent 合并", "Merge with original agent"],
  "agent.approval.mergedManually": ["我已手动合并", "I merged manually"],
  "agent.approval.cancelTask": ["取消任务", "Cancel task"],

  // History.
  "agent.history.list": ["执行记录列表", "History list"],
  "agent.history.detail": ["记录详情", "Record details"],
  "agent.history.filterWorkspace": ["按工作区筛选", "Filter by workspace"],
  "agent.history.allWorkspaces": ["全部工作区", "All workspaces"],
  "agent.history.filterStatus": ["按状态筛选", "Filter by status"],
  "agent.history.allStatuses": ["全部状态", "All statuses"],
  "agent.history.search": ["搜索标题或缺陷 ID", "Search title or bug ID"],
  "agent.history.recordCount": [
    "{count} 条记录",
    ({ count }) => `${count} record${Number(count) === 1 ? "" : "s"}`,
  ],
  "agent.history.empty": ["没有匹配的执行记录", "No matching execution records"],
  "agent.history.loadMore": [
    "加载更多（已显示 {shown} / {total}）",
    "Load more ({shown} of {total} shown)",
  ],
  "agent.history.selectHint": [
    "选择左侧记录查看详情",
    "Select a record on the left to see details",
  ],
  "agent.history.workspace": ["工作区", "Workspace"],
  "agent.history.bugId": ["缺陷 ID", "Bug ID"],
  "agent.history.source": ["来源", "Source"],
  "agent.history.startedAt": ["开始时间", "Started"],
  "agent.history.finishedAt": ["结束时间", "Finished"],
  "agent.history.exitCode": ["退出码", "Exit code"],
  "agent.history.workdir": ["工作目录", "Working directory"],
  "agent.history.repo": ["仓库", "Repository"],
  "agent.history.branch": ["分支", "Branch"],
  "agent.history.error": ["错误", "Error"],
  "agent.history.prompt": ["提示词", "Prompt"],
  "agent.history.emptyValue": ["（空）", "(Empty)"],
  "agent.history.chatTitle": ["对话 · {title}", "Chat: {title}"],
  "agent.history.deleteTitle": ["删除执行记录", "Delete execution record"],
  "agent.history.deleteConfirm": [
    "将删除「{title}」的本地执行记录，删除后无法恢复。",
    'This deletes the local execution record for "{title}" and cannot be undone.',
  ],
  "agent.history.deleteHint": [
    "只删除本地记录，不影响导出目录、缺陷内容和已提交的代码。",
    "Only the local record is deleted; the export folder, bug content and committed code are untouched.",
  ],
  "agent.history.openTerminal": ["打开系统终端", "Open system terminal"],
  "agent.history.viewChat": ["查看对话", "View chat"],
  "agent.history.actions": ["执行记录快捷操作", "Execution record actions"],
  "agent.history.deleteRecord": ["删除记录", "Delete record"],
} as const satisfies Catalog;
