//! Per-session permission mode (table `dsh_session_modes`, schema v11).
//!
//! The mode used to be process-wide: `agent.json.permissionMode` went into the
//! runtime's environment and the policy plugin read it once at activation. The
//! gate runs per tool call, so a session-scoped value can change immediately;
//! this table is where that value survives an app restart. A missing row means
//! "inherit the global default", not "auto".

use rusqlite::{params, Connection, OptionalExtension};
use tapd_i18n::tr;

use crate::agent_settings::PermissionMode;
use crate::cache::Cache;

pub(super) fn load(cache: &Cache, session_id: &str) -> Result<Option<PermissionMode>, String> {
    with_conn(cache, |conn| {
        let raw = conn
            .query_row(
                "SELECT mode FROM dsh_session_modes WHERE session_id = ?1",
                [session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(sql_error)?;
        // A shape change (or a hand-edited row) falls back to the default.
        Ok(raw.and_then(|value| PermissionMode::parse(&value)))
    })
}

pub(super) fn save(
    cache: &Cache,
    session_id: &str,
    mode: PermissionMode,
    at: &str,
) -> Result<(), String> {
    with_conn(cache, |conn| {
        conn.execute(
            "INSERT INTO dsh_session_modes (session_id, mode, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at",
            params![session_id, mode.as_env(), at],
        )
        .map_err(sql_error)?;
        Ok(())
    })
}

pub(super) fn delete(cache: &Cache, session_id: &str) -> Result<(), String> {
    with_conn(cache, |conn| {
        conn.execute(
            "DELETE FROM dsh_session_modes WHERE session_id = ?1",
            [session_id],
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
    fn session_modes_round_trip_and_are_optional() {
        let path = std::env::temp_dir().join(format!(
            "tapd-mode-store-{}.sqlite3",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let cache = Cache::open(path.clone());

        assert!(load(&cache, "s1").expect("load").is_none());
        save(&cache, "s1", PermissionMode::Full, "2026-11-17T05:00:00.000Z").expect("save");
        assert_eq!(load(&cache, "s1").expect("load"), Some(PermissionMode::Full));

        // A second write replaces the row; another session stays untouched.
        save(&cache, "s1", PermissionMode::Notify, "2026-11-17T06:00:00.000Z")
            .expect("save");
        assert_eq!(
            load(&cache, "s1").expect("load"),
            Some(PermissionMode::Notify)
        );

        delete(&cache, "s1").expect("delete");
        assert!(load(&cache, "s1").expect("load").is_none());
        let _ = std::fs::remove_file(&path);
    }
}
