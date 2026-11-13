//! Read-only filesystem access for the Explorer and file viewer panels.
//!
//! The root is always the project's configured folder
//! (`agent.json` → `projects[workspaceId].repoPath`). Every request carries a
//! `/`-separated path relative to that root; [`resolve_in_root`] canonicalizes
//! both sides and compares components, which also rejects symlinks that point
//! outside the project. There is deliberately no write API.
//!
//! The same helpers back the desktop commands, the loopback `/file` streaming
//! route and the mobile companion endpoints; none of them re-implement path
//! handling.

use std::{
    fs as std_fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;
use tapd_i18n::{tr, tr_args};
use tauri::AppHandle;

/// Stable prefix the UI matches to render its "configure a folder" empty state.
pub const NO_FOLDER_PREFIX: &str = "no_folder:";
/// One directory level stops after this many entries.
pub const MAX_LIST_ENTRIES: usize = 5_000;
/// Text previews stop after this many bytes; the UI says "first 2 MB".
pub const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
/// `fs_read` refuses to load anything larger than this into memory.
pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// The streaming route buffers one body, so it keeps its own larger ceiling.
pub const MAX_STREAM_BYTES: u64 = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why a filesystem request failed. The HTTP layers map these onto status
/// codes; the Tauri commands flatten them into the message string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsErrorKind {
    /// No local folder is configured for the project.
    NoFolder,
    /// Bad request shape (absolute path, `..`, NUL, `.git`, a directory read).
    InvalidRequest,
    /// The resolved path is outside the project root (symlink escape).
    OutsideRoot,
    /// The root or the target does not exist.
    NotFound,
    /// The file body exceeds the streaming / read ceiling.
    TooLarge,
    /// Any other I/O failure.
    Io,
}

#[derive(Debug, Clone)]
pub struct FsError {
    pub kind: FsErrorKind,
    message: String,
}

impl FsError {
    fn new(kind: FsErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn no_folder() -> Self {
        Self::new(
            FsErrorKind::NoFolder,
            format!("{NO_FOLDER_PREFIX} {}", tr("app.project.unbound")),
        )
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(FsErrorKind::InvalidRequest, message)
    }

    fn outside() -> Self {
        Self::new(
            FsErrorKind::OutsideRoot,
            "path resolves outside the project folder",
        )
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(FsErrorKind::NotFound, message)
    }

    fn too_large(message: impl Into<String>) -> Self {
        Self::new(FsErrorKind::TooLarge, message)
    }

    fn io(error: std::io::Error) -> Self {
        Self::new(FsErrorKind::Io, error.to_string())
    }

    /// The message the Tauri commands and companion JSON expose.
    pub fn message(&self) -> String {
        self.message.clone()
    }
}

impl std::fmt::Display for FsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for FsError {}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

/// Root of one workspace: `agent.json`'s configured repository folder with a
/// leading `~` expanded. An empty config is the UI's recognized empty state.
pub(crate) fn root_for(app: &AppHandle, workspace_id: &str) -> Result<PathBuf, FsError> {
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Err(FsError::no_folder());
    }
    let config = crate::agent::mcp_agent_config(app);
    let repo_path = config
        .projects
        .get(workspace_id)
        .map(|project| project.repo_path.as_str())
        .unwrap_or_default();
    root_from_repo_path(repo_path)
}

/// Turns the configured string into an existing canonical directory.
fn root_from_repo_path(repo_path: &str) -> Result<PathBuf, FsError> {
    let trimmed = repo_path.trim();
    if trimmed.is_empty() {
        return Err(FsError::no_folder());
    }
    let expanded = tapd_core::paths::expand_home(trimmed);
    let canonical = expanded
        .canonicalize()
        .map_err(|_| FsError::not_found(tr_args("app.project.missing", &[&expanded.display()])))?;
    if !canonical.is_dir() {
        return Err(FsError::not_found(tr_args(
            "app.project.missing",
            &[&expanded.display()],
        )));
    }
    Ok(canonical)
}

