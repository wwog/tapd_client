//! SQLite persistence for the notification service.
//!
//! The in-memory [`NotificationStore`] is the working set (fast pending-list
//! rendering); this module loads it once at startup and mirrors mutations
//! row-by-row so a 30s poll never rewrites the whole state. Tables are created
//! by the cache migration (v3) in `cache.rs`.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::cache::Cache;
use crate::notification::model::{
    NotificationItem, NotificationKind, NotificationScope, NotificationSettings, NotificationState,
    NotificationStore, SeenBug,
};

/// Loads the whole store. `None` = no settings row yet (fresh install) or
/// SQLite is disabled.
pub fn load(cache: &Cache) -> Option<NotificationStore> {
    cache.with_conn(load_conn).flatten()
}

/// True only when the settings row is confirmed absent. A failed load (corrupt
/// or partially migrated schema) must not look like a fresh install, otherwise
/// startup would overwrite the stored state with defaults.
pub fn is_fresh(cache: &Cache) -> bool {
    match cache.with_conn(|conn| {
        conn.query_row(
            "SELECT 1 FROM notification_settings WHERE id = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
    }) {
        Some(Ok(None)) => true,
        _ => false,
    }
}

fn load_conn(conn: &Connection) -> Option<NotificationStore> {
    let settings = conn
        .query_row(
            "SELECT enabled, scope, include_new, include_transferred, include_reopened,
                    poll_interval_secs, quiet_enabled, quiet_start, quiet_end, max_visible,
                    ai_enabled
               FROM notification_settings WHERE id = 1",
            [],
            |row| {
                Ok(NotificationSettings {
                    enabled: row.get::<_, i64>(0)? != 0,
                    scope: scope_from(&row.get::<_, String>(1)?),
                    include_new: row.get::<_, i64>(2)? != 0,
                    include_transferred: row.get::<_, i64>(3)? != 0,
                    include_reopened: row.get::<_, i64>(4)? != 0,
                    poll_interval_secs: row.get::<_, i64>(5)? as u64,
                    quiet_hours: crate::notification::model::QuietHours {
                        enabled: row.get::<_, i64>(6)? != 0,
                        start: row.get(7)?,
                        end: row.get(8)?,
                    },
                    max_visible: row.get::<_, i64>(9)? as u32,
                    ai_enabled: row.get::<_, i64>(10)? != 0,
                })
            },
        )
        .optional()
        .ok()??;

    let mut items_stmt = conn
        .prepare(
            "SELECT id, workspace_id, workspace_name, bug_id, title, kind, owner, creator,
                    severity, priority, created, detected_at, state
               FROM notification_items ORDER BY rowid ASC",
        )
        .ok()?;
    let items = items_stmt
        .query_map([], |row| {
            Ok(NotificationItem {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                workspace_name: row.get(2)?,
                bug_id: row.get(3)?,
                title: row.get(4)?,
                kind: kind_from(&row.get::<_, String>(5)?),
                owner: row.get(6)?,
                creator: row.get(7)?,
                severity: row.get(8)?,
                priority: row.get(9)?,
                created: row.get(10)?,
                detected_at: row.get(11)?,
                state: state_from(&row.get::<_, String>(12)?),
                // Persisted items are always TAPD bugs; AI cards are in-memory.
                source: crate::notification::model::NotificationSource::Tapd,
                ai: None,
            })
        })
        .ok()?
        .filter_map(Result::ok)
        .collect();

    let mut seen_stmt = conn
        .prepare(
            "SELECT bug_key, status, owner, created, assigned_time, kinds, last_seen
               FROM notification_seen",
        )
        .ok()?;
    let seen: BTreeMap<String, SeenBug> = seen_stmt
        .query_map([], |row| {
            let kinds: String = row.get(5)?;
            Ok((
                row.get::<_, String>(0)?,
                SeenBug {
                    status: row.get(1)?,
                    owner: row.get(2)?,
                    created: row.get(3)?,
                    assigned_time: row.get(4)?,
                    kinds: split_kinds(&kinds),
                    last_seen: row.get(6)?,
                },
            ))
        })
        .ok()?
        .filter_map(Result::ok)
        .collect();

    let mut ignored_stmt = conn
        .prepare("SELECT bug_key FROM notification_ignored")
        .ok()?;
    let ignored = ignored_stmt
        .query_map([], |row| row.get::<_, String>(0))
        .ok()?
        .filter_map(Result::ok)
        .collect();

    let mut cursors_stmt = conn
        .prepare("SELECT workspace_id, cursor FROM notification_cursors")
        .ok()?;
    let cursors = cursors_stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok()?
        .filter_map(Result::ok)
        .collect();

    Some(NotificationStore {
        settings,
        items,
        seen,
        ignored,
        cursors,
    })
}

pub fn save_settings(cache: &Cache, settings: &NotificationSettings) {
    let result =
        cache.with_conn(|conn| -> rusqlite::Result<()> { upsert_settings(conn, settings) });
    warn_on_error(result, "failed to save notification settings");
}

/// Drops every card. Called when a notification session starts (app launch or
/// login) so an old backlog never greets the user.
pub fn clear_items(cache: &Cache) {
    let result = cache.with_conn(|conn| -> rusqlite::Result<()> {
        conn.execute("DELETE FROM notification_items", [])?;
        Ok(())
    });
    warn_on_error(result, "failed to clear notification items");
}

/// Drops the per-account poll state (seen/cursors/ignored). Used when the
/// signed-in account changes; settings and cards are handled separately.
pub fn clear_poll_state(cache: &Cache) {
    let result = cache.with_conn(|conn| -> rusqlite::Result<()> {
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM notification_seen", [])?;
        tx.execute("DELETE FROM notification_ignored", [])?;
        tx.execute("DELETE FROM notification_cursors", [])?;
        tx.commit()
    });
    warn_on_error(result, "failed to clear notification poll state");
}

pub fn insert_item(cache: &Cache, item: &NotificationItem, max_items: usize) {
    let result = cache.with_conn(|conn| -> rusqlite::Result<()> {
        let tx = conn.unchecked_transaction()?;
        insert_item_row(&tx, item)?;
        trim_items(&tx, max_items)?;
        tx.commit()
    });
    warn_on_error(result, "failed to save notification item");
}

pub fn update_item_state(cache: &Cache, id: &str, state: NotificationState) {
    let result = cache.with_conn(|conn| -> rusqlite::Result<()> {
        conn.execute(
            "UPDATE notification_items SET state = ?2 WHERE id = ?1",
            params![id, state_str(state)],
        )?;
        Ok(())
    });
    warn_on_error(result, "failed to update notification state");
}

pub fn insert_ignored(cache: &Cache, key: &str) {
    let result = cache.with_conn(|conn| -> rusqlite::Result<()> {
        conn.execute(
            "INSERT OR IGNORE INTO notification_ignored (bug_key) VALUES (?1)",
            params![key],
        )?;
        Ok(())
    });
    warn_on_error(result, "failed to save ignored notification");
}

/// Everything one poll round needs to persist, written in a single transaction.
pub struct PollWrite<'a> {
    pub seen: &'a [(String, SeenBug)],
    pub items: &'a [NotificationItem],
    pub ignore_lifted: &'a [String],
    /// Set only when every page was consumed; a truncated round must keep the
    /// previous cursor so the remaining window is retried next poll.
    pub cursor: Option<&'a str>,
    pub trim_items: bool,
    pub max_items: usize,
}

