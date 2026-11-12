mod common;

use common::*;
use tapd_workflow::{Input, MergeBlock, RunOutcome, TaskStatus, TerminalStatus, Workflow};

fn awaiting_merge(workflow: &mut Workflow, task_id: &str, bug: &str) {
    running_worktree_task(workflow, task_id, bug);
    finish(workflow, task_id, false, true, &["src/fix.rs"]);
    assert_eq!(status(workflow, task_id), TaskStatus::AwaitingApproval);
    let effects = workflow.apply(Input::ApproveReview {
        task_id: id(task_id),
        now: now(20),
    });
    assert!(
        effects
            .iter()
            .all(|effect| !matches!(effect, tapd_workflow::Effect::InspectWorkspace { .. })),
        "known changes must not trigger an inspection"
    );
    assert_eq!(status(workflow, task_id), TaskStatus::AwaitingMerge);
}

fn begin_merge(workflow: &mut Workflow, task_id: &str) -> String {
    let effects = workflow.apply(Input::StartMerge {
        task_id: id(task_id),
        now: now(30),
    });
    assert!(check_merge(&effects).is_some(), "preconditions must run");
    assert_eq!(status(workflow, task_id), TaskStatus::AwaitingMerge);
    let effects = workflow.apply(Input::MergePreconditionsChecked {
        task_id: id(task_id),
        result: Ok(()),
    });
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, tapd_workflow::Effect::StartMergeAgent { .. })));
    assert_eq!(status(workflow, task_id), TaskStatus::Merging);
    "tapd/a".to_string()
}

#[test]
fn worktree_uncommitted_change_enters_review_with_files() {
    let mut workflow = boot(worktree_config(2));
    running_worktree_task(&mut workflow, "a", "bug-a");
    let effects = finish(&mut workflow, "a", true, false, &["src/a.rs", "src/b.rs"]);
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingApproval);
    let task = workflow.task(&id("a")).unwrap();
    let approval = task.approval.as_ref().expect("approval");
    assert_eq!(approval.files, vec!["src/a.rs", "src/b.rs"]);
    assert!(approval.approved_at.is_none());
    assert!(history_records(&effects).is_empty());
}

#[test]
fn worktree_committed_change_also_enters_review() {
    let mut workflow = boot(worktree_config(2));
    running_worktree_task(&mut workflow, "a", "bug-a");
    finish(&mut workflow, "a", false, true, &["src/a.rs"]);
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingApproval);
    assert!(workflow
        .task(&id("a"))
        .unwrap()
        .approval
        .as_ref()
        .unwrap()
        .files
        .contains(&"src/a.rs".to_string()));
}

#[test]
fn worktree_without_changes_succeeds_and_cleans_up() {
    let mut workflow = boot(worktree_config(2));
    running_worktree_task(&mut workflow, "a", "bug-a");
    let effects = finish(&mut workflow, "a", false, false, &[]);
    assert_eq!(status(&workflow, "a"), TaskStatus::Succeeded);
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, tapd_workflow::Effect::RemoveWorktree { .. })));
    assert_eq!(history_records(&effects).len(), 1);
    assert_eq!(
        history_records(&effects)[0].status,
        TerminalStatus::Succeeded
    );
}

#[test]
fn worktree_clean_approval_goes_straight_to_awaiting_merge() {
    let mut workflow = boot(worktree_config(2));
    running_worktree_task(&mut workflow, "a", "bug-a");
    finish(&mut workflow, "a", false, true, &["src/a.rs"]);
    let effects = workflow.apply(Input::ApproveReview {
        task_id: id("a"),
        now: now(20),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingMerge);
    let task = workflow.task(&id("a")).unwrap();
    assert!(!task.commit_only);
    assert!(task.merge.as_ref().unwrap().instructions.is_some());
    assert!(start_fix_agent(&effects).is_none());
}

#[test]
fn worktree_dirty_approval_requeues_commit_only_and_reuses_worktree() {
    let mut workflow = boot(worktree_config(2));
    running_worktree_task(&mut workflow, "a", "bug-a");
    finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    let effects = workflow.apply(Input::ApproveReview {
        task_id: id("a"),
        now: now(20),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);
    let task = workflow.task(&id("a")).unwrap();
    assert!(task.commit_only);
    assert!(create_worktrees(&effects).is_empty(), "worktree is reused");
    assert!(effects.iter().any(|effect| matches!(
        effect,
        tapd_workflow::Effect::StartFixAgent { cwd, .. } if cwd == "/wt/a"
    )));
}

#[test]
fn commit_only_run_clean_goes_to_awaiting_merge() {
    let mut workflow = boot(worktree_config(2));
    running_worktree_task(&mut workflow, "a", "bug-a");
    finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    workflow.apply(Input::ApproveReview {
        task_id: id("a"),
        now: now(20),
    });
    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", false, false, &[]);
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingMerge);
    assert!(!workflow.task(&id("a")).unwrap().commit_only);
}

#[test]
fn commit_only_run_with_dirty_tree_fails() {
    let mut workflow = boot(worktree_config(2));
    running_worktree_task(&mut workflow, "a", "bug-a");
    finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    workflow.apply(Input::ApproveReview {
        task_id: id("a"),
        now: now(20),
    });
    agent_started(&mut workflow, "a");
    let effects = finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    assert_eq!(status(&workflow, "a"), TaskStatus::Failed);
    assert_eq!(history_records(&effects).len(), 1);
    assert_eq!(history_records(&effects)[0].status, TerminalStatus::Failed);
}

#[test]
fn non_worktree_dirty_success_enters_review_and_commit_only_finishes() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingApproval);

    workflow.apply(Input::ApproveReview {
        task_id: id("a"),
        now: now(20),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);
    assert!(workflow.task(&id("a")).unwrap().commit_only);

    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", false, false, &[]);
    assert_eq!(status(&workflow, "a"), TaskStatus::Succeeded);
}

