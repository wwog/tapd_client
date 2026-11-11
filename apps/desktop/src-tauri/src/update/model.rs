//! State model for the auto-update flow: phases, the known release and the
//! payload the UI receives on `update://state`.

use std::time::Instant;

use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    /// No update (or not checked yet).
    #[default]
    Idle,
    Checking,
    /// A newer release is known and ready to install.
    Available,
    Downloading,
    Installing,
    /// Package installed; the process is about to restart.
    Ready,
    /// Install failed. The main window stays hidden until the user cancels.
    Error,
}

impl UpdatePhase {
    /// Phases that own the screen: main hidden, island expanded.
    pub(super) fn owns_screen(self) -> bool {
        matches!(
            self,
            Self::Downloading | Self::Installing | Self::Ready | Self::Error
        )
    }

    /// Phase after a check settled: a recorded mandatory update keeps the
    /// modal, everything else returns to idle.
    pub(super) fn settled(forced: bool) -> Self {
        if forced {
            Self::Available
        } else {
            Self::Idle
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub notes: String,
    pub date: Option<String>,
    /// The release notes carried `FORCE_UPDATE_MARKER`: the upgrade cannot be
    /// dismissed or skipped.
    pub forced: bool,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub received: u64,
    pub total: Option<u64>,
    pub percent: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: UpdatePhase,
    pub current_version: String,
    pub checked_at: Option<String>,
    pub available: Option<AvailableUpdate>,
    pub progress: Option<UpdateProgress>,
    pub error: Option<String>,
    /// Release page for the manual-download fallback.
    pub manual_url: String,
}

#[derive(Default)]
pub(super) struct Inner {
    pub(super) phase: UpdatePhase,
    pub(super) checked_at: Option<String>,
    pub(super) available: Option<AvailableUpdate>,
    pub(super) progress: Option<UpdateProgress>,
    pub(super) error: Option<String>,
    /// Last progress event time, used to throttle high-frequency chunks.
    pub(super) last_emit: Option<Instant>,
}
