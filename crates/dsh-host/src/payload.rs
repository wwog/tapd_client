//! Shipped payload manifest.
//!
//! `scripts/dsh/prepare.mjs` writes `resources/dsh/manifest.json` next to the
//! compressed tarball. The app extracts the tarball into its data directory and
//! keeps this manifest beside it. Freshness is decided by the app (version and
//! archive digest): a rebuilt payload under an unchanged version must still
//! replace the old tree, so there is no manifest-level freshness helper here.

use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PayloadManifest {
    /// `@deepseek-ai/dsh` version the payload was built from.
    pub version: String,
    /// `process.platform` of the build machine (`darwin`, `win32`, `linux`).
    pub platform: String,
    /// `process.arch` of the build machine (`arm64`, `x64`).
    pub arch: String,
    pub file: String,
    pub bytes: u64,
    pub sha256: String,
    pub files: u64,
    pub unpacked_bytes: u64,
    pub built_at: String,
}

impl PayloadManifest {
    pub fn parse(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// Absolute path of the compressed payload inside `dir`.
    pub fn archive_path(&self, dir: &Path) -> PathBuf {
        dir.join(&self.file)
    }

    /// Whether this build can run on the given host.
    pub fn matches_host(&self, platform: &str, arch: &str) -> bool {
        self.platform == platform && self.arch == arch
    }
}

/// Directory holding one extracted runtime: `<root>/<version>`.
///
/// Keeping the version in the path means an upgrade never mutates a tree a
/// running runtime is using; the old directory is disposable.
pub fn runtime_dir(root: &Path, version: &str) -> PathBuf {
    root.join(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "version": "0.2.2-rc.3",
        "platform": "darwin",
        "arch": "arm64",
        "file": "payload-0.2.2-rc.3-darwin-arm64.tar.zst",
        "bytes": 19000000,
        "sha256": "abc",
        "files": 24556,
        "unpackedBytes": 231900000,
        "builtAt": "2026-11-16T10:00:00.000Z"
    }"#;

    #[test]
    fn parses_the_generated_manifest() {
        let manifest = PayloadManifest::parse(SAMPLE).expect("manifest");
        assert_eq!(manifest.version, "0.2.2-rc.3");
        assert_eq!(manifest.unpacked_bytes, 231_900_000);
        assert_eq!(
            manifest.archive_path(Path::new("/res/dsh")),
            PathBuf::from("/res/dsh/payload-0.2.2-rc.3-darwin-arm64.tar.zst")
        );
    }

    #[test]
    fn host_and_version_gates() {
        let manifest = PayloadManifest::parse(SAMPLE).expect("manifest");
        assert!(manifest.matches_host("darwin", "arm64"));
        assert!(!manifest.matches_host("darwin", "x64"));
        assert!(!manifest.matches_host("linux", "arm64"));
    }

    #[test]
    fn runtime_dir_is_version_scoped() {
        assert_eq!(
            runtime_dir(Path::new("/data/dsh"), "0.2.2-rc.3"),
            PathBuf::from("/data/dsh/0.2.2-rc.3")
        );
    }
}
