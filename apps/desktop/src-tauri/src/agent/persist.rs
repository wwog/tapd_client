//! Incremental task persistence: dirty snapshots and the single SQLite writer.

use std::collections::HashSet;
use std::sync::atomic::Ordering;

use super::{AgentCore, AgentTask};

impl AgentCore {
    pub(super) fn mark_task_dirty(&self, task: AgentTask) {
        self.pending_tasks
            .lock()
            .expect("agent pending lock")
            .insert(task.id.clone(), task);
    }

    pub(super) fn mark_tasks_dirty<I>(&self, tasks: I)
    where
        I: IntoIterator<Item = AgentTask>,
    {
        let mut pending = self.pending_tasks.lock().expect("agent pending lock");
        for task in tasks {
            pending.insert(task.id.clone(), task);
        }
    }

    /// Updates the queue flag and marks it for persistence when it changes.
    pub(super) fn set_paused(&self, paused: bool) {
        if self.paused.swap(paused, Ordering::SeqCst) != paused {
            self.paused_dirty.store(true, Ordering::SeqCst);
        }
    }

    pub(super) fn set_storage_error(&self, message: Option<String>) {
        *self.storage_error.lock().expect("agent storage error lock") = message;
    }

    pub(super) fn persist_tasks(&self) -> bool {
        // One writer at a time: a drained older snapshot must not be written
        // after a newer one.
        let _writer = self.persist_lock.lock().expect("agent persist lock");

        // Drain the pending snapshots first: only tasks touched since the last
        // write are serialized, so persistence is O(changed).
        let tasks: Vec<AgentTask> = {
            let mut pending = self.pending_tasks.lock().expect("agent pending lock");
            if pending.is_empty() {
                Vec::new()
            } else {
                pending.drain().map(|(_, task)| task).collect()
            }
        };
        let removed: Vec<String> = {
            let mut removed = self.removed_tasks.lock().expect("agent removed lock");
            if removed.is_empty() {
                Vec::new()
            } else {
                removed.drain().collect()
            }
        };
        let paused_dirty = self.paused_dirty.swap(false, Ordering::SeqCst);
        if tasks.is_empty() && removed.is_empty() && !paused_dirty {
            return true;
        }

        let paused = self.paused.load(Ordering::SeqCst);
        let persisted = self.state.cache.save_agent_tasks(&tasks, paused, &removed);
        if !persisted {
            self.set_storage_error(Some("任务状态保存失败，重启后可能丢失".to_string()));
            // SQLite is unavailable. Re-read the latest in-memory state (a
            // mutation may have landed while the write was failing) so the
            // retry never resurrects an older snapshot.
            tracing::error!("failed to persist agent tasks; retrying on the next mutation");
            let failed: HashSet<&str> = tasks.iter().map(|task| task.id.as_str()).collect();
            let latest: Vec<AgentTask> = {
                let current = self.tasks.lock().expect("agent tasks lock");
                current
                    .iter()
                    .filter(|task| failed.contains(task.id.as_str()))
                    .cloned()
                    .collect()
            };
            let found: HashSet<&str> = latest.iter().map(|task| task.id.as_str()).collect();
            let missing: Vec<String> = failed
                .into_iter()
                .filter(|id| !found.contains(id))
                .map(str::to_string)
                .collect();

            self.mark_tasks_dirty(latest);
            if !missing.is_empty() {
                self.removed_tasks
                    .lock()
                    .expect("agent removed lock")
                    .extend(missing);
            }
            if !removed.is_empty() {
                self.removed_tasks
                    .lock()
                    .expect("agent removed lock")
                    .extend(removed);
            }
            if paused_dirty {
                self.paused_dirty.store(true, Ordering::SeqCst);
            }
            return false;
        }
        self.set_storage_error(None);
        true
    }
}
