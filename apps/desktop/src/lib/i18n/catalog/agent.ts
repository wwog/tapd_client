/**
 * Agent page catalogue: sessions, stream, runtime states and the agent's own
 * configuration tab. Explanations live in `title`, so most entries are labels.
 */
import type { Catalog } from "../types";

export const agent = {
  // Settings dialog (opened from the task column footer).
  "agent.tab.config": ["配置", "Configuration"],

  // Task list.
  "agent.session.delete": ["删除会话", "Delete conversation"],
  "agent.session.deleteHint": [
    "删除「{title}」及其对话记录？它自己的 worktree 会一起删掉（未提交的改动也会丢失），仓库不受影响。",
    "Delete “{title}” and its history? Its own worktree is removed too (uncommitted changes are lost); the repository itself is untouched.",
  ],
  "agent.session.reveal": ["在 Finder 中打开", "Reveal in Finder"],
  "agent.session.revealFailed": ["打不开这个目录：{error}", "Cannot open that folder: {error}"],

  // Local files in answers: links, inline code and images open a viewer tab.
  "agent.file.open": ["在文件查看器中打开", "Open in the file viewer"],
  "agent.file.missing": ["找不到这个文件：{path}", "That file was not found: {path}"],
  "agent.file.openFailed": ["打不开这个文件：{error}", "Cannot open that file: {error}"],
  "agent.file.isDir": ["这是一个文件夹", "That path is a folder"],
  "agent.file.sessionRoot": ["会话文件", "Session files"],
  "agent.file.rootRoot": ["本机文件", "Files on this Mac"],

  "agent.task.noProject": ["未关联项目", "No project"],
  "agent.task.untitled": ["新会话", "New session"],
  "agent.task.empty": ["还没有任务", "No tasks yet"],
  "agent.task.emptyHint": [
    "在缺陷页点「用 Agent 修复」，或在事项页点「交给 Agent」创建任务。",
    "Use \"Fix with agent\" on a bug, or \"Hand to Agent\" on a work item.",
  ],
  "agent.task.loadFailed": ["任务列表读取失败", "Could not load tasks"],
  "agent.task.newInProject": ["在「{name}」中新建会话", "New conversation in “{name}”"],
  "agent.task.workflowQueued": ["排队中", "Queued"],
  "agent.task.workflowRunning": ["进行中", "Running"],
  "agent.task.workflowAwaitingReview": ["待审核", "In review"],
  "agent.task.workflowFinalizing": ["收尾中", "Finishing"],
  "agent.task.workflowDone": ["已完成", "Done"],
  "agent.task.workflowFailed": ["失败", "Failed"],
  "agent.task.workflowCanceled": ["已取消", "Canceled"],
  "agent.task.live": ["运行中", "Running"],
  "agent.task.needsInput": ["{count} 项待处理", "{count} waiting for you"],

  // Task actions.
  "agent.task.fix": ["修复", "Fix"],
  "agent.task.changes": ["{files} 个文件", "{files} files"],
  "agent.task.changesHint": ["相对任务起点的改动", "Changes since the task started"],
  "agent.task.hideDiff": ["收起改动", "Hide changes"],
  "agent.task.diffEmpty": ["没有改动", "No changes"],
  "agent.task.diffTruncated": [
    "改动过大，只显示前一部分。",
    "The diff is too large; only the first part is shown.",
  ],
  "agent.task.stop": ["停止", "Stop"],
  "agent.task.openExport": ["打开导出目录", "Open export folder"],

  // Task pane: the workflow task's permanent record.
  "agent.task.tabTask": ["任务", "Task"],
  "agent.task.workspaceRepo": ["主仓库", "Main repository"],
  "agent.task.directHint": [
    "本轮直接在主仓库工作，审核与提交会包含仓库里已有的未提交改动。",
    "This round works in the main repository; review and commit include its existing uncommitted changes.",
  ],
  "agent.task.approveDirectHint": [
    "提交主仓库的改动，然后让 Agent 回写 TAPD（本轮没有合并步骤）。",
    "Commits the main repository's changes, then has the agent write back to TAPD (no merge step this round).",
  ],
  "agent.task.cleanedHint": [
    "worktree 已清理，继续会话在主仓库进行。",
    "The worktree was cleaned up; continuing this session runs in the main repository.",
  ],
  "agent.task.gitStart": ["开始", "Start"],
  "agent.task.gitCommit": ["提交", "Commit"],
  "agent.task.gitMerge": ["合并", "Merge"],
  "agent.task.writeback": ["TAPD 回写", "TAPD write-back"],
  "agent.task.writebackComment": ["评论已写入", "Comment posted"],
  "agent.task.writebackStatus": ["状态 {from} → {to}", "Status {from} → {to}"],
  "agent.task.writebackPending": ["尚未回写", "Not written back yet"],
  "agent.task.doneTitle": ["任务已完成", "Task complete"],
  "agent.task.doneDirectHint": [
    "本轮直接在主仓库完成。",
    "This round finished in the main repository.",
  ],
  "agent.task.doneCleanedHint": [
    "worktree 已清理，继续会话在主仓库进行。",
    "The worktree was cleaned up; continuing runs in the main repository.",
  ],
  "agent.task.doneKeptHint": [
    "worktree 已保留。",
    "The worktree was kept.",
  ],
  "agent.task.viewTask": ["查看任务", "View task"],

  // Review surface (awaiting_review / finalizing).
  "agent.review.projectDir": ["项目目录", "Project folder"],
  "agent.review.openProject": ["打开项目目录：{path}", "Open the project folder: {path}"],
  "agent.review.worktreeDir": ["Worktree", "Worktree"],
  "agent.review.openWorktree": ["打开 worktree：{path}", "Open the worktree: {path}"],
  "agent.review.branch": ["分支", "Branch"],
  "agent.review.openFailed": ["打不开：{error}", "Cannot open that: {error}"],
  "agent.review.noPath": ["无法确定「{path}」的绝对路径", "Cannot resolve “{path}” to an absolute path"],
  "agent.review.summary": ["AI 摘要", "AI summary"],
  "agent.review.verification": ["验证", "Verification"],
  "agent.review.risks": ["风险", "Risks"],
  "agent.review.files": ["改动文件", "Changed files"],
  "agent.review.filesHint": [
    "「应用内查看」展开逐文件 diff；「IDE 打开」用保存的打开方式打开这个文件。",
    "“View here” expands the per-file diff; “Open in IDE” opens the file with the saved app.",
  ],
  "agent.review.filesLoadFailed": ["改动列表读取失败", "Could not load the changed files"],
  "agent.review.viewHere": ["应用内查看", "View here"],
  "agent.review.openIde": ["IDE 打开", "Open in IDE"],
  "agent.review.binary": ["二进制", "Binary"],
  "agent.review.truncated": [
    "文件过多，只显示前一部分。",
    "Too many files; only the first part is shown.",
  ],
  "agent.review.statusAdded": ["新增", "Added"],
  "agent.review.statusModified": ["修改", "Modified"],
  "agent.review.statusDeleted": ["删除", "Deleted"],
  "agent.review.statusRenamed": ["重命名", "Renamed"],
  "agent.review.statusUntracked": ["未跟踪", "Untracked"],
  "agent.review.approve": ["通过并收尾", "Approve and finish"],
  "agent.review.approveHint": [
    "提交 worktree 的改动，合并回主仓库并清理，然后让 Agent 回写 TAPD。",
    "Commits the worktree, merges it into the repository, cleans up, then has the agent write back to TAPD.",
  ],
  "agent.review.continue": ["继续修改", "Keep editing"],
  "agent.review.continueHint": ["回到对话，让 Agent 继续修改。", "Go back to the conversation and let the agent keep editing."],
  "agent.review.continuePlaceholder": [
    "说明还要改什么…",
    "Describe what still needs to change…",
  ],
  "agent.review.discard": ["放弃", "Discard"],
  "agent.review.discardHint": [
    "先储藏本轮改动，再取消任务。",
    "Stashes this round's changes, then cancels the task.",
  ],
  "agent.review.finalize": ["收尾进度", "Finishing"],
  "agent.review.finalizeHint": [
    "提交 → 合并 → 清理 → 回写；失败的那一步可以重试。",
    "Commit → merge → clean up → write back; a failed step can be retried.",
  ],
  "agent.review.stepCommit": ["提交", "Commit"],
  "agent.review.stepMerge": ["合并", "Merge"],
  "agent.review.stepCleanup": ["清理", "Clean up"],
  "agent.review.stepWriteback": ["回写", "Write back"],
  "agent.review.finalizing": ["正在收尾…", "Finishing…"],
  "agent.review.retry": ["重试", "Retry"],
  "agent.review.retryHint": [
    "从失败的那一步继续收尾。",
    "Continue finishing from the step that failed.",
  ],

  // Team board (P5).
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

  // Composer work bar: the two session-local choices, fixed once it starts.
  "agent.chat.team": ["同事协作", "Coworkers"],
  "agent.chat.teamHint": [
    "会话开始时选择是否让同事一起干活；发送第一条消息后不可更改。",
    "Choose whether coworkers join this session before it starts; the choice is fixed after the first message.",
  ],
  "agent.chat.worktree": ["Worktree", "Worktree"],
  "agent.chat.worktreeHint": [
    "会话开始时选择是否在自己的 git worktree 中工作；发送第一条消息后不可更改。",
    "Choose whether this session works in its own git worktree before it starts; the choice is fixed after the first message.",
  ],
  "agent.chat.lockedHint": [
    "会话已经开始，同事协作与 worktree 不可再更改。",
    "The session has started; coworkers and the worktree can no longer be changed.",
  ],
  "agent.chat.worktreeFailed": [
    "切换 worktree 失败：{error}",
    "Could not switch the worktree: {error}",
  ],

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
  "agent.enqueue.teamHint": [
    "同事协作在任务创建后固定，AI 可与同事分工。",
    "Team collaboration is fixed when the task is created; the agent can share work with coworkers.",
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
  "agent.stream.jumpToLatest": ["跳到最新", "Jump to latest"],
  "agent.stream.prompts": ["提示词", "Prompts"],

  // Built-in plugin inventory (agent config → plugins).
  "agent.plugins.loading": ["正在读取插件…", "Reading plugins…"],
  "agent.plugins.search": ["搜索插件", "Search plugins"],
  "agent.plugins.sessionTitle": ["会话插件", "Session plugins"],
  "agent.plugins.sessionHint": ["按会话组成", "Composed per session"],
  "agent.plugins.sessionEmpty": [
    "本部署没有按会话组成的插件：引擎插件都在全局组成",
    "No per-session plugins here: every engine plugin is composed globally",
  ],
  "agent.plugins.globalTitle": ["全局插件", "Global plugins"],
  "agent.plugins.globalHint": ["系统与所有会话共用", "Shared by the system and every session"],
  "agent.plugins.empty": ["没有插件", "No plugins"],
  "agent.plugins.emptySearch": ["没有匹配的插件", "No matching plugins"],
  "agent.plugins.stateOff": ["已停用", "Disabled"],
  "agent.plugins.statePending": ["等待依赖", "Waiting"],
  "agent.plugins.stateLoading": ["加载中", "Loading"],
  "agent.plugins.stateActive": ["运行中", "Running"],
  "agent.plugins.stateFailed": ["启动失败", "Failed"],
  "agent.plugins.stateUnloading": ["卸载中", "Unloading"],

  // 集成: the tool registry a new session inherits.
  "agent.tools.loading": ["正在读取工具", "Reading tools"],
  "agent.tools.search": ["搜索工具", "Search tools"],
  "agent.tools.readyTitle": ["已注入", "Injected"],
  "agent.tools.readyHint": ["新会话启动即可调用", "Callable as soon as a session starts"],
  "agent.tools.conditionalTitle": ["按需开启", "On demand"],
  "agent.tools.conditionalHint": ["对应模式打开后可用", "Callable while their mode is on"],
  "agent.tools.params": ["{n} 个参数", ({ n }) => `${n} params`],
  "agent.tools.empty": ["运行时没有注册工具", "The runtime has no tools registered"],
  "agent.tools.emptySearch": ["没有匹配的工具", "No matching tools"],

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

  // Session mode picker (composer).
  "agent.mode.title": ["会话模式", "Session mode"],
  "agent.mode.plan": ["计划模式", "Plan mode"],
  "agent.mode.planHint": [
    "先出计划，批准后再动手",
    "Plan first; act after approval",
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
  "agent.model.defaultModel": ["默认模型", "Default model"],
  "agent.model.pick": ["选择模型", "Select model"],
  "agent.model.pickTitle": ["模型", "Model"],
  "agent.model.manage": ["管理模型", "Manage models"],
  "agent.model.providerModels": ["{count} 个模型", "{count} models"],
  "agent.model.noAvailable": ["还没有可用模型", "No model available yet"],
  "agent.model.orderHint": [
    "拖动调整顺序。第一个供应商的第一个启用模型是新会话默认；模型列表同理。",
    "Drag to reorder. The first enabled model of the first enabled provider is the default for new sessions; the same rule applies inside one provider.",
  ],
  "agent.model.reasoningEffort": ["思考强度", "Reasoning effort"],
  "agent.model.reasoningOff": ["关闭", "Off"],
  "agent.model.fetchModels": ["获取模型", "Fetch models"],
  "agent.model.fetching": ["获取中…", "Fetching…"],
  "agent.model.fetchAdded": ["已添加 {count} 个模型", "Added {count} models"],
  "agent.model.fetchNone": ["没有新模型", "No new models"],
  "agent.model.fetchHint": [
    "从供应商的模型列表接口读取，已有的模型不会被覆盖。",
    "Reads the provider's model listing; existing entries are kept.",
  ],
  "agent.model.reorderHint": ["拖动调整顺序", "Drag to reorder"],
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
  "agent.config.nav.models": ["模型", "Models"],
  "agent.config.nav.rules": ["规则", "Rules"],
  "agent.config.nav.general": ["常规", "General"],
  "agent.config.nav.integrations": ["集成", "Integrations"],
  "agent.config.nav.plugins": ["内置插件", "Built-in plugins"],
  "agent.config.execution": ["执行", "Execution"],
  "agent.config.prompt": ["提示词模板", "Prompt template"],
  "agent.config.promptHint": [
    "附加到每一次任务。",
    "Appended to every task.",
  ],
  "agent.config.units": ["并行任务数", "Parallel tasks"],
  "agent.config.unitsHint": [
    "同时运行的工作流任务数，1–8；超出的任务排队等待。",
    "How many workflow tasks may run at once, 1-8; the rest wait in the queue.",
  ],
  "agent.config.permission": ["默认权限模式", "Default permission mode"],
  "agent.config.permissionHint": [
    "新会话和未单独设置的会话使用；在每个会话的输入框下方可单独调整，立即生效。",
    "Used by new sessions and sessions without their own choice; each session can override it from its composer, effective immediately.",
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
    "运行时没有应用最新配置，重启后生效",
    "The runtime could not adopt the latest settings; restart to apply them",
  ],
  "agent.config.restartRuntime": ["重启运行时", "Restart runtime"],
  "agent.config.restartBusy": [
    "重启会中断正在运行的会话，之后需要重新发送。确定继续？",
    "Restarting interrupts running conversations; you will need to resend. Continue?",
  ],
  "agent.config.team": ["团队协作", "Team collaboration"],
  "agent.config.teamHint": [
    "新任务会话默认进入任务板，主 Agent 可把工作派给同事子 agent；提示词不再写同事名单。自由会话默认关闭，可在输入框上方单独开启。",
    "New task sessions start on the team board, where the lead can hand work to coworker subagents; the coworker roster stays out of the prompt. Free chats start off and can opt in above the composer.",
  ],
  "agent.config.runtime": ["运行时", "Runtime"],
  "agent.config.runtimeHint": ["只读的运行时信息。", "Read-only runtime facts."],
  "agent.config.payloadVersion": ["Payload 版本", "Payload version"],
  "agent.config.node": ["Node", "Node"],
  "agent.config.nodePath": ["Node 路径", "Node path"],
  "agent.config.provider": ["Provider", "Provider"],
  "agent.config.currentModel": ["当前模型", "Current model"],

  // Trajectory panel: the conversation's second view.
  "agent.traj.viewChat": ["对话", "Chat"],
  "agent.traj.viewTrajectory": ["轨迹", "Trajectory"],
} as const satisfies Catalog;
