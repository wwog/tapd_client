//! Pure review/merge/config policies. Kept free of state so they can be tested
//! directly and reused by hosts.

use tapd_i18n::tr_args;

use crate::config::WorkflowConfig;
use crate::task::{Task, TaskStatus};

/// Manual fallback shown when an agent merge cannot run.
pub fn manual_merge_instructions(repo: &str, branch: &str) -> String {
    tr_args("flow.merge.manualsteps", &[&repo, &branch])
}

/// Prompt for the merge runner. The host renders it into the runtime request.
pub fn merge_prompt(repo: &str, branch: &str) -> String {
    tr_args("flow.merge.prompt", &[&repo, &branch, &branch])
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
