//! Incremental task persistence driven by workflow effects.
//!
//! The workflow owns the task state; this module only queues the `AgentTask`
//! views it hands over. A dedicated thread performs every SQLite write in
//! queue order, so an async caller never waits on a disk fsync and an older
//! batch can never land after a newer one.

use super::{AgentCore, AgentTask, PersistJob};

impl AgentCore {
    pub(super) fn set_storage_error(&self, message: Option<String>) {
        if let Ok(mut slot) = self.storage_error.lock() {
            *slot = message;
        }
    }

    /// Queues an upsert of the given views plus removals and the queue pause
    /// flag. Returns `false` only when the writer thread is gone.
    ///
    /// The pause flag is part of every write, so there is no "nothing to do"
    /// shortcut: an empty task list still records `paused`.
    pub(super) fn persist_views(
        &self,
        tasks: &[AgentTask],
        paused: bool,
        removed: &[String],
    ) -> bool {
        let mut queued = true;
        for task_id in removed {
            queued &= self
                .persist_tx
                .send(PersistJob::Delete {
                    paused,
                    task_id: task_id.clone(),
                })
                .is_ok();
        }
        let job = if tasks.is_empty() {
            PersistJob::Paused { paused }
        } else {
            PersistJob::Upsert {
                views: tasks.to_vec(),
                paused,
            }
        };
        queued && self.persist_tx.send(job).is_ok()
    }

    /// Persists the workflow's *current* views for these ids.
    ///
    /// Reading and enqueueing happen under one lock, so a spawned dispatcher
    /// that runs out of order still writes snapshots in the order they were
    /// observed, and the last write is the newest state.
    pub(super) fn persist_task_views(&self, task_ids: &[String], paused: bool) -> bool {
        let _order = self.persist_lock.lock().expect("agent persist lock");
        let views = self.current_views(task_ids);
        self.persist_tx
            .send(PersistJob::Upsert { views, paused })
            .is_ok()
    }

    /// Waits for the writer thread to drain (shutdown only).
    pub(super) fn flush_persist(&self) {
        let (done, wait) = std::sync::mpsc::sync_channel(1);
        if self.persist_tx.send(PersistJob::Flush(done)).is_ok() {
            let _ = wait.recv_timeout(std::time::Duration::from_secs(5));
        }
    }
}
