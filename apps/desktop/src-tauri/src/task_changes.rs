//! The only bridge between [`AgentTask`] and `tapd_workspace`, plus the live
//! change cache the UI reads while a task runs.
//!
//! `tapd_workspace` owns every git fact (file list, line totals, diff text,
//! HEAD). This module only adapts a task record into a workspace, converts the
//! summary into the workflow's durable `ChangeSet`, and keeps a small per-task
//! cache so hook-driven refreshes can be de-bounced and single-flighted.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde_json::Value;
use tapd_i18n::tr_args;
use tapd_workspace::{ChangeSummary, DiffView, TaskWorkspace};

use crate::agent::AgentTask;

/// How long a task's change cache stays warm after the UI last showed it.
const WATCH_TTL: Duration = Duration::from_secs(60);

/// Tool names that write files. Matched as a substring so vendor spellings
/// (`MultiEdit`, `str_replace_editor`, `apply_patch`) all hit.
const EDIT_TOOLS: &[&str] = &[
    "edit",
    "write",
    "multiedit",
    "apply_patch",
    "str_replace",
    "insert",
    "notebook",
    "patch",
    "create",
    "delete",
    "move",
    "rename",
    "copy",
];

/// Tool-input keys that name a file, in the spellings the supported CLIs use.
const PATH_KEYS: &[&str] = &[
    "file_path",
    "filePath",
    "path",
    "paths",
    "file",
    "target_file",
    "notebook_path",
];

/// The task's place in git: the main repository, the worktree directory when
/// one exists, the branch that survives it, and what the user already had dirty
/// when the run started.
pub(crate) fn workspace_for(task: &AgentTask) -> TaskWorkspace {
    TaskWorkspace::new(
        task.repo_path.trim().to_string(),
        task.work_dir().trim().to_string(),
        task.worktree_branch.clone(),
        task.baseline_head.clone(),
        task.baseline_dirty.clone(),
    )
}

/// The durable subset of a summary the workflow records on the task.
pub(crate) fn change_set_from(summary: &ChangeSummary) -> tapd_workflow::ChangeSet {
    tapd_workflow::ChangeSet::new(
        summary.files.iter().map(|file| file.path.clone()).collect(),
        summary.dirty,
        summary.committed,
    )
    .with_totals(summary.additions, summary.deletions)
    .with_commit(summary.commit.clone())
}

/// True once a run captured its starting point. Before that (queued, or
/// preparing before `TaskPrepared`) there is nothing to compare against: the
/// empty-tree fallback would report the whole repository as this task's change.
pub(crate) fn has_workspace_history(
    baseline_head: Option<&str>,
    worktree_branch: Option<&str>,
    started_at: Option<&str>,
) -> bool {
    let present = |value: Option<&str>| value.is_some_and(|value| !value.trim().is_empty());
    present(baseline_head) || present(worktree_branch) || present(started_at)
}

/// Blocking summary for `spawn_blocking` callers. `work_dir` overrides the
/// task's working directory, which `InspectWorkspace` receipts carry as `path`.
pub(crate) fn summary_blocking(
    task: &AgentTask,
    work_dir: Option<&str>,
) -> Result<ChangeSummary, String> {
    if !has_workspace_history(
        task.baseline_head.as_deref(),
        task.worktree_branch.as_deref(),
        task.started_at.as_deref(),
    ) {
        return Ok(ChangeSummary::empty());
    }
    let mut workspace = workspace_for(task);
    if let Some(work_dir) = work_dir.map(str::trim).filter(|dir| !dir.is_empty()) {
        workspace.work_dir = work_dir.to_string();
    }
    workspace.summary().map_err(|error| error.to_string())
}

/// Async wrapper: git runs on the blocking pool, never on the runtime thread.
pub(crate) async fn summary(
    task: &AgentTask,
    work_dir: Option<&str>,
) -> Result<ChangeSummary, String> {
    let task = task.clone();
    let work_dir = work_dir.map(str::to_string);
    tokio::task::spawn_blocking(move || summary_blocking(&task, work_dir.as_deref()))
        .await
        .map_err(|error| tr_args("agent.workspace.check.failed", &[&error]))?
}