fn canonical_root(root: &Path) -> Result<PathBuf, FsError> {
    let canonical = root
        .canonicalize()
        .map_err(|_| FsError::not_found(tr_args("app.project.missing", &[&root.display()])))?;
    if !canonical.is_dir() {
        return Err(FsError::not_found(tr_args(
            "app.project.missing",
            &[&root.display()],
        )));
    }
    Ok(canonical)
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/// Validates the request path shape without touching the disk: only relative
/// `Normal` components are accepted (`.` is harmless), and `.git` is never
/// traversed even though it is returned in a listing.
fn validate_relative(relative: &str) -> Result<(), FsError> {
    if relative.contains('\0') {
        return Err(FsError::invalid("path contains a NUL byte"));
    }
    let path = Path::new(relative);
    if path.is_absolute() {
        return Err(FsError::invalid("absolute paths are not accepted"));
    }
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                if name == ".git" {
                    return Err(FsError::invalid("the .git directory is not browsable"));
                }
            }
            Component::CurDir => {}
            _ => return Err(FsError::invalid("path escapes the project folder")),
        }
    }
    Ok(())
}

/// Resolves a relative path inside `root`. The target must exist. Both sides
/// are canonicalized before the component-wise containment check, so a symlink
/// pointing anywhere outside the project is rejected.
pub(crate) fn resolve_in_root(root: &Path, relative: &str) -> Result<PathBuf, FsError> {
    let canonical_root = canonical_root(root)?;
    validate_relative(relative)?;

    let joined = if relative.is_empty() {
        canonical_root.clone()
    } else {
        canonical_root.join(relative)
    };
    let target = joined
        .canonicalize()
        .map_err(|_| FsError::not_found("path does not exist"))?;
    if !target.starts_with(&canonical_root) {
        return Err(FsError::outside());
    }
    Ok(target)
}

/// Path relative to the canonical root with `/` separators ("" at the root).
fn relative_display(root: &Path, target: &Path) -> Result<String, FsError> {
    let relative = target.strip_prefix(root).map_err(|_| FsError::outside())?;
    Ok(relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/"))
}

fn unix_secs(metadata: &std_fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum FsEntryKind {
    Dir,
    File,
    Symlink,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    name: String,
    /// Relative to the project root, `/`-separated, no leading slash.
    path: String,
    kind: FsEntryKind,
    /// Bytes; 0 for directories.
    size: u64,
    /// Unix seconds.
    mtime: i64,
    hidden: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsListing {
    /// Absolute project root; display only, never sent back as a path.
    root: String,
    /// Relative directory; "" is the project root.
    path: String,
    entries: Vec<FsEntry>,
    truncated: bool,
}

/// One directory level, directories first, case-insensitive name sort.
pub(crate) fn list_dir(root: &Path, relative: &str) -> Result<FsListing, FsError> {
    let canonical = canonical_root(root)?;
    let target = resolve_in_root(&canonical, relative)?;
    if !target.is_dir() {
        return Err(FsError::invalid("path is not a directory"));
    }
    let display = relative_display(&canonical, &target)?;

    let mut entries = Vec::new();
    for entry in std_fs::read_dir(&target).map_err(FsError::io)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let kind = if file_type.is_symlink() {
            FsEntryKind::Symlink
        } else if file_type.is_dir() {
            FsEntryKind::Dir
        } else {
            FsEntryKind::File
        };
        // Follow links for display metadata; a broken link still lists.
        let metadata = entry
            .metadata()
            .map(|metadata| {
                // `DirEntry::metadata` does not follow symlinks; resolve the
                // target for the size shown in the tree.
                if kind == FsEntryKind::Symlink {
                    std_fs::metadata(entry.path()).unwrap_or(metadata)
                } else {
                    metadata
                }
            })
            .ok();
        let size = match kind {
            FsEntryKind::Dir => 0,
            _ => metadata.as_ref().map(std_fs::Metadata::len).unwrap_or(0),
        };
        let mtime = metadata.as_ref().map(unix_secs).unwrap_or(0);
        let path = if display.is_empty() {
            name.clone()
        } else {
            format!("{display}/{name}")
        };
        entries.push(FsEntry {
            hidden: name.starts_with('.'),
            name,
            path,
            kind,
            size,
            mtime,
        });
    }

    entries.sort_by(|left, right| {
        let left_dir = left.kind == FsEntryKind::Dir;
        let right_dir = right.kind == FsEntryKind::Dir;
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });

    let truncated = entries.len() > MAX_LIST_ENTRIES;
    entries.truncate(MAX_LIST_ENTRIES);

    Ok(FsListing {
        root: canonical.to_string_lossy().to_string(),
        path: display,
        entries,
        truncated,
    })
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum FsContentKind {
    Text,
    Markdown,
    Image,
    Audio,
    Video,
    Binary,
    TooLarge,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsContent {
    kind: FsContentKind,
    path: String,
    size: u64,
    mtime: i64,
    /// UTF-8 body for text/markdown; null for every other kind.
    text: Option<String>,
    /// The read stopped at the server's text limit.
    truncated: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    path: String,
    kind: FsEntryKind,
    size: u64,
    mtime: i64,
}

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
];
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "webm", "m4v"];
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "m4a", "ogg", "flac", "aac"];
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx"];

fn extension_lower(path: &Path) -> String {
    path.extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn media_kind(path: &Path) -> Option<FsContentKind> {
    let extension = extension_lower(path);
    if IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Some(FsContentKind::Image);
    }
    if VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        return Some(FsContentKind::Video);
    }
    if AUDIO_EXTENSIONS.contains(&extension.as_str()) {
        return Some(FsContentKind::Audio);
    }
    None
}

