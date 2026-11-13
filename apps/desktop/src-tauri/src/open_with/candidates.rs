//! The curated "open with" table and the path lookups derived from it.
//!
//! macOS exposes no scriptable LaunchServices query without Objective-C, so the
//! menu is a fixed list. Every app path lives here exactly once; other modules
//! resolve ids through [`find_candidate`] instead of repeating literals.

use std::path::Path;

use super::SYSTEM_TARGET;

/// Kinds an app is offered for: `image`, `video`, `file`, `directory`.
type Kinds = &'static [&'static str];

const IMAGE_AND_FILE: Kinds = &["image", "file"];
const IMAGE: Kinds = &["image"];
const VIDEO: Kinds = &["video"];
const FILE: Kinds = &["file"];
const BROWSER: Kinds = &["image", "video", "file"];
const EDITOR: Kinds = &["image", "file", "directory"];
const DIRECTORY: Kinds = &["directory"];

pub(super) struct Candidate {
    pub(super) id: &'static str,
    pub(super) label: &'static str,
    pub(super) path: &'static str,
    pub(super) kinds: Kinds,
}

pub(super) const CANDIDATES: &[Candidate] = &[
    // System apps
    Candidate {
        id: "preview",
        label: "app.openwith.preview",
        path: "/System/Applications/Preview.app",
        kinds: IMAGE_AND_FILE,
    },
    Candidate {
        id: "photos",
        label: "app.openwith.photos",
        path: "/System/Applications/Photos.app",
        kinds: IMAGE,
    },
    Candidate {
        id: "quicktime",
        label: "QuickTime Player",
        path: "/System/Applications/QuickTime Player.app",
        kinds: VIDEO,
    },
    Candidate {
        id: "textedit",
        label: "app.openwith.textedit",
        path: "/System/Applications/TextEdit.app",
        kinds: FILE,
    },
    Candidate {
        id: "music",
        label: "app.openwith.music",
        path: "/System/Applications/Music.app",
        kinds: VIDEO,
    },
    // Browsers
    Candidate {
        id: "safari",
        label: "Safari",
        path: "/Applications/Safari.app",
        kinds: BROWSER,
    },
    Candidate {
        id: "chrome",
        label: "Google Chrome",
        path: "/Applications/Google Chrome.app",
        kinds: BROWSER,
    },
    Candidate {
        id: "edge",
        label: "Microsoft Edge",
        path: "/Applications/Microsoft Edge.app",
        kinds: BROWSER,
    },
    Candidate {
        id: "firefox",
        label: "Firefox",
        path: "/Applications/Firefox.app",
        kinds: BROWSER,
    },
    Candidate {
        id: "arc",
        label: "Arc",
        path: "/Applications/Arc.app",
        kinds: BROWSER,
    },
    // Editors / players
    Candidate {
        id: "vscode",
        label: "Visual Studio Code",
        path: "/Applications/Visual Studio Code.app",
        kinds: EDITOR,
    },
    Candidate {
        id: "xcode",
        label: "Xcode",
        path: "/Applications/Xcode.app",
        kinds: DIRECTORY,
    },
    Candidate {
        id: "zed",
        label: "Zed",
        path: "/Applications/Zed.app",
        kinds: DIRECTORY,
    },
    Candidate {
        id: "cursor",
        label: "Cursor",
        path: "/Applications/Cursor.app",
        kinds: EDITOR,
    },
    Candidate {
        id: "sublime",
        label: "Sublime Text",
        path: "/Applications/Sublime Text.app",
        kinds: FILE,
    },
    Candidate {
        id: "iina",
        label: "IINA",
        path: "/Applications/IINA.app",
        kinds: VIDEO,
    },
    Candidate {
        id: "vlc",
        label: "VLC",
        path: "/Applications/VLC.app",
        kinds: VIDEO,
    },
];

/// Editors a project folder is opened in, in default-preference order.
pub(super) const DIRECTORY_EDITORS: &[&str] = &["vscode", "xcode", "zed", "cursor"];

pub(super) fn find_candidate(id: &str) -> Option<&'static Candidate> {
    CANDIDATES.iter().find(|candidate| candidate.id == id)
}

/// Representative app macOS uses for a kind, only for its icon.
pub(super) fn system_app_path(kind: &str) -> &'static str {
    if kind == "directory" {
        return finder_app_path();
    }
    // The ids below are declared in CANDIDATES; the lookup is infallible.
    let id = match kind {
        "image" => "preview",
        "video" => "quicktime",
        _ => "textedit",
    };
    find_candidate(id).expect("system app candidate is in CANDIDATES").path
}

/// Finder is a CoreServices app; some releases also expose it under
/// /System/Applications.
pub(super) fn finder_app_path() -> &'static str {
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
pub(super) fn system_label(kind: &str) -> &'static str {
    if kind == "directory" {
        "app.openwith.finder"
    } else {
        "app.openwith.system"
    }
}

/// The browser used for the `browser` target, in preference order.
pub(super) fn browser_app_path() -> Option<&'static str> {
    ["safari", "chrome"].into_iter().find_map(|id| {
        let path = find_candidate(id)?.path;
        Path::new(path).is_dir().then_some(path)
    })
}

/// A folder is almost always bound to a code project, so fall back to the first
/// installed editor instead of Finder when the user has not chosen yet.
pub(super) fn default_directory_target() -> String {
    DIRECTORY_EDITORS
        .iter()
        .find(|id| find_candidate(id).is_some_and(|candidate| Path::new(candidate.path).is_dir()))
        .map(|id| (*id).to_string())
        .unwrap_or_else(|| SYSTEM_TARGET.to_string())
}
