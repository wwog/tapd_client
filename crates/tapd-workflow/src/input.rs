//! Inputs accepted by [`crate::Workflow::apply`]. Everything platform
//! specific is a fact the host observed; the core never creates these itself.

use crate::task::{ChangeSet, Snapshot, TaskId, TaskSpec, Timestamp, WorktreeRef};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunOutcome {
    pub canceled: bool,
    pub success: bool,
    pub error: Option<String>,
    pub changes: Option<ChangeSet>,
    pub exit_code: Option<i32>,
}

impl RunOutcome {
    pub fn success(changes: Option<ChangeSet>) -> Self {
        Self {
            canceled: false,
            success: true,
            error: None,
            changes,
            exit_code: Some(0),
        }
    }

    pub fn failure(error: impl Into<String>, changes: Option<ChangeSet>) -> Self {
        Self {
            canceled: false,
            success: false,
            error: Some(error.into()),
            changes,
            exit_code: None,
        }
    }

    pub fn canceled() -> Self {
        Self {
            canceled: true,
            success: false,
            error: None,
            changes: None,
            exit_code: None,
        }
    }
}

impl Default for RunOutcome {
    fn default() -> Self {
        Self {
            canceled: false,
            success: false,
            error: None,
            changes: None,
            exit_code: None,
        }
    }
}

/// Why the host refused to start a merge agent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MergeBlock {
    DirtyRepository { files: usize },
    RuntimeUnavailable { error: String },
    RepositoryBusy,
    WorktreeMissing,
}

impl MergeBlock {
    pub fn message(&self) -> String {
        match self {
            Self::DirtyRepository { files } => {
                format!("主仓库有 {files} 个未提交文件，无法自动合并")
            }
            Self::RuntimeUnavailable { error } => error.clone(),
            Self::RepositoryBusy => "该仓库已有任务正在合并，请稍后重试".to_string(),
            Self::WorktreeMissing => "任务缺少分支或 worktree，无法自动合并".to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    // -- host lifecycle -----------------------------------------------------
    SystemEntered {
        now: Timestamp,
    },
    SnapshotLoaded {
        snapshot: Snapshot,
    },
    Suspend {
        now: Timestamp,
    },
    AcknowledgeRecovery {
        report_id: u64,
    },

    // -- user / UI ----------------------------------------------------------
    Enqueue {
        task_id: TaskId,
        spec: TaskSpec,
        now: Timestamp,
    },
    Retry {
        task_id: TaskId,
        new_id: TaskId,
        now: Timestamp,
    },
    ApproveReview {
        task_id: TaskId,
        now: Timestamp,
    },
    StopReview {
        task_id: TaskId,
        now: Timestamp,
    },
    StartMerge {
        task_id: TaskId,
        now: Timestamp,
    },
    VerifyMerge {
        task_id: TaskId,
        now: Timestamp,
    },
    Cancel {
        task_id: TaskId,
        now: Timestamp,
    },
    DeleteTerminal {
        task_id: TaskId,
    },
    ResumeQueue {
        now: Timestamp,
    },
    SetConfig {
        config: crate::config::WorkflowConfig,
    },

    // -- host facts ---------------------------------------------------------
    AgentStarted {
        task_id: TaskId,
    },
    AgentStartFailed {
        task_id: TaskId,
        error: String,
    },
    RunFinished {
        task_id: TaskId,
        outcome: RunOutcome,
        now: Timestamp,
    },
    WorktreeCreated {
        task_id: TaskId,
        worktree: WorktreeRef,
    },
    WorktreeCreateFailed {
        task_id: TaskId,
        error: String,
    },
    WorktreeRemoved {
        task_id: TaskId,
        error: Option<String>,
    },
    WorkspaceInspected {
        task_id: TaskId,
        changes: ChangeSet,
    },
    MergePreconditionsChecked {
        task_id: TaskId,
        result: Result<(), MergeBlock>,
    },
    MergeAgentFinished {
        task_id: TaskId,
        outcome: RunOutcome,
        now: Timestamp,
    },
    BranchMergeVerified {
        task_id: TaskId,
        merged: bool,
        error: Option<String>,
    },
}
