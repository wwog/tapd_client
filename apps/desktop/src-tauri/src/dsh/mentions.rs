//! Workspace file completion for the composer's `@` panel.
//!
//! The search is scoped to the session's own execution root (worktree → repo →
//! chat scratch), so a mention can never point at a repository the user did not
//! choose. A git checkout answers from `git ls-files` (tracked plus untracked,
//! ignoring `.gitignore`), which is both fast and exactly the set the agent can
//! see; anything else falls back to a bounded walk with dsh's own exclusion
//! list. Results are cached per root: typing one query per keystroke must not
//! re-traverse a large workspace.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Entry budget per root, mirroring dsh's `maxEntries`.
const MAX_ENTRIES: usize = 50_000;
/// Directory names never indexed (the same list dsh ships).
const EXCLUDED: [&str; 15] = [
    ".git",
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    "target",
    ".next",
    ".nuxt",
    ".turbo",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".gradle",
];
/// How long an index may answer after the tree changed. Short enough that a
/// file the agent just wrote is mentionable, long enough to type against.
const TTL: Duration = Duration::from_secs(10);

/// One completion candidate. `kind` is a tag the UI paints, and leaves room for
/// the non-file kinds ZCode's panel lists (`plugin`, `conversation`) once a
/// provider for them exists.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionItem {
    /// Workspace-relative, `/`-separated.
    pub path: String,
    pub kind: &'static str,
}

struct Index {
    files: Vec<String>,
    built: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, Index>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Index>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ranked candidates under `root` for one `@query`.
pub fn list(root: &str, query: &str, limit: usize) -> Vec<MentionItem> {
    let files = index(root);
    let needle = query.trim().to_lowercase();
    let mut scored: Vec<(i32, &String)> = Vec::new();
    for path in &files {
        if let Some(score) = score(path, &needle) {
            scored.push((score, path));
        }
    }
    scored.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.len().cmp(&right.1.len()))
            .then_with(|| left.1.cmp(right.1))
    });
    scored
        .into_iter()
        .take(limit.clamp(1, 50))
        .map(|(_, path)| MentionItem {
            path: path.clone(),
            kind: "file",
        })
        .collect()
}

/// Drops one root's cache, so a file created outside the TTL window is found.
pub fn invalidate(root: &str) {
    cache().lock().expect("mention cache").remove(root);
}

fn index(root: &str) -> Vec<String> {
    let mut guard = cache().lock().expect("mention cache");
    if let Some(entry) = guard.get(root) {
        if entry.built.elapsed() < TTL {
            return entry.files.clone();
        }
    }
    let files = scan(root);
    guard.insert(
        root.to_string(),
        Index {
            files: files.clone(),
            built: Instant::now(),
        },
    );
    files
}

fn scan(root: &str) -> Vec<String> {
    let path = Path::new(root);
    if !path.is_dir() {
        return Vec::new();
    }
    let git = git_files(root);
    if !git.is_empty() {
        return git;
    }
    let mut files = Vec::new();
    walk(path, "", &mut files);
    files
}

/// `git ls-files --cached --others --exclude-standard`: tracked files plus
/// untracked-but-not-ignored ones, NUL separated so spaces need no quoting.
fn git_files(root: &str) -> Vec<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let mut files = Vec::new();
    for raw in output.stdout.split(|byte| *byte == 0) {
        if raw.is_empty() || files.len() >= MAX_ENTRIES {
            continue;
        }
        let Ok(path) = std::str::from_utf8(raw) else {
            continue;
        };
        if path.starts_with(".git/") {
            continue;
        }
        files.push(path.to_string());
    }
    files
}

fn walk(root: &Path, prefix: &str, files: &mut Vec<String>) {
    if files.len() >= MAX_ENTRIES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut names: Vec<_> = entries.flatten().collect();
    names.sort_by_key(|entry| entry.file_name());
    for entry in names {
        if files.len() >= MAX_ENTRIES {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            if EXCLUDED.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            walk(&entry.path(), &format!("{prefix}{name}/"), files);
        } else if kind.is_file() {
            files.push(format!("{prefix}{name}"));
        }
    }
}

/// dsh's own ranking: exact name, prefix, contains, path contains, subsequence.
fn score(path: &str, needle: &str) -> Option<i32> {
    if needle.is_empty() {
        return Some(0);
    }
    let lower = path.to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let name_hit = |score: i32| Some(score);
    if name == needle {
        return name_hit(1000);
    }
    if name.starts_with(needle) {
        return name_hit(900);
    }
    if name.contains(needle) {
        return name_hit(700);
    }
    if lower.contains(needle) {
        return name_hit(500);
    }
    let mut cursor = 0usize;
    let mut gap = 0i32;
    for character in needle.chars() {
        let rest = &lower[cursor..];
        let found = rest.find(character)?;
        gap += found as i32;
        cursor += found + character.len_utf8();
    }
    Some(300 + (100 - gap).max(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> String {
        let root = std::env::temp_dir().join(format!("tapd-mentions-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src/deep")).expect("mkdir");
        std::fs::create_dir_all(root.join("node_modules/pkg")).expect("mkdir");
        std::fs::write(root.join("src/main.rs"), "fn main() {}").expect("write");
        std::fs::write(root.join("src/deep/release_guard.rs"), "").expect("write");
        std::fs::write(root.join("README.md"), "").expect("write");
        std::fs::write(root.join("node_modules/pkg/index.js"), "").expect("write");
        root.to_string_lossy().to_string()
    }

    #[test]
    fn lists_workspace_files_skipping_dependencies() {
        let root = temp_workspace("list");
        let items = list(&root, "", 20);
        let paths: Vec<_> = items.iter().map(|item| item.path.as_str()).collect();
        assert!(paths.contains(&"src/main.rs"));
        assert!(paths.contains(&"README.md"));
        assert!(!paths.iter().any(|path| path.contains("node_modules")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ranks_name_matches_before_path_matches() {
        let root = temp_workspace("rank");
        let items = list(&root, "guard", 5);
        assert_eq!(items[0].path, "src/deep/release_guard.rs");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_subsequence_still_matches() {
        let root = temp_workspace("fuzzy");
        let items = list(&root, "rg", 5);
        assert!(items.iter().any(|item| item.path.ends_with("release_guard.rs")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
