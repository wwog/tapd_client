//! Persistence for the agent task queue (`agent_tasks` + `agent_queue_state`).
//! The queue itself lives in memory; SQLite is the durable copy.

use rusqlite::{params, OptionalExtension};

use super::{unix_now, Cache};

impl Cache {
    /// Loads the persisted agent task list and the queue-paused flag.
    /// `None` means SQLite is disabled (the caller degrades to an empty
    /// in-memory queue).
    pub fn load_agent_tasks(&self) -> Option<(Vec<crate::agent::AgentTask>, bool)> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare("SELECT payload FROM agent_tasks WHERE payload <> '' ORDER BY rowid ASC")
                .ok()?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .ok()?;
            let mut tasks = Vec::new();
            for payload in rows.flatten() {
                match serde_json::from_str(&payload) {
                    Ok(task) => tasks.push(task),
                    Err(error) => tracing::warn!(%error, "failed to decode persisted agent task"),
                }
            }
            let paused = conn
                .query_row(
                    "SELECT paused FROM agent_queue_state WHERE id = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .ok()
                .flatten()
                .unwrap_or(0)
                != 0;
            Some((tasks, paused))
        })
        .flatten()
    }

    /// Persists the given (already dirty) tasks plus the queue flag and removes
    /// `removed` rows in one transaction. Returns `false` when SQLite is
    /// unavailable or the write failed.
    pub fn save_agent_tasks(
        &self,
        tasks: &[crate::agent::AgentTask],
        paused: bool,
        removed: &[String],
    ) -> bool {
        let guard = self.conn.lock().expect("cache lock");
        let Some(conn) = guard.as_ref() else {
            return false;
        };
        let updated_at = unix_now();
        let result = (|| -> rusqlite::Result<()> {
            let tx = conn.unchecked_transaction()?;
            for task in tasks {
                let payload = match serde_json::to_string(task) {
                    Ok(payload) => payload,
                    Err(error) => {
                        tracing::warn!(%error, task_id = %task.id, "failed to serialize agent task");
                        continue;
                    }
                };
                tx.execute(
                    "INSERT INTO agent_tasks (id, payload, updated_at)
                     VALUES (?1, ?2, ?3)
                     ON CONFLICT(id) DO UPDATE SET
                        payload = excluded.payload,
                        updated_at = excluded.updated_at",
                    params![task.id, payload, updated_at],
                )?;
            }
            for id in removed {
                tx.execute("DELETE FROM agent_tasks WHERE id = ?1", params![id])?;
            }
            tx.execute(
                "INSERT INTO agent_queue_state (id, paused) VALUES (1, ?1)
                 ON CONFLICT(id) DO UPDATE SET paused = excluded.paused",
                params![if paused { 1i64 } else { 0i64 }],
            )?;
            tx.commit()
        })();
        match result {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!(%error, "failed to persist agent tasks");
                false
            }
        }
    }
}
