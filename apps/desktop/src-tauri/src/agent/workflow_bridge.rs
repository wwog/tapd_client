//! Bridge between the desktop `AgentTask` records and the sans-IO
//! [`tapd_workflow`] core.
//!
//! The two JSON shapes are already aligned (camelCase, flattened task spec,
//! transparent `TaskId`, string timestamps), so the mapping is a plain
//! `serde_json` round trip instead of a hand-written converter. That keeps the
//! desktop record the single persisted format while the core owns task state,
//! scheduling, review/merge and recovery rules.

use tapd_workflow::config::{RecoveryPolicy, WorkflowConfig};
use tapd_workflow::task::Task;
use tapd_workflow::RecoveryReport;

use super::{AgentConfig, AgentTask};

/// Returned by queue commands issued before the user entered the system
/// (login valid + onboarding finished).
pub(super) const NOT_ENTERED: &str = "工作流尚未初始化，请先进入系统";

/// Workflow configuration derived from the desktop Agent settings. The
/// recovery policy keeps the crate defaults (auto retry interrupted runs, at
/// most three attempts) and maps the "resume queued tasks on startup" setting.
pub(super) fn workflow_config(config: &AgentConfig) -> WorkflowConfig {
    WorkflowConfig {
        worktree_enabled: config.worktree_enabled,
        execution_units: config.execution_units,
        recovery_policy: RecoveryPolicy {
            restore_queued: config.restore_queued_tasks,
            ..RecoveryPolicy::default()
        },
    }
}

/// Desktop record -> core task.
pub(super) fn to_workflow_task(task: &AgentTask) -> Result<Task, String> {
    let value = serde_json::to_value(task)
        .map_err(|error| format!("任务 {} 无法转换为工作流任务：{error}", task.id))?;
    serde_json::from_value(value)
        .map_err(|error| format!("任务 {} 无法转换为工作流任务：{error}", task.id))
}

/// Core task -> desktop record.
pub(super) fn from_workflow_task(task: &Task) -> Result<AgentTask, String> {
    let value = serde_json::to_value(task)
        .map_err(|error| format!("工作流任务 {} 无法转换为任务记录：{error}", task.id))?;
    serde_json::from_value(value)
        .map_err(|error| format!("工作流任务 {} 无法转换为任务记录：{error}", task.id))
}

/// A report with no counters carries no information for the user.
pub(super) fn report_is_empty(report: &RecoveryReport) -> bool {
    report.queued == 0
        && report.retried == 0
        && report.awaiting_approval == 0
        && report.awaiting_merge == 0
        && report.failed == 0
}
