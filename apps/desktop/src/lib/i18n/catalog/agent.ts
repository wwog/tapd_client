/**
 * Agent page catalogue: sessions, stream, runtime states and the agent's own
 * configuration tab. Explanations live in `title`, so most entries are labels.
 */
import type { Catalog } from "../types";

export const agent = {
  // Tabs.
  "agent.tab.tasks": ["任务", "Tasks"],
  "agent.tab.config": ["配置", "Configuration"],

  // Task list.
  "agent.session.new": ["新建会话", "New session"],
  "agent.session.delete": ["删除会话", "Delete conversation"],
  "agent.session.deleteHint": [
    "删除「{title}」及其对话记录？此操作无法撤销。",
    "Delete “{title}” and its history? This cannot be undone.",
  ],
  "agent.task.noProject": ["未关联项目", "No project"],
  "agent.task.untitled": ["新会话", "New session"],
  "agent.task.empty": ["还没有任务", "No tasks yet"],
  "agent.task.emptyHint": [
    "在缺陷页点「用 Agent 修复」，或在事项页点「交给 Agent」创建任务。",
    "Use \"Fix with agent\" on a bug, or \"Hand to Agent\" on a work item.",
  ],
  "agent.task.loadFailed": ["任务列表读取失败", "Could not load tasks"],
  "agent.task.workflowRunning": ["进行中", "Running"],
  "agent.task.workflowAwaitingReview": ["待审核", "In review"],
  "agent.task.workflowAwaitingMerge": ["待合并", "To merge"],
  "agent.task.workflowDone": ["已完成", "Done"],
  "agent.task.workflowFailed": ["失败", "Failed"],
  "agent.task.workflowCanceled": ["已取消", "Canceled"],
  "agent.task.live": ["运行中", "Running"],
  "agent.task.needsInput": ["{count} 项待处理", "{count} waiting for you"],

  // Task actions.
  "agent.task.fix": ["修复", "Fix"],
  "agent.task.changes": ["{files} 个文件", "{files} files"],
  "agent.task.changesHint": ["相对任务起点的改动", "Changes since the task started"],
  "agent.task.viewDiff": ["查看改动", "View changes"],
  "agent.task.hideDiff": ["收起改动", "Hide changes"],
  "agent.task.diffEmpty": ["没有改动", "No changes"],
  "agent.task.diffTruncated": [
    "改动过大，只显示前一部分。",
    "The diff is too large; only the first part is shown.",
  ],
  "agent.task.approve": ["通过并提交", "Approve and commit"],
  "agent.task.cancelStash": ["停止并储藏", "Stop and stash"],
  "agent.task.merge": ["合并回主仓库", "Merge into the repository"],
  "agent.task.cancel": ["取消任务", "Cancel task"],
  "agent.task.stop": ["停止", "Stop"],
  "agent.task.openExport": ["打开导出目录", "Open export folder"],

  // Team board (P5).
  "agent.team.toggle": ["团队协作", "Team mode"],
  "agent.team.toggleHint": [
    "开启后主 Agent 会把可拆分的工作派给同事，并在任务板登记。",
    "The lead agent hands splittable work to coworkers and registers it on the board.",
  ],
  "agent.team.viewChat": ["会话", "Chat"],
  "agent.team.viewBoard": ["任务板", "Board"],
  "agent.team.lead": ["协调者", "Coordinator"],
  "agent.team.colPending": ["待分配", "Pending"],
  "agent.team.colInProgress": ["进行中", "In progress"],
  "agent.team.colCompleted": ["已完成", "Done"],
  "agent.team.unassigned": ["未分配", "Unassigned"],
  "agent.team.blocked": ["{n} 项阻塞", "{n} blocked"],
  "agent.team.ready": ["可开始", "Ready"],
  "agent.team.moreScopes": ["+{n}", "+{n}"],
  "agent.team.empty": ["任务板为空", "No board tasks"],
  "agent.team.emptyHint": [
    "团队协作开启后，主 Agent 会把可拆分的工作登记在这里。",
    "With team mode on, the lead agent registers splittable work here.",
  ],
  "agent.team.loadFailed": ["任务板读取失败", "Could not load the board"],

  // Enqueue sheet (bug footer, bug row, local item row).
  "agent.enqueue.bugHint": ["导出缺陷并交给 Agent 修复", "Export the bug and let the agent fix it"],
  "agent.enqueue.placeholder": [
    "补充说明（可选）",
    "Extra instructions (optional)",
  ],
  "agent.enqueue.hint": [
    "说明会追加到任务提示词。",
    "Appended to the task prompt.",
  ],

  // Stream.
  "agent.stream.noSession": ["还没有选择会话", "No session selected"],
  "agent.stream.noSessionHint": [
    "从左侧选择会话，或新建一个会话。",
    "Pick a session on the left, or create one.",
  ],
  "agent.stream.empty": ["还没有消息", "No messages yet"],
  "agent.stream.emptyHint": [
    "在下方输入任务，Enter 发送。",
    "Describe the task below; Enter sends it.",
  ],
  "agent.stream.loadFailed": ["会话记录读取失败", "Could not load the conversation"],
  "agent.turn.working": ["工作中 {duration}", "Working for {duration}"],
  "agent.turn.workingPlain": ["工作中", "Working"],
  "agent.turn.worked": ["已工作 {duration}", "Worked for {duration}"],
  "agent.turn.trace": ["轨迹", "Trace"],
  "agent.turn.expand": ["展开这一轮的轨迹", "Show the trace of this turn"],
  "agent.turn.collapse": ["收起这一轮的轨迹", "Hide the trace of this turn"],
  "agent.turn.reads": ["查阅 {count} 项", "{count} reads"],
  "agent.turn.commands": ["执行 {count} 命令", "{count} commands"],
  "agent.turn.searches": ["搜索 {count} 次", "{count} searches"],
  "agent.turn.files": ["修改 {count} 文件", "{count} files"],
  "agent.turn.summarySeparator": ["，", ", "],
  "agent.turn.failed": ["本轮失败", "This turn failed"],
  "agent.turn.blocked": ["本轮被策略拦截", "This turn was blocked"],
  "agent.turn.aborted": ["已停止这一轮", "This turn was stopped"],

  // One tool call as one timeline row.
  "agent.action.thinking": ["正在思考", "Thinking"],
  "agent.action.ran": ["已执行", "Ran"],
  "agent.action.read": ["已读取", "Read"],
  "agent.action.viewed": ["已查看", "Viewed"],
  "agent.action.wrote": ["已写入", "Wrote"],
  "agent.action.edited": ["已编辑", "Edited"],
  "agent.action.searched": ["已搜索", "Searched"],
  "agent.action.searchedWeb": ["已搜索网页", "Searched the web"],
  "agent.action.fetched": ["已获取", "Fetched"],
  "agent.action.called": ["调用了", "Called"],
  "agent.action.runningBash": ["正在执行", "Running"],
  "agent.action.runningRead": ["正在读取", "Reading"],
  "agent.action.runningViewed": ["正在查看", "Viewing"],
  "agent.action.runningWrote": ["正在写入", "Writing"],
  "agent.action.runningEdited": ["正在编辑", "Editing"],
  "agent.action.runningSearched": ["正在搜索", "Searching"],
  "agent.action.runningFetched": ["正在访问", "Fetching"],
  "agent.action.runningCalled": ["正在调用", "Calling"],
  "agent.action.failed": ["执行失败", "Failed"],
  "agent.thinking": ["思考", "Reasoning"],

  // Token usage.
  "agent.usage.chip": ["用量 {tokens} tok", "Usage {tokens} tok"],
  "agent.usage.hint": [
    "这一条回复的用量；dsh 按消息上报，回复结束才更新。",
    "What this reply cost; dsh reports it per message, so it settles when the reply ends.",
  ],
  "agent.usage.title": ["本轮用量", "This reply"],
  "agent.usage.route": ["提供方 / 模型", "Provider / model"],
  "agent.usage.cacheHit": ["缓存命中", "Cache hit"],
  "agent.usage.input": ["未缓存输入", "Uncached input"],
  "agent.usage.cacheRead": ["缓存读取", "Cache read"],
  "agent.usage.output": ["输出", "Output"],
  "agent.usage.total": ["合计", "Total"],
  "agent.usage.tokens": ["{tokens} tok", "{tokens} tok"],
  "agent.stats.turns": ["{turns} 轮 {steps} 步", "{turns} turns, {steps} steps"],
  "agent.stats.turnsLabel": ["轮 / 步", "Turns / steps"],
  "agent.stats.speed": ["{speed} tok/s", "{speed} tok/s"],
  "agent.stats.tokens": ["{tokens} tok", "{tokens} tok"],
  "agent.stats.cache": ["缓存命中 {percent}%", "cache {percent}%"],
  "agent.stats.percent": ["{percent}%", "{percent}%"],
  "agent.stats.title": ["会话统计", "Session stats"],
  "agent.stats.modelTime": ["模型用时", "Model time"],
  "agent.stats.ttft": ["首 token 平均", "Avg TTFT"],
  "agent.stats.tps": ["输出速度", "Output speed"],
  "agent.stats.seconds": ["{seconds} 秒", "{seconds}s"],
  "agent.stats.minutes": [
    "{minutes} 分 {seconds} 秒",
    "{minutes}m {seconds}s",
  ],
  "agent.stats.hint": [
    "本会话累计：轮 / 步、上一段生成速度、总 token、输入缓存命中率、上下文占用。点开看明细。",
    "Session totals: turns/steps, last generation speed, total tokens, cache hit rate, context used. Click for details.",
  ],

  // Token usage of the whole session (the dock's second figure).
  "agent.usage.sessionTitle": ["Token 用量", "Token usage"],

  // Context composition (the dock's ring).
  "agent.context.title": ["上下文", "Context"],
  "agent.context.hint": [
    "最近一次请求占用的上下文窗口，以及系统提示词、工具定义、对话消息各自的估算用量。",
    "Context window used by the latest request, split into system prompt, tool definitions and messages.",
  ],
  "agent.context.used": ["上下文已用 {percent}%", "Context used {percent}%"],
  "agent.context.window": ["{used} / {window}", "{used} / {window}"],
  "agent.context.system": ["系统提示词", "System prompt"],
  "agent.context.tools": ["工具定义", "Tool definitions"],
  "agent.context.messages": ["对话消息", "Messages"],
  "agent.context.pending": [
    "等待运行时的用量统计…",
    "Waiting for the runtime's meter…",
  ],
  "agent.context.unknown": ["待统计", "Not measured"],
  // The split only exists for a live request; history keeps the totals.
  "agent.context.splitPending": [
    "这几项的占比在下一次请求后更新",
    "The split updates with the next request",
  ],

  // Composer.
  "agent.composer.placeholder": ["描述要做什么…", "Describe the task…"],
  "agent.composer.hint": ["Enter 发送，Shift+Enter 换行", "Enter sends, Shift+Enter adds a line"],

  // Runtime states (also used as the composer's disabled explanation).
  "agent.runtime.stopped": ["正在准备运行时", "Preparing the runtime"],
  "agent.runtime.starting": ["运行时启动中", "Runtime starting"],
      "agent.runtime.stateFailed": ["运行时状态读取失败", "Could not read the runtime status"],
  "agent.runtime.nodeMissing": ["未找到 Node.js", "Node.js not found"],
  "agent.runtime.nodeMissingHint": [
    "内置 Agent 需要系统安装 Node.js 24.9 或更高版本，应用不打包 Node。",
    "The built-in agent needs Node.js 24.9 or newer installed; the app does not bundle Node.",
  ],
  "agent.runtime.modelMissing": ["未配置模型 API", "Model API is not configured"],
  "agent.runtime.modelMissingHint": [
    "在「配置」里填写 API 地址与模型后重新启动。",
    "Set the API address and model in Configuration, then start again.",
  ],
  "agent.runtime.payloadMissing": ["运行时文件缺失", "Runtime files are missing"],
  "agent.runtime.payloadMissingHint": [
    "首次启动需要解压约 230 MB 的运行时文件，通常 6–25 秒。如果解压失败，请重新安装应用。",
    "First launch unpacks about 230 MB of runtime files, usually 6-25 seconds. If unpacking fails, reinstall the app.",
  ],
  "agent.runtime.failed": ["运行时启动失败", "Runtime failed to start"],
  "agent.runtime.prepare": ["解压运行时", "Unpack runtime"],
  "agent.runtime.preparing": ["正在解压运行时 {seconds}s", "Unpacking runtime {seconds}s"],
  "agent.runtime.preparingHint": [
    "只解压一次；完成前不要退出应用。",
    "This runs once; keep the app open until it finishes.",
  ],
  "agent.runtime.config": ["前往配置", "Open configuration"],

  // Approvals and questions.
  "agent.approval.title": ["需要确认", "Needs confirmation"],
  "agent.approval.hint": [
    "运行时请求执行一个工具；只有「允许一次」才会执行。",
    "The runtime asks to run a tool; only Allow once executes it.",
  ],
  "agent.approval.allow": ["允许一次", "Allow once"],
  "agent.approval.reject": ["拒绝", "Reject"],
  "agent.question.step": ["问题 {index}/{total}", "Question {index} of {total}"],
  "agent.question.skip": ["跳过本题", "Skip"],
  "agent.question.skipHint": [
    "跳过表示这一题不选择任何选项。",
    "Skipping answers this question with no selection.",
  ],
  "agent.question.custom": ["其他答案", "Other answer"],
  "agent.question.dismiss": ["取消提问", "Dismiss"],
  "agent.question.dismissHint": [
    "取消会结束这次提问，不等于同意。",
    "Dismissing ends the request; it is not an approval.",
  ],

  // Configuration tab.
  "agent.config.loadFailed": ["配置读取失败", "Could not load configuration"],
  "agent.config.model": ["模型", "Model"],
  "agent.config.modelHint": [
    "每个供应商一套 API;改动即时保存,重启运行时后使用新的模型。",
    "One API per provider; changes save as you type and apply after a runtime restart.",
  ],
  "agent.config.baseUrl": ["Base URL", "Base URL"],
  "agent.config.baseUrlHint": [
    "网关基础地址，不含具体资源路径；Anthropic 与 Gemini 的地址形态不同。",
    "Gateway base address without the resource path; Anthropic and Gemini gateways differ.",
  ],
  "agent.config.apiKey": ["API Key", "API Key"],
  "agent.config.apiKeyHint": [
    "保存在本机 agent.json（明文），只经环境变量传给运行时，不写进日志。",
    "Stored locally in agent.json (plain text); passed to the runtime only through an environment variable and never logged.",
  ],

  // Model providers.
  "agent.model.providers": ["供应商", "Providers"],
  "agent.model.addProvider": ["添加供应商", "Add provider"],
  "agent.model.newProvider": ["新供应商", "New provider"],
  "agent.model.providerName": ["名称", "Name"],
  "agent.model.enabled": ["启用", "Enabled"],
  "agent.model.removeProvider": ["删除供应商", "Remove provider"],
  "agent.model.removeProviderHint": [
    "它下面的模型会一起删除。",
    "Its models are removed with it.",
  ],
  "agent.model.apiFormat": ["API 格式", "API format"],
  "agent.model.protocolCompletions": [
    "Chat Completions (/chat/completions)",
    "Chat Completions (/chat/completions)",
  ],
  "agent.model.protocolResponses": ["Responses (/responses)", "Responses (/responses)"],
  "agent.model.protocolAnthropic": [
    "Anthropic Messages (/v1/messages)",
    "Anthropic Messages (/v1/messages)",
  ],
  "agent.model.protocolGoogle": ["Google Generative AI", "Google Generative AI"],
  "agent.model.models": ["模型列表", "Models"],
  "agent.model.addModel": ["添加模型", "Add model"],
  "agent.model.editModel": ["编辑模型", "Edit model"],
  "agent.model.removeModel": ["删除模型", "Remove model"],
  "agent.model.noProviders": ["还没有供应商", "No providers yet"],
  "agent.model.noModels": ["还没有模型", "No models yet"],
  "agent.model.noModelsHint": [
    "运行时至少需要一个启用的模型。",
    "The runtime needs at least one enabled model.",
  ],
  "agent.model.default": ["默认", "Default"],
  "agent.model.setDefault": ["设为默认模型", "Use as the default model"],
  "agent.model.pick": ["选择模型", "Select model"],
  "agent.model.pickTitle": ["模型", "Model"],
  "agent.model.manage": ["管理模型", "Manage models"],
  "agent.model.noAvailable": ["还没有可用模型", "No model available yet"],
  "agent.model.orderHint": [
    "拖动调整顺序;第一个供应商的默认模型用于新会话",
    "Drag to reorder; the first provider's default model starts new sessions",
  ],
  "agent.model.reasoningEffort": ["思考强度", "Reasoning effort"],
  "agent.model.reasoningAuto": ["自动", "Auto"],
  "agent.model.edit": ["编辑", "Edit"],
  "agent.model.reasoning": ["推理", "Reasoning"],
  "agent.model.inputText": ["文本", "Text"],
  "agent.model.inputTextLocked": ["文本是必选输入。", "Text is always accepted."],
  "agent.model.inputImage": ["图片", "Image"],
  "agent.model.modelId": ["模型 ID", "Model ID"],
  "agent.model.modelIdPlaceholder": ["模型 ID", "Model ID"],
  "agent.model.idRequired": ["模型 ID 不能为空", "Model ID is required"],
  "agent.model.idDuplicate": ["这个模型已经在列表里了", "That model is already listed"],
  "agent.model.contextWindow": ["上下文窗口", "Context window"],
  "agent.model.maxTokens": ["最大输出 Token", "Max output tokens"],
  "agent.model.optional": ["可留空", "Optional"],
  "agent.model.advanced": ["高级配置", "Advanced"],
  "agent.model.inputTypes": ["输入类型", "Input types"],
  "agent.model.reasoningLevels": ["推理等级", "Reasoning levels"],
  "agent.model.reasoningMapping": ["推理参数映射", "Reasoning parameter mapping"],
  "agent.model.addLevel": ["添加等级", "Add level"],
  "agent.model.removeLevel": ["删除等级", "Remove level"],
  "agent.model.wirePlaceholder": ["发到线上的参数值", "Value sent upstream"],
  "agent.config.prompt": ["提示词模板", "Prompt template"],
  "agent.config.promptHint": [
    "附加到每一次任务。",
    "Appended to every task.",
  ],
  "agent.config.worktree": ["Worktree 隔离", "Worktree isolation"],
  "agent.config.worktreeHint": [
    "每个任务在独立的 git worktree 中运行。",
    "Each task runs in its own git worktree.",
  ],
  "agent.config.units": ["执行单元", "Execution units"],
  "agent.config.unitsHint": [
    "同时运行的任务数，1–8；关闭 worktree 时固定为 1。",
    "Concurrent tasks, 1-8; fixed at 1 when worktree isolation is off.",
  ],
  "agent.config.permission": ["权限模式", "Permission mode"],
  "agent.config.permissionHint": [
    "规则在执行前判定；切换后需要重启运行时。",
    "Rules are checked before each call; a change needs a runtime restart.",
  ],
  "agent.config.permissionAuto": ["自主", "Autonomous"],
  "agent.config.permissionAutoHint": [
    "只有风险操作才询问。",
    "Only risky operations ask for approval.",
  ],
  "agent.config.permissionNotify": ["变更前通知", "Notify before changes"],
  "agent.config.permissionNotifyHint": [
    "全部放行，执行前推一条通知。",
    "Everything is allowed; a notice is sent before it runs.",
  ],
  "agent.config.permissionFull": ["完全访问", "Full access"],
  "agent.config.permissionFullHint": [
    "除硬黑名单外全部放行。",
    "Everything except the hard blocklist is allowed.",
  ],
  "agent.config.restartRequired": [
    "配置已修改，重启运行时后生效",
    "Settings changed; takes effect after a runtime restart",
  ],
  "agent.config.restartRuntime": ["重启运行时", "Restart runtime"],
  "agent.config.restartBusy": [
    "重启会中断正在运行的会话，之后需要重新发送。确定继续？",
    "Restarting interrupts running conversations; you will need to resend. Continue?",
  ],
  "agent.config.coworkers": ["同事", "Coworkers"],
  "agent.config.coworkersHint": [
    "打开后启用智能体团队,同事一起加入;重启运行时后生效。",
    "Turning this on enables the agent team and its coworkers; applied after a runtime restart.",
  ],
  "agent.config.runtime": ["运行时", "Runtime"],
  "agent.config.runtimeHint": ["只读的运行时信息。", "Read-only runtime facts."],
  "agent.config.payloadVersion": ["Payload 版本", "Payload version"],
  "agent.config.node": ["Node", "Node"],
  "agent.config.nodePath": ["Node 路径", "Node path"],
  "agent.config.provider": ["Provider", "Provider"],
  "agent.config.currentModel": ["当前模型", "Current model"],
} as const satisfies Catalog;
