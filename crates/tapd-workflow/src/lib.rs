//! Sans-IO core for the desktop agent workflow: task state machine, execution
//! unit scheduling, review/merge policy, recovery and terminal history.
//!
//! The crate has no platform dependencies. The host feeds facts as
//! [`Input`] values into [`Workflow::apply`] and executes the returned
//! [`Effect`]s. Time, ids, paths and repository state all come from the host.
#![forbid(unsafe_code)]

pub mod config;
pub mod effect;
pub mod history;
pub mod input;
pub mod policy;
pub mod recovery;
pub mod scheduler;
pub mod task;
pub mod workflow;

pub const SCHEMA_VERSION: u32 = 1;

pub use config::{
    effective_units, RecoveryPolicy, WorkflowConfig, DEFAULT_EXECUTION_UNITS,
    DEFAULT_MAX_AUTO_RETRY, MAX_EXECUTION_UNITS, MIN_EXECUTION_UNITS,
};
pub use effect::{Effect, EffectId, NoticeLevel, RecoveryReport};
pub use history::{HistoryRecord, TerminalStatus};
pub use input::{Input, MergeBlock, RunOutcome};
pub use policy::{merge_prompt, worktree_toggle_locked};
pub use recovery::{suspend, RecoveryOutcome, RESTARTED_MERGE_ERROR};
pub use scheduler::{active_count, next_queued_index, task_counts, TaskCounts};
pub use task::{
    ChangeSet, Snapshot, Task, TaskApproval, TaskId, TaskMerge, TaskSpec, TaskStatus, Timestamp,
    WorktreeRef,
};
pub use workflow::{status_key, Workflow};

/// Convenience re-export: the manual fallback text lives in `policy`.
pub use policy::manual_merge_instructions;