/// Upserts observations without creating notifications or moving a poll cursor.
///
/// Used by the bug list: a refresh — manual or the periodic one — counts as an
/// observation round, so rows already on screen must not fire a card later.
pub fn write_seen(cache: &Cache, seen: &[(String, SeenBug)]) {
    if seen.is_empty() {
        return;
    }
    let result = cache.with_conn(|conn| -> rusqlite::Result<()> {
        let tx = conn.unchecked_transaction()?;
        for (key, row) in seen {
            upsert_seen(&tx, key, row)?;
        }
        tx.commit()
    });
    warn_on_error(result, "failed to persist notification seen rows");
}

pub fn write_poll(cache: &Cache, workspace_id: &str, write: PollWrite<'_>) {
    let result = cache.with_conn(|conn| -> rusqlite::Result<()> {
        let tx = conn.unchecked_transaction()?;
        for (key, seen) in write.seen {
            upsert_seen(&tx, key, seen)?;
        }
        for item in write.items {
            insert_item_row(&tx, item)?;
        }
        for key in write.ignore_lifted {
            tx.execute(
                "DELETE FROM notification_ignored WHERE bug_key = ?1",
                params![key],
            )?;
        }
        if let Some(cursor) = write.cursor {
            tx.execute(
                "INSERT INTO notification_cursors (workspace_id, cursor) VALUES (?1, ?2)
                 ON CONFLICT(workspace_id) DO UPDATE SET cursor = excluded.cursor",
                params![workspace_id, cursor],
            )?;
        }
        if write.trim_items {
            trim_items(&tx, write.max_items)?;
        }
        tx.commit()
    });
    warn_on_error(result, "failed to persist notification poll");
}

