//! Composer send queue (table `dsh_queues`, schema v14).
//!
//! While a turn runs the composer holds follow-up messages client-side so they
//! stay editable; this table is what lets that queue survive a restart. One row
//! per session: the ordered items as opaque JSON (they carry image bytes) plus
//! the pause reason. An empty queue deletes its row, so loading never has to
//! filter.
//!
//! The item shape belongs to the UI; Rust only checks that the JSON parses as an
//! array, so a shape change does not need a backend change.

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use tapd_i18n::tr;

use crate::cache::Cache;

/// One stored queue may not exceed this. Items embed image bytes (base64), and
/// the composer admits up to eight attachments of up to 24 MiB each, so without
/// a cap a single row could reach hundreds of megabytes: the IPC + parse cost
/// would freeze the UI and the write would eventually fail silently. Anything
/// larger is refused here instead of being persisted.
const MAX_QUEUE_BYTES: usize = 64 * 1024 * 1024;

/// Every stored queue, oldest write first (the UI keys by session anyway).
pub(super) fn load(cache: &Cache) -> Result<Vec<Value>, String> {
    with_conn(cache, |conn| {
        let mut statement = conn
            .prepare("SELECT session_id, items, pause FROM dsh_queues ORDER BY updated_at ASC")
            .map_err(sql_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(sql_error)?;
        let mut queues = Vec::new();
        for row in rows {
            let (session_id, items, pause) = row.map_err(sql_error)?;
            if items.len() > MAX_QUEUE_BYTES {
                // Only a writer that predates the cap can leave such a row;
                // reading it would reintroduce the freeze the cap prevents.
                tracing::warn!(
                    session = %session_id,
                    bytes = items.len(),
                    "skipped an oversized queued-draft row"
                );
                continue;
            }
            let items: Value = serde_json::from_str(&items).unwrap_or_else(|_| json!([]));
            if !items.is_array() || items.as_array().is_some_and(|items| items.is_empty()) {
                continue;
            }
            queues.push(json!({
                "sessionId": session_id,
                "items": items,
                "pause": pause,
            }));
        }
        Ok(queues)
    })
}

/// Replaces one session's queue; an empty list removes the row.
pub(super) fn save(
    cache: &Cache,
    session_id: &str,
    items: &str,
    pause: Option<&str>,
) -> Result<(), String> {
    if items.len() > MAX_QUEUE_BYTES {
        return Err(tr("dsh.queue.tooLarge").to_string());
    }
    let parsed: Value = serde_json::from_str(items).map_err(|error| error.to_string())?;
    if !parsed.is_array() {
        return Err(tr("dsh.queue.invalid").to_string());
    }
    if parsed.as_array().is_some_and(|items| items.is_empty()) {
        return delete(cache, session_id);
    }
    with_conn(cache, |conn| {
        conn.execute(
            "INSERT INTO dsh_queues (session_id, items, pause, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id) DO UPDATE SET
                 items = excluded.items,
                 pause = excluded.pause,
                 updated_at = excluded.updated_at",
            params![session_id, items, pause, now_millis()],
        )
        .map_err(sql_error)?;
        Ok(())
    })
}

/// Drops one session's queue (the session itself was deleted).
pub(super) fn delete(cache: &Cache, session_id: &str) -> Result<(), String> {
    with_conn(cache, |conn| {
        conn.execute("DELETE FROM dsh_queues WHERE session_id = ?1", [session_id])
            .map_err(sql_error)?;
        Ok(())
    })
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn with_conn<T>(
    cache: &Cache,
    run: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    cache
        .with_conn(run)
        .unwrap_or_else(|| Err(tapd_i18n::tr("dsh.task.store").to_string()))
}

fn sql_error(error: rusqlite::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queues_round_trip_and_disappear_when_empty() {
        let path = std::env::temp_dir().join(format!(
            "tapd-queue-store-{}.sqlite3",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let cache = Cache::open(path.clone());

        let items = r#"[{"id":"q1","text":"继续"},{"id":"q2","text":"再看一次","images":[{"data":"AA=="}]}]"#;
        save(&cache, "s1", items, Some("stopped")).expect("write");
        save(&cache, "s2", r#"[{"id":"q3","text":"别的会话"}]"#, None).expect("write");

        let loaded = load(&cache).expect("read");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0]["sessionId"], "s1");
        assert_eq!(loaded[0]["items"].as_array().map(|v| v.len()), Some(2));
        assert_eq!(loaded[0]["pause"], "stopped");
        assert!(loaded[1]["pause"].is_null());

        // Replacing keeps one row per session and the new order.
        save(&cache, "s1", r#"[{"id":"q2","text":"再看一次"}]"#, None).expect("write");
        let loaded = load(&cache).expect("read");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0]["items"].as_array().map(|v| v.len()), Some(1));

        // An empty list removes the row instead of storing `[]`.
        save(&cache, "s1", "[]", None).expect("write");
        let loaded = load(&cache).expect("read");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0]["sessionId"], "s2");

        // A deleted session takes its queue with it.
        delete(&cache, "s2").expect("delete");
        assert!(load(&cache).expect("read").is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_non_array_payload_is_rejected() {
        let path = std::env::temp_dir().join(format!(
            "tapd-queue-store-bad-{}.sqlite3",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let cache = Cache::open(path.clone());
        assert!(save(&cache, "s1", r#"{"items":[]}"#, None).is_err());
        assert!(save(&cache, "s1", "not json", None).is_err());
        let _ = std::fs::remove_file(&path);
    }
}
