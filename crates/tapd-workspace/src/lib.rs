//! Git-backed change summary and diff for one task workspace.
//!
//! A task either edits the main repository (`work_dir` exists) or an isolated
//! worktree (`work_dir` + `branch`). Once a worktree is removed, its branch
//! still carries the changes, so both shapes share one [`TaskWorkspace`] API.
//!
//! Line counts, file status, binary detection, diffs and commits all come from
//! git itself; nothing here counts lines or inspects file contents.
#![forbid(unsafe_code)]

mod git;
mod types;

#[cfg(test)]
mod tests;

pub use types::{
    ChangeKind, ChangeSummary, ChangedFile, DiffView, TaskWorkspace, WorkspaceError, EMPTY_TREE,
    MAX_DIFF_CHARS, MAX_LISTED_FILES,
};
