/** agent catalogue: built-in dsh runtime, unified task list, task actions and
 *  the approvals/questions the phone can answer. */
import type { Catalog } from "../types";

export const agent = {
  /* -- Tab ---------------------------------------------------------------- */
  "mobile.agent.newSession": ["新建会话", "New session"],
  "mobile.agent.creating": ["创建中…", "Creating…"],
  "mobile.agent.loadFailed": ["读取任务失败", "Couldn't load tasks"],
  "mobile.agent.newSessionFailed": ["新建会话失败", "Couldn't create a session"],
  "mobile.agent.empty": ["还没有任务", "No tasks yet"],
  "mobile.agent.emptyHint": [
    "任务来自「事项」或桌面端。",
    "Tasks come from work items or the desktop.",
  ],
  "mobile.agent.untitledSession": ["未命名会话", "Untitled session"],
  "mobile.agent.noProject": ["未关联项目", "No project"],
  "mobile.agent.badgeHint": ["{n} 项待处理", "{n} pending"],

  /* -- Runtime status ----------------------------------------------------- */
  "mobile.agent.phaseStopped": ["未启动", "Stopped"],
  "mobile.agent.phaseStarting": ["启动中", "Starting"],
  "mobile.agent.phaseReady": ["已就绪", "Ready"],
  "mobile.agent.phaseFailed": ["启动失败", "Failed"],
  "mobile.agent.statusLoadFailed": [
    "读取运行时状态失败",
    "Couldn't read the runtime status",
  ],
  "mobile.agent.start": ["启动", "Start"],
  "mobile.agent.startFailed": ["启动运行时失败", "Couldn't start the runtime"],

  /* -- Workflow chips ----------------------------------------------------- */
  "mobile.agent.workflowRunning": ["进行中", "Running"],
  "mobile.agent.workflowReview": ["待审核", "Awaiting review"],
  "mobile.agent.workflowMerge": ["待合并", "Awaiting merge"],
  "mobile.agent.workflowDone": ["已完成", "Done"],
  "mobile.agent.workflowFailed": ["失败", "Failed"],
  "mobile.agent.workflowCanceled": ["已取消", "Canceled"],

  /* -- Task actions ------------------------------------------------------- */
  "mobile.agent.viewDiff": ["查看改动", "View changes"],
  "mobile.agent.approve": ["通过并提交", "Approve and commit"],
  "mobile.agent.stopAndStash": ["停止并储藏", "Stop and stash"],
  "mobile.agent.merge": ["合并回主仓库", "Merge into main"],
  "mobile.agent.cancelTask": ["取消任务", "Cancel task"],
  "mobile.agent.stop": ["停止", "Stop"],
  "mobile.agent.diffTruncated": ["已截断", "Truncated"],
  "mobile.agent.diffEmpty": ["没有可显示的改动", "No changes to show"],
  "mobile.agent.diffFailed": ["读取改动失败", "Couldn't load the changes"],
  "mobile.agent.resumeFailed": ["恢复会话失败", "Couldn't resume the session"],

  /* -- Approvals ---------------------------------------------------------- */
  "mobile.agent.approvalRequest": ["授权请求", "Approval request"],
  "mobile.agent.approvalTool": ["工具", "Tool"],
  "mobile.agent.approvalTarget": ["目标", "Target"],
  "mobile.agent.allowOnce": ["允许一次", "Allow once"],
  "mobile.agent.reject": ["拒绝", "Reject"],
  "mobile.agent.approvalFailed": ["审批失败", "Couldn't answer the approval"],
  "mobile.agent.pendingLoadFailed": [
    "读取待处理请求失败",
    "Couldn't load pending requests",
  ],

  /* -- Questions ---------------------------------------------------------- */
  "mobile.agent.questionRequest": ["需要你的回答", "Question"],
  "mobile.agent.answerQuestion": ["去回答", "Answer"],
  "mobile.agent.questionProgress": ["问题 {i}/{n}", "Question {i} of {n}"],
  "mobile.agent.questionCustom": ["自定义回答", "Custom answer"],
  "mobile.agent.questionCustomPlaceholder": ["输入回答", "Type an answer"],
  "mobile.agent.questionFailed": ["提交回答失败", "Couldn't submit the answer"],

  /* -- Team board --------------------------------------------------------- */
  "mobile.agent.teamToggle": ["团队协作", "Team mode"],
  "mobile.agent.teamToggleHint": [
    "开启后主 Agent 会把可拆分的工作派给同事，并在任务板登记。",
    "The lead agent hands splittable work to coworkers and registers it on the board.",
  ],
  "mobile.agent.teamToggleFailed": ["切换团队协作失败", "Couldn't switch team mode"],
  "mobile.agent.viewChat": ["会话", "Chat"],
  "mobile.agent.viewBoard": ["任务板", "Board"],
  "mobile.agent.colPending": ["待分配", "Pending"],
  "mobile.agent.colInProgress": ["进行中", "In progress"],
  "mobile.agent.colCompleted": ["已完成", "Done"],
  "mobile.agent.teamUnassigned": ["未分配", "Unassigned"],
  "mobile.agent.teamBlocked": ["{n} 项阻塞", "{n} blocked"],
  "mobile.agent.teamReady": ["可开始", "Ready"],
  "mobile.agent.teamMoreScopes": ["+{n}", "+{n}"],
  "mobile.agent.teamEmpty": ["任务板为空", "No board tasks"],
  "mobile.agent.teamEmptyHint": [
    "团队协作开启后，主 Agent 会把可拆分的工作登记在这里。",
    "With team mode on, the lead agent registers splittable work here.",
  ],
  "mobile.agent.teamLoadFailed": ["读取任务板失败", "Couldn't load the board"],

  /* -- Session view ------------------------------------------------------- */
  "mobile.agent.syncing": ["同步中", "Syncing"],
  "mobile.agent.entriesLoadFailed": ["读取消息失败", "Couldn't load messages"],
  "mobile.agent.emptyTranscript": ["还没有消息", "No messages yet"],
  "mobile.agent.emptyTranscriptHint": [
    "在下方输入第一条消息。",
    "Type the first message below.",
  ],
  "mobile.agent.composerPlaceholder": ["给 Agent 发消息", "Message the Agent"],
  "mobile.agent.composerHint": [
    "Enter 发送，Shift+Enter 换行。",
    "Enter to send, Shift+Enter for a new line.",
  ],
  "mobile.agent.promptFailed": ["发送失败", "Couldn't send the message"],
  "mobile.agent.reasoning": ["思考过程", "Reasoning"],
  "mobile.agent.toolRunning": ["运行中", "Running"],
  "mobile.agent.toolArgs": ["参数", "Arguments"],
  "mobile.agent.toolResult": ["结果", "Result"],
  "mobile.agent.turnEnded": ["本轮结束", "Turn ended"],
} as const satisfies Catalog;