/// Classifies a body without reading it. `None` means "read the first bytes to
/// tell text from binary".
fn kind_without_read(path: &Path, size: u64) -> Option<FsContentKind> {
    if size > MAX_FILE_BYTES {
        return Some(FsContentKind::TooLarge);
    }
    media_kind(path)
}

/// Reads one file for the preview panel. Text bodies stop at [`MAX_READ_BYTES`];
/// non-UTF-8 bodies fall back to `binary` without a body.
pub(crate) fn read_file(root: &Path, relative: &str) -> Result<FsContent, FsError> {
    let canonical = canonical_root(root)?;
    let target = resolve_in_root(&canonical, relative)?;
    let metadata = std_fs::metadata(&target).map_err(FsError::io)?;
    if metadata.is_dir() {
        return Err(FsError::invalid("path is a directory"));
    }
    let display = relative_display(&canonical, &target)?;
    let size = metadata.len();
    let mtime = unix_secs(&metadata);

    if let Some(kind) = kind_without_read(&target, size) {
        return Ok(FsContent {
            kind,
            path: display,
            size,
            mtime,
            text: None,
            truncated: false,
        });
    }

    let mut file = std_fs::File::open(&target).map_err(FsError::io)?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_READ_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(FsError::io)?;
    let truncated = bytes.len() as u64 > MAX_READ_BYTES;
    bytes.truncate(MAX_READ_BYTES as usize);

    let (kind, text) = match String::from_utf8(bytes) {
        Ok(text) => {
            let kind = if MARKDOWN_EXTENSIONS.contains(&extension_lower(&target).as_str()) {
                FsContentKind::Markdown
            } else {
                FsContentKind::Text
            };
            (kind, Some(text))
        }
        Err(_) => (FsContentKind::Binary, None),
    };

    Ok(FsContent {
        kind,
        path: display,
        size,
        mtime,
        text,
        truncated,
    })
}

