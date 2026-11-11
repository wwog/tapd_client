//! "打开方式" targets: which desktop app opens a resource.
//!
//! macOS does not expose a scriptable LaunchServices query without Objective-C,
//! so this offers a curated set of installed apps per resource kind and pulls
//! their icons out of the bundle with `sips` (cached as PNG).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde::Serialize;

pub const SYSTEM_TARGET: &str = "system";
pub const BROWSER_TARGET: &str = "browser";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTarget {
    pub id: String,
    pub label: String,
    /// `data:image/png;base64,…`, when the icon could be extracted.
    pub icon: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTargetSet {
    /// Currently selected target id, always present in `targets`.
    pub selected: String,
    pub targets: Vec<OpenTarget>,
}

struct Candidate {
    id: &'static str,
    label: &'static str,
    path: &'static str,
    /// Kinds this app is offered for: `image`, `video`, `file`, `directory`.
    kinds: &'static [&'static str],
}

const CANDIDATES: &[Candidate] = &[
    // System apps
    Candidate {
        id: "preview",
        label: "预览",
        path: "/System/Applications/Preview.app",
        kinds: &["image", "file"],
    },
    Candidate {
        id: "photos",
        label: "照片",
        path: "/System/Applications/Photos.app",
        kinds: &["image"],
    },
    Candidate {
        id: "quicktime",
        label: "QuickTime Player",
        path: "/System/Applications/QuickTime Player.app",
        kinds: &["video"],
    },
    Candidate {
        id: "textedit",
        label: "文本编辑",
        path: "/System/Applications/TextEdit.app",
        kinds: &["file"],
    },
    Candidate {
        id: "music",
        label: "音乐",
        path: "/System/Applications/Music.app",
        kinds: &["video"],
    },
    // Browsers
    Candidate {
        id: "safari",
        label: "Safari",
        path: "/Applications/Safari.app",
        kinds: &["image", "video", "file"],
    },
    Candidate {
        id: "chrome",
        label: "Google Chrome",
        path: "/Applications/Google Chrome.app",
        kinds: &["image", "video", "file"],
    },
    Candidate {
        id: "edge",
        label: "Microsoft Edge",
        path: "/Applications/Microsoft Edge.app",
        kinds: &["image", "video", "file"],
    },
    Candidate {
        id: "firefox",
        label: "Firefox",
        path: "/Applications/Firefox.app",
        kinds: &["image", "video", "file"],
    },
    Candidate {
        id: "arc",
        label: "Arc",
        path: "/Applications/Arc.app",
        kinds: &["image", "video", "file"],
    },
    // Editors / players
    Candidate {
        id: "vscode",
        label: "Visual Studio Code",
        path: "/Applications/Visual Studio Code.app",
        kinds: &["image", "file", "directory"],
    },
    Candidate {
        id: "xcode",
        label: "Xcode",
        path: "/Applications/Xcode.app",
        kinds: &["directory"],
    },
    Candidate {
        id: "zed",
        label: "Zed",
        path: "/Applications/Zed.app",
        kinds: &["directory"],
    },
    Candidate {
        id: "cursor",
        label: "Cursor",
        path: "/Applications/Cursor.app",
        kinds: &["image", "file", "directory"],
    },
    Candidate {
        id: "sublime",
        label: "Sublime Text",
        path: "/Applications/Sublime Text.app",
        kinds: &["file"],
    },
    Candidate {
        id: "iina",
        label: "IINA",
        path: "/Applications/IINA.app",
        kinds: &["video"],
    },
    Candidate {
        id: "vlc",
        label: "VLC",
        path: "/Applications/VLC.app",
        kinds: &["video"],
    },
];

/// Representative app macOS uses for a kind, only for its icon.
fn system_app_path(kind: &str) -> &'static str {
    match kind {
        "image" => "/System/Applications/Preview.app",
        "video" => "/System/Applications/QuickTime Player.app",
        "directory" => finder_app_path(),
        _ => "/System/Applications/TextEdit.app",
    }
}

/// Finder is a CoreServices app; some releases also expose it under
/// /System/Applications.
fn finder_app_path() -> &'static str {
    const PATHS: [&str; 2] = [
        "/System/Applications/Finder.app",
        "/System/Library/CoreServices/Finder.app",
    ];
    PATHS
        .into_iter()
        .find(|path| Path::new(path).is_dir())
        .unwrap_or(PATHS[1])
}

/// The system target is Finder for folders; everything else is a document.
fn system_label(kind: &str) -> &'static str {
    if kind == "directory" {
        "访达"
    } else {
        "系统默认应用"
    }
}

/// Editors a project folder is opened in, in default-preference order.
const DIRECTORY_EDITORS: &[&str] = &["vscode", "xcode", "zed", "cursor"];

/// A folder is almost always bound to a code project, so fall back to the first
/// installed editor instead of Finder when the user has not chosen yet.
fn default_directory_target() -> String {
    DIRECTORY_EDITORS
        .iter()
        .find(|id| find_candidate(id).is_some_and(|candidate| Path::new(candidate.path).is_dir()))
        .map(|id| (*id).to_string())
        .unwrap_or_else(|| SYSTEM_TARGET.to_string())
}

fn browser_app_path() -> Option<&'static str> {
    ["/Applications/Safari.app", "/Applications/Google Chrome.app"]
        .into_iter()
        .find(|path| Path::new(path).is_dir())
}

