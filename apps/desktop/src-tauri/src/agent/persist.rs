//! Incremental task persistence driven by workflow effects.
//!
//! The workflow owns the task state; this module only writes the `AgentTask`
//! views it hands over. Every write is serialized so an older batch can never
//! land after a newer one.

use tapd_i18n::tr;

use super::{AgentCore, AgentTask};

impl AgentCore {
    pub(super) fn set_storage_error(&self, message: Option<String>) {
        *self.storage_error.lock().expect("agent storage error lock") = message;
    }

    /// Upserts the given views and removes `removed`, together with the queue
    /// pause flag. Returns `false` when SQLite is unavailable or the write
    /// failed; the caller must surface that instead of pretending it worked.
    ///
    /// The pause flag is part of every write, so there is no "nothing to do"
    /// shortcut: an empty task list still records `paused`.
    pub(super) fn persist_views(
        &self,
        tasks: &[AgentTask],
        paused: bool,
        removed: &[String],
    ) -> bool {
        let _writer = self.persist_lock.lock().expect("agent persist lock");
        let persisted = self.state.cache.save_agent_tasks(tasks, paused, removed);
        if !persisted {
            tracing::error!("failed to persist agent tasks; the store is unavailable");
            self.set_storage_error(Some(tr("agent.persist.failed").to_string()));
            return false;
        }
        self.set_storage_error(None);
        true
    }
}