#[test]
fn non_worktree_committed_success_skips_review() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", true, true, &["src/a.rs"]);
    assert_eq!(status(&workflow, "a"), TaskStatus::Succeeded);
}

#[test]
fn non_worktree_commit_only_dirty_fails() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    workflow.apply(Input::ApproveReview {
        task_id: id("a"),
        now: now(20),
    });
    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    assert_eq!(status(&workflow, "a"), TaskStatus::Failed);
}

#[test]
fn unknown_changes_trigger_a_workspace_inspection_before_approval() {
    let task = worktree_task_with_status("a", "bug-a", TaskStatus::AwaitingApproval);
    assert!(task.changes.is_none());
    let (mut workflow, _) = boot_with(worktree_config(1), vec![task], true);
    let effects = workflow.apply(Input::ApproveReview {
        task_id: id("a"),
        now: now(20),
    });
    assert!(effects.iter().any(|effect| matches!(
        effect,
        tapd_workflow::Effect::InspectWorkspace { path, .. } if path == "/wt/a"
    )));
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingApproval);

    let effects = workflow.apply(Input::WorkspaceInspected {
        task_id: id("a"),
        changes: tapd_workflow::ChangeSet::new(vec!["src/a.rs".to_string()], true, false),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);
    assert!(workflow.task(&id("a")).unwrap().commit_only);
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, tapd_workflow::Effect::StartFixAgent { .. })));
}

#[test]
fn duplicate_approve_is_rejected() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    workflow.apply(Input::ApproveReview {
        task_id: id("a"),
        now: now(20),
    });
    let effects = workflow.apply(Input::ApproveReview {
        task_id: id("a"),
        now: now(21),
    });
    assert!(rejected(&effects).is_some());
}

#[test]
fn stop_review_cancels_and_pauses_the_queue() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    let effects = workflow.apply(Input::StopReview {
        task_id: id("a"),
        now: now(20),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::Canceled);
    assert!(workflow.paused());
    assert_eq!(history_records(&effects).len(), 1);

    let next = enqueue(&mut workflow, "b", "bug-b");
    assert!(start_fix_agent(&next).is_none());
    assert_eq!(status(&workflow, "b"), TaskStatus::Queued);
}

#[test]
fn late_run_finished_does_not_downgrade_review_or_terminal_states() {
    let mut workflow = boot(worktree_config(2));
    running_worktree_task(&mut workflow, "a", "bug-a");
    finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    let effects = finish_outcome(&mut workflow, "a", RunOutcome::failure("late", None));
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingApproval);
    assert!(history_records(&effects).is_empty());

    running_worktree_task(&mut workflow, "b", "bug-b");
    finish(&mut workflow, "b", false, false, &[]);
    let effects = finish_outcome(&mut workflow, "b", RunOutcome::failure("late", None));
    assert_eq!(status(&workflow, "b"), TaskStatus::Succeeded);
    assert!(history_records(&effects).is_empty());
}

