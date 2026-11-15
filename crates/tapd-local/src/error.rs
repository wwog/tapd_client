//! Domain errors for local projects and work items.

use std::error::Error;
use std::fmt;

/// Rejected input, not a failed environment: the caller supplied an empty
/// required field or an unknown status text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocalError {
    EmptyProjectName,
    EmptyRepoPath,
    EmptyTitle,
    EmptyTaskId,
    /// A status string read back from storage that this version does not know.
    InvalidStatus(String),
}

impl fmt::Display for LocalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyProjectName => f.write_str("project name is empty"),
            Self::EmptyRepoPath => f.write_str("repository path is empty"),
            Self::EmptyTitle => f.write_str("work item title is empty"),
            Self::EmptyTaskId => f.write_str("agent task id is empty"),
            Self::InvalidStatus(status) => write!(f, "unknown work item status: {status}"),
        }
    }
}

impl Error for LocalError {}