/// Unified diff for the whole task or one file; the crate already truncates.
pub(crate) async fn diff(task: &AgentTask, file: Option<String>) -> Result<DiffView, String> {
    if !has_workspace_history(
        task.baseline_head.as_deref(),
        task.worktree_branch.as_deref(),
        task.started_at.as_deref(),
    ) {
        return Ok(DiffView {
            text: String::new(),
            truncated: false,
            empty: true,
        });
    }
    let task = task.clone();
    tokio::task::spawn_blocking(move || {
        workspace_for(&task)
            .diff(file.as_deref())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| tr_args("agent.workspace.check.failed", &[&error]))?
}

/// Current HEAD of a repository, used to record the landed merge commit.
pub(crate) fn head_commit(repo_path: &str) -> Result<Option<String>, String> {
    let repo_path = repo_path.trim();
    TaskWorkspace::new(repo_path, repo_path, None, None, Vec::new())
        .head_commit()
        .map_err(|error| error.to_string())
}

/// True when a hook event is a tool call that may have written files.
///
/// Pure JSON inspection: the hook handler calls this on the hot path, so it
/// must not touch the filesystem or git.
pub(crate) fn edits_files(event: &str, payload: Option<&Value>) -> bool {
    // Hook names differ per client (`PreToolUse`, `pre_tool_use`, `AfterTool`);
    // only tool events can change files.
    let key: String = event
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    if !key.contains("tool") {
        return false;
    }
    let Some(payload) = payload else {
        return false;
    };
    if tool_name(payload).is_some_and(|name| {
        let name = name.to_ascii_lowercase();
        EDIT_TOOLS.iter().any(|tool| name.contains(tool))
    }) {
        return true;
    }
    inputs(payload).any(|input| {
        input
            .as_object()
            .is_some_and(|object| PATH_KEYS.iter().any(|key| object.contains_key(*key)))
    })
}

fn tool_name(payload: &Value) -> Option<&str> {
    ["tool_name", "toolName", "tool"]
        .iter()
        .find_map(|key| payload.get(key)?.as_str())
}

fn inputs(payload: &Value) -> impl Iterator<Item = &Value> {
    ["tool_input", "toolInput", "input"]
        .iter()
        .filter_map(|key| payload.get(key))
}

/// One task's cache entry. `watched_until` gates refreshes: a task nobody is
/// looking at never spawns git work.
#[derive(Default)]
struct Entry {
    cached: Option<ChangeSummary>,
    computed_at: Option<Instant>,
    watched_until: Option<Instant>,
    /// A tool event touched files since the cache was written.
    stale: bool,
    /// A refresh is already scheduled or running (single flight).
    inflight: bool,
}

/// Per-task change cache. Every method locks, makes one decision and returns:
/// no git, no IO, so it is safe to call from the hook handler.
#[derive(Default)]
pub(crate) struct ChangesTracker {
    entries: Mutex<HashMap<String, Entry>>,
}

impl ChangesTracker {
    /// The UI is showing this task: keep its cache warm and drop expired
    /// entries of tasks nobody watches any more. A summary stored at run end
    /// (never watched yet) survives while it is still young enough to answer
    /// the panel without another git run.
    pub(crate) fn watch(&self, task_id: &str) {
        let now = Instant::now();
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        entries.retain(|_, entry| {
            let computed_recently = entry
                .computed_at
                .is_some_and(|computed_at| now.saturating_duration_since(computed_at) <= WATCH_TTL);
            entry.inflight
                || entry.stale
                || computed_recently
                || entry.watched_until.is_some_and(|until| until > now)
        });
        entries
            .entry(task_id.to_string())
            .or_default()
            .watched_until = Some(now + WATCH_TTL);
    }

    /// Marks the cache as out of date. Called from the hook handler, so it does
    /// exactly one lock and no IO. A task whose summary was already computed
    /// once keeps following its run: an edit after a long idle gap resumes
    /// refreshes instead of waiting for the panel to be reopened.
    pub(crate) fn mark_stale(&self, task_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            let entry = entries.entry(task_id.to_string()).or_default();
            entry.stale = true;
            if entry.computed_at.is_some() {
                entry.watched_until = Some(Instant::now() + WATCH_TTL);
            }
        }
    }

    /// The last summary written for a task, however old. Production reads
    /// [`Self::fresh`]; tests use this to inspect what `store` kept.
    #[cfg(test)]
    pub(crate) fn cached(&self, task_id: &str) -> Option<ChangeSummary> {
        self.entries.lock().ok()?.get(task_id)?.cached.clone()
    }

    /// The cached summary only when it was computed at most `max_age` ago.
    pub(crate) fn fresh(&self, task_id: &str, max_age: Duration) -> Option<ChangeSummary> {
        let entries = self.entries.lock().ok()?;
        let entry = entries.get(task_id)?;
        let computed_at = entry.computed_at?;
        (Instant::now().duration_since(computed_at) <= max_age)
            .then(|| entry.cached.clone())
            .flatten()
    }

    /// Claims the refresh slot. Returns false when nothing is stale, the task
    /// is not watched, or a refresh is already in flight.
    pub(crate) fn begin_refresh(&self, task_id: &str) -> bool {
        let now = Instant::now();
        let Ok(mut entries) = self.entries.lock() else {
            return false;
        };
        let Some(entry) = entries.get_mut(task_id) else {
            return false;
        };
        if !entry.stale || entry.inflight || !entry.watched_until.is_some_and(|until| until > now) {
            return false;
        }
        entry.inflight = true;
        entry.stale = false;
        true
    }

    pub(crate) fn store(&self, task_id: &str, summary: ChangeSummary) {
        if let Ok(mut entries) = self.entries.lock() {
            let entry = entries.entry(task_id.to_string()).or_default();
            entry.cached = Some(summary);
            entry.computed_at = Some(Instant::now());
            entry.inflight = false;
        }
    }

    /// Extends the watch window after a successful refresh so a task the user
    /// is following keeps updating for the whole run instead of expiring 60s
    /// after the panel was opened.
    pub(crate) fn touch(&self, task_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            if let Some(entry) = entries.get_mut(task_id) {
                entry.watched_until = Some(Instant::now() + WATCH_TTL);
            }
        }
    }

    /// A refresh failed; free the slot so the next edit retries.
    pub(crate) fn abort_refresh(&self, task_id: &str) {
        if let Ok(mut entries) = self.entries.lock() {
            if let Some(entry) = entries.get_mut(task_id) {
                entry.inflight = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tapd_workspace::{ChangeKind, ChangedFile};

    use super::*;

    #[test]
    fn edits_files_reads_tool_payloads_without_io() {
        let written = json!({ "tool_name": "Edit", "tool_input": { "file_path": "src/a.rs" } });
        assert!(edits_files("PostToolUse", Some(&written)));
        // A path is enough evidence even when the tool name is vendor-specific.
        let pathed = json!({ "tool_name": "SomeCli", "tool_input": { "path": "src/a.rs" } });
        assert!(edits_files("pre_tool_use", Some(&pathed)));

        let bash = json!({
            "tool_name": "Bash",
            "tool_input": { "command": "cargo test", "description": "run tests" }
        });
        assert!(!edits_files("PostToolUse", Some(&bash)));
        assert!(!edits_files("PostToolUse", None));
        // Session-level events cannot have changed a file.
        assert!(!edits_files("Stop", Some(&written)));
    }

    #[test]
    fn a_task_without_a_captured_baseline_has_no_changes() {
        // Queued, or preparing before `TaskPrepared`: nothing was diffed yet.
        assert!(!has_workspace_history(None, None, None));
        assert!(!has_workspace_history(Some("  "), None, Some("")));
        // Any captured fact means the run has a starting point.
        assert!(has_workspace_history(Some("abc123"), None, None));
        assert!(has_workspace_history(
            None,
            Some("tapd/01234567-task0001"),
            None
        ));
        assert!(has_workspace_history(
            None,
            None,
            Some("2026-11-16T10:00:00Z")
        ));
    }

    #[test]
    fn tracker_is_watch_gated_and_single_flight() {
        let tracker = ChangesTracker::default();
        tracker.mark_stale("t1");
        assert!(
            !tracker.begin_refresh("t1"),
            "an unwatched task must never spawn a refresh"
        );

        tracker.watch("t1");
        assert!(tracker.begin_refresh("t1"));
        assert!(!tracker.begin_refresh("t1"), "only one refresh in flight");

        let summary = ChangeSummary {
            files: Vec::new(),
            file_count: 0,
            additions: 0,
            deletions: 0,
            dirty: false,
            committed: false,
            commit: None,
        };
        tracker.store("t1", summary.clone());
        assert_eq!(tracker.cached("t1"), Some(summary.clone()));
        assert_eq!(
            tracker.fresh("t1", Duration::from_secs(2)),
            Some(summary.clone())
        );
        // A task whose summary was computed once resumes refreshes on later
        // edits, even if its watch window had already been spent.
        tracker.mark_stale("t1");
        assert!(tracker.begin_refresh("t1"));
        tracker.abort_refresh("t1");
        // A summary stored at run end (never watched) must survive the next
        // watch, which is exactly what lets the panel reuse it.
        tracker.watch("t1");
        assert_eq!(tracker.fresh("t1", Duration::from_secs(2)), Some(summary));
        assert!(tracker.cached("other").is_none());
    }

    #[test]
    fn change_set_from_carries_files_totals_and_commit() {
        let summary = ChangeSummary {
            files: vec![ChangedFile {
                path: "src/a.rs".to_string(),
                status: ChangeKind::Modified,
                additions: 3,
                deletions: 1,
                binary: false,
            }],
            file_count: 1,
            additions: 3,
            deletions: 1,
            dirty: true,
            committed: true,
            commit: Some("abc1234".to_string()),
        };
        let change_set = change_set_from(&summary);
        assert_eq!(change_set.files, vec!["src/a.rs".to_string()]);
        assert!(change_set.dirty);
        assert!(change_set.committed);
        assert_eq!(change_set.additions, 3);
        assert_eq!(change_set.deletions, 1);
        assert_eq!(change_set.commit.as_deref(), Some("abc1234"));
    }
}