#[test]
fn merge_agent_success_retains_branch_and_removes_directory() {
    let mut workflow = boot(worktree_config(2));
    awaiting_merge(&mut workflow, "a", "bug-a");
    let branch = begin_merge(&mut workflow, "a");

    let effects = workflow.apply(Input::MergeAgentFinished {
        task_id: id("a"),
        outcome: RunOutcome::success(None),
        now: now(40),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::Merging);
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, tapd_workflow::Effect::VerifyBranchMerged { .. })));

    let effects = workflow.apply(Input::BranchMergeVerified {
        task_id: id("a"),
        merged: true,
        error: None,
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::Succeeded);
    let task = workflow.task(&id("a")).unwrap();
    assert_eq!(task.worktree_branch.as_deref(), Some(branch.as_str()));
    assert_eq!(task.worktree_path.as_deref(), Some("/wt/a"));
    assert!(task.merge.as_ref().unwrap().finished_at.is_some());
    assert!(effects.iter().any(|effect| matches!(
        effect,
        tapd_workflow::Effect::RemoveWorktree { path, .. } if path == "/wt/a"
    )));
    assert_eq!(history_records(&effects).len(), 1);
    let record = history_records(&effects)[0];
    assert_eq!(record.status, TerminalStatus::Succeeded);
    assert_eq!(record.worktree_branch.as_deref(), Some(branch.as_str()));

    let effects = workflow.apply(Input::WorktreeRemoved {
        task_id: id("a"),
        error: None,
    });
    assert_eq!(workflow.task(&id("a")).unwrap().worktree_path, None);
    assert_eq!(
        workflow.task(&id("a")).unwrap().worktree_branch.as_deref(),
        Some(branch.as_str())
    );
    assert!(has_persist(&effects));
}

#[test]
fn canceled_merge_agent_still_verifies_the_branch() {
    let mut workflow = boot(worktree_config(2));
    awaiting_merge(&mut workflow, "a", "bug-a");
    begin_merge(&mut workflow, "a");
    let effects = workflow.apply(Input::MergeAgentFinished {
        task_id: id("a"),
        outcome: RunOutcome::canceled(),
        now: now(40),
    });
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, tapd_workflow::Effect::VerifyBranchMerged { .. })));
    workflow.apply(Input::BranchMergeVerified {
        task_id: id("a"),
        merged: false,
        error: None,
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingMerge);
}

#[test]
fn merge_agent_failure_rolls_back_to_awaiting_merge_with_manual_steps() {
    let mut workflow = boot(worktree_config(2));
    awaiting_merge(&mut workflow, "a", "bug-a");
    begin_merge(&mut workflow, "a");
    workflow.apply(Input::MergeAgentFinished {
        task_id: id("a"),
        outcome: RunOutcome::failure("merge conflict", None),
        now: now(40),
    });
    let effects = workflow.apply(Input::BranchMergeVerified {
        task_id: id("a"),
        merged: false,
        error: None,
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingMerge);
    let merge = workflow.task(&id("a")).unwrap().merge.as_ref().unwrap();
    assert_eq!(merge.error.as_deref(), Some("merge conflict"));
    assert!(merge.instructions.as_ref().unwrap().contains("git merge"));
    assert!(history_records(&effects).is_empty());
    assert_eq!(
        workflow.task(&id("a")).unwrap().worktree_branch.as_deref(),
        Some("tapd/a")
    );
}

#[test]
fn manual_verify_merge_succeeds_without_a_merge_agent() {
    let mut workflow = boot(worktree_config(2));
    awaiting_merge(&mut workflow, "a", "bug-a");
    let effects = workflow.apply(Input::VerifyMerge {
        task_id: id("a"),
        now: now(30),
    });
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, tapd_workflow::Effect::VerifyBranchMerged { .. })));
    let effects = workflow.apply(Input::BranchMergeVerified {
        task_id: id("a"),
        merged: true,
        error: None,
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::Succeeded);
    assert_eq!(history_records(&effects).len(), 1);
}

