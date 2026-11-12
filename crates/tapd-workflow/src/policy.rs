//! Pure review/merge/config policies. Kept free of state so they can be tested
//! directly and reused by hosts.

use crate::config::WorkflowConfig;
use crate::task::{Task, TaskStatus};

/// Manual fallback shown when an agent merge cannot run.
pub fn manual_merge_instructions(repo: &str, branch: &str) -> String {
    format!(
        "手动合并步骤：\n1. cd \"{repo}\"\n2. git status  # 工作区必须干净；有改动先 commit 或 git stash；上次合并中断可先 git merge --abort\n3. git merge \"{branch}\"\n4. 如有冲突：解决后 git add -A && git commit\n5. 运行相关测试\n6. 合并后回到 TAPD 更新状态并评论影响范围\n7. 回到本任务点「我已手动合并」"
    )
}

/// Prompt for the merge runner. The host renders it into the runtime request.
pub fn merge_prompt(repo: &str, branch: &str) -> String {
    format!(
        "请把已审核通过的修复分支合并到当前仓库，并完成 TAPD 回写。\n仓库：{repo}\n分支：{branch}\n\n要求：\n1. 先 git status 确认工作区干净；有未提交改动就停止并说明，不要提交或丢弃用户改动。\n2. git merge {branch}；有冲突时解决冲突，保留双方意图。\n3. 运行相关测试。\n4. 合并完成后：用 tapd_add_bug_comment 说明原因、方案与影响范围，再用 tapd_update_bug_status 更新缺陷状态；可先查 tapd_get_bug_transitions。\n5. 不要 push。\n6. 完成后说明结果。"
    )
}

/// Switching the worktree mode is locked while any task is live. Changing
/// `execution_units` is always allowed.
pub fn worktree_toggle_locked(current: bool, next: bool, has_live_task: bool) -> bool {
    next != current && has_live_task
}

pub fn has_live_task(tasks: &[Task]) -> bool {
    tasks.iter().any(|task| !task.status.is_terminal())
}

/// A serial (non-worktree) queue must stop while a review is pending; with
/// worktrees each task owns its checkout, so only an explicit pause blocks.
pub fn blocked(config: &WorkflowConfig, paused: bool, tasks: &[Task]) -> bool {
    paused
        || (!config.worktree_enabled
            && tasks
                .iter()
                .any(|task| task.status == TaskStatus::AwaitingApproval))
}

pub fn has_awaiting_approval(tasks: &[Task]) -> bool {
    tasks
        .iter()
        .any(|task| task.status == TaskStatus::AwaitingApproval)
}
