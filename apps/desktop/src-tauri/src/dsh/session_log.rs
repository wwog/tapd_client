//! Reads dsh's own session log.
//!
//! The runtime only knows a session after it is created or resumed, so a page
//! opened right after a restart has no history at all — even though dsh wrote
//! every event to disk. The log is the source of truth for that case: read it,
//! decompress it, hand the events to the same normalizer the bridge uses.
//!
//! Layout (`$DSH_HOME/sessions/`):
//!
//! ```text
//! <escaped cwd>/<session id>/session.v4.jsonl[.zstd]
//! ```
//!
//! The escaped directory is a hash of the launch directory, so the session id
//! is the only reliable part; every project directory is searched.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::bridge::BridgeState;

/// Compressed log first (what current dsh writes), then the plain variant.
const COMPRESSED: &str = "session.v4.jsonl.zstd";
const PLAIN: &str = "session.v4.jsonl";

/// Ceiling for one decompressed log. A session that grew past this is not worth
/// blocking a command on; the runtime path still covers it.
const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;

/// Where dsh keeps its own logs (`$DSH_HOME/sessions`).
pub fn dir(app: &AppHandle) -> Option<PathBuf> {
    app.try_state::<Arc<crate::state::AppState>>()
        .map(|state| state.paths.data_dir.join("dsh").join("home").join("sessions"))
}

/// Keeps a session's own model choice before an SDK resume resets it to the
/// runtime default. The choice lives in the session log, so this also works
/// after an app restart; a pick made in this run already wins and is left
/// untouched.
pub fn preserve_selection(app: &AppHandle, session_id: &str) {
    let Some(bridge) = app.try_state::<Arc<BridgeState>>() else {
        return;
    };
    if bridge.pending_selection(session_id).is_some() {
        return;
    }
    if let Some(selection) = bridge.recorded_selection(session_id) {
        bridge.remember_selection(session_id, selection);
        return;
    }
    let Some(sessions_dir) = dir(app) else {
        return;
    };
    if !bridge.knows(session_id) && !bridge.hydrate_from_log(&sessions_dir, session_id) {
        return;
    }
    if let Some(selection) = bridge.recorded_selection(session_id) {
        bridge.remember_selection(session_id, selection);
    }
}

/// Locates one session's log under `sessions_dir`.
pub fn path(sessions_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(sessions_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(session_id);
        if !candidate.is_dir() {
            continue;
        }
        for name in [COMPRESSED, PLAIN] {
            let file = candidate.join(name);
            if file.is_file() {
                return Some(file);
            }
        }
    }
    None
}

/// Every event in one session's log, in file order. Malformed lines are skipped
/// rather than failing the read: a torn last line is normal after a crash.
pub fn events(sessions_dir: &Path, session_id: &str) -> Option<Vec<Value>> {
    let file = path(sessions_dir, session_id)?;
    let compressed = file.extension().and_then(|value| value.to_str()) == Some("zstd");
    let handle = File::open(&file).ok()?;

    let lines: Box<dyn BufRead> = if compressed {
        let decoder = zstd::stream::read::Decoder::new(handle).ok()?;
        Box::new(BufReader::new(decoder.take(MAX_LOG_BYTES)))
    } else {
        Box::new(BufReader::new(handle.take(MAX_LOG_BYTES)))
    };

    let mut events = Vec::new();
    for line in lines.lines() {
        let Ok(line) = line else { continue };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            events.push(value);
        }
    }
    (!events.is_empty()).then_some(events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn sessions_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tapd-session-log-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("--Users-me--").join("s1")).unwrap();
        dir
    }

    #[test]
    fn reads_a_compressed_log() {
        let dir = sessions_dir("zstd");
        let file = dir.join("--Users-me--").join("s1").join(COMPRESSED);
        let mut encoder = zstd::stream::write::Encoder::new(File::create(&file).unwrap(), 3)
            .unwrap();
        encoder
            .write_all(b"{\"type\":\"turn/start\",\"seq\":0}\n\n{\"type\":\"turn/end\",\"seq\":1}\n")
            .unwrap();
        encoder.finish().unwrap();

        let read = events(&dir, "s1").expect("log read");
        assert_eq!(read.len(), 2);
        assert_eq!(read[1]["seq"], 1);
        assert!(path(&dir, "s1").is_some());
        assert!(events(&dir, "missing").is_none());
    }

    #[test]
    fn skips_a_torn_line_and_reads_plain_logs() {
        let dir = sessions_dir("plain");
        let file = dir.join("--Users-me--").join("s1").join(PLAIN);
        std::fs::write(&file, "{\"seq\":0}\n{\"seq\":\n").unwrap();

        let read = events(&dir, "s1").expect("log read");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0]["seq"], 0);
    }

    #[test]
    fn an_empty_log_is_not_history() {
        let dir = sessions_dir("empty");
        std::fs::write(dir.join("--Users-me--").join("s1").join(PLAIN), "").unwrap();
        assert!(events(&dir, "s1").is_none());
    }
}
