//! Local-only projects and their work items (UI word: 「事项」).
//!
//! A local project points at a repository path chosen on disk; its work items
//! are edited inside the client and never reach TAPD. This crate only
//! validates and normalizes: ids, timestamps and every filesystem/git/network
//! effect belong to the caller, so the same types back both a persisted store
//! and a deserialized snapshot.
#![forbid(unsafe_code)]

mod error;
mod types;

#[cfg(test)]
mod tests;

pub use error::LocalError;
pub use types::{
    project_id, work_item_id, LocalProject, WorkItem, WorkItemImportance, WorkItemStatus,
};