fn find_candidate(id: &str) -> Option<&'static Candidate> {
    CANDIDATES.iter().find(|candidate| candidate.id == id)
}

/// Resolves the effective target for a kind: the saved choice when it is still
/// installed and supports the kind, otherwise `system` (or, for a folder that
/// was never configured, the first installed editor).
pub fn selected_target(kind: &str, open_with: &BTreeMap<String, String>) -> String {
    let kind = normalize_kind(kind);
    let Some(saved) = open_with.get(kind) else {
        return if kind == "directory" {
            default_directory_target()
        } else {
            SYSTEM_TARGET.to_string()
        };
    };
    let saved = saved.as_str();
    if saved == SYSTEM_TARGET {
        return saved.to_string();
    }
    // A folder is never handed to a browser, even if an old config says so.
    if saved == BROWSER_TARGET && kind != "directory" {
        return saved.to_string();
    }

    match find_candidate(saved) {
        Some(candidate)
            if candidate.kinds.contains(&kind) && Path::new(candidate.path).is_dir() =>
        {
            saved.to_string()
        }
        _ => SYSTEM_TARGET.to_string(),
    }
}

/// Builds the menu for one resource kind. Blocking (spawns `defaults`/`sips`).
pub fn target_set(kind: &str, cache_dir: &Path, open_with: &BTreeMap<String, String>) -> OpenTargetSet {
    let kind = normalize_kind(kind);
    let mut targets = Vec::new();

    targets.push(OpenTarget {
        id: SYSTEM_TARGET.to_string(),
        label: system_label(kind).to_string(),
        icon: icon_for(Path::new(system_app_path(kind)), cache_dir),
    });

    // A folder is never opened in a browser.
    if kind != "directory" {
        if let Some(browser) = browser_app_path() {
            targets.push(OpenTarget {
                id: BROWSER_TARGET.to_string(),
                label: "默认浏览器".to_string(),
                icon: icon_for(Path::new(browser), cache_dir),
            });
        }
    }

    let system_path = system_app_path(kind);
    for candidate in CANDIDATES {
        if !candidate.kinds.contains(&kind) || candidate.path == system_path {
            continue;
        }
        let path = Path::new(candidate.path);
        if !path.is_dir() {
            continue;
        }
        targets.push(OpenTarget {
            id: candidate.id.to_string(),
            label: candidate.label.to_string(),
            icon: icon_for(path, cache_dir),
        });
    }

    OpenTargetSet {
        selected: selected_target(kind, open_with),
        targets,
    }
}

pub fn normalize_kind(kind: &str) -> &str {
    match kind {
        "image" | "video" | "directory" => kind,
        _ => "file",
    }
}

/// App path for an executable target id; `None` for `system`/`browser`.
pub fn app_path_for(id: &str) -> Option<PathBuf> {
    find_candidate(id)
        .filter(|candidate| Path::new(candidate.path).is_dir())
        .map(|candidate| PathBuf::from(candidate.path))
}

fn icon_cache() -> &'static Mutex<BTreeMap<String, Option<String>>> {
    static CACHE: Mutex<BTreeMap<String, Option<String>>> = Mutex::new(BTreeMap::new());
    &CACHE
}

/// Extracts a 64px PNG icon from an app bundle and returns it as a data URL.
fn icon_for(app: &Path, cache_dir: &Path) -> Option<String> {
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
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in path.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_saved_target_falls_back_to_system() {
        let mut prefs = BTreeMap::new();
        prefs.insert("image".to_string(), "does-not-exist".to_string());
        assert_eq!(selected_target("image", &prefs), SYSTEM_TARGET);
    }

    #[test]
    fn wrong_kind_falls_back_to_system() {
        let mut prefs = BTreeMap::new();
        // QuickTime is not offered for images.
        prefs.insert("image".to_string(), "quicktime".to_string());
        assert_eq!(selected_target("image", &prefs), SYSTEM_TARGET);
    }

    #[test]
    fn normalizes_unknown_kinds_to_file() {
        assert_eq!(normalize_kind("image"), "image");
        assert_eq!(normalize_kind("video"), "video");
        assert_eq!(normalize_kind("directory"), "directory");
        assert_eq!(normalize_kind("archive"), "file");
    }

    #[test]
    fn missing_editor_for_directory_falls_back_to_system() {
        let mut prefs = BTreeMap::new();
        prefs.insert("directory".to_string(), "does-not-exist".to_string());
        assert_eq!(selected_target("directory", &prefs), SYSTEM_TARGET);
    }

    #[test]
    fn explicit_finder_choice_is_kept() {
        let mut prefs = BTreeMap::new();
        prefs.insert("directory".to_string(), SYSTEM_TARGET.to_string());
        assert_eq!(selected_target("directory", &prefs), SYSTEM_TARGET);
    }

    #[test]
    fn browser_is_never_a_directory_target() {
        let mut prefs = BTreeMap::new();
        prefs.insert("directory".to_string(), BROWSER_TARGET.to_string());
        assert_eq!(selected_target("directory", &prefs), SYSTEM_TARGET);
    }

    #[test]
    fn directory_menu_only_offers_editors() {
        let cache = std::env::temp_dir().join("tapd-open-with-test");
        let set = target_set("directory", &cache, &BTreeMap::new());
        assert_eq!(set.targets[0].label, "访达");
        assert!(set.targets.iter().all(|target| {
            target.id == SYSTEM_TARGET || DIRECTORY_EDITORS.contains(&target.id.as_str())
        }));
    }
}
