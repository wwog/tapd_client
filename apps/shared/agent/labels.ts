import type { AgentLocale } from "./types";

/**
 * Copy for the shared agent chat view, as `[zh, en]` pairs keyed by short
 * semantic ids. Desktop and companion render the same components, so this
 * copy is not in either app's i18n catalogue — it ships with the view.
 * Extend here for copy both ends share; app-only copy stays in the app's own
 * catalogue.
 */
const LABELS = {
  "todo.title": ["任务", "Tasks"],
  "todo.progress": ["{done}/{total}", "{done}/{total}"],
  "todo.current": ["当前：{content}", "Now: {content}"],
  "todo.empty": ["还没有任务", "No tasks yet"],
  "subagent.group": ["子 agent", "Subagents"],
  "subagent.running": ["工作中", "Working"],
  "subagent.done": ["已完成", "Done"],
  "subagent.failed": ["已失败", "Failed"],
  "subagent.stopped": ["已停止", "Stopped"],
  "subagent.outOfRoom": ["已用尽空间", "Out of room"],
  "subagent.declined": ["已拒绝任务", "Declined"],
  "notice.closing": ["收尾消息", "Closing message"],
  "notice.noClosing": ["没有收尾消息", "No closing message"],

  // Turn block (elapsed line, folded trace groups, failure lines).
  "turn.working": ["工作中 {duration}", "Working for {duration}"],
  "turn.workingPlain": ["工作中", "Working"],
  "turn.worked": ["已工作 {duration}", "Worked for {duration}"],
  "turn.trace": ["轨迹", "Trace"],
  "turn.expand": ["展开这一轮的轨迹", "Show the trace of this turn"],
  "turn.collapse": ["收起这一轮的轨迹", "Hide the trace of this turn"],
  "turn.reasoning": ["思考 {count} 段", "{count} reasoning blocks"],
  "turn.notes": ["说明 {count} 段", "{count} notes"],
  "turn.reads": ["查阅 {count} 项", "{count} reads"],
  "turn.agents": ["子 agent {count} 个", "{count} subagents"],
  "turn.commands": ["执行 {count} 命令", "{count} commands"],
  "turn.files": ["修改 {count} 文件", "{count} files"],
  "turn.failed": ["本轮失败", "This turn failed"],
  "turn.blocked": ["本轮被策略拦截", "This turn was blocked"],
  "turn.aborted": ["已停止这一轮", "This turn was stopped"],
  "turn.retry": ["重试", "Retry"],

  // Tool action verbs and row labels.
  "action.thinking": ["正在思考", "Thinking"],
  "action.reasoning": ["思考", "Reasoning"],
  "action.ran": ["已执行", "Ran"],
  "action.read": ["已读取", "Read"],
  "action.viewed": ["已查看", "Viewed"],
  "action.wrote": ["已写入", "Wrote"],
  "action.edited": ["已编辑", "Edited"],
  "action.searched": ["已搜索", "Searched"],
  "action.searchedWeb": ["已搜索网页", "Searched the web"],
  "action.fetched": ["已获取", "Fetched"],
  "action.called": ["调用了", "Called"],
  "action.runningBash": ["正在执行", "Running"],
  "action.runningRead": ["正在读取", "Reading"],
  "action.runningViewed": ["正在查看", "Viewing"],
  "action.runningWrote": ["正在写入", "Writing"],
  "action.runningEdited": ["正在编辑", "Editing"],
  "action.runningSearched": ["正在搜索", "Searching"],
  "action.runningFetched": ["正在访问", "Fetching"],
  "action.runningCalled": ["正在调用", "Calling"],
  "action.failed": ["执行失败", "Failed"],
  "action.result": ["执行结果", "Output"],
  "action.openTrace": ["在轨迹中查看这次调用", "Open this call in the trajectory"],
  "action.loading": ["加载中", "Loading"],

  // Message meta row.
  "meta.copy": ["复制", "Copy"],
  "meta.copied": ["已复制", "Copied"],

  // Elapsed-time formatting (the turn clock).
  "stats.seconds": ["{seconds} 秒", "{seconds}s"],
  "stats.minutes": ["{minutes} 分 {seconds} 秒", "{minutes}m {seconds}s"],

  // Trajectory panel.
  "traj.toolbarAria": ["轨迹工具栏", "Trajectory toolbar"],
  "traj.duration": ["时长", "Duration"],
  "traj.useDuration": ["按实际时长排列", "Lay out by recorded duration"],
  "traj.useSequence": ["按操作顺序排列", "Lay out by operation order"],
  "traj.turns": ["轮次", "Turns"],
  "traj.calls": ["调用", "Calls"],
  "traj.search": ["搜索轨迹", "Search the trajectory"],
  "traj.searchPlaceholder": ["搜索", "Search"],
  "traj.timelineAria": ["轨迹时间轴", "Trajectory timeline"],
  "traj.noTiming": ["没有可用的计时数据", "No timing data"],
  "traj.laneInput": ["输入", "Input"],
  "traj.laneModel": ["模型", "Model"],
  "traj.laneTools": ["工具", "Tools"],
  "traj.kindUser": ["用户", "User"],
  "traj.kindAssistant": ["助手", "Assistant"],
  "traj.kindTool": ["工具", "Tool"],
  "traj.kindNotice": ["通知", "Notice"],
  "traj.groupMessage": ["消息", "Message"],
  "traj.groupStep": ["第 {step} 步", "Step {step}"],
  "traj.turnLabel": ["第 {turn} 轮", "Turn {turn}"],
  "traj.toolCallOnly": ["（仅工具调用）", "(tool call only)"],
  "traj.noOutput": ["无输出", "No output"],
  "traj.noPayload": ["没有可显示的参数", "No payload captured"],
  "traj.empty": ["这个会话还没有记录", "This session has no records yet"],
  "traj.loadFailed": ["加载失败", "Load failed"],
  "traj.steps": ["{count} 步", "{count} steps"],
  "traj.stepsOne": ["{count} 步", "{count} step"],
  "traj.callsCount": ["{count} 次工具调用", "{count} tool calls"],
  "traj.callsCountOne": ["{count} 次工具调用", "{count} tool call"],
  "traj.stateCompleted": ["已完成", "Completed"],
  "traj.statePending": ["运行中", "Running"],
  "traj.stateFailed": ["失败", "Failed"],
  "traj.hierarchy": ["层级", "Hierarchy"],
  "traj.status": ["状态", "Status"],
  "traj.assistantMessage": ["助手消息", "Assistant message"],
  "traj.usage": ["Token", "Tokens"],
  "traj.usageInput": ["输入", "Input"],
  "traj.usageCacheRead": ["缓存读取", "Cache read"],
  "traj.usageCacheWrite": ["缓存写入", "Cache write"],
  "traj.usageOutput": ["输出", "Output"],
  "traj.usageNotReported": ["未报告用量", "No usage reported"],
  "traj.started": ["开始时间", "Started"],
  "traj.startedAt": ["开始于 {time}", "Started {time}"],
  "traj.total": ["共 {duration}", "{duration} total"],
  "traj.totalDuration": ["总时长", "Total duration"],
  "traj.ttft": ["首 token 延迟", "Time to first token"],
  "traj.generation": ["生成", "Generation"],
  "traj.throughput": ["吞吐量", "Throughput"],
  "traj.ttftDecoding": ["首 token {ttft} · 生成 {decoding}", "TTFT {ttft} · decode {decoding}"],
  "traj.tokensPerSecond": ["{value} tok/s", "{value} tok/s"],
  "traj.timingSource": ["计时来源", "Timing source"],
  "traj.timingSession": ["会话时间戳", "Session timestamps"],
  "traj.timingRunning": ["会话时间戳（运行中）", "Session timestamps (running)"],
  "traj.notAvailable": ["不可用", "Not available"],
  "traj.milliseconds": ["{value} 毫秒", "{value} ms"],
  "traj.seconds": ["{value} 秒", "{value} s"],
  "traj.showLocal": ["显示本地时间", "Show local time"],
  "traj.showUnix": ["显示 Unix 时间戳", "Show Unix timestamp"],
  "traj.tabSummary": ["概述", "Summary"],
  "traj.tabPreview": ["预览", "Preview"],
  "traj.tabRaw": ["原始内容", "Raw"],
  "traj.tabInput": ["参数", "Input"],
  "traj.tabOutput": ["结果", "Result"],
  "traj.tabSchema": ["Schema", "Schema"],
  "traj.tabTiming": ["计时", "Timing"],
  "traj.schemaUnavailable": ["Schema 不可用", "Schema unavailable"],
  "traj.thinking": ["思考", "Thinking"],
  "traj.inspectorAria": ["记录详情", "Record details"],
  "traj.closeInspector": ["关闭详情", "Close details"],
  "traj.resize": ["调整详情宽度", "Resize details"],
  "traj.expand": ["展开", "Expand"],
  "traj.collapse": ["收起", "Collapse"],
} as const satisfies Record<string, [string, string]>;

export type AgentLabelKey = keyof typeof LABELS;

/** Picks the pair for `locale`; `{var}` slots take `vars` values verbatim. */
export function agentLabel(
  key: AgentLabelKey,
  locale: AgentLocale,
  vars?: Record<string, string | number>,
): string {
  let text: string = LABELS[key][locale === "en" ? 1 : 0];
  if (!vars) return text;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}