pub fn delete_seen_and_ignored(cache: &Cache, keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    let result = cache.with_conn(|conn| -> rusqlite::Result<()> {
        let tx = conn.unchecked_transaction()?;
        for key in keys {
            tx.execute(
                "DELETE FROM notification_seen WHERE bug_key = ?1",
                params![key],
            )?;
            tx.execute(
                "DELETE FROM notification_ignored WHERE bug_key = ?1",
                params![key],
            )?;
        }
        tx.commit()
    });
    warn_on_error(result, "failed to prune notification seen rows");
}

fn upsert_settings(
    conn: &Connection,
    settings: &NotificationSettings,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO notification_settings (
            id, enabled, scope, include_new, include_transferred, include_reopened,
            poll_interval_secs, quiet_enabled, quiet_start, quiet_end, max_visible,
            ai_enabled
         ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
            enabled = excluded.enabled,
            scope = excluded.scope,
            include_new = excluded.include_new,
            include_transferred = excluded.include_transferred,
            include_reopened = excluded.include_reopened,
            poll_interval_secs = excluded.poll_interval_secs,
            quiet_enabled = excluded.quiet_enabled,
            quiet_start = excluded.quiet_start,
            quiet_end = excluded.quiet_end,
            max_visible = excluded.max_visible,
            ai_enabled = excluded.ai_enabled",
        params![
            if settings.enabled { 1_i64 } else { 0 },
            scope_str(settings.scope),
            if settings.include_new { 1_i64 } else { 0 },
            if settings.include_transferred {
                1_i64
            } else {
                0
            },
            if settings.include_reopened { 1_i64 } else { 0 },
            settings.poll_interval_secs as i64,
            if settings.quiet_hours.enabled {
                1_i64
            } else {
                0
            },
            settings.quiet_hours.start,
            settings.quiet_hours.end,
            settings.max_visible as i64,
            if settings.ai_enabled { 1_i64 } else { 0 },
        ],
    )?;
    Ok(())
}

fn insert_item_row(conn: &Connection, item: &NotificationItem) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO notification_items (
            id, workspace_id, workspace_name, bug_id, title, kind, owner, creator,
            severity, priority, created, detected_at, state
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            item.id,
            item.workspace_id,
            item.workspace_name,
            item.bug_id,
            item.title,
            item.kind.as_str(),
            item.owner,
            item.creator,
            item.severity,
            item.priority,
            item.created,
            item.detected_at,
            state_str(item.state),
        ],
    )?;
    Ok(())
}

fn upsert_seen(conn: &Connection, key: &str, seen: &SeenBug) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO notification_seen (
            bug_key, status, owner, created, assigned_time, kinds, last_seen
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(bug_key) DO UPDATE SET
            status = excluded.status,
            owner = excluded.owner,
            created = excluded.created,
            assigned_time = excluded.assigned_time,
            kinds = excluded.kinds,
            last_seen = excluded.last_seen",
        params![
            key,
            seen.status,
            seen.owner,
            seen.created,
            seen.assigned_time,
            seen.kinds.join(","),
            seen.last_seen,
        ],
    )?;
    Ok(())
}

fn trim_items(conn: &Connection, max_items: usize) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM notification_items
          WHERE id NOT IN (
              SELECT id FROM notification_items ORDER BY rowid DESC LIMIT ?1
          )",
        params![max_items as i64],
    )?;
    Ok(())
}

fn split_kinds(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|kind| !kind.is_empty())
        .map(str::to_string)
        .collect()
}

fn scope_str(scope: NotificationScope) -> &'static str {
    match scope {
        NotificationScope::Mine => "mine",
        NotificationScope::Project => "project",
    }
}

fn scope_from(raw: &str) -> NotificationScope {
    match raw.trim() {
        "project" => NotificationScope::Project,
        _ => NotificationScope::Mine,
    }
}

fn kind_from(raw: &str) -> NotificationKind {
    NotificationKind::parse(raw).unwrap_or(NotificationKind::New)
}

fn state_str(state: NotificationState) -> &'static str {
    match state {
        NotificationState::Pending => "pending",
        NotificationState::Handled => "handled",
        NotificationState::Viewed => "viewed",
        NotificationState::Ignored => "ignored",
    }
}

fn state_from(raw: &str) -> NotificationState {
    match raw.trim() {
        "handled" => NotificationState::Handled,
        "viewed" => NotificationState::Viewed,
        "ignored" => NotificationState::Ignored,
        _ => NotificationState::Pending,
    }
}

