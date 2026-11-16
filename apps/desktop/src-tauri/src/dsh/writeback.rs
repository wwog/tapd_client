//! TAPD write-back after a task's changes reach the main repository.
//!
//! The comment and the status transition reuse the same helpers the bug detail
//! panel uses, so the workflow rules (for example "a `new` bug must be accepted
//! before it can be resolved") stay in one place. Local projects have no TAPD
//! counterpart, so their tasks skip this module entirely.

use serde_json::Value;
use tapd_i18n::tr_args;
use tauri::AppHandle;

use super::{DshTask, TaskChanges};
use crate::bug_write;

/// Adds a summary comment and moves the bug to `resolved`.
///
/// The transition runs first: when it succeeds and the comment fails, a retry
/// only repeats the comment instead of the (already performed) transition. A
/// failure surfaces to the caller, which keeps the task in `awaiting_merge` so
/// the user can retry.
pub(super) async fn write_back(
    app: &AppHandle,
    task: &DshTask,
    workspace_id: &str,
    changes: Option<&TaskChanges>,
) -> Result<(), String> {
    let Some(bug_id) = task.bug_id.as_deref().filter(|id| !id.trim().is_empty()) else {
        return Ok(());
    };
    bug_write::perform_transition(app, workspace_id, bug_id, "resolved", &Value::Null)
        .await
        .map(|_| ())
        .map_err(|error| tr_args("dsh.task.writeback.failed", &[&error]))?;

    let comment = comment(task, changes);
    bug_write::add_comment(app, workspace_id, bug_id, &comment)
        .await
        .map(|_| ())
        .map_err(|error| tr_args("dsh.task.writeback.failed", &[&error]))
}

/// The comment body: a one-line summary and, for worktree tasks, the branch
/// that carries the work.
fn comment(task: &DshTask, changes: Option<&TaskChanges>) -> String {
    let changes = changes.cloned().unwrap_or_default();
    let mut comment = tr_args(
        "dsh.task.writeback.comment",
        &[&changes.files, &changes.additions, &changes.deletions],
    );
    if let Some(branch) = task
        .branch
        .as_deref()
        .filter(|branch| !branch.trim().is_empty())
    {
        comment.push_str(&tr_args("dsh.task.writeback.branch", &[&branch]));
    }
    comment
}

#[cfg(test)]
mod tests {
    use super::super::{ProjectKind, TaskKind, TaskProject, Workflow};
    use super::*;
    use dsh_host::transcript::SessionStatus;

    fn task(branch: Option<&str>) -> DshTask {
        DshTask {
            id: "s1".to_string(),
            kind: TaskKind::Bug,
            project: Some(TaskProject {
                id: "ws".to_string(),
                name: "UU".to_string(),
                kind: ProjectKind::Tapd,
            }),
            title: "登录崩溃".to_string(),
            bug_id: Some("42".to_string()),
            workflow: Workflow::AwaitingMerge,
            status: SessionStatus::Idle,
            repo_path: "/repo".to_string(),
            worktree_path: branch.map(|_| "/worktree".to_string()),
            branch: branch.map(str::to_string),
            json_path: "/tmp/bug.json".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            message_count: 0,
            changes: None,
            review: None,
            merge: None,
        }
    }

    #[test]
    fn comment_reports_counts_and_the_branch() {
        let changes = TaskChanges {
            files: 2,
            additions: 30,
            deletions: 4,
        };
        let with_branch = comment(&task(Some("tapd/42-ab12cd")), Some(&changes));
        assert!(with_branch.contains('2'));
        assert!(with_branch.contains("30"));
        assert!(with_branch.contains("tapd/42-ab12cd"));

        let without = comment(&task(None), None);
        assert!(!without.contains("tapd/"));
        assert!(without.contains('0'));
    }
}
