mod common;

use common::*;
use tapd_workflow::{worktree_toggle_locked, Effect, Input, TaskStatus};

#[test]
fn switching_worktree_is_locked_while_any_task_is_live() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    assert!(matches!(
        status(&workflow, "a"),
        TaskStatus::Preparing | TaskStatus::Running
    ));

    let effects = workflow.apply(Input::SetConfig {
        config: worktree_config(2),
    });
    assert!(rejected(&effects).unwrap().contains("无法切换 Worktree"));
    assert!(!workflow.config().worktree_enabled);
}

#[test]
fn switching_worktree_is_locked_by_reviews_and_merges_too() {
    let approval = worktree_task_with_status("a", "bug-a", TaskStatus::AwaitingApproval);
    let (mut workflow, _) = boot_with(worktree_config(1), vec![approval], true);
    let effects = workflow.apply(Input::SetConfig {
        config: serial_config(),
    });
    assert!(rejected(&effects).is_some());
    assert!(workflow.config().worktree_enabled);
}

#[test]
fn execution_units_can_change_while_tasks_run() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    let mut next = workflow.config().clone();
    next.execution_units = 8;
    let effects = workflow.apply(Input::SetConfig { config: next });
    assert!(rejected(&effects).is_none());
    assert_eq!(workflow.config().execution_units, 8);
    assert_eq!(workflow.config().effective_units(), 1);
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, Effect::PersistConfig { .. })));
}

#[test]
fn worktree_can_be_switched_when_every_task_is_terminal() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", false, true, &["src/a.rs"]);
    assert_eq!(status(&workflow, "a"), TaskStatus::Succeeded);

    let effects = workflow.apply(Input::SetConfig {
        config: worktree_config(1),
    });
    assert!(rejected(&effects).is_none());
    assert!(workflow.config().worktree_enabled);
}

#[test]
fn setting_the_same_worktree_value_is_never_locked() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    let effects = workflow.apply(Input::SetConfig {
        config: serial_config(),
    });
    assert!(rejected(&effects).is_none());
}

#[test]
fn toggle_lock_is_pure_and_only_applies_to_real_switches() {
    assert!(!worktree_toggle_locked(false, false, true));
    assert!(!worktree_toggle_locked(true, true, true));
    assert!(!worktree_toggle_locked(false, true, false));
    assert!(worktree_toggle_locked(false, true, true));
    assert!(worktree_toggle_locked(true, false, true));
}

#[test]
fn manual_merge_and_merge_prompts_name_repo_and_branch() {
    let manual = tapd_workflow::manual_merge_instructions("/repo", "tapd/a");
    assert!(manual.contains("/repo"));
    assert!(manual.contains("tapd/a"));
    assert!(manual.contains("我已手动合并"));

    let prompt = tapd_workflow::merge_prompt("/repo", "tapd/a");
    assert!(prompt.contains("/repo"));
    assert!(prompt.contains("tapd/a"));
    assert!(prompt.contains("git merge"));
}

#[test]
fn snapshot_exposes_the_toggle_lock() {
    let mut workflow = boot(serial_config());
    assert!(!workflow.worktree_toggle_locked(true));
    enqueue(&mut workflow, "a", "bug-a");
    assert!(workflow.worktree_toggle_locked(true));
    assert!(!workflow.worktree_toggle_locked(false));
}

#[test]
fn schedule_uses_new_units_after_config_change() {
    let (mut workflow, _) = boot_with(serial_config(), Vec::new(), true);
    enqueue(&mut workflow, "a", "bug-a");
    enqueue(&mut workflow, "b", "bug-b");
    assert_eq!(status(&workflow, "a"), TaskStatus::Queued);

    workflow.apply(Input::ResumeQueue { now: now(2) });
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);
    assert_eq!(status(&workflow, "b"), TaskStatus::Queued);

    let mut next = workflow.config().clone();
    next.execution_units = 8;
    workflow.apply(Input::SetConfig { config: next });
    // Without worktrees the effective width stays 1.
    assert_eq!(status(&workflow, "b"), TaskStatus::Queued);
}
