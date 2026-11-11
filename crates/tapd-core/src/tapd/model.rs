//! TAPD domain model.
//!
//! Plain data types: no parsing, no formatting. The types are grouped by the
//! aggregate they describe and re-exported here, so `tapd::model::BugDetail`
//! and friends keep their original paths.
//!
//! - `workspace`: workspaces and their members.
//! - `bug`: list rows, comments, attachments and the full detail.
//! - `change`: the change history attached to a detail.
//! - `media`: images/videos embedded in rich text.

mod bug;
mod change;
mod media;
mod workspace;

pub use bug::{Attachment, BugDetail, BugListPage, BugSummary, Comment};
pub use change::{ChangeEntry, ChangeField, ChangeHistory};
pub use media::{MediaKind, MediaRef};
pub use workspace::{Workspace, WorkspaceMember};
