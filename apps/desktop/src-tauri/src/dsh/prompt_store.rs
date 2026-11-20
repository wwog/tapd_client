//! Recently submitted composer prompts (table `dsh_prompts`, schema v13).
//!
//! The composer's ↑ history is a local affordance: a chat's own user messages
//! are already in the transcript, but a fresh chat has none, and reopening an
//! old session should still offer what the user typed elsewhere. One flat,
//! deduplicated list is enough for both, so rows are keyed by text and pruned to
//! the newest few hundred.

use rusqlite::{params, Connection};
use tapd_i18n::tr;

use crate::cache::Cache;

/// Rows kept on disk. The panel shows 50; the rest is slack for dedup order.
const KEEP: i64 = 200;

pub(super) fn remember(
    cache: &Cache,
    session_id: &str,
    text: &str,
    at: &str,
) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }
    with_conn(cache, |conn| {
        conn.execute(
            "INSERT INTO dsh_prompts (session_id, text, at) VALUES (?1, ?2, ?3)",
            params![session_id, text, at],
        )
        .map_err(sql_error)?;
        conn.execute(
            "DELETE FROM dsh_prompts
             WHERE id NOT IN (SELECT id FROM dsh_prompts ORDER BY id DESC LIMIT ?1)",
            [KEEP],
        )
        .map_err(sql_error)?;
        Ok(())
    })
}

/// The newest distinct prompts, newest first.
pub(super) fn recent(cache: &Cache, limit: u32) -> Result<Vec<String>, String> {
    let limit = limit.clamp(1, KEEP as u32) as i64;
    with_conn(cache, |conn| {
        let mut statement = conn
            .prepare(
                "SELECT text FROM dsh_prompts
                 GROUP BY text ORDER BY MAX(id) DESC LIMIT ?1",
            )
            .map_err(sql_error)?;
        let rows = statement
            .query_map([limit], |row| row.get::<_, String>(0))
            .map_err(sql_error)?;
        let mut texts = Vec::new();
        for row in rows {
            texts.push(row.map_err(sql_error)?);
        }
        Ok(texts)
    })
}

/// Drops one session's prompts when the session itself is deleted: the rows
/// outlive the session on purpose, but a deleted conversation should not keep
/// feeding the panel.
pub(super) fn delete_for_session(cache: &Cache, session_id: &str) -> Result<(), String> {
    with_conn(cache, |conn| {
        conn.execute(
            "DELETE FROM dsh_prompts WHERE session_id = ?1",
            [session_id],
        )
        .map_err(sql_error)?;
        Ok(())
    })
}

fn with_conn<T>(
    cache: &Cache,
    run: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
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
    fn prompts_round_trip_newest_first_and_deduplicated() {
        let path = std::env::temp_dir().join(format!(
            "tapd-prompt-store-{}.sqlite3",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let cache = Cache::open(path.clone());

        remember(&cache, "s1", "first", "2026-11-20T00:00:00.000Z").expect("write");
        remember(&cache, "s1", "second", "2026-11-20T00:00:01.000Z").expect("write");
        // The same text again moves to the front instead of duplicating.
        remember(&cache, "s2", "first", "2026-11-20T00:00:02.000Z").expect("write");
        // Blank input is not history.
        remember(&cache, "s1", "   ", "2026-11-20T00:00:03.000Z").expect("write");

        assert_eq!(recent(&cache, 10).expect("read"), ["first", "second"]);

        delete_for_session(&cache, "s1").expect("delete");
        assert_eq!(recent(&cache, 10).expect("read"), ["first"]);
        let _ = std::fs::remove_file(&path);
    }
}
