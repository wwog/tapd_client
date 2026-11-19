//! Pure helpers for the built-in DeepSeek Harness runtime.
//!
//! The desktop app owns the process, files and sockets; this crate owns the
//! parts worth testing without them:
//!
//! - [`node`]: the system-Node version gate (no bundled Node).
//! - [`payload`]: the shipped payload manifest and freshness rules.
//! - [`profile`]: `$DSH_HOME/profiles/tapd/` file rendering.
//! - [`protocol`]: typed SDK JSON-RPC messages.
//! - [`rpc`]: newline framing and dispatch.
//! - [`transcript`]: the normalized session/entry/stream contract every
//!   frontend reads.
//!
//! Contract notes live in `docs/DSH.md`.

pub mod node;
pub mod payload;
pub mod profile;
pub mod protocol;
pub mod rpc;
pub mod transcript;

pub use node::{requirement as node_requirement, NodeRequirementError, NodeVersion};
pub use payload::PayloadManifest;
pub use profile::{PluginRow, ProfileSpec, ProviderConfig, ProviderModel};
pub use rpc::{Incoming, RpcError, RpcId};
pub use transcript::{
    DshDelta, DshEntry, DshSession, DshStream, ModelSelection, SessionStatus, ToolStatus,
    Transcript, TurnState,
};
