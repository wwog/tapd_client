//! SQLite persistence for the runtime's context meter (table
//! `dsh_session_meters`, schema v10).
//!
//! The meter describes one *request*: how much of the window the prompt took
//! and how that split between the system prompt, the tool definitions and the
//! messages. dsh pushes it while it builds a request and never writes it to the
//! session log, so without this table a restarted app knows a session's token
//! totals (they come from the log) but not their composition.
//!
//! One row per session, replaced on every stats frame: the previous value is
//! history nobody reads, and the table must stay tiny.

use rusqlite::{params, Connection, OptionalExtension};
use tapd_i18n::tr;

use crate::cache::Cache;
use dsh_host::transcript::SessionMeter;

/// The meter stored for one session, with the time it was sampled.
pub(super) struct StoredMeter {
    pub at: String,
    pub meter: SessionMeter,
}

pub(super) fn load(cache: &Cache, session_id: &str) -> Result<Option<StoredMeter>, String> {
    with_conn(cache, |conn| {
        let row = conn
            .query_row(
                "SELECT updated_at, payload FROM dsh_session_meters WHERE session_id = ?1",
                [session_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(sql_error)?;
        Ok(row.and_then(|(at, payload)| {
            // A shape change (or a hand-edited row) must not break the page.
            serde_json::from_str::<SessionMeter>(&payload)
                .ok()
                .map(|meter| StoredMeter { at, meter })
        }))
    })
}

pub(super) fn save(cache: &Cache, session_id: &str, at: &str, meter: &SessionMeter) -> Result<(), String> {
    let payload = serde_json::to_string(meter).map_err(|error| error.to_string())?;
    with_conn(cache, |conn| {
        conn.execute(
            "INSERT INTO dsh_session_meters (session_id, updated_at, payload) VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload",
            params![session_id, at, payload],
        )
        .map_err(sql_error)?;
        Ok(())
    })
}

fn with_conn<T>(cache: &Cache, run: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    cache
        .with_conn(run)
        .unwrap_or_else(|| Err(tr("dsh.task.store").to_string()))
}

fn sql_error(error: rusqlite::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_meter_round_trips() {
        let path = std::env::temp_dir().join(format!(
            "tapd-meter-store-{}.sqlite3",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let cache = Cache::open(path.clone());
        let meter = SessionMeter {
            context_used_tokens: Some(16_400),
            context_window: Some(1_000_000),
            system_tokens: Some(1_800),
            tools_tokens: Some(8_800),
            message_tokens: Some(1_460),
            ..Default::default()
        };
        save(&cache, "s1", "2026-11-17T03:00:00.000Z", &meter).expect("save");

        let stored = load(&cache, "s1").expect("load").expect("row");
        assert_eq!(stored.at, "2026-11-17T03:00:00.000Z");
        assert_eq!(stored.meter.tools_tokens, Some(8_800));
        assert!(load(&cache, "missing").expect("load").is_none());

        // A second save replaces the row instead of piling up history.
        let newer = SessionMeter {
            tools_tokens: Some(9_000),
            ..meter
        };
        save(&cache, "s1", "2026-11-17T04:00:00.000Z", &newer).expect("save");
        assert_eq!(
            load(&cache, "s1").expect("load").unwrap().meter.tools_tokens,
            Some(9_000)
        );
        let _ = std::fs::remove_file(&path);
    }
}
