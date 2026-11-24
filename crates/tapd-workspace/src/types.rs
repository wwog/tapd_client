//! Public value types shared by the workspace summary and diff APIs.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Files listed per summary; `ChangeSummary::file_count` stays exact.
pub const MAX_LISTED_FILES: usize = 200;
/// Diff text is cut at this many characters, not bytes.
pub const MAX_DIFF_CHARS: usize = 120_000;
/// One side of a file, as shipped for the review's inline diff. Larger files
/// are cut and flagged rather than refused: the first part still diffs.
pub const MAX_FILE_CHARS: usize = 512_000;
/// The canonical empty tree, used when a task has no baseline commit.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// One task's place in a repository.
///
/// `repo_path` is the repository root handed to `git -C`; `work_dir` is the
/// worktree (or the main repository for a single-task run). A worktree task
/// keeps `branch`/`baseline` so its changes stay readable after the worktree
/// directory is removed.
#[derive(Clone, Debug)]
pub struct TaskWorkspace {
    pub repo_path: String,
    pub work_dir: String,
    pub branch: Option<String>,
    pub baseline: Option<String>,
    pub excluded: Vec<String>,
}

/// Everything the UI needs to describe a workspace at a glance.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSummary {
    /// At most [`MAX_LISTED_FILES`] entries; `file_count` is the real total.
    pub files: Vec<ChangedFile>,
    pub file_count: usize,
    pub additions: usize,
    pub deletions: usize,
    /// Uncommitted changes remain, excluding `TaskWorkspace::excluded`.
    pub dirty: bool,
    /// HEAD (or the branch tip) differs from the baseline.
    pub committed: bool,
    /// The commit holding this task's change when `committed` is set; `None`
    /// when the change only lives in the working tree (or the branch tip is
    /// still the baseline), so callers never present the starting commit as
    /// the task's product.
    pub commit: Option<String>,
}

impl ChangeSummary {
    /// A workspace with nothing to report: no run has captured a baseline yet.
    pub fn empty() -> Self {
        Self {
            files: Vec::new(),
            file_count: 0,
            additions: 0,
            deletions: 0,
            dirty: false,
            committed: false,
            commit: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: ChangeKind,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffView {
    pub text: String,
    pub truncated: bool,
    pub empty: bool,
}

/// Both sides of one file, for the review's inline diff.
///
/// The editor diffs these itself, so no line numbers or hunks travel through
/// the command channel; each side is `None` when the file does not exist there
/// (added, deleted or new repository).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileSides {
    pub base: Option<String>,
    pub current: Option<String>,
    /// A side was cut at [`MAX_FILE_CHARS`].
    pub truncated: bool,
    /// A side is not UTF-8 text, so there is nothing to diff.
    pub binary: bool,
}

/// A workspace failure with an already-localised message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceError {
    message: String,
}

impl WorkspaceError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// The localised message, including git's stderr when one is available.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for WorkspaceError {}
