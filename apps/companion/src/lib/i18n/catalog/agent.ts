/** agent catalogue: built-in dsh runtime, unified task list, task actions and
 *  the approvals/questions the phone can answer. */
import type { Catalog } from "../types";

export const agent = {
  /* -- Tab ---------------------------------------------------------------- */
  "mobile.agent.creating": ["创建中…", "Creating…"],
  "mobile.agent.newSessionInProject": [
    "在「{project}」新建会话",
    "New session in {project}",
  ],
  "mobile.agent.projectsLoadFailed": [
    "读取项目列表失败",
    "Couldn't load projects",
  ],
  "mobile.agent.loadFailed": ["读取任务失败", "Couldn't load tasks"],
  "mobile.agent.empty": ["还没有任务", "No tasks yet"],
  "mobile.agent.emptyHint": [
    "任务来自「事项」或桌面端。",
    "Tasks come from work items or the desktop.",
  ],
  "mobile.agent.untitledSession": ["未命名会话", "Untitled session"],
  "mobile.agent.sessionGone": ["会话已被删除", "This session was deleted"],
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
  "mobile.agent.workflowQueued": ["排队中", "Queued"],
  "mobile.agent.workflowRunning": ["进行中", "Running"],
  "mobile.agent.workflowReview": ["待审核", "In review"],
  "mobile.agent.workflowFinalizing": ["收尾中", "Finishing"],
  "mobile.agent.workflowDone": ["已完成", "Done"],
  "mobile.agent.workflowFailed": ["失败", "Failed"],
  "mobile.agent.workflowCanceled": ["已取消", "Canceled"],
  "mobile.agent.workflowInterrupted": ["已中断", "Interrupted"],

  /* -- Task list / queue view --------------------------------------------- */
  "mobile.agent.viewTasks": ["任务", "Tasks"],
  "mobile.agent.viewQueue": ["队列", "Queue"],
  "mobile.agent.queueEmpty": ["队列为空", "Queue is empty"],
  "mobile.agent.queueEmptyHint": [
    "排队中、执行中和待审核的任务会集中在这里。",
    "Queued, running and review tasks collect here.",
  ],
  "mobile.agent.continue": ["继续", "Continue"],
  "mobile.agent.continuePrompt": [
    "继续完成当前任务，从上次中断的地方接着做。",
    "Continue the current task from where it was interrupted.",
  ],
  "mobile.agent.cancelTask": ["取消任务", "Cancel task"],
  "mobile.agent.openSource": ["任务尚未开始，查看来源记录", "Not started yet; open the source record"],

  /* -- Hand a record to the agent ----------------------------------------- */
  "mobile.enqueue.title": ["交给 Agent", "Hand to agent"],
  "mobile.enqueue.note": ["补充说明（可选）", "Add a note (optional)"],
  "mobile.enqueue.noteHint": [
    "Agent 会先读详情，再把这段当补充说明。",
    "The agent reads the record first, then treats this as extra context.",
  ],
  "mobile.enqueue.failed": [
    "交给 Agent 失败",
    "Couldn't hand over to the agent",
  ],
  "mobile.enqueue.queued": [
    "已交给 Agent，可在「Agent → 队列」查看",
    "Handed over; see it under Agent → Queue",
  ],

  /* -- Review & finalizing (docs/AGENT_TASK_FLOW.md §7) ------------------- */
  "mobile.agent.reviewTitle": ["审核", "Review"],
  "mobile.agent.reviewSummary": ["AI 摘要", "AI summary"],
  "mobile.agent.reviewVerification": ["验证", "Verification"],
  "mobile.agent.reviewRisks": ["风险", "Risks"],
  "mobile.agent.reviewFiles": ["改动文件", "Changed files"],
  "mobile.agent.reviewNoFiles": ["没有可查看的文件", "No files to show"],
  "mobile.agent.reviewLoading": ["正在读取改动…", "Loading changes…"],
  "mobile.agent.reviewLoadFailed": [
    "改动列表读取失败",
    "Could not load the changed files",
  ],
  "mobile.agent.reviewTruncated": ["已截断", "Truncated"],
  "mobile.agent.diffEmpty": ["没有差异内容", "No diff content"],
  "mobile.agent.diffFailed": ["读取差异失败", "Couldn't load the diff"],
  "mobile.agent.viewFile": ["查看文件", "View file"],
  "mobile.agent.fileAdded": ["新增", "Added"],
  "mobile.agent.fileModified": ["修改", "Modified"],
  "mobile.agent.fileDeleted": ["删除", "Deleted"],
  "mobile.agent.fileRenamed": ["重命名", "Renamed"],
  "mobile.agent.fileUntracked": ["未跟踪", "Untracked"],
  "mobile.agent.finalizeTitle": ["正在收尾", "Finishing"],
  "mobile.agent.finalizeStepCommit": ["提交", "Commit"],
  "mobile.agent.finalizeStepMerge": ["合并", "Merge"],
  "mobile.agent.finalizeStepCleanup": ["清理", "Cleanup"],
  "mobile.agent.finalizeStepWriteback": ["回写", "Writeback"],
  "mobile.agent.finalizeRetry": ["重试收尾", "Retry finishing"],
  "mobile.agent.finalizeRetrying": ["重试中…", "Retrying…"],

  /* -- Task actions ------------------------------------------------------- */
  "mobile.agent.approve": ["通过并收尾", "Approve and finish"],
  "mobile.agent.abandon": ["放弃", "Discard"],
  "mobile.agent.stop": ["停止", "Stop"],
  "mobile.agent.resumeFailed": ["恢复会话失败", "Couldn't resume the session"],
  "mobile.agent.retryFailed": ["重试失败", "Couldn't retry the turn"],

  /* -- Delete a session (task list rows) ---------------------------------- */
  "mobile.agent.deleteTitle": ["删除会话", "Delete session"],
  "mobile.agent.deleteHint": [
    "删除「{title}」及其对话记录？它自己的 worktree 会一起删掉（未提交的改动也会丢失），仓库不受影响。",
    "Delete “{title}” and its history? Its own worktree is removed too (uncommitted changes are lost); the repository itself is untouched.",
  ],
  "mobile.agent.deleteFailed": ["删除失败", "Couldn't delete the session"],

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
  "mobile.agent.teamToggle": ["同事协作", "Coworkers"],
  "mobile.agent.teamToggleHint": [
    "会话开始时选择是否让同事一起干活；发送第一条消息后不可更改。",
    "Choose whether coworkers join before the session starts; fixed after the first message.",
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
  "mobile.agent.resuming": ["正在恢复会话…", "Resuming…"],
  "mobile.agent.entriesLoadFailed": ["读取消息失败", "Couldn't load messages"],
  "mobile.agent.emptyTranscript": ["还没有消息", "No messages yet"],
  "mobile.agent.emptyTranscriptHint": [
    "在下方输入第一条消息。",
    "Type the first message below.",
  ],

  /* -- Composer ---------------------------------------------------------- */
  "mobile.agent.composerPlaceholder": ["给 Agent 发消息", "Message the Agent"],
  "mobile.agent.composerHint": [
    "Enter 发送，Shift+Enter 换行。",
    "Enter to send, Shift+Enter for a new line.",
  ],
  "mobile.agent.promptFailed": ["发送失败", "Couldn't send the message"],
  "mobile.agent.stopFailed": ["停止失败", "Couldn't stop the turn"],
  "mobile.agent.chatWorktree": ["Worktree", "Worktree"],
  "mobile.agent.chatWorktreeHint": [
    "会话开始时选择是否在独立 worktree 中运行；发送第一条消息后不可更改。",
    "Choose whether this session runs in an isolated worktree before it starts; fixed after the first message.",
  ],
  "mobile.agent.workBarLocked": [
    "会话已经开始，同事协作与 worktree 不可再更改",
    "The session has started; coworkers and the worktree can no longer be changed",
  ],
  "mobile.agent.chatWorktreeFailed": [
    "切换 worktree 失败",
    "Couldn't switch the worktree",
  ],

  /* -- Session mode picker (composer) ------------------------------------- */
  "mobile.agent.modeTitle": ["会话模式", "Session mode"],
  "mobile.agent.modePlan": ["计划模式", "Plan mode"],
  "mobile.agent.modePlanHint": [
    "先出计划，批准后再动手",
    "Plan first; act after approval",
  ],
  "mobile.agent.modeNotify": ["变更前通知", "Notify before changes"],
  "mobile.agent.modeNotifyHint": [
    "全部放行，执行前推一条通知",
    "Everything is allowed; a notice is sent before it runs",
  ],
  "mobile.agent.modeAuto": ["自主", "Autonomous"],
  "mobile.agent.modeAutoHint": [
    "只有风险操作才询问",
    "Only risky operations ask for approval",
  ],
  "mobile.agent.modeFull": ["完全访问", "Full access"],
  "mobile.agent.modeFullHint": [
    "除硬黑名单外全部放行",
    "Everything except the hard blocklist is allowed",
  ],
  "mobile.agent.modeSetFailed": ["切换模式失败", "Couldn't switch mode"],

  /* -- Session model picker (composer) ------------------------------------ */
  "mobile.agent.modelPickTitle": ["模型", "Model"],
  "mobile.agent.modelNoAvailable": ["还没有可用模型", "No model available yet"],
  "mobile.agent.modelProviderModels": ["{count} 个模型", "{count} models"],
  "mobile.agent.modelImage": ["图像输入", "Image input"],
  "mobile.agent.modelReasoningTag": ["可推理", "Reasoning"],
  "mobile.agent.modelReasoningEffort": ["思考强度", "Reasoning effort"],
  "mobile.agent.modelReasoningOff": ["关闭", "Off"],
  "mobile.agent.modelSetFailed": ["切换模型失败", "Couldn't switch model"],

  /* -- Composer status line ----------------------------------------------- */
  "mobile.agent.usageTurns": ["{turns} 轮 · {steps} 步", "{turns} turns · {steps} steps"],
  "mobile.agent.usageTokens": ["{tokens} tokens", "{tokens} tokens"],
  "mobile.agent.usageContext": ["上下文 {percent}%", "Context {percent}%"],

  /* -- Task / conversation / trajectory panes ----------------------------- */
  "mobile.agent.paneTask": ["任务", "Task"],
  "mobile.agent.paneChat": ["对话", "Chat"],
  "mobile.agent.paneTrajectory": ["轨迹", "Trajectory"],

  /* -- Task pane ---------------------------------------------------------- */
  "mobile.agent.taskBranch": ["分支", "Branch"],
  "mobile.agent.taskModel": ["模型", "Model"],
  "mobile.agent.taskWorkingDir": ["工作目录", "Working dir"],
  "mobile.agent.taskDirect": ["主仓库直接运行", "Runs in the main checkout"],
  "mobile.agent.taskBug": ["缺陷", "Bug"],
  "mobile.agent.openBug": ["打开缺陷", "Open bug"],
  "mobile.agent.openItem": ["打开事项", "Open item"],
  "mobile.agent.taskChanges": ["{files} 个文件", "{files} files"],
  "mobile.agent.taskRevisions": ["修订", "Revisions"],
  "mobile.agent.taskGitStart": ["开始", "Start"],
  "mobile.agent.taskGitCommit": ["提交", "Commit"],
  "mobile.agent.taskGitMerge": ["合并", "Merge"],
  "mobile.agent.taskWriteback": ["TAPD 回写", "TAPD write-back"],
  "mobile.agent.taskWritebackComment": ["评论已写入", "Comment written"],
  "mobile.agent.taskWritebackStatus": [
    "状态 {from} → {to}",
    "Status {from} → {to}",
  ],
  "mobile.agent.doneTitle": ["任务已完成", "Task finished"],
  "mobile.agent.viewTask": ["查看任务", "View task"],
} as const satisfies Catalog;
