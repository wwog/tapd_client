//! System Node discovery rules.
//!
//! The payload never ships a Node binary: the app resolves `node` from the
//! user's shell PATH (Finder-launched apps have a minimal PATH, so the caller
//! passes `shell_path::user_path()`), then applies the upstream engine gate.

use thiserror::Error;

/// Upstream `engines.node` for `@deepseek-ai/dsh@0.2.2-rc.3`.
pub const MINIMUM_MAJOR: u64 = 24;
pub const MINIMUM_MINOR: u64 = 9;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct NodeVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl NodeVersion {
    /// Accepts `v24.21.0` and `24.21.0`; pre-release suffixes are ignored.
    pub fn parse(raw: &str) -> Option<Self> {
        let trimmed = raw.trim().trim_start_matches('v');
        let core = trimmed.split(['-', '+']).next()?;
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next().unwrap_or("0").parse().ok()?;
        Some(Self {
            major,
            minor,
            patch,
        })
    }

    pub fn meets_minimum(self) -> bool {
        (self.major, self.minor) >= (MINIMUM_MAJOR, MINIMUM_MINOR)
    }

    /// `24.21.0` — no leading `v`, suitable for user-facing copy.
    pub fn label(self) -> String {
        format!("{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Debug, Error)]
pub enum NodeRequirementError {
    #[error("node was not found on PATH")]
    Missing,
    #[error("node {found} is older than the required {required}")]
    TooOld { found: String, required: String },
    #[error("could not read the node version: {output}")]
    Unreadable { output: String },
}

/// The minimum accepted version, as structured data.
pub fn requirement() -> NodeVersion {
    NodeVersion {
        major: MINIMUM_MAJOR,
        minor: MINIMUM_MINOR,
        patch: 0,
    }
}

/// Validates an already-discovered version.
pub fn evaluate(found: Option<&str>) -> Result<NodeVersion, NodeRequirementError> {
    let Some(raw) = found else {
        return Err(NodeRequirementError::Missing);
    };
    let Some(version) = NodeVersion::parse(raw) else {
        return Err(NodeRequirementError::Unreadable {
            output: raw.to_string(),
        });
    };
    if !version.meets_minimum() {
        return Err(NodeRequirementError::TooOld {
            found: version.label(),
            required: requirement().label(),
        });
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_version_shapes() {
        assert_eq!(
            NodeVersion::parse("v24.21.0"),
            Some(NodeVersion {
                major: 24,
                minor: 21,
                patch: 0
            })
        );
        assert_eq!(
            NodeVersion::parse(" 24.9.1-nightly20260101 "),
            Some(NodeVersion {
                major: 24,
                minor: 9,
                patch: 1
            })
        );
        assert_eq!(
            NodeVersion::parse("v25.0.0"),
            Some(NodeVersion {
                major: 25,
                minor: 0,
                patch: 0
            })
        );
        assert_eq!(NodeVersion::parse("node"), None);
        assert_eq!(NodeVersion::parse("24"), None);
    }

    #[test]
    fn enforces_the_upstream_engine_gate() {
        assert!(evaluate(Some("v24.9.0")).is_ok());
        assert!(evaluate(Some("v25.1.0")).is_ok());
        assert!(matches!(
            evaluate(Some("v24.8.9")),
            Err(NodeRequirementError::TooOld { .. })
        ));
        assert!(matches!(
            evaluate(Some("v22.20.0")),
            Err(NodeRequirementError::TooOld { .. })
        ));
        assert!(matches!(
            evaluate(None),
            Err(NodeRequirementError::Missing)
        ));
    }
}
