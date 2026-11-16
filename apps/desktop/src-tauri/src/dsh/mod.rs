//! Built-in agent runtime: payload extraction, process supervision and the
//! SDK JSON-RPC control plane.
//!
//! Contract and research notes live in `docs/DSH.md`. The pieces:
//!
//! - [`payload`]: find the shipped archive, verify it, extract it into the data
//!   directory (`<data>/dsh/<version>/`), and clean superseded versions.
//! - [`runtime`]: resolve system Node, compose the profile, spawn the runtime,
//!   pump stdio, and answer approvals / questions.
//! - [`commands`]: the Tauri command surface.
//!
//! Nothing here bundles Node or calls npm: the payload is a prepared JS tree and
//! the runtime is `node <payload>/@deepseek-ai/dsh/lib/bin.js`.

pub mod commands;
pub mod payload;
pub mod runtime;



/// Tauri event names. The frontend subscribes to these; the payload stays local.
pub const EVENT_READY: &str = "dsh://ready";
pub const EVENT_STATUS: &str = "dsh://status";
pub const EVENT_SESSION_EVENT: &str = "dsh://session-event";
pub const EVENT_APPROVAL: &str = "dsh://approval";
pub const EVENT_QUESTION: &str = "dsh://question";
pub const EVENT_ERROR: &str = "dsh://error";
