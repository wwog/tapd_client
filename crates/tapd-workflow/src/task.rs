//! Task data model. The JSON shape mirrors the desktop app's historical
//! `AgentTask` records: camelCase, flat worktree fields and string timestamps.

use serde::{Deserialize, Serialize};

use crate::config::WorkflowConfig;

/// Timestamps are opaque strings supplied by the host (normally RFC 3339).
/// The core never reads a clock.
pub type Timestamp = String;

/// Identifier supplied by the host. Transparent so old JSON storing a plain
/// string keeps working.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TaskId(pub String);

impl TaskId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for TaskId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl From<String> for TaskId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl std::fmt::Display for TaskId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Preparing,
    Running,
    /// Agent finished a change that needs a human commit decision.
    AwaitingApproval,
    /// Change committed on its worktree branch; waiting for a merge decision.
    AwaitingMerge,
    /// A merge agent (or a manual verification) is working on the main repo.
    Merging,
    Succeeded,
    Failed,
    Canceled,
}

impl TaskStatus {
    /// Occupies an execution slot (or the merge runner).
    pub fn is_active(self) -> bool {
        matches!(self, Self::Preparing | Self::Running | Self::Merging)
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Canceled)
    }
}

/// Everything a host needs to start a fix run. Flattened into [`Task`] so the
/// JSON stays compatible with the existing `AgentTask` record.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskSpec {
    pub workspace_id: String,
    pub workspace_name: String,
    pub bug_id: String,
    pub title: String,
    pub severity: String,
    pub priority: String,
    pub repo_path: String,
    pub runtime_id: String,
    /// 本次运行使用的模型；空字符串表示运行时默认。
    pub model: String,
    /// 本次运行的访问权限选项 id；空字符串表示运行时默认。
    pub permission_mode: String,
    /// Origin of the task (`manual` / `notification`), host-owned metadata.
    #[serde(default)]
    pub source: String,
    pub extra_prompt: String,
    pub attachments: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChangeSet {
    pub files: Vec<String>,
    /// Uncommitted files remain in the working tree.
    pub dirty: bool,
    /// At least one commit was produced after the run baseline.
    pub committed: bool,
}

impl ChangeSet {
    pub fn new(files: Vec<String>, dirty: bool, committed: bool) -> Self {
        Self {
            files,
            dirty,
            committed,
        }
    }

    pub fn has_changes(&self) -> bool {
        self.dirty || self.committed
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRef {
    pub path: String,
    pub branch: String,
}

/// A change waiting for a commit decision.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskApproval {
    pub summary: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<String>,
    pub requested_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_at: Option<Timestamp>,
    /// Stash reference recorded by the host when a review is stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stash: Option<String>,
}

/// Merge-stage state, including the manual fallback text.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskMerge {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<Timestamp>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: TaskId,
    /// Flattened into the task JSON, matching the historical record layout.
    #[serde(flatten)]
    pub spec: TaskSpec,
    pub status: TaskStatus,
    /// Number of automatic retries already spent after interruptions.
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub created_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<Timestamp>,
    /// Exported bug package handed to the agent. Old records may lack it.
    #[serde(default)]
    pub json_path: String,
    /// Flat worktree fields are preserved for JSON compatibility; use
    /// [`Task::worktree`] to read them as a pair.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<TaskApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge: Option<TaskMerge>,
    /// Next run only verifies, commits and writes back to TAPD.
    #[serde(default)]
    pub commit_only: bool,
    /// Files already dirty before the run; excluded from the change safety net.
    #[serde(default)]
    pub baseline_dirty: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_head: Option<String>,
    /// Host-computed change summary for the last run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<ChangeSet>,
    /// The previous run was interrupted by a restart/suspend.
    #[serde(default)]
    pub interrupted: bool,
}

impl Task {
    pub fn new(id: TaskId, spec: TaskSpec, created_at: Timestamp) -> Self {
        Self {
            id,
            spec,
            status: TaskStatus::Queued,
            attempt: 0,
            created_at,
            started_at: None,
            finished_at: None,
            json_path: String::new(),
            worktree_path: None,
            worktree_branch: None,
            exit_code: None,
            error: None,
            prompt: String::new(),
            agent_session_id: None,
            approval: None,
            merge: None,
            commit_only: false,
            baseline_dirty: Vec::new(),
            baseline_head: None,
            changes: None,
            interrupted: false,
        }
    }

    pub fn worktree(&self) -> Option<WorktreeRef> {
        let path = self
            .worktree_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())?;
        let branch = self
            .worktree_branch
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())?;
        Some(WorktreeRef {
            path: path.to_string(),
            branch: branch.to_string(),
        })
    }

    pub fn is_worktree(&self) -> bool {
        self.worktree().is_some()
    }

    /// Directory the agent works in: worktree when present, else the repo.
    pub fn work_dir(&self) -> &str {
        self.worktree_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .unwrap_or(&self.spec.repo_path)
    }

    pub fn branch(&self) -> Option<&str> {
        self.worktree_branch
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
    }
}

/// Persisted workflow state. `generation` is optional so older snapshots load
/// unchanged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snapshot {
    pub schema_version: u32,
    pub config: WorkflowConfig,
    pub paused: bool,
    pub tasks: Vec<Task>,
    pub generation: u64,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            schema_version: crate::SCHEMA_VERSION,
            config: WorkflowConfig::default(),
            paused: false,
            tasks: Vec::new(),
            generation: 0,
        }
    }
}

impl Snapshot {
    pub fn new(config: WorkflowConfig) -> Self {
        Self {
            schema_version: crate::SCHEMA_VERSION,
            config,
            paused: false,
            tasks: Vec::new(),
            generation: 0,
        }
    }
}