pub(crate) fn stat(root: &Path, relative: &str) -> Result<FsStat, FsError> {
    let canonical = canonical_root(root)?;
    let target = resolve_in_root(&canonical, relative)?;
    let link_metadata = std_fs::symlink_metadata(&target).map_err(FsError::io)?;
    let kind = if link_metadata.file_type().is_symlink() {
        FsEntryKind::Symlink
    } else if link_metadata.is_dir() {
        FsEntryKind::Dir
    } else {
        FsEntryKind::File
    };
    let metadata = if kind == FsEntryKind::Symlink {
        std_fs::metadata(&target).unwrap_or(link_metadata)
    } else {
        link_metadata
    };
    Ok(FsStat {
        path: relative_display(&canonical, &target)?,
        kind,
        size: if kind == FsEntryKind::Dir {
            0
        } else {
            metadata.len()
        },
        mtime: unix_secs(&metadata),
    })
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/// Reads a whole file for the loopback / companion streaming routes.
pub(crate) fn read_bytes(root: &Path, relative: &str) -> Result<(Vec<u8>, String), FsError> {
    let canonical = canonical_root(root)?;
    let target = resolve_in_root(&canonical, relative)?;
    let metadata = std_fs::metadata(&target).map_err(FsError::io)?;
    if metadata.is_dir() {
        return Err(FsError::invalid("path is a directory"));
    }
    if metadata.len() > MAX_STREAM_BYTES {
        return Err(FsError::too_large("file is too large to stream"));
    }
    let content_type = content_type_for(&target);
    let bytes = std_fs::read(&target).map_err(FsError::io)?;
    if bytes.len() as u64 > MAX_STREAM_BYTES {
        return Err(FsError::too_large("file is too large to stream"));
    }
    Ok((bytes, content_type.to_string()))
}

/// Content-Type for the streaming routes. Unknown extensions stream as bytes.
pub(crate) fn content_type_for(path: &Path) -> &'static str {
    match extension_lower(path).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "txt" => "text/plain; charset=utf-8",
        "md" | "markdown" => "text/markdown; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "svgz" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fs_list(
    app: AppHandle,
    workspace_id: String,
    path: String,
) -> Result<FsListing, String> {
    let root = root_for(&app, &workspace_id).map_err(|error| error.message())?;
    tokio::task::spawn_blocking(move || list_dir(&root, &path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())
}

#[tauri::command]
pub async fn fs_read(
    app: AppHandle,
    workspace_id: String,
    path: String,
) -> Result<FsContent, String> {
    let root = root_for(&app, &workspace_id).map_err(|error| error.message())?;
    tokio::task::spawn_blocking(move || read_file(&root, &path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())
}

#[tauri::command]
pub async fn fs_stat(app: AppHandle, workspace_id: String, path: String) -> Result<FsStat, String> {
    let root = root_for(&app, &workspace_id).map_err(|error| error.message())?;
    tokio::task::spawn_blocking(move || stat(&root, &path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    struct TempTree {
        base: PathBuf,
    }

    impl TempTree {
        fn new(label: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "tapd-fs-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std_fs::create_dir_all(&base).expect("create temp root");
            Self { base }
        }

        fn root(&self) -> PathBuf {
            self.base.canonicalize().expect("canonical temp root")
        }

        fn write(&self, relative: &str, bytes: &[u8]) {
            let path = self.base.join(relative);
            if let Some(parent) = path.parent() {
                std_fs::create_dir_all(parent).expect("create parent");
            }
            std_fs::write(path, bytes).expect("write fixture");
        }

        fn mkdir(&self, relative: &str) {
            std_fs::create_dir_all(self.base.join(relative)).expect("create dir");
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std_fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn rejects_parent_escapes_and_absolute_paths() {
        let tree = TempTree::new("escape");
        let root = tree.root();

        for relative in ["..", "../outside", "a/../../outside", "./../x"] {
            let error = resolve_in_root(&root, relative).expect_err("escape must fail");
            assert_eq!(error.kind, FsErrorKind::InvalidRequest, "{relative}");
        }

        let absolute = root.join("a.txt");
        let error = resolve_in_root(&root, &absolute.to_string_lossy()).expect_err("absolute");
        assert_eq!(error.kind, FsErrorKind::InvalidRequest);
        assert!(error.message().contains("absolute"));
    }

    #[test]
    fn rejects_nul_and_the_git_directory() {
        let tree = TempTree::new("git");
        let root = tree.root();
        tree.mkdir(".git");
        tree.write(".git/config", b"[core]");

        assert_eq!(
            resolve_in_root(&root, "a\0b").expect_err("NUL").kind,
            FsErrorKind::InvalidRequest
        );
        assert_eq!(
            resolve_in_root(&root, ".git/config")
                .expect_err(".git")
                .kind,
            FsErrorKind::InvalidRequest
        );

        // The entry is still returned at the root; the UI decides to hide it.
        let listing = list_dir(&root, "").expect("list root");
        assert!(listing.entries.iter().any(|entry| entry.name == ".git"));
    }

    #[test]
    fn resolves_a_valid_nested_path() {
        let tree = TempTree::new("nested");
        tree.write("src/lib/main.rs", b"fn main() {}");
        let root = tree.root();

        let resolved = resolve_in_root(&root, "src/lib/main.rs").expect("nested path");
        assert_eq!(resolved, root.join("src/lib/main.rs"));
        assert_eq!(resolve_in_root(&root, "").expect("root itself"), root);
        assert_eq!(
            resolve_in_root(&root, "./src/./lib/main.rs").expect("dot components"),
            root.join("src/lib/main.rs")
        );
    }

    #[test]
    fn reports_a_missing_root_and_an_unconfigured_folder() {
        let tree = TempTree::new("missing");
        let missing = tree.base.join("does-not-exist");
        let error = resolve_in_root(&missing, "").expect_err("missing root");
        assert_eq!(error.kind, FsErrorKind::NotFound);

        let error = root_from_repo_path("   ").expect_err("unconfigured folder");
        assert_eq!(error.kind, FsErrorKind::NoFolder);
        assert!(error.message().starts_with(NO_FOLDER_PREFIX));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_root() {
        use std::os::unix::fs::symlink;

        let tree = TempTree::new("symlink");
        let outside = TempTree::new("symlink-outside");
        outside.write("secret.txt", b"secret");
        tree.write("inside.txt", b"inside");
        let root = tree.root();

        symlink(outside.base.join("secret.txt"), tree.base.join("evil-file")).expect("link file");
        symlink(&outside.base, tree.base.join("evil-dir")).expect("link dir");
        symlink(tree.base.join("inside.txt"), tree.base.join("good-link")).expect("inside link");

        let file_error = resolve_in_root(&root, "evil-file").expect_err("file escape");
        assert_eq!(file_error.kind, FsErrorKind::OutsideRoot);
        let dir_error = resolve_in_root(&root, "evil-dir/secret.txt").expect_err("dir escape");
        assert_eq!(dir_error.kind, FsErrorKind::OutsideRoot);

        // A link that stays inside the project is still readable.
        assert_eq!(
            resolve_in_root(&root, "good-link").expect("inside link"),
            root.join("inside.txt")
        );
    }

    #[test]
    fn sorts_directories_first_and_marks_hidden_entries() {
        let tree = TempTree::new("sort");
        tree.mkdir("beta");
        tree.mkdir("Alpha");
        tree.write("a.txt", b"a");
        tree.write("B.txt", b"b");
        tree.write(".hidden", b"h");
        let root = tree.root();

        let listing = list_dir(&root, "").expect("list root");
        assert_eq!(listing.path, "");
        assert!(!listing.truncated);

        let order: Vec<&str> = listing
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(order, vec!["Alpha", "beta", ".hidden", "a.txt", "B.txt"]);

        let alpha = &listing.entries[0];
        assert_eq!(alpha.kind, FsEntryKind::Dir);
        assert_eq!(alpha.path, "Alpha");
        assert_eq!(alpha.size, 0);
        assert!(!alpha.hidden);

        let hidden = listing
            .entries
            .iter()
            .find(|entry| entry.name == ".hidden")
            .expect("hidden entry");
        assert!(hidden.hidden);
        assert_eq!(hidden.kind, FsEntryKind::File);
        assert_eq!(hidden.size, 1);

        let nested = list_dir(&root, "beta").expect("list nested");
        assert_eq!(nested.path, "beta");
    }

    #[test]
    fn classifies_text_markdown_binary_and_images() {
        let tree = TempTree::new("content");
        tree.write("hello.txt", b"hello");
        tree.write("readme.md", b"# hi");
        tree.write("bad.txt", &[0xff, 0xfe, 0x00]);
        tree.write("pixel.png", &[0x89, b'P', b'N', b'G']);
        tree.write("clip.mp4", &[0, 0, 0, 0]);
        tree.write("song.mp3", b"ID3");
        let root = tree.root();

        let text = read_file(&root, "hello.txt").expect("text");
        assert_eq!(text.kind, FsContentKind::Text);
        assert_eq!(text.text.as_deref(), Some("hello"));
        assert!(!text.truncated);

        let markdown = read_file(&root, "readme.md").expect("markdown");
        assert_eq!(markdown.kind, FsContentKind::Markdown);
        assert_eq!(markdown.text.as_deref(), Some("# hi"));

        let binary = read_file(&root, "bad.txt").expect("binary");
        assert_eq!(binary.kind, FsContentKind::Binary);
        assert!(binary.text.is_none());

        let image = read_file(&root, "pixel.png").expect("image");
        assert_eq!(image.kind, FsContentKind::Image);
        assert!(image.text.is_none());

        let video = read_file(&root, "clip.mp4").expect("video");
        assert_eq!(video.kind, FsContentKind::Video);
        let audio = read_file(&root, "song.mp3").expect("audio");
        assert_eq!(audio.kind, FsContentKind::Audio);

        let too_large = kind_without_read(&root.join("x.txt"), MAX_FILE_BYTES + 1);
        assert_eq!(too_large, Some(FsContentKind::TooLarge));
    }

    #[test]
    fn truncates_text_reads_at_the_two_megabyte_limit() {
        let tree = TempTree::new("truncate");
        let body = vec![b'a'; (MAX_READ_BYTES + 16) as usize];
        tree.write("big.txt", &body);
        let root = tree.root();

        let content = read_file(&root, "big.txt").expect("read big text");
        assert_eq!(content.kind, FsContentKind::Text);
        assert!(content.truncated);
        assert_eq!(
            content.text.as_ref().map(String::len),
            Some(MAX_READ_BYTES as usize)
        );
        assert_eq!(content.size, MAX_READ_BYTES + 16);
    }

    #[test]
    fn stat_reports_kind_size_and_mtime() {
        let tree = TempTree::new("stat");
        tree.write("note.txt", b"abc");
        tree.mkdir("sub");
        let root = tree.root();

        let file = stat(&root, "note.txt").expect("stat file");
        assert_eq!(file.kind, FsEntryKind::File);
        assert_eq!(file.size, 3);
        assert_eq!(file.path, "note.txt");
        assert!(file.mtime > 0);

        let dir = stat(&root, "sub").expect("stat dir");
        assert_eq!(dir.kind, FsEntryKind::Dir);
        assert_eq!(dir.size, 0);
    }

    #[test]
    fn maps_content_types_for_streaming() {
        assert_eq!(content_type_for(Path::new("a/b.PNG")), "image/png");
        assert_eq!(content_type_for(Path::new("clip.mov")), "video/quicktime");
        assert_eq!(
            content_type_for(Path::new("README.md")),
            "text/markdown; charset=utf-8"
        );
        assert_eq!(
            content_type_for(Path::new("no-extension")),
            "application/octet-stream"
        );
    }
}
