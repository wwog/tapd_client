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

fn icon_cache() -> &'static Mutex<BTreeMap<String, Option<String>>> {
    static CACHE: Mutex<BTreeMap<String, Option<String>>> = Mutex::new(BTreeMap::new());
    &CACHE
}

/// Extracts a 64px PNG icon from an app bundle and returns it as a data URL.
pub(super) fn icon_for(app: &Path, cache_dir: &Path) -> Option<String> {
    let key = app.to_string_lossy().to_string();
    if let Some(cached) = icon_cache().lock().ok()?.get(&key) {
        return cached.clone();
    }

    let icon = extract_icon(app, cache_dir);
    if let Ok(mut cache) = icon_cache().lock() {
        cache.insert(key, icon.clone());
    }
    icon
}

fn extract_icon(app: &Path, cache_dir: &Path) -> Option<String> {
    let png_path = cache_dir.join(format!("{:016x}.png", path_hash(app)));
    let bytes = match std::fs::read(&png_path) {
        Ok(bytes) => bytes,
        Err(_) => {
            std::fs::create_dir_all(cache_dir).ok()?;
            let icns = find_icns(app)?;
            let status = Command::new("sips")
                .args(["-s", "format", "png", "-Z", "64"])
                .arg(&icns)
                .arg("--out")
                .arg(&png_path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .ok()?;
            if !status.success() {
                return None;
            }
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
