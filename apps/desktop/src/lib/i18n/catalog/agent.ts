/**
 * Agent page catalogue: sessions, stream, runtime states and the agent's own
 * configuration tab. Explanations live in `title`, so most entries are labels.
 */
import type { Catalog } from "../types";

export const agent = {
  // Tabs.
  "agent.tab.sessions": ["会话", "Sessions"],
  "agent.tab.config": ["配置", "Configuration"],

  // Session list.
  "agent.session.new": ["新建会话", "New session"],
  "agent.session.empty": ["还没有会话", "No sessions yet"],
  "agent.session.emptyHint": [
    "点「新建会话」开始；会话在第一次发送后出现在这里。",
    "Start with New session; it appears here after the first message.",
  ],
  "agent.session.untitled": ["新会话", "New session"],
  "agent.session.loadFailed": ["会话列表读取失败", "Could not load sessions"],
  "agent.session.statusRunning": ["运行中", "Running"],
  "agent.session.statusIdle": ["空闲", "Idle"],
  "agent.session.statusFailed": ["失败", "Failed"],

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
  "agent.thinking": ["思考", "Reasoning"],
  "agent.tool.calling": ["工具调用", "Tool call"],
  "agent.tool.running": ["运行中", "Running"],
  "agent.tool.failed": ["工具执行失败", "Tool failed"],

  // Composer.
  "agent.composer.placeholder": ["描述要做什么…", "Describe the task…"],
  "agent.composer.hint": ["Enter 发送，Shift+Enter 换行", "Enter sends, Shift+Enter adds a line"],

  // Runtime states (also used as the composer's disabled explanation).
  "agent.runtime.stopped": ["运行时未启动", "Runtime is not running"],
  "agent.runtime.starting": ["运行时启动中", "Runtime starting"],
  "agent.runtime.start": ["启动", "Start"],
  "agent.runtime.stop": ["停止", "Stop"],
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
    "自定义模型 API，保存后下次启动运行时生效。",
    "Custom model API; applies the next time the runtime starts.",
  ],
  "agent.config.providerId": ["Provider ID", "Provider ID"],
  "agent.config.providerIdHint": [
    "写进运行时 profile 的 provider 标识，小写字母开头。",
    "Provider key in the runtime profile; starts with a lowercase letter.",
  ],
  "agent.config.displayName": ["显示名", "Display name"],
  "agent.config.baseUrl": ["API 地址", "API address"],
  "agent.config.baseUrlHint": [
    "OpenAI 兼容、Anthropic 或 Gemini 网关的基础地址。",
    "Base URL of an OpenAI-compatible, Anthropic or Gemini gateway.",
  ],
  "agent.config.protocol": ["协议", "Protocol"],
  "agent.config.protocolOpenai": ["OpenAI 兼容", "OpenAI-compatible"],
  "agent.config.protocolAnthropic": ["Anthropic", "Anthropic"],
  "agent.config.protocolGemini": ["Gemini", "Gemini"],
  "agent.config.apiKey": ["API 密钥", "API key"],
  "agent.config.apiKeyHint": [
    "只通过环境变量传给运行时，不写进配置文件。",
    "Passed to the runtime through an environment variable, never written to a config file.",
  ],
  "agent.config.modelId": ["模型 ID", "Model ID"],
  "agent.config.contextWindow": ["上下文长度", "Context window"],
  "agent.config.modelList": ["模型目录", "Model directory"],
  "agent.config.modelListHint": [
    "每行或每逗号分隔一个模型 ID；留空表示直接发送上面的模型。",
    "One model id per line or comma; leave empty to send the model above as-is.",
  ],
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
  "agent.config.coworkers": ["同事", "Coworkers"],
  "agent.config.coworkersHint": [
    "选中的同事会把角色与技能包附加到提示词。",
    "Selected coworkers add their role and skills to the prompt.",
  ],
  "agent.config.coworkersEmpty": ["还没有可用的同事", "No coworkers available"],
  "agent.config.runtime": ["运行时", "Runtime"],
  "agent.config.runtimeHint": ["只读的运行时信息。", "Read-only runtime facts."],
  "agent.config.payloadVersion": ["Payload 版本", "Payload version"],
  "agent.config.node": ["Node", "Node"],
  "agent.config.nodePath": ["Node 路径", "Node path"],
  "agent.config.provider": ["Provider", "Provider"],
  "agent.config.currentModel": ["当前模型", "Current model"],
} as const satisfies Catalog;
