//! Resolving a path written in an agent reply into a file-viewer target.
//!
//! Replies mention files inside the session's working directory, configured
//! project repositories and occasionally anything else on disk. The desktop
//! opens those in the workbench viewer, which reads through [`crate::fs`] under
//! a workspace id, so the path has to be mapped onto the right root first:
//!
//! 1. a configured project root (TAPD or local) wins, matching the tab the
//!    Explorer would open;
//! 2. otherwise the session's own working directory (`__session__:<id>`), which
//!    covers free chats and worktree tasks;
//! 3. otherwise the filesystem root (the read-only whole-disk scope the paired
//!    phone already browses, with the same credential deny list).

use std::path::{Component, Path, PathBuf};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tapd_i18n::tr;
use tauri::AppHandle;

use super::tasks;
use crate::fs::{self, ROOT_WORKSPACE_ID, SESSION_WORKSPACE_ID_PREFIX};

/// What a reply's path turned out to be. `kind` is `file`, `dir` or `missing`;
/// the UI opens a tab for a file, explains the other two.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTarget {
    /// Workspace id the workbench file panel opens under.
    pub workspace_id: String,
    /// Relative to that workspace's root, `/`-separated.
    pub path: String,
    /// Tab label (the file name).
    pub label: String,
    pub kind: &'static str,
}

/// Maps one path from a reply onto a workspace root. `raw` is whatever the
/// Markdown link or inline code contained: a relative path, an absolute path,
/// `~/…` or a `file://` URL, possibly percent-encoded.
pub(crate) fn resolve(app: &AppHandle, session_id: &str, raw: &str) -> Result<FileTarget, String> {
    let cleaned = clean(raw);
    if cleaned.is_empty() {
        return Err(tr("dsh.file.invalid").to_string());
    }

    let requested = Path::new(&cleaned);
    let base = tasks::session_root(app, session_id);
    let absolute = if requested.is_absolute() {
        lexical(requested)
    } else {
        let Some(base) = base.as_deref() else {
            return Err(tr("dsh.file.noSession").to_string());
        };
        lexical(&base.join(requested))
    };

    // Follow symlinks when the file exists: the containment checks downstream
    // (and the viewer's own reads) canonicalize the same way. A missing path
    // keeps its lexical form so the reply can still be told apart from a typo.
    let mut target = absolute.canonicalize().unwrap_or_else(|_| absolute.clone());
    if let Some(base) = base.as_deref() {
        target = remap_onto_execution_root(app, session_id, base, requested, target);
    }
    let kind = match std::fs::metadata(&target) {
        Ok(meta) if meta.is_file() => "file",
        Ok(meta) if meta.is_dir() => "dir",
        _ => "missing",
    };

    if let Some((workspace_id, path)) = pick_root(&target, &fs::project_roots(app)) {
        return Ok(FileTarget {
            workspace_id,
            path,
            label: label_of(&target, &cleaned),
            kind,
        });
    }

    if let Some(root) = base.and_then(|root| root.canonicalize().ok()) {
        if let Some(path) = relative_to(&root, &target) {
            return Ok(FileTarget {
                workspace_id: format!("{SESSION_WORKSPACE_ID_PREFIX}{session_id}"),
                path,
                label: label_of(&target, &cleaned),
                kind,
            });
        }
    }

    let path = relative_to(Path::new("/"), &target)
        .unwrap_or_else(|| cleaned.trim_start_matches('/').to_string());
    Ok(FileTarget {
        workspace_id: ROOT_WORKSPACE_ID.to_string(),
        path,
        label: label_of(&target, &cleaned),
        kind,
    })
}

/// Maps a reply path that was written against the repository (or a worktree the
/// session used earlier) onto the directory the session is executing in.
///
/// The model sees absolute paths now and then, and a task's worktree path
/// changes once its work is merged. The same repository-relative file is what
/// the user means, so the copy in the current root wins; when the current root
/// does not have it, the repository's copy is tried next.
fn remap_onto_execution_root(
    app: &AppHandle,
    session_id: &str,
    base: &Path,
    requested: &Path,
    target: PathBuf,
) -> PathBuf {
    let base = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    let alternates = tasks::session_alternate_roots(app, session_id);

    if !target.starts_with(&base) {
        for root in &alternates {
            let root = root.canonicalize().unwrap_or_else(|_| root.clone());
            let Some(relative) = relative_to(&root, &target) else {
                continue;
            };
            let candidate = lexical(&base.join(&relative));
            let candidate = candidate.canonicalize().unwrap_or(candidate);
            if candidate.exists() {
                return candidate;
            }
        }
    }

    if !target.exists() {
        // The mirror case: the current root lacks the file (e.g. a worktree
        // only carries changed files), but the repository has it. `requested`
        // is already what an absolute path is relative to the current root.
        let relative = if requested.is_absolute() {
            relative_to(&base, &target).map(PathBuf::from)
        } else {
            Some(requested.to_path_buf())
        };
        if let Some(relative) = relative {
            for root in &alternates {
                let candidate = root.join(&relative);
                if candidate.exists() {
                    return candidate.canonicalize().unwrap_or(candidate);
                }
            }
        }
    }

    target
}