#[test]
fn manual_verify_merge_failure_stays_awaiting_merge() {
    let mut workflow = boot(worktree_config(2));
    awaiting_merge(&mut workflow, "a", "bug-a");
    workflow.apply(Input::VerifyMerge {
        task_id: id("a"),
        now: now(30),
    });
    workflow.apply(Input::BranchMergeVerified {
        task_id: id("a"),
        merged: false,
        error: Some("not an ancestor".to_string()),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingMerge);
    assert_eq!(
        workflow
            .task(&id("a"))
            .unwrap()
            .merge
            .as_ref()
            .unwrap()
            .error
            .as_deref(),
        Some("not an ancestor")
    );
}

#[test]
fn dirty_main_repository_blocks_merge_and_keeps_manual_fallback() {
    let mut workflow = boot(worktree_config(2));
    awaiting_merge(&mut workflow, "a", "bug-a");
    workflow.apply(Input::StartMerge {
        task_id: id("a"),
        now: now(30),
    });
    let effects = workflow.apply(Input::MergePreconditionsChecked {
        task_id: id("a"),
        result: Err(MergeBlock::DirtyRepository { files: 2 }),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingMerge);
    let merge = workflow.task(&id("a")).unwrap().merge.as_ref().unwrap();
    assert!(merge.error.as_deref().unwrap().contains('2'));
    assert!(merge.instructions.is_some());
    assert!(!effects
        .iter()
        .any(|effect| matches!(effect, tapd_workflow::Effect::StartMergeAgent { .. })));
}

#[test]
fn unavailable_runtime_blocks_merge() {
    let mut workflow = boot(worktree_config(2));
    awaiting_merge(&mut workflow, "a", "bug-a");
    workflow.apply(Input::StartMerge {
        task_id: id("a"),
        now: now(30),
    });
    workflow.apply(Input::MergePreconditionsChecked {
        task_id: id("a"),
        result: Err(MergeBlock::RuntimeUnavailable {
            error: "runtime missing".to_string(),
        }),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingMerge);
    assert_eq!(
        workflow
            .task(&id("a"))
            .unwrap()
            .merge
            .as_ref()
            .unwrap()
            .error
            .as_deref(),
        Some("runtime missing")
    );
}

#[test]
fn same_repository_merge_is_serialized() {
    let mut workflow = boot(worktree_config(2));
    awaiting_merge(&mut workflow, "a", "bug-a");
    awaiting_merge(&mut workflow, "b", "bug-b");

    begin_merge(&mut workflow, "a");
    let effects = workflow.apply(Input::StartMerge {
        task_id: id("b"),
        now: now(31),
    });
    assert!(rejected(&effects).unwrap().contains("正在合并"));
    assert_eq!(status(&workflow, "b"), TaskStatus::AwaitingMerge);
}

#[test]
fn duplicate_start_merge_is_rejected_once_merging() {
    let mut workflow = boot(worktree_config(2));
    awaiting_merge(&mut workflow, "a", "bug-a");
    begin_merge(&mut workflow, "a");
    let effects = workflow.apply(Input::StartMerge {
        task_id: id("a"),
        now: now(31),
    });
    assert!(rejected(&effects).is_some());
}

#[test]
fn cancel_awaiting_merge_cancels_but_keeps_branch() {
    let mut workflow = boot(worktree_config(2));
    awaiting_merge(&mut workflow, "a", "bug-a");
    let effects = workflow.apply(Input::Cancel {
        task_id: id("a"),
        now: now(30),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::Canceled);
    assert_eq!(history_records(&effects).len(), 1);
    let task = workflow.task(&id("a")).unwrap();
    assert_eq!(task.worktree_branch.as_deref(), Some("tapd/a"));
    assert_eq!(task.worktree_path.as_deref(), Some("/wt/a"));
}

#[test]
fn cancel_merging_aborts_to_awaiting_merge_and_keeps_branch() {
    let mut workflow = boot(worktree_config(2));
    awaiting_merge(&mut workflow, "a", "bug-a");
    begin_merge(&mut workflow, "a");
    let effects = workflow.apply(Input::Cancel {
        task_id: id("a"),
        now: now(30),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingMerge);
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, tapd_workflow::Effect::CancelAgent { .. })));
    let task = workflow.task(&id("a")).unwrap();
    assert_eq!(
        task.merge.as_ref().unwrap().error.as_deref(),
        Some("合并已中止")
    );
    assert_eq!(task.worktree_branch.as_deref(), Some("tapd/a"));
    assert_eq!(task.worktree_path.as_deref(), Some("/wt/a"));
    assert!(history_records(&effects).is_empty());
}

#[test]
fn history_is_appended_exactly_once_per_terminal_transition() {
    let mut workflow = boot(worktree_config(2));
    awaiting_merge(&mut workflow, "a", "bug-a");
    begin_merge(&mut workflow, "a");
    workflow.apply(Input::MergeAgentFinished {
        task_id: id("a"),
        outcome: RunOutcome::success(None),
        now: now(40),
    });
    let effects = workflow.apply(Input::BranchMergeVerified {
        task_id: id("a"),
        merged: true,
        error: None,
    });
    assert_eq!(history_records(&effects).len(), 1);

    // Late or duplicate receipts must not append again.
    let duplicate = workflow.apply(Input::BranchMergeVerified {
        task_id: id("a"),
        merged: true,
        error: None,
    });
    assert!(history_records(&duplicate).is_empty());
    let late = finish_outcome(&mut workflow, "a", RunOutcome::failure("late", None));
    assert!(history_records(&late).is_empty());
    let cancel = workflow.apply(Input::Cancel {
        task_id: id("a"),
        now: now(50),
    });
    assert!(rejected(&cancel).is_some());
    assert!(history_records(&cancel).is_empty());
}
