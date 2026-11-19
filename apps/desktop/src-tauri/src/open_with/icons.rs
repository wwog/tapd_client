//! App icon extraction and caching.
//!
//! Icons come from the bundle's `.icns` via `sips`, converted to a 64px PNG and
//! cached both in memory (per process) and on disk (per cache directory).

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

use crate::media;

fn icon_cache() -> &'static Mutex<BTreeMap<String, String>> {
    static CACHE: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
    &CACHE
}

/// Extracts a 64px PNG icon from an app bundle and returns it as a data URL.
pub(super) fn icon_for(app: &Path, cache_dir: &Path) -> Option<String> {
    let key = app.to_string_lossy().to_string();
    if let Some(cached) = icon_cache().lock().ok()?.get(&key) {
        return Some(cached.clone());
    }

    let icon = extract_icon(app, cache_dir);
    // Only successes are memoized. A failure here is often transient (sips
    // still warming up right after launch, a bundle being replaced), and
    // caching it would keep the icon missing until the app restarts.
    if let (Some(icon), Ok(mut cache)) = (&icon, icon_cache().lock()) {
        cache.insert(key, icon.clone());
    }
    icon
}

fn extract_icon(app: &Path, cache_dir: &Path) -> Option<String> {
    let png_path = cache_dir.join(format!("{:016x}.png", path_hash(app)));
    let bytes = match std::fs::read(&png_path) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        _ => {
            std::fs::create_dir_all(cache_dir).ok()?;
            let icns = find_icns(app)?;
            // Convert into a per-process temp file and rename it into place:
            // a concurrent request for the same app must never read (and
            // memoize) a half-written PNG.
            let temp_path = cache_dir.join(format!(
                "{:016x}.{}.tmp.png",
                path_hash(app),
                std::process::id()
            ));
            let status = Command::new("sips")
                .args(["-s", "format", "png", "-Z", "64"])
                .arg(&icns)
                .arg("--out")
                .arg(&temp_path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .ok()?;
            if !status.success() {
                let _ = std::fs::remove_file(&temp_path);
                return None;
            }
            std::fs::rename(&temp_path, &png_path).ok()?;
            std::fs::read(&png_path).ok()?
        }
    };

    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:image/png;base64,{encoded}"))
}

fn find_icns(app: &Path) -> Option<PathBuf> {
    let resources = app.join("Contents/Resources");
    let mut names: Vec<String> = Vec::new();

    let plist = app.join("Contents/Info.plist");
    if let Ok(output) = Command::new("defaults")
        .arg("read")
        .arg(plist.to_string_lossy().to_string())
        .arg("CFBundleIconFile")
        .output()
    {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !value.is_empty() {
            names.push(value);
        }
    }

    for fallback in ["AppIcon", "app", "icon", "Icon"] {
        names.push(fallback.to_string());
    }

    for name in names {
        for candidate in [format!("{name}.icns"), name.clone()] {
            let path = resources.join(&candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn path_hash(path: &Path) -> u64 {
    media::fnv1a(path.to_string_lossy().as_bytes())
}
