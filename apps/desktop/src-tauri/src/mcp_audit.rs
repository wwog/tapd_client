//! Local audit trail for MCP tool calls.
//!
//! The sidecar forwards every call to `/mcp/call`; the app records the tool,
//! client, policy decision and outcome here. Bodies/comment text are never
//! stored, only small scalar summaries.
//!
//! Entries live in the `mcp_audit` table of `cache.sqlite3` and are trimmed to
//! the newest [`MAX_ENTRIES`] rows on every write. The in-memory copy keeps
//! the UI list fast; JSON is only written when the user exports the log.

use std::{
    fs, io,
    path::Path,
    sync::{Arc, Mutex},
};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cache::Cache;

const MAX_ENTRIES: usize = 500;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuditEntry {
    pub id: String,
    pub ts: String,
    pub tool: String,
    pub client: String,
    /// `allowed` | `denied` | `error`
    pub decision: String,
    pub ok: bool,
    pub duration_ms: u64,
    pub workspace_id: Option<String>,
    pub bug_id: Option<String>,
    pub error: Option<String>,
    /// Non-sensitive call shape (ids, status, limits, comment length).
    pub summary: Value,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct AuditFile {
    #[serde(default)]
    entries: Vec<McpAuditEntry>,
}

pub struct McpAudit {
    cache: Arc<Cache>,
    entries: Mutex<Vec<McpAuditEntry>>,
}

impl McpAudit {
    /// Opens the audit log from SQLite. Auditing degrades to the in-memory
    /// list when SQLite is unavailable.
    pub fn load(cache: Arc<Cache>) -> Self {
        let entries = load_entries(&cache).unwrap_or_default();
        Self {
            cache,
            entries: Mutex::new(entries),
        }
    }

    /// Appends an entry and persists the bounded log. Persistence failures are
    /// logged by the caller; auditing must never break a tool call.
    pub fn record(&self, entry: McpAuditEntry) -> io::Result<()> {
        {
            let mut entries = self.entries.lock().expect("mcp audit lock");
            entries.push(entry.clone());
            let excess = entries.len().saturating_sub(MAX_ENTRIES);
            if excess > 0 {
                entries.drain(0..excess);
            }
        }

        let result = self.cache.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            insert_row(&tx, &entry)?;
            trim(&tx)?;
            tx.commit()
        });
        match result {
            Some(Ok(())) => Ok(()),
            Some(Err(error)) => Err(io::Error::other(error.to_string())),
            // SQLite disabled: the in-memory audit still works.
            None => Ok(()),
        }
    }

    pub fn list(&self, limit: usize) -> Vec<McpAuditEntry> {
        let entries = self.entries.lock().expect("mcp audit lock");
        entries
            .iter()
            .rev()
            .take(limit.clamp(1, MAX_ENTRIES))
            .cloned()
            .collect()
    }

    pub fn clear(&self) -> io::Result<()> {
        let result = self
            .cache
            .with_conn(|conn| conn.execute("DELETE FROM mcp_audit", []));
        match result {
            Some(Err(error)) => Err(io::Error::other(error.to_string())),
            // SQLite disabled: clearing the in-memory copy is all we can do.
            Some(Ok(_)) | None => {
                self.entries.lock().expect("mcp audit lock").clear();
                Ok(())
            }
        }
    }

    /// Writes the full audit log as pretty JSON and returns the file path.
    pub fn export(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let entries = self.entries.lock().expect("mcp audit lock").clone();
        let raw = serde_json::to_vec_pretty(&AuditFile { entries })
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        fs::write(path, raw)
    }
}

fn insert_row(conn: &Connection, entry: &McpAuditEntry) -> rusqlite::Result<()> {
    let payload = serde_json::to_string(entry).unwrap_or_else(|_| "null".to_string());
    conn.execute(
        "INSERT OR REPLACE INTO mcp_audit (id, payload, created_at) VALUES (?1, ?2, ?3)",
        params![entry.id, payload, crate::cache::unix_now()],
    )?;
    Ok(())
}

/// Drops everything except the newest `MAX_ENTRIES` rows.
fn trim(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM mcp_audit WHERE rowid NOT IN (
            SELECT rowid FROM mcp_audit ORDER BY rowid DESC LIMIT ?1
         )",
        params![MAX_ENTRIES as i64],
    )?;
    Ok(())
}

fn load_entries(cache: &Cache) -> Option<Vec<McpAuditEntry>> {
    cache
        .with_conn(|conn| {
            let mut statement = conn
                .prepare("SELECT payload FROM mcp_audit ORDER BY rowid ASC")
                .ok()?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0)).ok()?;
            Some(
                rows.flatten()
                    .filter_map(|payload| serde_json::from_str(&payload).ok())
                    .collect(),
            )
        })
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tapd-mcp-audit-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn entry(tool: &str) -> McpAuditEntry {
        McpAuditEntry {
            id: uuid::Uuid::new_v4().simple().to_string(),
            ts: "2026-01-01T00:00:00Z".to_string(),
            tool: tool.to_string(),
            client: "zcode".to_string(),
            decision: "allowed".to_string(),
            ok: true,
            duration_ms: 3,
            workspace_id: Some("ws".to_string()),
            bug_id: Some("bug".to_string()),
            error: None,
            summary: serde_json::json!({ "limit": 20 }),
        }
    }

    #[test]
    fn loads_persisted_entries() {
        let dir = temp_dir();
        let cache = Arc::new(Cache::open(dir.join("cache.sqlite3")));
        let audit = McpAudit::load(cache.clone());
        audit.record(entry("tapd_whoami")).expect("record");

        let reloaded = McpAudit::load(cache.clone());
        assert_eq!(reloaded.list(10).len(), 1);
        assert_eq!(reloaded.list(10)[0].tool, "tapd_whoami");
    }

    #[test]
    fn trims_to_the_newest_entries() {
        let dir = temp_dir();
        let cache = Arc::new(Cache::open(dir.join("cache.sqlite3")));
        let audit = McpAudit::load(cache.clone());

        for index in 0..=MAX_ENTRIES {
            audit
                .record(entry(&format!("tool-{index}")))
                .expect("record");
        }

        let entries = audit.list(MAX_ENTRIES + 10);
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].tool, format!("tool-{MAX_ENTRIES}"));

        let rows: i64 = cache
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM mcp_audit", [], |row| row.get(0))
                    .unwrap()
            })
            .expect("sqlite");
        assert_eq!(rows, MAX_ENTRIES as i64);
    }

    #[test]
    fn clear_removes_memory_and_sqlite_rows() {
        let dir = temp_dir();
        let cache = Arc::new(Cache::open(dir.join("cache.sqlite3")));
        let audit = McpAudit::load(cache.clone());
        audit.record(entry("tapd_whoami")).expect("record");

        audit.clear().expect("clear");
        assert!(audit.list(10).is_empty());

        let rows: i64 = cache
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM mcp_audit", [], |row| row.get(0))
                    .unwrap()
            })
            .expect("sqlite");
        assert_eq!(rows, 0);
    }
}