fn warn_on_error(result: Option<rusqlite::Result<()>>, context: &str) {
    match result {
        Some(Err(error)) => tracing::warn!(%error, context, "notification database write failed"),
        None => tracing::debug!(
            context,
            "notification database unavailable; state is in-memory"
        ),
        Some(Ok(())) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_seen_observes_without_cards_or_cursor() {
        let dir = std::env::temp_dir().join(format!(
            "tapd-notification-seen-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let cache = Cache::open(dir.join("cache.sqlite3"));
        save_settings(&cache, &NotificationStore::default().settings);

        let seen = SeenBug {
            status: "open".to_string(),
            owner: "李四".to_string(),
            created: "2026-11-01 09:00:00".to_string(),
            assigned_time: String::new(),
            kinds: Vec::new(),
            last_seen: "2026-11-10 12:00:00".to_string(),
        };
        write_seen(&cache, &[("1:2".to_string(), seen)]);

        let loaded = load(&cache).expect("store round-trip");
        assert_eq!(loaded.seen["1:2"].owner, "李四");
        // Observing a rendered list is not a poll: no cards, no cursor move.
        assert!(loaded.items.is_empty());
        assert!(loaded.cursors.is_empty());
    }

    #[test]
    fn round_trips_and_writes_incrementally() {
        let dir = std::env::temp_dir().join(format!(
            "tapd-notification-db-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let cache = Cache::open(dir.join("cache.sqlite3"));

        let store = NotificationStore::default();
        save_settings(&cache, &store.settings);

        let item = NotificationItem {
            id: "n1".to_string(),
            workspace_id: "1".to_string(),
            workspace_name: "项目".to_string(),
            bug_id: "2".to_string(),
            title: "标题".to_string(),
            kind: NotificationKind::New,
            owner: "李四".to_string(),
            creator: "张三".to_string(),
            severity: "严重".to_string(),
            priority: "高".to_string(),
            created: "2026-11-10 11:00:00".to_string(),
            detected_at: "2026-11-10 11:01:00".to_string(),
            state: NotificationState::Pending,
            source: crate::notification::model::NotificationSource::Tapd,
            ai: None,
        };
        let seen = SeenBug {
            status: "new".to_string(),
            owner: "李四".to_string(),
            created: "2026-11-10 11:00:00".to_string(),
            assigned_time: String::new(),
            kinds: vec!["new".to_string()],
            last_seen: "2026-11-10 11:01:00".to_string(),
        };
        insert_ignored(&cache, "1:3");
        write_poll(
            &cache,
            "1",
            PollWrite {
                seen: &[("1:2".to_string(), seen)],
                items: &[item],
                ignore_lifted: &[],
                cursor: Some("2026-11-10 11:01:00"),
                trim_items: false,
                max_items: 200,
            },
        );

        let loaded = load(&cache).expect("store round-trip");
        assert_eq!(loaded.items.len(), 1);
        assert_eq!(loaded.items[0].kind, NotificationKind::New);
        assert_eq!(loaded.items[0].state, NotificationState::Pending);
        assert_eq!(loaded.seen["1:2"].kinds, vec!["new".to_string()]);
        assert_eq!(loaded.ignored, vec!["1:3".to_string()]);
        assert_eq!(loaded.cursors["1"], "2026-11-10 11:01:00");

        // Incremental poll write: update one seen row, lift one ignore, move
        // the cursor. Untouched rows must survive.
        let mut changed = loaded.seen["1:2"].clone();
        changed.status = "resolved".to_string();
        changed.last_seen = "2026-11-10 11:31:00".to_string();
        write_poll(
            &cache,
            "1",
            PollWrite {
                seen: &[("1:2".to_string(), changed)],
                items: &[],
                ignore_lifted: &["1:3".to_string()],
                cursor: Some("2026-11-10 11:31:00"),
                trim_items: false,
                max_items: 200,
            },
        );

        let loaded = load(&cache).expect("store after poll");
        assert_eq!(loaded.seen["1:2"].status, "resolved");
        assert_eq!(loaded.seen.len(), 1);
        assert!(loaded.ignored.is_empty());
        assert_eq!(loaded.cursors["1"], "2026-11-10 11:31:00");
        assert_eq!(loaded.items.len(), 1);

        // Pruning drops the seen row and its ignored key together.
        insert_ignored(&cache, "1:2");
        delete_seen_and_ignored(&cache, &["1:2".to_string()]);
        let loaded = load(&cache).expect("store after prune");
        assert!(!loaded.seen.contains_key("1:2"));
        assert!(loaded.ignored.is_empty());

        // A new notification session drops cards but keeps settings.
        clear_items(&cache);
        let loaded = load(&cache).expect("store after session reset");
        assert!(loaded.items.is_empty());
        assert_eq!(loaded.cursors["1"], "2026-11-10 11:31:00");

        // Account switch drops the poll state entirely.
        clear_poll_state(&cache);
        let loaded = load(&cache).expect("store after poll-state reset");
        assert!(loaded.seen.is_empty());
        assert!(loaded.cursors.is_empty());
        assert!(loaded.ignored.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
