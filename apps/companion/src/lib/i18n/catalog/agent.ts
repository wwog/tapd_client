/** agent catalogue: short semantic key -> [zh, en]. */
import type { Catalog } from "../types";

export const agent = {
  // Shared within the agent screens
  "magent.untitled": ["（无标题）", "(No title)"],

  // Agent page
  "magent.cancelHint": [
    "取消后任务结束，已产生的改动保留在工作区。",
    "Cancelling ends the task and keeps changes already made in the workspace.",
  ],
  "magent.coworkersHint": [
    "选择随任务一起提示 Agent 的同事包。",
    "Choose the coworker packs to include in Agent prompts.",
  ],
  "magent.coworkers": ["同事包", "Coworker packs"],
  "magent.historyHint": [
    "已结束任务的执行记录与重试。",
    "Execution history and retry for finished tasks.",
  ],
  "magent.history": ["执行记录", "Execution history"],
  "magent.queuePaused": ["队列已暂停（在桌面端恢复）", "Queue paused (resume on desktop)"],
  "magent.queuePausedHint": [
    "搁置审核会暂停队列；在桌面端 Agent 页恢复。",
    "Shelving a review pauses the queue; resume it on the desktop Agent page.",
  ],
  "magent.storageHint": ["任务状态可能无法在重启后保留。", "Task state may not survive a restart."],
  "magent.refreshFailedHint": [
    "刷新失败，将在下个轮询周期重试。",
    "Refresh failed; it will retry on the next poll.",
  ],
  "magent.lastActionFailedHint": [
    "上一次操作失败的结果，重试成功后消失。",
    "Result of the last failed action; it clears after a successful retry.",
  ],
  "magent.idleHint": [
    "在缺陷列表对单个缺陷使用「用 Agent 修复」发起任务。",
    'Start a task from the bug list with "Fix with Agent" on a single bug.',
  ],
  "magent.noActiveTasks": ["没有进行中的任务", "No active tasks"],
  "magent.awaitingAction": ["待处理", "Awaiting action"],
  "magent.running": ["运行中", "Running"],
  "magent.queue": ["队列", "Queue"],
  "magent.cancelQueuedHint": ["取消这个排队中的任务。", "Cancel this queued task."],

  // Task detail page
  "magent.taskDetail": ["任务详情", "Task details"],
  "magent.retryHint": ["用同样内容创建一个新任务。", "Create a new task with the same content."],
  "magent.taskLoading": ["正在读取任务…", "Reading task…"],
  "magent.taskDeletedHint": ["任务可能已被删除。", "The task may have been deleted."],
  "magent.taskNotFound": ["未找到该任务", "Task not found"],
  "magent.repo": ["仓库", "Repository"],
  "magent.branch": ["分支", "Branch"],
  "magent.source": ["来源", "Source"],
  "magent.runtime": ["运行时", "Runtime"],
  "magent.created": ["创建", "Created"],
  "magent.started": ["开始", "Started"],
  "magent.finished": ["结束", "Finished"],
  "magent.duration": ["耗时", "Duration"],
  "magent.noRepo": ["未配置仓库", "No repository configured"],
  "magent.error": ["错误：{error}", "Error: {error}"],
  "magent.cancelHintDetail": [
    "取消后任务结束，已产生的改动保留。搁置审核请在上方审核卡操作。",
    "Cancelling ends the task and keeps changes already made. To shelve the review, use the review card above.",
  ],
  "magent.cancelTask": ["取消任务", "Cancel task"],
  "magent.retryNote": [
    "重试会创建一个新任务并重新排队。",
    "Retry creates a new task and queues it again.",
  ],
  "magent.prompt": ["提示词", "Prompt"],
  "magent.lastActionFailed": ["上一次操作失败的结果。", "Result of the last failed action."],

  // Execution history page
  "magent.retryConfirm": [
    "重试会创建一个新任务并重新排队，确定重试？",
    "Retry creates a new task and queues it again. Retry?",
  ],
  "magent.filterByStatus": ["按状态筛选", "Filter by status"],
  "magent.lastRetryFailed": ["上一次重试失败的结果。", "Result of the last failed retry."],
  "magent.historyLoading": ["正在读取记录…", "Reading history…"],
  "magent.historyEmptyHint": ["结束的任务会出现在这里。", "Finished tasks appear here."],
  "magent.historyEmpty": ["没有执行记录", "No execution history"],
  "magent.historyDeleteHint": ["删除执行记录请在桌面端操作。", "Delete execution history on the desktop."],
  "magent.createdAt": ["创建 {time}", "Created {time}"],
  "magent.loadMore": [
    "加载更多（已显示 {shown} / {total}）",
    "Load more ({shown} / {total} shown)",
  ],

  // Coworkers page
  "magent.coworkersSelectedHint": [
    "勾选的同事会随 Agent 任务一起提示。",
    "Selected coworkers are included in Agent task prompts.",
  ],
  "magent.selectedCount": ["已选 {n}", "Selected: {n}"],
  "magent.reload": ["重新加载", "Reload"],
  "magent.coworkersLoading": ["正在读取同事包…", "Reading coworker packs…"],
  "magent.coworkersEmptyHint": [
    "把同事包放进桌面端 assets/coworker 后重启。",
    "Put coworker packs in the desktop assets/coworker folder, then restart.",
  ],
  "magent.coworkersEmpty": ["还没有同事入职", "No coworkers yet"],
  "magent.noSkills": ["没有技能包", "No skill packs"],
  "magent.saveFailed": ["保存失败，勾选未丢失，可重试。", "Save failed; your selection is kept. Try again."],
  "magent.saveHint": [
    "保存后启用的同事包会附加到之后发起的 Agent 任务提示词里。",
    "Enabled packs are appended to prompts for Agent tasks started afterwards.",
  ],
  "magent.saving": ["保存中…", "Saving…"],

  // Review / merge cards
  "magent.approve": ["通过", "Approve"],
  "magent.approveHint": [
    "通过后 Agent 继续核对、提交并回写 TAPD。",
    "Once approved, the Agent verifies, commits and writes back to TAPD.",
  ],
  "magent.shelve": ["搁置", "Shelve"],
  "magent.shelveHint": [
    "搁置：本次改动存入 git stash，任务取消，队列暂停（在桌面端恢复）。代码不会丢。",
    "Shelve: changes go into git stash, the task is cancelled and the queue pauses (resume on desktop). Nothing is lost.",
  ],
  "magent.viewDiff": ["查看改动", "View changes"],
  "magent.hideDiff": ["收起改动", "Hide changes"],
  "magent.risk": ["风险：{risk}", "Risk: {risk}"],
  "magent.diffTitle": ["相对任务起点的差异（只读）", "Diff from task start (read-only)"],
  "magent.diffLoading": ["正在读取差异…", "Reading diff…"],
  "magent.awaitingReviewHint": [
    "Agent 已完成修改，等待审核。",
    "Agent finished the changes and is awaiting review.",
  ],
  "magent.files.count": [
    "涉及文件 {n} 个",
    ({ n }) => `${n} file${Number(n) === 1 ? "" : "s"}`,
  ],
  "magent.mergeHint": [
    "合并由原 Agent 在主仓库执行，合并成功才算完成。",
    "The original Agent merges in the main repository; the task completes only when the merge succeeds.",
  ],
  "magent.mergeReady": [
    "审核已通过。确认后使用原 Agent 把分支合并到主仓库。",
    "Review approved. Confirm to merge the branch into the main repository with the original Agent.",
  ],
  "magent.manualMergeSteps": ["手动合并步骤", "Manual merge steps"],
  "magent.mergeStart": ["用原 Agent 合并", "Merge with original Agent"],
} as const satisfies Catalog;
