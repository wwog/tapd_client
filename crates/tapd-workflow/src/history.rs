//! Terminal history records. The core only declares the shape and the moment
//! to append; persistence belongs to the host.

use serde::{Deserialize, Serialize};

use crate::task::{Task, TaskMerge, TaskStatus, Timestamp};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Succeeded,
    Failed,
    Canceled,
}

impl TerminalStatus {
    pub fn from_status(status: TaskStatus) -> Option<Self> {
        match status {
            TaskStatus::Succeeded => Some(Self::Succeeded),
            TaskStatus::Failed => Some(Self::Failed),
            TaskStatus::Canceled => Some(Self::Canceled),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub task_id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub bug_id: String,
    pub title: String,
    pub status: TerminalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Timestamp>,
    pub finished_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge: Option<TaskMerge>,
}

impl HistoryRecord {
    /// Builds a record for a terminal task. Returns `None` for live tasks so
    /// callers cannot accidentally write an incomplete history row.
    pub fn from_task(task: &Task) -> Option<Self> {
        let status = TerminalStatus::from_status(task.status)?;
        Some(Self {
            task_id: task.id.0.clone(),
            workspace_id: task.spec.workspace_id.clone(),
            workspace_name: task.spec.workspace_name.clone(),
            bug_id: task.spec.bug_id.clone(),
            title: task.spec.title.clone(),
            status,
            started_at: task.started_at.clone(),
            finished_at: task
                .finished_at
                .clone()
                .unwrap_or_else(|| task.started_at.clone().unwrap_or_default()),
            exit_code: task.exit_code,
            error: task.error.clone(),
            worktree_branch: task.worktree_branch.clone(),
            merge: task.merge.clone(),
        })
    }

    /// Idempotence key the host may use for `INSERT OR IGNORE`.
    pub fn key(&self) -> (&str, &str) {
        (&self.task_id, &self.finished_at)
    }
}
