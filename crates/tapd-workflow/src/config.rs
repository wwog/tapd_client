//! Workflow configuration: worktree isolation, execution units and recovery.

use serde::{Deserialize, Serialize};

/// Number of task runners when worktree isolation is enabled. Kept within
/// `1..=8` so a hand-edited snapshot cannot start an unbounded number of
/// agents.
pub const MIN_EXECUTION_UNITS: u32 = 1;
pub const MAX_EXECUTION_UNITS: u32 = 8;
pub const DEFAULT_EXECUTION_UNITS: u32 = 2;
pub const DEFAULT_MAX_AUTO_RETRY: u32 = 3;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkflowConfig {
    /// When true every task runs in its own git worktree and up to
    /// `execution_units` tasks run in parallel. When false the queue is serial
    /// and each task works directly in the repository.
    pub worktree_enabled: bool,
    /// Requested number of concurrent task runners. Clamped by
    /// [`effective_units`]; always 1 without worktrees.
    pub execution_units: u32,
    pub recovery_policy: RecoveryPolicy,
}

impl Default for WorkflowConfig {
    fn default() -> Self {
        Self {
            worktree_enabled: false,
            execution_units: DEFAULT_EXECUTION_UNITS,
            recovery_policy: RecoveryPolicy::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecoveryPolicy {
    /// Requeue a task that was `Preparing`/`Running` when the client exited.
    /// When false such tasks fail immediately on startup.
    pub auto_retry_interrupted: bool,
    /// Maximum number of automatic retries after interruptions. A task whose
    /// next attempt would exceed this fails on startup.
    pub max_auto_retry: u32,
    /// Keep tasks that were `Queued` when the client exited and let them run
    /// again after recovery. When false the queue is kept either way, but it
    /// stays paused until the user resumes it.
    #[serde(default = "default_true")]
    pub restore_queued: bool,
}

/// Field-level `serde(default = ...)`: the container default would otherwise
/// deserialize a missing `restore_queued` as `false` for a hand-written
/// snapshot.
fn default_true() -> bool {
    true
}

impl Default for RecoveryPolicy {
    fn default() -> Self {
        Self {
            auto_retry_interrupted: true,
            max_auto_retry: DEFAULT_MAX_AUTO_RETRY,
            restore_queued: true,
        }
    }
}

/// Scheduling width: worktrees clamp the configured units to `1..=8`; without
/// worktrees the queue is serial regardless of the stored value.
pub fn effective_units(config: &WorkflowConfig) -> usize {
    if config.worktree_enabled {
        config
            .execution_units
            .clamp(MIN_EXECUTION_UNITS, MAX_EXECUTION_UNITS) as usize
    } else {
        1
    }
}

impl WorkflowConfig {
    pub fn effective_units(&self) -> usize {
        effective_units(self)
    }
}
