//! "打开方式" targets: which desktop app opens a resource.
//!
//! macOS does not expose a scriptable LaunchServices query without Objective-C,
//! so this offers a curated set of installed apps per resource kind and pulls
//! their icons out of the bundle with `sips` (cached as PNG).
//!
//! The table and its path lookups live in [`candidates`]; icon extraction lives
//! in [`icons`]. This file resolves the effective target and builds the menu.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::Serialize;

mod candidates;
mod icons;

use candidates::{
    browser_app_path, default_directory_target, find_candidate, system_app_path, system_label,
    CANDIDATES,
};
use icons::icon_for;

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

#[cfg(test)]
mod tests {
    use super::candidates::DIRECTORY_EDITORS;
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