/// Longest matching root wins, so a project nested inside another one does not
/// hand the file to the outer tab. Ties keep the first entry (TAPD before
/// local, mirroring [`crate::fs::root_for`]).
fn pick_root(target: &Path, roots: &[(String, PathBuf)]) -> Option<(String, String)> {
    let mut ordered: Vec<&(String, PathBuf)> = roots.iter().collect();
    ordered.sort_by_key(|(_, root)| std::cmp::Reverse(root.components().count()));
    ordered
        .into_iter()
        .find_map(|(id, root)| relative_to(root, target).map(|path| (id.clone(), path)))
}

/// `/`-separated path of `target` below `root`; `None` when it is outside.
fn relative_to(root: &Path, target: &Path) -> Option<String> {
    let relative = target.strip_prefix(root).ok()?;
    Some(
        relative
            .components()
            .filter_map(|component| match component {
                Component::Normal(name) => Some(name.to_string_lossy().to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/"),
    )
}

fn label_of(target: &Path, fallback: &str) -> String {
    target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| fallback.to_string())
}

/// Strips Markdown punctuation, decodes `%20`-style escapes and expands `~`.
fn clean(raw: &str) -> String {
    let mut trimmed = raw.trim();
    // Inline code paths are often wrapped for emphasis; `<…>` is the Markdown
    // form of a destination containing spaces.
    trimmed = trimmed
        .trim_matches('`')
        .trim_matches('"')
        .trim_matches('\'')
        .trim();
    if let Some(inner) = trimmed
        .strip_prefix('<')
        .and_then(|rest| rest.strip_suffix('>'))
    {
        trimmed = inner.trim();
    }
    // Markdown links carry a line anchor (`path.swift#L497-L516`); it names a
    // range inside the file, not part of its name.
    trimmed = strip_line_anchor(trimmed);
    let decoded = percent_decode_str(trimmed).decode_utf8_lossy().into_owned();
    // A link may percent-encode the `#` (`%23L12`); strip again after decoding.
    let decoded = strip_line_anchor(decoded.trim()).trim();
    let without_file = decoded
        .strip_prefix("file://")
        .map(|rest| {
            rest.strip_prefix("localhost")
                .filter(|rest| rest.starts_with('/'))
                .unwrap_or(rest)
        })
        .unwrap_or(decoded);
    tapd_core::paths::expand_home(without_file)
        .to_string_lossy()
        .to_string()
}

/// Drops a trailing GitHub/VSCode line anchor (`#L12`, `#L12-L34`,
/// `#L12C1-L34C9`, `#lines-12`). Anything else after `#` is left alone: it may
/// be part of a real file name.
fn strip_line_anchor(raw: &str) -> &str {
    let Some((path, fragment)) = raw.rsplit_once('#') else {
        return raw;
    };
    let anchor = fragment.starts_with("lines-")
        || (fragment.starts_with('L')
            && fragment[1..]
                .chars()
                .all(|ch| ch.is_ascii_digit() || ch == '-' || ch == 'L' || ch == 'C'));
    if anchor && !path.is_empty() {
        path
    } else {
        raw
    }
}

/// Collapses `.` and `..` without touching the disk (`/a/b/../c` → `/a/c`).
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_strips_markdown_and_expands_file_urls() {
        assert_eq!(clean("`docs/a.md`"), "docs/a.md");
        assert_eq!(clean("\"docs/a.md\""), "docs/a.md");
        assert_eq!(clean("<docs/a b.md>"), "docs/a b.md");
        assert_eq!(clean("file:///tmp/a%20b.md"), "/tmp/a b.md");
        assert_eq!(clean("file://localhost/tmp/a.md"), "/tmp/a.md");
        // A line anchor is a range inside the file, not part of its name.
        assert_eq!(clean("src/a.swift#L497-L516"), "src/a.swift");
        assert_eq!(clean("src/a.swift#L12C1-L34C9"), "src/a.swift");
        assert_eq!(clean("src/a.swift#lines-12"), "src/a.swift");
        // A `#` that is part of the name survives.
        assert_eq!(clean("docs/a#b.md"), "docs/a#b.md");
    }

    #[test]
    fn lexical_collapses_dots_without_the_disk() {
        assert_eq!(lexical(Path::new("/a/b/../c")), PathBuf::from("/a/c"));
        assert_eq!(lexical(Path::new("/a/./b")), PathBuf::from("/a/b"));
        assert_eq!(lexical(Path::new("/a/../../b")), PathBuf::from("/b"));
    }

    #[test]
    fn longest_project_root_wins() {
        let roots = vec![
            ("outer".to_string(), PathBuf::from("/repo")),
            ("inner".to_string(), PathBuf::from("/repo/apps/desktop")),
        ];
        let picked = pick_root(Path::new("/repo/apps/desktop/src/main.rs"), &roots);
        assert_eq!(
            picked,
            Some(("inner".to_string(), "src/main.rs".to_string()))
        );
    }

    #[test]
    fn files_outside_every_root_have_no_match() {
        let roots = vec![("repo".to_string(), PathBuf::from("/repo"))];
        assert!(pick_root(Path::new("/elsewhere/a.md"), &roots).is_none());
    }

    #[test]
    fn relative_display_never_escapes_the_root() {
        assert_eq!(
            relative_to(Path::new("/repo"), Path::new("/repo/docs/a.md")),
            Some("docs/a.md".to_string())
        );
        assert!(relative_to(Path::new("/repo"), Path::new("/repo-old/a.md")).is_none());
    }
}
