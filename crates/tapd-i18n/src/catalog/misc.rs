//! Messages for `tapd-workflow`: task rejections, review/merge errors and the
//! prompts the workflow renders for a human or an agent. Key format:
//! `flow.topic`.

use crate::Message;

pub static MESSAGES: &[Message] = &[
    // -- merge policy ------------------------------------------------------
    ("flow.merge.dirtyrepo", "主仓库有 {} 个未提交文件，无法自动合并", "The main repository has {} uncommitted files; cannot merge automatically"),
    ("flow.merge.repobusy", "该仓库已有任务正在合并，请稍后重试", "This repository already has a task merging; try again later"),
    ("flow.merge.worktreemissing", "任务缺少分支或 worktree，无法自动合并", "The task has no branch or worktree; cannot merge automatically"),
    ("flow.merge.manualsteps", "手动合并步骤：\n1. cd \"{}\"\n2. git status  # 工作区必须干净；有改动先 commit 或 git stash；上次合并中断可先 git merge --abort\n3. git merge \"{}\"\n4. 如有冲突：解决后 git add -A && git commit\n5. 运行相关测试\n6. 合并后回到 TAPD 更新状态并评论影响范围\n7. 回到本任务点「我已手动合并」", "Manual merge steps:\n1. cd \"{}\"\n2. git status  # the working tree must be clean; commit or git stash any changes first; after an interrupted merge run git merge --abort\n3. git merge \"{}\"\n4. On conflicts: resolve, then git add -A && git commit\n5. Run the relevant tests\n6. After merging, update the status in TAPD and comment on the impact\n7. Return to this task and click \"I merged manually\""),
    ("flow.merge.prompt", "请把已审核通过的修复分支合并到当前仓库，并完成 TAPD 回写。\n仓库：{}\n分支：{}\n\n要求：\n1. 先 git status 确认工作区干净；有未提交改动就停止并说明，不要提交或丢弃用户改动。\n2. git merge {}；有冲突时解决冲突，保留双方意图。\n3. 运行相关测试。\n4. 合并完成后：用 tapd_add_bug_comment 说明原因、方案与影响范围，再用 tapd_update_bug_status 更新缺陷状态；可先查 tapd_get_bug_transitions。\n5. 不要 push。\n6. 完成后说明结果。", "Merge the approved fix branch into the current repository and complete the TAPD write-back.\nRepository: {}\nBranch: {}\n\nRequirements:\n1. Run git status first to confirm the working tree is clean; stop and explain if there are uncommitted changes, and never commit or discard the user's changes.\n2. git merge {}; resolve any conflicts, keeping both sides' intent.\n3. Run the relevant tests.\n4. After merging: use tapd_add_bug_comment to explain the cause, fix and impact, then tapd_update_bug_status to update the bug status; check tapd_get_bug_transitions first if needed.\n5. Do not push.\n6. Explain the result when done."),
    ("flow.merge.canceled", "已取消合并", "Merge canceled"),
    ("flow.merge.aborted", "合并已中止", "Merge aborted"),
    ("flow.merge.branchunmerged", "分支尚未并入主仓库", "The branch has not been merged into the main repository"),
    // -- recovery ----------------------------------------------------------
    ("flow.recovery.mergerestarted", "客户端重启，合并已中止", "The client restarted; the merge was aborted"),
    ("flow.recovery.retryexhausted", "客户端重启，自动重试次数已用尽", "The client restarted; automatic retries are exhausted"),
    ("flow.recovery.retrydisabled", "客户端重启，已停止自动重试", "The client restarted; automatic retries stopped"),
    // -- task rejections ---------------------------------------------------
    ("flow.task.exists", "任务已存在：{}", "Task already exists: {}"),
    ("flow.task.bugactive", "该缺陷已有未结束的任务（{}）", "This bug already has an unfinished task ({})"),
    ("flow.task.notfound", "任务不存在", "Task not found"),
    ("flow.task.notretryable", "任务仍在队列或运行中，不能重试", "The task is still queued or running and cannot be retried"),
    ("flow.task.notawaitingapproval", "任务不在待审核状态", "The task is not awaiting review"),
    ("flow.task.notawaitingmerge", "任务不在待合并状态", "The task is not awaiting merge"),
    ("flow.task.nobranch", "任务没有待合并分支", "The task has no branch to merge"),
    ("flow.task.repoempty", "主仓库路径为空", "The main repository path is empty"),
    ("flow.task.mergefailed", "任务 {} 合并失败：{}", "Task {} failed to merge: {}"),
    ("flow.task.mergeblocked", "任务 {} 无法自动合并：{}", "Task {} cannot merge automatically: {}"),
    ("flow.task.notcancelable", "任务已经结束，无需取消", "The task has already finished; nothing to cancel"),
    ("flow.task.deletefinishedonly", "只能删除已结束的任务", "Only finished tasks can be deleted"),
    ("flow.task.worktreebusy", "队列中还有未结束的任务，无法切换 Worktree", "Tasks are still unfinished in the queue; cannot switch Worktree"),
    ("flow.task.notpreparing", "任务不在准备状态", "The task is not preparing"),
    ("flow.task.exitcode", "Agent 进程退出码 {}", "Agent process exited with code {}"),
    ("flow.task.processfailed", "Agent 进程异常结束", "The agent process ended unexpectedly"),
    ("flow.task.canceled", "已取消", "Canceled"),
    ("flow.task.commitdirty", "提交阶段仍有未提交改动", "Uncommitted changes remain after the commit step"),
    // -- review ------------------------------------------------------------
    ("flow.review.stopped", "已停止审核，改动保留在工作区", "Review stopped; changes are kept in the working tree"),
    ("flow.review.approvalready", "Agent 完成修改，等待审核", "Agent finished editing; awaiting review"),
    ("flow.review.approvalreadyfiles", "Agent 完成修改，涉及 {} 个文件，等待审核", "Agent finished editing {} files; awaiting review"),
];
