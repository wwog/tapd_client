//! Shared on-disk cache for TAPD media, keyed by URL.
//!
//! Three consumers fetch the same TAPD resources through the session cookie:
//! the bug export (`get_bug` re-downloaded every asset on each call), the media
//! proxy behind the desktop UI and the mobile companion, and `open_media` when
//! the user opens a file locally. One entry per URL means the second consumer
//! reads a file instead of downloading the same screenshot or video again.
//!
//! Layout under `<data>/media-cache/`:
//! - `<hex>` — the downloaded bytes (name is the URL hash, no extension)
//! - `<hex>.json` — the URL plus content type the fetch learned
//! - `open/` — named files handed to the OS (it picks an app by extension)
//!
//! Entries are never invalidated: TAPD media URLs address one immutable file
//! (re-uploading an attachment yields a new URL). Old versions are dropped by
//! the size cap below, and the whole cache goes with the data directory on
//! 「清理缓存」.

use std::{
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use tapd_core::paths::AppPaths;

use crate::media;

/// Past this many bytes a write prunes the oldest entries down to
/// [`TARGET_BYTES`], so one large video does not evict the whole cache but the
/// directory still cannot grow without a bound.
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const TARGET_BYTES: u64 = 1536 * 1024 * 1024;

const META_SUFFIX: &str = ".json";

/// A cache entry: the blob to read plus what the fetch learned about it.
#[derive(Clone, Debug)]
pub(crate) struct CachedMedia {
    pub path: PathBuf,
    pub content_type: String,
    pub size: u64,
}

#[derive(Deserialize, Serialize)]
struct Meta {
    /// Stored so a hash collision cannot hand back another resource's bytes.
    url: String,
    content_type: String,
}

/// Root of the cache. `open/` holds the named copies handed to the OS.
pub(crate) fn dir(paths: &AppPaths) -> PathBuf {
    paths.data_dir.join("media-cache")
}

fn key(url: &str) -> String {
    format!("{:016x}", media::fnv1a(url.as_bytes()))
}

fn meta_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}{META_SUFFIX}"))
}

/// Blob name (`<hex>`): exactly the key, which separates them from the legacy
/// `<hash>-<url-name>` files older builds left here.
fn is_blob(name: &str) -> bool {
    name.len() == 16 && name.chars().all(|character| character.is_ascii_hexdigit())
}

/// Looks up a previous download. A missing or unreadable entry is a miss, never
/// an error: the caller downloads instead.
pub(crate) fn get(dir: &Path, url: &str) -> Option<CachedMedia> {
    let key = key(url);
    let meta_bytes = std::fs::read(meta_path(dir, &key)).ok()?;
    let meta: Meta = serde_json::from_slice(&meta_bytes).ok()?;
    if meta.url != url {
        return None;
    }

    let path = dir.join(&key);
    let metadata = std::fs::metadata(&path).ok()?;
    if metadata.len() == 0 {
        return None;
    }

    Some(CachedMedia {
        path,
        content_type: meta.content_type,
        size: metadata.len(),
    })
}

/// Stores a full download. HTML is never cached: TAPD answers a wrong URL or
/// missing permission with a login/error page, and no consumer can use it.
pub(crate) fn put(dir: &Path, url: &str, content_type: &str, bytes: &[u8]) -> Option<CachedMedia> {
    if bytes.is_empty() || media::content_type_is_html(content_type) {
        return None;
    }
    std::fs::create_dir_all(dir).ok()?;

    let key = key(url);
    let blob = dir.join(&key);
    write_atomic(&blob, bytes)?;
    let meta = serde_json::to_vec(&Meta {
        url: url.to_string(),
        content_type: content_type.to_string(),
    })
    .ok()?;
    write_atomic(&meta_path(dir, &key), &meta)?;

    trim(dir);
    Some(CachedMedia {
        path: blob,
        content_type: content_type.to_string(),
        size: bytes.len() as u64,
    })
}

/// Writes through a temp file so a reader never sees a partial blob when two
/// requests for the same URL race.
fn write_atomic(path: &Path, bytes: &[u8]) -> Option<()> {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes).ok()?;
    std::fs::rename(&tmp, path).ok()?;
    Some(())
}

/// Drops the oldest blobs once the cache passes [`MAX_BYTES`]. `open/` copies
/// are left alone (they are hard links the user asked to keep).
fn trim(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    let mut blobs: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_blob(&name) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        total += metadata.len();
        blobs.push((
            entry.path(),
            metadata.len(),
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        ));
    }

    if total <= MAX_BYTES {
        return;
    }

    blobs.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in blobs {
        if total <= TARGET_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                let _ = std::fs::remove_file(meta_path(dir, name));
            }
            total = total.saturating_sub(size);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("tapd-media-cache-{}", uuid::Uuid::new_v4().simple()))
    }

    const URL: &str = "https://file.tapd.cn/1/attachments/download/2/a.png";

    #[test]
    fn put_then_get_round_trips_bytes_and_content_type() {
        let dir = temp_dir();
        let cached = put(&dir, URL, "image/png", b"png-bytes").expect("cached");

        assert_eq!(cached.size, 9);
        assert_eq!(cached.content_type, "image/png");

        let hit = get(&dir, URL).expect("cache hit");
        assert_eq!(hit.size, 9);
        assert_eq!(hit.content_type, "image/png");
        assert_eq!(std::fs::read(&hit.path).expect("read blob"), b"png-bytes");

        // A different URL is a different entry.
        assert!(get(&dir, "https://file.tapd.cn/1/attachments/download/3/a.png").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn html_and_empty_bodies_are_not_cached() {
        let dir = temp_dir();
        assert!(put(&dir, URL, "text/html; charset=utf-8", b"<html>error</html>").is_none());
        assert!(put(&dir, URL, "image/png", b"").is_none());
        assert!(get(&dir, URL).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_meta_or_blob_is_a_miss() {
        let dir = temp_dir();
        let cached = put(&dir, URL, "image/png", b"png-bytes").expect("cached");
        std::fs::remove_file(&cached.path).expect("drop blob");
        assert!(get(&dir, URL).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trim_only_counts_key_shaped_blobs() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join("0123456789abcdef"), b"blob").expect("blob");
        std::fs::write(dir.join("0123456789abcdef.json"), b"{}").expect("meta");
        std::fs::write(dir.join("deadbeef-old-name.png"), b"legacy").expect("legacy");

        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .expect("dir")
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_file()))
            .filter(|entry| is_blob(&entry.file_name().to_string_lossy()))
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();

        assert_eq!(names, vec!["0123456789abcdef".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
