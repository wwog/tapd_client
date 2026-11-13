//! Effects returned to the host. The core never performs them; the host maps
//! each variant to its git/PTY/store adapters and feeds the receipt back as an
//! [`crate::Input`].

use serde::{Deserialize, Serialize};
use tapd_i18n::tr_args;

use crate::config::WorkflowConfig;
use crate::history::HistoryRecord;
use crate::input::MergeBlock;
use crate::task::{Task, TaskId, TaskSpec, Timestamp};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EffectId(pub u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub id: u64,
    pub restored_at: Timestamp,
    pub queued: usize,
    pub retried: usize,
    pub awaiting_approval: usize,
    pub awaiting_merge: usize,
    pub failed: usize,
    /// The queue was restored but is paused: queued tasks are kept and wait
    /// for an explicit user resume instead of continuing automatically.
    pub queue_paused: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    // -- protocol -----------------------------------------------------------
    Rejected {
        message: String,
    },
    LoadSnapshot,
    /// Upsert only the tasks that changed. Host applies by `id`.
    PersistChanged {
        tasks: Vec<Task>,
    },
    /// The task record is gone; the host removes it from its store.
    PersistDeleted {
        task_id: TaskId,
    },
    /// The queue pause flag changed (or is being reported at shutdown). The
    /// host persists it next to the task snapshot.
    PersistPaused {
        paused: bool,
    },
    PersistConfig {
        config: WorkflowConfig,
    },
    AppendHistory {
        record: HistoryRecord,
    },
    EmitRecoveryReport {
        report: RecoveryReport,
    },
    EmitNotice {
        level: NoticeLevel,
        message: String,
    },
    /// Lightweight "snapshot changed" ping for hosts that do not persist
    /// per-effect (e.g. deletion or pause changes).
    StateChanged,

    // -- worktree / workspace ----------------------------------------------
    CreateWorktree {
        effect: EffectId,
        task_id: TaskId,
        repo_path: String,
        bug_id: String,
    },
    InspectWorkspace {
        effect: EffectId,
        task_id: TaskId,
        path: String,
    },
    RemoveWorktree {
        effect: EffectId,
        task_id: TaskId,
        repo_path: String,
        path: String,
    },

    // -- fix agent ----------------------------------------------------------
    StartFixAgent {
        effect: EffectId,
        task_id: TaskId,
        runtime_id: String,
        cwd: String,
        spec: TaskSpec,
    },
    CancelAgent {
        task_id: TaskId,
    },

    // -- merge --------------------------------------------------------------
    CheckMergePreconditions {
        effect: EffectId,
        task_id: TaskId,
        repo_path: String,
        branch: String,
    },
    StartMergeAgent {
        effect: EffectId,
        task_id: TaskId,
        repo_path: String,
        branch: String,
        spec: TaskSpec,
    },
    VerifyBranchMerged {
        effect: EffectId,
        task_id: TaskId,
        repo_path: String,
        branch: String,
    },
}

impl Effect {
    pub fn rejected(message: impl Into<String>) -> Self {
        Self::Rejected {
            message: message.into(),
        }
    }

    pub fn merge_block_notice(task_id: &TaskId, block: &MergeBlock) -> Self {
        Self::EmitNotice {
            level: NoticeLevel::Warning,
            message: tr_args("flow.task.mergeblocked", &[task_id, &block.message()]),
        }
    }
}
