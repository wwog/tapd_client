//! Local-only projects and their work items.
//!
//! A local project is a folder on this machine with no TAPD workspace behind
//! it; its items are never written back to TAPD. The data lives in its own
//! SQLite file ([`tapd_core::paths::AppPaths::local_db_file`]) so TAPD logout
//! and "清理缓存" cannot delete it.
//!
//! Layout:
//! - [`store`]: schema, validation and all persistence.
//! - [`command`]: the `local_*` feature commands (desktop + paired phone).

pub(crate) mod command;
mod store;

pub use store::LocalStore;
