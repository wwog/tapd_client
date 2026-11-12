//! Scheduling helpers: queue counts and FIFO selection.

use crate::config::{effective_units, WorkflowConfig};
use crate::task::{Task, TaskStatus};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TaskCounts {
    pub queued: usize,
    pub active: usize,
    pub awaiting_approval: usize,
    pub awaiting_merge: usize,
}

impl TaskCounts {
    pub fn total(&self) -> usize {
        self.queued + self.active + self.awaiting_approval + self.awaiting_merge
    }
}

pub fn task_counts(tasks: &[Task]) -> TaskCounts {
    let mut counts = TaskCounts::default();
    for task in tasks {
        match task.status {
            TaskStatus::Queued => counts.queued += 1,
            TaskStatus::Preparing | TaskStatus::Running | TaskStatus::Merging => counts.active += 1,
            TaskStatus::AwaitingApproval => counts.awaiting_approval += 1,
            TaskStatus::AwaitingMerge => counts.awaiting_merge += 1,
            TaskStatus::Succeeded | TaskStatus::Failed | TaskStatus::Canceled => {}
        }
    }
    counts
}

pub fn active_count(tasks: &[Task]) -> usize {
    tasks.iter().filter(|task| task.status.is_active()).count()
}

/// FIFO: insertion order, first queued task wins.
pub fn next_queued_index(tasks: &[Task]) -> Option<usize> {
    tasks
        .iter()
        .position(|task| task.status == TaskStatus::Queued)
}

pub fn can_start_more(config: &WorkflowConfig, tasks: &[Task]) -> bool {
    active_count(tasks) < effective_units(config)
}
