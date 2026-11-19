//! TAPD write-back text for the finishing turn.
//!
//! The host no longer writes TAPD itself: after the code is committed, merged
//! and the worktree is cleaned up, the model receives one hidden `host-prompt`
//! turn whose tools are the conditional `tapd_*` set. This module builds that
//! message so the facts (branch, commit, change counts, bug link) come from the
//! task row instead of the model's memory.

use std::path::Path;

use tapd_i18n::{tr, tr_args};

use super::{DshTask, TaskChanges};

/// The hidden turn that starts the write-back phase (docs/AGENT_TASK_FLOW.md §6.2).
pub(super) fn prompt(
    task: &DshTask,
    changes: Option<&TaskChanges>,
    commit: Option<&str>,
    merge: Option<&str>,
    workspace: &str,
) -> String {
    let changes = changes.cloned().unwrap_or_default();
    let branch = text_or(task.branch.as_deref(), "-");
    let commit = text_or(commit, "-");
    let merge = text_or(merge, "-");
    let link = bug_link(task);
    tr_args(
        "dsh.task.writeback.prompt",
        &[
            &branch,
            &commit,
            &merge,
            &workspace,
            &changes.files,
            &changes.additions,
            &changes.deletions,
            &link,
        ],
    )
}

fn text_or(value: Option<&str>, fallback: &str) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

/// What happened to the round's workspace, for the write-back prompt. A dirty
/// worktree is kept by the cleanup step, so the model is told it still exists
/// instead of being told the session is back in the repository.
pub(super) fn workspace_state(task: &DshTask, direct: bool) -> String {
    if let Some(path) = task
        .worktree_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty() && Path::new(path).is_dir())
    {
        return tr_args("dsh.task.writeback.worktreeKept", &[&path]);
    }
    if direct {
        return tr("dsh.task.writeback.directRepo").to_string();
    }
    tr("dsh.task.writeback.worktreeRemoved").to_string()
}

/// The bug's own page, so the write-back turn can quote it in the comment.
fn bug_link(task: &DshTask) -> String {
    let workspace = task
        .project
        .as_ref()
        .map(|project| project.id.trim())
        .filter(|id| !id.is_empty());
    let bug = task
        .bug_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    match (workspace, bug) {
        (Some(workspace), Some(bug)) => {
            format!("https://www.tapd.cn/{workspace}/bugtrace/bugs/view?bug_id={bug}")
        }
        _ => "-".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{ProjectKind, TaskKind, TaskProject, Workflow};
    use super::*;
    use dsh_host::transcript::SessionStatus;

    fn task() -> DshTask {
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
            workflow: Workflow::Finalizing,
            status: SessionStatus::Idle,
            repo_path: "/repo".to_string(),
            worktree_path: None,
            branch: Some("tapd/42-ab12cd".to_string()),
            json_path: "/tmp/bug.json".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            message_count: 0,
            changes: None,
            review: None,
            finalize: None,
        }
    }

    #[test]
    fn the_prompt_carries_branch_commit_counts_and_the_bug_link() {
        let changes = TaskChanges {
            files: 2,
            additions: 30,
            deletions: 4,
        };
        let text = prompt(
            &task(),
            Some(&changes),
            Some("abc123"),
            Some("def456"),
            "worktree 已清理，会话已回到主仓库。",
        );
        assert!(text.contains("tapd/42-ab12cd"));
        assert!(text.contains("abc123"));
        assert!(text.contains("def456"));
        assert!(text.contains("worktree 已清理"));
        assert!(text.contains('2'));
        assert!(text.contains("30"));
        assert!(text.contains("https://www.tapd.cn/ws/bugtrace/bugs/view?bug_id=42"));
        assert!(text.contains("task_complete"));
    }

    #[test]
    fn missing_facts_fall_back_instead_of_leaving_placeholders() {
        let mut task = task();
        task.branch = None;
        task.bug_id = None;
        let text = prompt(&task, None, None, None, "-");
        assert!(!text.contains("{0}"));
        assert!(!text.contains("{7}"));
    }
}
