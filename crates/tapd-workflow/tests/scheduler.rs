mod common;

use common::*;
use tapd_workflow::{effective_units, Effect, TaskStatus};

#[test]
fn worktree_two_units_start_two_tasks_and_queue_the_third() {
    let mut workflow = boot(worktree_config(2));
    let first = enqueue(&mut workflow, "a", "bug-a");
    assert_eq!(create_worktrees(&first).len(), 1);
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);

    let second = enqueue(&mut workflow, "b", "bug-b");
    assert_eq!(create_worktrees(&second).len(), 1);
    assert_eq!(status(&workflow, "b"), TaskStatus::Preparing);

    let third = enqueue(&mut workflow, "c", "bug-c");
    assert!(create_worktrees(&third).is_empty());
    assert_eq!(status(&workflow, "c"), TaskStatus::Queued);

    let counts = workflow.counts();
    assert_eq!(counts.active, 2);
    assert_eq!(counts.queued, 1);
}

#[test]
fn non_worktree_queue_is_serial_even_with_many_units() {
    let mut workflow = boot(serial_config());
    let first = enqueue(&mut workflow, "a", "bug-a");
    assert!(create_worktrees(&first).is_empty());
    assert!(start_fix_agent(&first).is_some());
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);

    let second = enqueue(&mut workflow, "b", "bug-b");
    assert!(start_fix_agent(&second).is_none());
    assert_eq!(status(&workflow, "b"), TaskStatus::Queued);

    agent_started(&mut workflow, "a");
    let finished = finish(&mut workflow, "a", false, true, &["src/a.rs"]);
    assert_eq!(status(&workflow, "a"), TaskStatus::Succeeded);
    assert!(start_fix_agent(&finished).is_some());
    assert_eq!(status(&workflow, "b"), TaskStatus::Preparing);
}

#[test]
fn worktree_review_does_not_block_other_units() {
    let mut workflow = boot(worktree_config(2));
    running_worktree_task(&mut workflow, "a", "bug-a");
    let review = finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingApproval);

    let next = enqueue(&mut workflow, "b", "bug-b");
    assert_eq!(create_worktrees(&next).len(), 1);
    assert_eq!(status(&workflow, "b"), TaskStatus::Preparing);
    assert!(!review.is_empty());
}

#[test]
fn non_worktree_review_blocks_the_single_queue() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingApproval);

    let blocked = enqueue(&mut workflow, "b", "bug-b");
    assert!(start_fix_agent(&blocked).is_none());
    assert_eq!(status(&workflow, "b"), TaskStatus::Queued);

    // Approving queues the reviewed task as commit-only; it is still the only
    // runnable task and resumes the queue.
    let approved = workflow.apply(tapd_workflow::Input::ApproveReview {
        task_id: id("a"),
        now: now(20),
    });
    assert!(matches!(
        approved
            .iter()
            .find(|effect| matches!(effect, Effect::StartFixAgent { .. })),
        Some(Effect::StartFixAgent { task_id, .. }) if task_id == &id("a")
    ));
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);
    assert_eq!(status(&workflow, "b"), TaskStatus::Queued);
}

#[test]
fn paused_queue_starts_nothing_until_resumed() {
    let (mut workflow, _) = boot_with(worktree_config(2), Vec::new(), true);
    let effects = enqueue(&mut workflow, "a", "bug-a");
    assert!(create_worktrees(&effects).is_empty());
    assert_eq!(status(&workflow, "a"), TaskStatus::Queued);

    let resumed = workflow.apply(tapd_workflow::Input::ResumeQueue { now: now(2) });
    assert_eq!(create_worktrees(&resumed).len(), 1);
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);
}

#[test]
fn preparing_occupies_a_slot_until_the_run_finishes() {
    let mut workflow = boot(worktree_config(1));
    enqueue(&mut workflow, "a", "bug-a");
    enqueue(&mut workflow, "b", "bug-b");
    assert_eq!(status(&workflow, "b"), TaskStatus::Queued);

    worktree_created(&mut workflow, "a");
    assert_eq!(status(&workflow, "b"), TaskStatus::Queued);

    agent_started(&mut workflow, "a");
    assert_eq!(status(&workflow, "a"), TaskStatus::Running);
    assert_eq!(status(&workflow, "b"), TaskStatus::Queued);

    finish(&mut workflow, "a", false, false, &[]);
    assert_eq!(status(&workflow, "b"), TaskStatus::Preparing);
}

#[test]
fn queue_is_fifo() {
    let mut workflow = boot(worktree_config(1));
    enqueue(&mut workflow, "a", "bug-a");
    enqueue(&mut workflow, "b", "bug-b");
    enqueue(&mut workflow, "c", "bug-c");

    finish(&mut workflow, "a", false, false, &[]);
    assert_eq!(status(&workflow, "a"), TaskStatus::Succeeded);
    assert_eq!(status(&workflow, "b"), TaskStatus::Preparing);
    assert_eq!(status(&workflow, "c"), TaskStatus::Queued);
}

#[test]
fn duplicate_bug_is_rejected_while_a_task_is_live() {
    let mut workflow = boot(worktree_config(2));
    enqueue(&mut workflow, "a", "same-bug");
    let effects = enqueue(&mut workflow, "b", "same-bug");
    assert!(rejected(&effects)
        .expect("rejection")
        .contains("已有未结束的任务"));
    assert!(workflow.task(&id("b")).is_none());
}

#[test]
fn effective_units_clamps_and_serializes_without_worktrees() {
    let mut config = serial_config();
    assert_eq!(effective_units(&config), 1);

    config.worktree_enabled = true;
    config.execution_units = 0;
    assert_eq!(effective_units(&config), 1);
    config.execution_units = 3;
    assert_eq!(effective_units(&config), 3);
    config.execution_units = 99;
    assert_eq!(effective_units(&config), 8);
}

#[test]
fn counts_track_active_review_merge_and_queue_states() {
    let tasks = vec![
        task_with_status("q", "b1", TaskStatus::Queued),
        task_with_status("p", "b2", TaskStatus::Preparing),
        task_with_status("r", "b3", TaskStatus::Running),
        task_with_status("m", "b4", TaskStatus::Merging),
        task_with_status("a", "b5", TaskStatus::AwaitingApproval),
        task_with_status("x", "b6", TaskStatus::AwaitingMerge),
        task_with_status("s", "b7", TaskStatus::Succeeded),
    ];
    let counts = tapd_workflow::task_counts(&tasks);
    assert_eq!(counts.queued, 1);
    assert_eq!(counts.active, 3);
    assert_eq!(counts.awaiting_approval, 1);
    assert_eq!(counts.awaiting_merge, 1);
    assert_eq!(counts.total(), 6);
}

#[test]
fn active_and_terminal_statuses_match_the_state_machine() {
    for status in [
        TaskStatus::Preparing,
        TaskStatus::Running,
        TaskStatus::Merging,
    ] {
        assert!(status.is_active(), "{status:?} occupies a slot");
        assert!(!status.is_terminal());
    }
    for status in [
        TaskStatus::Succeeded,
        TaskStatus::Failed,
        TaskStatus::Canceled,
    ] {
        assert!(status.is_terminal());
        assert!(!status.is_active());
    }
    for status in [
        TaskStatus::Queued,
        TaskStatus::AwaitingApproval,
        TaskStatus::AwaitingMerge,
    ] {
        assert!(!status.is_active());
        assert!(!status.is_terminal());
    }
}
