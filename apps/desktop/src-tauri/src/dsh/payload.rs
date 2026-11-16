//! Payload discovery, verification and extraction.
//!
//! The app ships `resources/dsh/{manifest.json,payload-<v>-<os>-<arch>.tar.zst}`
//! and extracts the archive once per version into `<data>/dsh/<version>/`.
//! Extraction is atomic: a crash leaves a temporary directory, never a
//! half-written runtime that the next start would trust.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use dsh_host::payload::{runtime_dir, PayloadManifest};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const PAYLOAD_SUBDIR: &str = "dsh";
const MARKER: &str = "node_modules/@deepseek-ai/dsh/package.json";
/// Build identity of the extracted tree. The dsh version alone is not enough:
/// our plugins and the prune rules change between builds, and a rebuilt
/// payload under an unchanged version must still replace the old tree.
const DIGEST: &str = ".payload-digest";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PayloadSource {
    /// `TAPD_DSH_PAYLOAD` — used by tests and the dev loop.
    Env,
    /// `<src-tauri>/resources/dsh` — debug builds read the build output.
    DevCheckout,
    /// Tauri's bundled resources.
    Bundled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadStatus {
    pub version: String,
    pub source: PayloadSource,
    pub archive: PathBuf,
    pub runtime_dir: PathBuf,
    pub extracted: bool,
}

/// Where the compressed payload lives.
pub fn payload_root(app: &AppHandle) -> Result<(PathBuf, PayloadSource), String> {
    if let Ok(dir) = std::env::var("TAPD_DSH_PAYLOAD") {
        let dir = PathBuf::from(dir);
        if dir.join("manifest.json").exists() {
            return Ok((dir, PayloadSource::Env));
        }
        return Err(format!(
            "TAPD_DSH_PAYLOAD points at {} but manifest.json is missing",
            dir.display()
        ));
    }

    if cfg!(debug_assertions) {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join(PAYLOAD_SUBDIR);
        if dev.join("manifest.json").exists() {
            return Ok((dev, PayloadSource::DevCheckout));
        }
    }

    let dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resource directory unavailable: {error}"))?
        .join(PAYLOAD_SUBDIR);
    Ok((dir, PayloadSource::Bundled))
}

/// Reads and validates the shipped manifest.
pub fn read_manifest(app: &AppHandle) -> Result<(PayloadManifest, PathBuf, PayloadSource), String> {
    let (root, source) = payload_root(app)?;
    let raw = fs::read_to_string(root.join("manifest.json"))
        .map_err(|error| format!("payload manifest unreadable: {error}"))?;
    let manifest = PayloadManifest::parse(&raw)
        .map_err(|error| format!("payload manifest invalid: {error}"))?;
    if !manifest.matches_host(host_platform(), host_arch()) {
        return Err(format!(
            "payload built for {}-{}, this host is {}-{}",
            manifest.platform,
            manifest.arch,
            host_platform(),
            host_arch()
        ));
    }
    Ok((manifest, root, source))
}

fn extracted_digest(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join(DIGEST))
        .ok()
        .map(|value| value.trim().to_string())
}

fn extracted_version(dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(dir.join(MARKER)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

/// A tree is usable only when both the version and the archive digest match.
fn is_fresh(dir: &Path, manifest: &PayloadManifest) -> bool {
    extracted_version(dir).as_deref() == Some(manifest.version.as_str())
        && extracted_digest(dir).as_deref() == Some(manifest.sha256.as_str())
}

fn sha256_of(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Current payload status without touching the disk beyond a couple of reads.
pub fn status(app: &AppHandle) -> Result<PayloadStatus, String> {
    let (manifest, root, source) = read_manifest(app)?;
    let data_dir = data_root(app)?;
    let dir = runtime_dir(&data_dir, &manifest.version);
    Ok(PayloadStatus {
        version: manifest.version.clone(),
        source,
        archive: manifest.archive_path(&root),
        extracted: is_fresh(&dir, &manifest),
        runtime_dir: dir,
    })
}

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.try_state::<std::sync::Arc<crate::state::AppState>>()
        .map(|state| state.paths.data_dir.join(PAYLOAD_SUBDIR))
        .ok_or_else(|| "app state unavailable".to_string())
}

/// Ensures `<data>/dsh/<version>/` holds the payload, extracting if needed.
///
/// Returns the runtime directory. Superseded versions are removed so upgrades
/// never leave several hundred megabytes behind.
pub fn ensure_payload(app: &AppHandle) -> Result<PayloadStatus, String> {
    let (manifest, root, source) = read_manifest(app)?;
    let data_dir = data_root(app)?;
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;

    let target = runtime_dir(&data_dir, &manifest.version);
    let archive = manifest.archive_path(&root);

    if is_fresh(&target, &manifest) {
        remove_other_versions(&data_dir, &manifest.version);
        return Ok(PayloadStatus {
            version: manifest.version,
            source,
            archive,
            runtime_dir: target,
            extracted: true,
        });
    }

    let started = Instant::now();
    let bytes = fs::read(&archive)
        .map_err(|error| format!("payload archive unreadable at {}: {error}", archive.display()))?;
    if bytes.len() as u64 != manifest.bytes {
        return Err(format!(
            "payload archive is {} bytes, manifest says {}",
            bytes.len(),
            manifest.bytes
        ));
    }
    let digest = sha256_of(&bytes);
    if digest != manifest.sha256 {
        return Err("payload archive checksum mismatch; rebuild it with `pnpm prepare:dsh`".to_string());
    }

    let staging = data_dir.join(format!(".extract-{}", uuid::Uuid::new_v4()));
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;

    let unpacked = (|| -> Result<(), String> {
        let decoder = zstd::stream::read::Decoder::new(bytes.as_slice())
            .map_err(|error| format!("payload is not zstd: {error}"))?;
        let mut archive = tar::Archive::new(decoder);
        archive
            .unpack(&staging)
            .map_err(|error| format!("payload extraction failed: {error}"))?;
        if extracted_version(&staging).as_deref() != Some(manifest.version.as_str()) {
            return Err("payload does not contain the expected dsh version".to_string());
        }
        fs::write(staging.join(DIGEST), format!("{}\n", manifest.sha256))
            .map_err(|error| format!("payload digest marker failed: {error}"))?;
        Ok(())
    })();

    if let Err(error) = unpacked {
        let _ = fs::remove_dir_all(&staging);
        // A previous copy of this version may be incomplete; drop it so the
        // next attempt starts clean instead of trusting a broken tree.
        let _ = fs::remove_dir_all(&target);
        return Err(error);
    }

    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| error.to_string())?;
    }
    fs::rename(&staging, &target).map_err(|error| format!("payload install failed: {error}"))?;

    tracing::info!(
        version = %manifest.version,
        seconds = started.elapsed().as_secs_f64(),
        "built-in agent payload extracted"
    );
    remove_other_versions(&data_dir, &manifest.version);

    Ok(PayloadStatus {
        version: manifest.version,
        source,
        archive,
        runtime_dir: target,
        extracted: true,
    })
}

/// Deletes extracted runtimes of superseded versions.
fn remove_other_versions(data_dir: &Path, keep: &str) {
    let Ok(entries) = fs::read_dir(data_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == keep || !entry.path().is_dir() {
            continue;
        }
        if let Err(error) = fs::remove_dir_all(entry.path()) {
            tracing::warn!(%error, dir = %name, "failed to remove an old agent payload");
        }
    }
}

/// Node's `process.platform` name for this host (`darwin`, not `macos`).
pub fn host_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Node's `process.arch` name for this host (`arm64`, not `aarch64`).
pub fn host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}
