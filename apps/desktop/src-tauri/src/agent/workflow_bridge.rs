//! Bridge between the desktop `AgentTask` records and the sans-IO
//! [`tapd_workflow`] core.
//!
//! The two JSON shapes are already aligned (camelCase, flattened task spec,
//! transparent `TaskId`, string timestamps), so the mapping is a plain
//! `serde_json` round trip instead of a hand-written converter. That keeps the
//! desktop record the single persisted format while the core owns the recovery
//! and suspend rules.
//!
//! Only recovery/suspend are wired here for now. The full state machine
//! migration is a later stage; until then the host keeps its own queue/review
//! logic and reuses the crate's pure policies.

use std::sync::atomic::{AtomicBool, Ordering};

use tapd_workflow::config::{RecoveryPolicy, WorkflowConfig};
use tapd_workflow::recovery;
use tapd_workflow::task::Task;
use tapd_workflow::RecoveryReport;

use super::{AgentConfig, AgentTask};

/// Returned by queue commands issued before the user entered the system
/// (login valid + onboarding finished).
pub(super) const NOT_ENTERED: &str = "工作流尚未初始化，请先进入系统";

/// Workflow configuration derived from the desktop Agent settings. The
/// recovery policy keeps the crate defaults (auto retry interrupted runs, at
/// most three attempts) until the host exposes its own settings.
pub(super) fn workflow_config(config: &AgentConfig) -> WorkflowConfig {
    WorkflowConfig {
        worktree_enabled: config.worktree_enabled,
        execution_units: config.execution_units,
        recovery_policy: RecoveryPolicy::default(),
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

/// Applies the core's startup recovery rules to the loaded queue.
///
/// Every task is mapped into the core, `recovery::recover` mutates the ones it
/// owns, and only the changed indexes are mapped back so the persisted record
/// keeps its own extra fields. Returns `None` when there is nothing to recover
/// (an empty queue); a mapping failure is an error, never a silent success.
///
/// Callers find the rewritten records again by the ids that were active before
/// the call: recovery only ever rewrites `Preparing`/`Running`/`Merging`.
pub(super) fn recover_tasks(
    tasks: &mut Vec<AgentTask>,
    config: &AgentConfig,
    now: &str,
) -> Result<Option<RecoveryReport>, String> {
    if tasks.is_empty() {
        return Ok(None);
    }

    let workflow_config = workflow_config(config);
    let mut converted = Vec::with_capacity(tasks.len());
    for task in tasks.iter() {
        converted.push(to_workflow_task(task)?);
    }

    let outcome = recovery::recover(&mut converted, &workflow_config, now);
    write_back(tasks, &converted, &outcome.changed)?;

    Ok(Some(RecoveryReport {
        id: report_id(now, &outcome),
        restored_at: now.to_string(),
        queued: outcome.queued,
        retried: outcome.retried,
        awaiting_approval: outcome.awaiting_approval,
        awaiting_merge: outcome.awaiting_merge,
        failed: outcome.failed.len(),
    }))
}

/// Parks live tasks before the client exits so a restart resumes them instead
/// of finding them `Running` forever. Returns the records that changed; they
/// must be persisted before the process is torn down.
pub(super) fn suspend_tasks(tasks: &mut [AgentTask], now: &str) -> Result<Vec<AgentTask>, String> {
    if tasks.is_empty() {
        return Ok(Vec::new());
    }

    let mut converted = Vec::with_capacity(tasks.len());
    for task in tasks.iter() {
        converted.push(to_workflow_task(task)?);
    }

    let changed = recovery::suspend(&mut converted, now);
    write_back(tasks, &converted, &changed)
}

/// Copies the changed core tasks back into the desktop records and returns the
/// resulting clones.
fn write_back(
    tasks: &mut [AgentTask],
    converted: &[Task],
    changed: &[usize],
) -> Result<Vec<AgentTask>, String> {
    let mut updated = Vec::with_capacity(changed.len());
    for &index in changed {
        let source = converted
            .get(index)
            .ok_or_else(|| format!("恢复索引越界：{index}"))?;
        let bridged = from_workflow_task(source)?;
        let slot = tasks
            .get_mut(index)
            .ok_or_else(|| format!("任务索引越界：{index}"))?;
        *slot = bridged;
        updated.push(slot.clone());
    }
    Ok(updated)
}

/// A report with no counters carries no information for the user.
pub(super) fn report_is_empty(report: &RecoveryReport) -> bool {
    report.queued == 0
        && report.retried == 0
        && report.awaiting_approval == 0
        && report.awaiting_merge == 0
        && report.failed == 0
}

/// Claims the one-time "entered the system" slot. Returns `true` only for the
/// first caller; repeated entry stays idempotent.
pub(super) fn claim_entry(entered: &AtomicBool) -> bool {
    !entered.swap(true, Ordering::SeqCst)
}

/// Undoes [`claim_entry`] when recovery failed, so a later login/entry can try
/// again instead of leaving the workflow permanently uninitialized.
pub(super) fn release_entry(entered: &AtomicBool) {
    entered.store(false, Ordering::SeqCst);
}

/// Gate for queue-mutating commands.
pub(super) fn ensure_entered(entered: &AtomicBool) -> Result<(), String> {
    if entered.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err(NOT_ENTERED.to_string())
    }
}

/// Stable report id derived from the timestamp and the counters: the host has
/// no clock in the core, and an id is only used to acknowledge the banner.
fn report_id(restored_at: &str, outcome: &recovery::RecoveryOutcome) -> u64 {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    restored_at.hash(&mut hasher);
    outcome.queued.hash(&mut hasher);
    outcome.retried.hash(&mut hasher);
    outcome.awaiting_approval.hash(&mut hasher);
    outcome.awaiting_merge.hash(&mut hasher);
    outcome.failed.len().hash(&mut hasher);
    hasher.finish()
}
