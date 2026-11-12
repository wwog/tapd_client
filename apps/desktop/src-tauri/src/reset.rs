//! Full reset of the local data directory.
//!
//! "清理缓存" removes everything under the app data directory. The running app
//! keeps `cache.sqlite3` and the active log file open, and on Windows those
//! handles block deletion, so the command only drops a marker and restarts;
//! the fresh process wipes the directory before logging or SQLite opens it.

use std::{fs, io, path::Path, time::Duration};

use tapd_core::paths::AppPaths;

/// Marker file kept inside the data directory and consumed on the next launch.
const MARKER_FILE: &str = ".reset-pending";
const REMOVE_ATTEMPTS: u32 = 10;
const RETRY_DELAY: Duration = Duration::from_millis(150);

/// Schedules a wipe of every entry in `data_dir` for the next launch.
pub fn request(paths: &AppPaths) -> io::Result<()> {
    paths.ensure_dirs()?;
    let marker = paths.data_dir.join(MARKER_FILE);
    fs::write(&marker, b"1")?;
    // Make sure the marker survives an abrupt exit.
    fs::OpenOptions::new().write(true).open(&marker)?.sync_all()
}

/// Wipes the data directory when a reset was requested. Returns `true` when a
/// reset was performed (the marker existed).
///
/// Must run before logging and SQLite are initialized.
pub fn apply_pending(paths: &AppPaths) -> io::Result<bool> {
    let marker = paths.data_dir.join(MARKER_FILE);
    if !marker.exists() {
        return Ok(false);
    }

    // The previous process may still be exiting; its handles can briefly block
    // removal on Windows, so retry for a short while.
    let mut failures: Vec<String> = Vec::new();
    for attempt in 0..REMOVE_ATTEMPTS {
        failures.clear();
        for entry in fs::read_dir(&paths.data_dir)?.flatten() {
            let path = entry.path();
            if path == marker {
                continue;
            }
            if let Err(error) = remove_entry(&path) {
                failures.push(format!("{}: {error}", path.display()));
            }
        }
        if failures.is_empty() {
            break;
        }
        if attempt + 1 < REMOVE_ATTEMPTS {
            std::thread::sleep(RETRY_DELAY);
        }
    }

    paths.ensure_dirs()?;

    if failures.is_empty() {
        let _ = fs::remove_file(&marker);
    } else {
        // Keep the marker so the next launch retries whatever is left.
        for failure in &failures {
            eprintln!("failed to clear local data: {failure}");
        }
    }
    Ok(true)
}

fn remove_entry(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_dir() {
        for entry in fs::read_dir(path)? {
            remove_entry(&entry?.path())?;
        }
        fs::remove_dir(path)
    } else {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            // Directory symlinks are removed as files on unix and as
            // directories on Windows.
            Err(error) if metadata.file_type().is_symlink() => {
                fs::remove_dir(path).map_err(|_| error)
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_paths() -> AppPaths {
        let root = std::env::temp_dir().join(format!(
            "tapd-client-reset-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        AppPaths {
            data_dir: root.join("data"),
            logs_dir: root.join("data").join("logs"),
            captures_dir: root.join("data").join("captures"),
            exports_dir: root.join("exports"),
            worktrees_dir: root.join("data").join("worktrees"),
            runtime_file: root.join("data").join("runtime.json"),
            config_file: root.join("data").join("config.json"),
        }
    }

    #[test]
    fn wipe_removes_everything_under_data_dir() {
        let paths = temp_paths();
        paths.ensure_dirs().expect("dirs");
        fs::write(&paths.config_file, "{}").expect("config");
        fs::write(&paths.runtime_file, "{}").expect("runtime");
        fs::write(paths.logs_dir.join("app.log"), "log").expect("log");
        fs::create_dir_all(paths.data_dir.join("app-icons").join("nested")).expect("nested");
        fs::write(
            paths
                .data_dir
                .join("app-icons")
                .join("nested")
                .join("icon.png"),
            "x",
        )
        .expect("icon");
        // Export output lives outside the data directory and must survive.
        fs::write(paths.exports_dir.join("bug.json"), "{}").expect("export");

        request(&paths).expect("marker");
        assert!(paths.data_dir.join(MARKER_FILE).exists());

        assert!(apply_pending(&paths).expect("wipe"));
        assert!(paths.data_dir.is_dir());
        assert!(paths.logs_dir.is_dir());
        assert!(paths.captures_dir.is_dir());
        assert!(!paths.data_dir.join(MARKER_FILE).exists());
        assert!(!paths.config_file.exists());
        assert!(!paths.runtime_file.exists());
        assert!(!paths.logs_dir.join("app.log").exists());
        assert!(!paths.data_dir.join("app-icons").exists());
        assert!(paths.exports_dir.join("bug.json").exists());

        let _ = fs::remove_dir_all(paths.data_dir.parent().expect("root"));
    }

    #[test]
    fn no_marker_means_no_wipe() {
        let paths = temp_paths();
        paths.ensure_dirs().expect("dirs");
        fs::write(&paths.config_file, "{}").expect("config");

        assert!(!apply_pending(&paths).expect("no wipe"));
        assert!(paths.config_file.exists());

        let _ = fs::remove_dir_all(paths.data_dir.parent().expect("root"));
    }
}
