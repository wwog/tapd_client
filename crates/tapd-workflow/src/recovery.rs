//! Startup recovery rules. Pure mutation over the loaded snapshot; the
//! workflow turns the outcome into a report and history effects.

use crate::config::WorkflowConfig;
use crate::policy::manual_merge_instructions;
use crate::task::{Task, TaskMerge, TaskStatus};

pub const RESTARTED_MERGE_ERROR: &str = "客户端重启，合并已中止";
pub const RETRY_EXHAUSTED_ERROR: &str = "客户端重启，自动重试次数已用尽";
pub const RETRY_DISABLED_ERROR: &str = "客户端重启，已停止自动重试";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecoveryOutcome {
    /// Indexes of tasks whose persisted representation changed.
    pub changed: Vec<usize>,
    /// Indexes of tasks that became `Failed` during recovery.
    pub failed: Vec<usize>,
    pub queued: usize,
    pub retried: usize,
    pub awaiting_approval: usize,
    pub awaiting_merge: usize,
}

pub fn recover(tasks: &mut [Task], config: &WorkflowConfig, restored_at: &str) -> RecoveryOutcome {
    let mut outcome = RecoveryOutcome::default();
    for (index, task) in tasks.iter_mut().enumerate() {
        match task.status {
            TaskStatus::Queued => outcome.queued += 1,
            TaskStatus::Preparing | TaskStatus::Running => {
                let next_attempt = task.attempt.saturating_add(1);
                task.attempt = next_attempt;
                task.interrupted = true;
                task.started_at = None;
                task.finished_at = None;
                task.exit_code = None;
                task.error = None;

                if config.recovery_policy.auto_retry_interrupted
                    && next_attempt <= config.recovery_policy.max_auto_retry
                {
                    task.status = TaskStatus::Queued;
                    outcome.retried += 1;
                } else {
                    task.status = TaskStatus::Failed;
                    task.error = Some(if config.recovery_policy.auto_retry_interrupted {
                        RETRY_EXHAUSTED_ERROR.to_string()
                    } else {
                        RETRY_DISABLED_ERROR.to_string()
                    });
                    task.finished_at = Some(restored_at.to_string());
                    outcome.failed.push(index);
                }
                outcome.changed.push(index);
            }
            TaskStatus::Merging => {
                task.status = TaskStatus::AwaitingMerge;
                task.started_at = None;
                task.finished_at = None;
                task.exit_code = None;
                task.error = None;
                let repo = task.spec.repo_path.clone();
                let branch = task.branch().unwrap_or("").to_string();
                let merge = task.merge.get_or_insert_with(Default::default);
                merge.error = Some(RESTARTED_MERGE_ERROR.to_string());
                merge.started_at = None;
                merge.finished_at = None;
                merge.instructions = Some(manual_merge_instructions(&repo, &branch));
                outcome.awaiting_merge += 1;
                outcome.changed.push(index);
            }
            TaskStatus::AwaitingApproval => outcome.awaiting_approval += 1,
            TaskStatus::AwaitingMerge => outcome.awaiting_merge += 1,
            TaskStatus::Succeeded | TaskStatus::Failed | TaskStatus::Canceled => {}
        }
    }
    outcome
}

/// Flips live tasks into their resting states when the client suspends.
///
/// `Preparing`/`Running` runs become `Queued` with `interrupted` set; an
/// in-flight merge becomes `AwaitingMerge` with the manual fallback text. The
/// attempt counter is deliberately left alone: only the next [`recover`] spends
/// a retry. Returns the indexes of tasks whose persisted representation
/// changed.
///
/// `now` is part of the host-facing signature so the caller can pass the same
/// timestamp used for the suspend effect. Every suspended field drops its
/// timestamp, so no value is recorded here.
pub fn suspend(tasks: &mut [Task], now: &str) -> Vec<usize> {
    let _ = now;
    let mut changed = Vec::new();
    for (index, task) in tasks.iter_mut().enumerate() {
        match task.status {
            TaskStatus::Preparing | TaskStatus::Running => {
                task.status = TaskStatus::Queued;
                task.interrupted = true;
                task.started_at = None;
                task.finished_at = None;
                task.exit_code = None;
                task.error = None;
                changed.push(index);
            }
            TaskStatus::Merging => {
                task.status = TaskStatus::AwaitingMerge;
                task.started_at = None;
                task.finished_at = None;
                task.exit_code = None;
                task.error = None;
                let repo = task.spec.repo_path.clone();
                let branch = task.branch().unwrap_or("").to_string();
                let merge = task.merge.get_or_insert_with(TaskMerge::default);
                merge.error = Some(RESTARTED_MERGE_ERROR.to_string());
                merge.started_at = None;
                merge.finished_at = None;
                merge.instructions = Some(manual_merge_instructions(&repo, &branch));
                changed.push(index);
            }
            _ => {}
        }
    }
    changed
}
