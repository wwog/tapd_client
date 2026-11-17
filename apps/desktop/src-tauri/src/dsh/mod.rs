//! Built-in agent runtime: payload extraction, process supervision and the
//! SDK JSON-RPC control plane.
//!
//! Contract and research notes live in `docs/DSH.md`. The pieces:
//!
//! - [`payload`]: find the shipped archive, verify it, extract it into the data
//!   directory (`<data>/dsh/<version>/`), and clean superseded versions.
//! - [`runtime`]: resolve system Node, compose the profile, spawn the runtime,
//!   pump stdio, and answer approvals / questions.
//! - [`bridge`]: the plugin socket listener and the normalized transcript
//!   registry every frontend reads.
//! - [`feature`]: the shared `dsh_*` operations for the Tauri commands and the
//!   companion feature router.
//! - [`commands`]: the Tauri command surface.
//!
//! Nothing here bundles Node or calls npm: the payload is a prepared JS tree and
//! the runtime is `node <payload>/@deepseek-ai/dsh/lib/bin.js`.

pub mod bridge;
pub mod commands;
pub mod feature;
mod meter_store;
mod mode_store;
pub mod payload;
pub mod policy;
pub mod runtime;
pub mod session_log;
pub mod tasks;
pub mod team;
/// Debug-only fake model provider (`TestAgent`).
#[cfg(debug_assertions)]
pub mod test_agent;



/// Tauri event names. The frontend subscribes to these; the payload stays local.
pub const EVENT_READY: &str = "dsh://ready";
pub const EVENT_STATUS: &str = "dsh://status";
pub const EVENT_SESSION_EVENT: &str = "dsh://session-event";
pub const EVENT_APPROVAL: &str = "dsh://approval";
pub const EVENT_QUESTION: &str = "dsh://question";
/// A request was answered (or its runtime went away), whichever surface did it.
/// The payload is `{ rpcId }`; every other surface drops that card.
pub const EVENT_SETTLED: &str = "dsh://request-settled";
pub const EVENT_ERROR: &str = "dsh://error";

/// Normalized views (the ones UIs should render). `dsh://entry` carries a
/// committed [`dsh_host::transcript::DshEntry`], `dsh://stream` a live delta,
/// and `dsh://sessions` the full session list (newest first).
pub const EVENT_ENTRY: &str = "dsh://entry";
pub const EVENT_STREAM: &str = "dsh://stream";
pub const EVENT_SESSIONS: &str = "dsh://sessions";
