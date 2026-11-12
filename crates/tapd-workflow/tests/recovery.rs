mod common;

use common::*;
use tapd_workflow::{
    suspend, Effect, Input, RecoveryPolicy, RunOutcome, TaskMerge, TaskStatus, WorkflowConfig,
    RESTARTED_MERGE_ERROR,
};

fn paused_config() -> WorkflowConfig {
    let mut config = serial_config();
    config.recovery_policy = RecoveryPolicy::default();
    config
}

#[test]
fn queued_tasks_are_retained_and_counted() {
    let queued = task_with_status("q", "bug-q", TaskStatus::Queued);
    let (workflow, effects) = boot_with(paused_config(), vec![queued], true);
    assert_eq!(status(&workflow, "q"), TaskStatus::Queued);
    assert_eq!(workflow.recovery_report().unwrap().queued, 1);
    assert_eq!(workflow.recovery_report().unwrap().retried, 0);
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, Effect::EmitRecoveryReport { .. })));
}

#[test]
fn default_policy_restores_queued_tasks_and_continues() {
    let config = paused_config();
    assert!(config.recovery_policy.restore_queued);

    let mut queued = task_with_status("q", "bug-q", TaskStatus::Queued);
    queued.interrupted = true;
    let mut tasks = vec![queued];
    let outcome = tapd_workflow::recovery::recover(&mut tasks, &config, &now(30));

    // Kept as-is (interrupted is not a recovery decision) and not paused.
    assert_eq!(tasks[0].status, TaskStatus::Queued);
    assert!(tasks[0].interrupted);
    assert_eq!(outcome.queued, 1);
    assert!(!outcome.pause_queue);
}

#[test]
fn disabled_restore_keeps_queued_tasks_but_pauses_the_queue() {
    let mut config = paused_config();
    config.recovery_policy.restore_queued = false;

    let mut queued = task_with_status("q", "bug-q", TaskStatus::Queued);
    queued.finished_at = None;
    let mut running = task_with_status("r", "bug-r", TaskStatus::Running);
    running.attempt = 0;
    let mut tasks = vec![queued, running];
    let outcome = tapd_workflow::recovery::recover(&mut tasks, &config, &now(30));

    // Queued is untouched; other recovery rules still apply.
    assert_eq!(tasks[0].status, TaskStatus::Queued);
    assert!(!tasks[0].interrupted);
    assert_eq!(tasks[1].status, TaskStatus::Queued);
    assert!(tasks[1].interrupted);
    assert_eq!(tasks[1].attempt, 1);
    assert_eq!(outcome.queued, 1);
    assert_eq!(outcome.retried, 1);
    assert!(outcome.pause_queue);
}

#[test]
fn report_queue_paused_follows_the_outcome() {
    let queued = task_with_status("q", "bug-q", TaskStatus::Queued);
    let (mut workflow, _) = boot_with(paused_config(), vec![queued.clone()], false);
    assert!(!workflow.recovery_report().unwrap().queue_paused);
    assert!(!workflow.paused());
    // The default policy lets the queue continue: the task is scheduled at once.
    assert_eq!(status(&workflow, "q"), TaskStatus::Preparing);

    let mut config = paused_config();
    config.recovery_policy.restore_queued = false;
    let (mut paused, _) = boot_with(config, vec![queued], false);
    assert!(paused.recovery_report().unwrap().queue_paused);
    assert!(paused.paused());
    // Paused means no automatic continue; the task is kept, not dropped.
    assert_eq!(status(&paused, "q"), TaskStatus::Queued);

    // An explicit resume releases the queue.
    paused.apply(Input::ResumeQueue { now: now(40) });
    assert!(!paused.paused());
}

#[test]
fn running_task_is_requeued_with_attempt_and_interrupted_flag() {
    let mut running = task_with_status("r", "bug-r", TaskStatus::Running);
    running.started_at = Some(now(1));
    let (workflow, effects) = boot_with(paused_config(), vec![running], true);
    let task = workflow.task(&id("r")).unwrap();
    assert_eq!(task.status, TaskStatus::Queued);
    assert_eq!(task.attempt, 1);
    assert!(task.interrupted);
    assert_eq!(task.started_at, None);
    assert!(task.finished_at.is_none());
    assert_eq!(workflow.recovery_report().unwrap().retried, 1);
    assert!(!history_records(&effects)
        .iter()
        .any(|record| record.task_id == "r"));
    assert!(has_persist(&effects));
}

#[test]
fn preparing_task_recovers_like_running() {
    let preparing = task_with_status("p", "bug-p", TaskStatus::Preparing);
    let (workflow, _) = boot_with(paused_config(), vec![preparing], true);
    assert_eq!(status(&workflow, "p"), TaskStatus::Queued);
    assert_eq!(workflow.task(&id("p")).unwrap().attempt, 1);
}

#[test]
fn merging_task_returns_to_awaiting_merge() {
    let merging = worktree_task_with_status("m", "bug-m", TaskStatus::Merging);
    let (workflow, effects) = boot_with(worktree_config(1), vec![merging], true);
    let task = workflow.task(&id("m")).unwrap();
    assert_eq!(task.status, TaskStatus::AwaitingMerge);
    assert!(!task.interrupted);
    let merge = task.merge.as_ref().unwrap();
    assert_eq!(
        merge.error.as_deref(),
        Some(tapd_workflow::recovery::RESTARTED_MERGE_ERROR)
    );
    assert!(merge.instructions.is_some());
    assert_eq!(workflow.recovery_report().unwrap().awaiting_merge, 1);
    assert!(history_records(&effects).is_empty());
}

#[test]
fn reviews_and_merge_decisions_survive_restart() {
    let approval = worktree_task_with_status("a", "bug-a", TaskStatus::AwaitingApproval);
    let merge = worktree_task_with_status("m", "bug-m", TaskStatus::AwaitingMerge);
    let (workflow, _) = boot_with(worktree_config(2), vec![approval, merge], true);
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingApproval);
    assert_eq!(status(&workflow, "m"), TaskStatus::AwaitingMerge);
    let report = workflow.recovery_report().unwrap();
    assert_eq!(report.awaiting_approval, 1);
    assert_eq!(report.awaiting_merge, 1);
    assert_eq!(report.retried, 0);
}

#[test]
fn retry_limit_fails_the_task_and_writes_history() {
    let mut running = task_with_status("r", "bug-r", TaskStatus::Running);
    running.attempt = 3;
    let (workflow, effects) = boot_with(paused_config(), vec![running], true);
    let task = workflow.task(&id("r")).unwrap();
    assert_eq!(task.status, TaskStatus::Failed);
    assert_eq!(task.attempt, 4);
    assert!(task.interrupted);
    assert!(task
        .error
        .as_deref()
        .unwrap()
        .contains("自动重试次数已用尽"));
    assert_eq!(task.finished_at.as_deref(), Some(now(0).as_str()));
    assert_eq!(workflow.recovery_report().unwrap().failed, 1);
    assert_eq!(history_records(&effects).len(), 1);
}

#[test]
fn disabled_auto_retry_fails_interrupted_tasks() {
    let mut config = paused_config();
    config.recovery_policy.auto_retry_interrupted = false;
    let running = task_with_status("r", "bug-r", TaskStatus::Running);
    let (workflow, effects) = boot_with(config, vec![running], true);
    let task = workflow.task(&id("r")).unwrap();
    assert_eq!(task.status, TaskStatus::Failed);
    assert_eq!(task.attempt, 1);
    assert!(task.error.as_deref().unwrap().contains("已停止自动重试"));
    assert_eq!(workflow.recovery_report().unwrap().failed, 1);
    assert_eq!(history_records(&effects).len(), 1);
}

#[test]
fn recovery_report_has_stable_id_and_restored_at() {
    let (workflow, effects) = boot_with(paused_config(), Vec::new(), true);
    let report = workflow.recovery_report().expect("report");
    assert_eq!(report.id, 1);
    assert_eq!(report.restored_at, now(0));
    assert_eq!(report.queued, 0);
    assert_eq!(report.failed, 0);
    match effects
        .iter()
        .find(|effect| matches!(effect, Effect::EmitRecoveryReport { .. }))
    {
        Some(Effect::EmitRecoveryReport { report: emitted }) => assert_eq!(emitted, report),
        _ => panic!("report effect missing"),
    }
}

#[test]
fn suspend_requeues_running_and_keeps_queued_tasks() {
    let mut workflow = boot(worktree_config(1));
    running_worktree_task(&mut workflow, "a", "bug-a");
    enqueue(&mut workflow, "b", "bug-b");
    // b cannot start while the only execution unit is taken by a.
    assert_eq!(status(&workflow, "a"), TaskStatus::Running);
    assert_eq!(status(&workflow, "b"), TaskStatus::Queued);

    let effects = workflow.apply(Input::Suspend { now: now(30) });
    assert_eq!(status(&workflow, "a"), TaskStatus::Queued);
    assert!(workflow.task(&id("a")).unwrap().interrupted);
    assert_eq!(status(&workflow, "b"), TaskStatus::Queued);
    assert!(!workflow.task(&id("b")).unwrap().interrupted);
    assert!(effects.iter().any(|effect| matches!(
        effect,
        Effect::PersistChanged { tasks } if tasks.iter().any(|task| task.id == id("a"))
    )));
    assert!(!workflow.entered());
}

#[test]
fn suspend_aborts_merging_to_awaiting_merge() {
    let mut workflow = boot(worktree_config(2));
    running_worktree_task(&mut workflow, "a", "bug-a");
    finish(&mut workflow, "a", false, true, &["src/a.rs"]);
    workflow.apply(Input::ApproveReview {
        task_id: id("a"),
        now: now(20),
    });
    workflow.apply(Input::StartMerge {
        task_id: id("a"),
        now: now(30),
    });
    workflow.apply(Input::MergePreconditionsChecked {
        task_id: id("a"),
        result: Ok(()),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::Merging);

    let effects = workflow.apply(Input::Suspend { now: now(40) });
    let task = workflow.task(&id("a")).unwrap();
    assert_eq!(task.status, TaskStatus::AwaitingMerge);
    assert_eq!(
        task.merge.as_ref().unwrap().error.as_deref(),
        Some(tapd_workflow::recovery::RESTARTED_MERGE_ERROR)
    );
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, Effect::PersistChanged { .. })));
}

#[test]
fn enqueue_after_suspend_requires_entering_again() {
    let mut workflow = boot(serial_config());
    workflow.apply(Input::Suspend { now: now(5) });
    let effects = enqueue(&mut workflow, "a", "bug-a");
    assert_eq!(rejected(&effects).as_deref(), Some("system not entered"));
    let effects = workflow.apply(Input::SystemEntered { now: now(6) });
    assert!(matches!(effects.as_slice(), [Effect::LoadSnapshot]));
}

#[test]
fn suspend_persists_even_without_running_tasks() {
    let mut workflow = boot(serial_config());
    let effects = workflow.apply(Input::Suspend { now: now(5) });
    assert!(effects.iter().any(|effect| matches!(
        effect,
        Effect::PersistChanged { tasks } if tasks.is_empty()
    )));
}

#[test]
fn recovered_task_reenters_the_queue_and_starts() {
    let mut config = worktree_config(1);
    config.recovery_policy = RecoveryPolicy::default();
    let mut running = worktree_task_with_status("r", "bug-r", TaskStatus::Running);
    running.attempt = 0;
    let (workflow, effects) = boot_with(config, vec![running], false);
    // The task was requeued and scheduled immediately in the same apply.
    assert_eq!(status(&workflow, "r"), TaskStatus::Preparing);
    assert!(workflow.task(&id("r")).unwrap().interrupted);
    assert!(effects.iter().any(|effect| matches!(
        effect,
        Effect::StartFixAgent { task_id, cwd, .. } if task_id == &id("r") && cwd == "/wt/r"
    )));
}

#[test]
fn suspend_then_recover_uses_the_fresh_snapshot() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    agent_started(&mut workflow, "a");
    workflow.apply(Input::Suspend { now: now(5) });
    let mut snapshot = workflow.snapshot();
    snapshot.paused = true;
    assert!(snapshot
        .tasks
        .iter()
        .any(|task| task.id == id("a") && task.status == TaskStatus::Queued && task.interrupted));

    workflow.apply(Input::SystemEntered { now: now(6) });
    workflow.apply(Input::SnapshotLoaded { snapshot });
    assert_eq!(status(&workflow, "a"), TaskStatus::Queued);
    // Suspend already requeued the task; startup recovery keeps it as-is and
    // does not spend another retry.
    assert_eq!(workflow.task(&id("a")).unwrap().attempt, 0);
    assert!(workflow.task(&id("a")).unwrap().interrupted);
}

#[test]
fn terminal_tasks_are_not_recovered_or_histored_again() {
    let mut done = task_with_status("d", "bug-d", TaskStatus::Succeeded);
    done.finished_at = Some(now(2));
    let (workflow, effects) = boot_with(paused_config(), vec![done.clone()], true);
    assert_eq!(status(&workflow, "d"), TaskStatus::Succeeded);
    let report = workflow.recovery_report().unwrap();
    assert_eq!(report.queued, 0);
    assert_eq!(report.failed, 0);
    assert!(history_records(&effects).is_empty());
}

#[test]
fn run_outcome_after_recovery_does_not_rewrite_terminal_task() {
    let mut failed = task_with_status("f", "bug-f", TaskStatus::Failed);
    failed.error = Some("original".to_string());
    failed.finished_at = Some(now(2));
    let (mut workflow, _) = boot_with(paused_config(), vec![failed], true);
    let effects = workflow.apply(Input::RunFinished {
        task_id: id("f"),
        outcome: RunOutcome::success(None),
        now: now(40),
    });
    assert_eq!(status(&workflow, "f"), TaskStatus::Failed);
    assert_eq!(
        workflow.task(&id("f")).unwrap().error.as_deref(),
        Some("original")
    );
    assert!(history_records(&effects).is_empty());
}

#[test]
fn suspend_pure_function_keeps_queued_tasks() {
    let mut queued = task_with_status("q", "bug-q", TaskStatus::Queued);
    queued.started_at = Some(now(4));
    queued.finished_at = Some(now(5));
    let mut tasks = vec![queued];

    let changed = suspend(&mut tasks, &now(30));

    assert!(changed.is_empty());
    assert_eq!(tasks[0].status, TaskStatus::Queued);
    assert!(!tasks[0].interrupted);
    assert_eq!(tasks[0].started_at.as_deref(), Some(now(4).as_str()));
    assert_eq!(tasks[0].finished_at.as_deref(), Some(now(5).as_str()));
}

#[test]
fn suspend_pure_function_requeues_preparing_and_running_without_spending_attempt() {
    let mut preparing = task_with_status("p", "bug-p", TaskStatus::Preparing);
    preparing.attempt = 2;
    preparing.started_at = Some(now(2));
    preparing.exit_code = Some(1);
    preparing.error = Some("boom".to_string());
    let mut running = task_with_status("r", "bug-r", TaskStatus::Running);
    running.attempt = 1;
    running.started_at = Some(now(3));
    let mut tasks = vec![preparing, running];

    let changed = suspend(&mut tasks, &now(30));

    assert_eq!(changed, vec![0, 1]);
    for task in &tasks {
        assert_eq!(task.status, TaskStatus::Queued);
        assert!(task.interrupted);
        assert_eq!(task.started_at, None);
        assert_eq!(task.finished_at, None);
        assert_eq!(task.exit_code, None);
        assert_eq!(task.error, None);
    }
    assert_eq!(tasks[0].attempt, 2);
    assert_eq!(tasks[1].attempt, 1);
}

#[test]
fn suspend_pure_function_aborts_merging_to_manual_merge() {
    let mut merging = worktree_task_with_status("m", "bug-m", TaskStatus::Merging);
    merging.started_at = Some(now(10));
    merging.finished_at = Some(now(11));
    merging.exit_code = Some(0);
    merging.error = Some("old".to_string());
    merging.merge = Some(TaskMerge {
        error: Some("old merge error".to_string()),
        instructions: Some("old instructions".to_string()),
        started_at: Some(now(12)),
        finished_at: Some(now(13)),
    });
    let mut tasks = vec![merging];

    let changed = suspend(&mut tasks, &now(30));

    assert_eq!(changed, vec![0]);
    let task = &tasks[0];
    assert_eq!(task.status, TaskStatus::AwaitingMerge);
    assert!(!task.interrupted);
    assert_eq!(task.started_at, None);
    assert_eq!(task.finished_at, None);
    assert_eq!(task.exit_code, None);
    assert_eq!(task.error, None);
    let merge = task.merge.as_ref().expect("merge state");
    assert_eq!(merge.error.as_deref(), Some(RESTARTED_MERGE_ERROR));
    assert_eq!(merge.started_at, None);
    assert_eq!(merge.finished_at, None);
    let instructions = merge.instructions.as_deref().expect("manual steps");
    assert!(instructions.contains("git merge \"tapd/m\""));
    assert!(instructions.contains("/repo"));
}

#[test]
fn suspend_pure_function_creates_merge_state_when_absent() {
    let mut merging = worktree_task_with_status("m", "bug-m", TaskStatus::Merging);
    merging.merge = None;
    let mut tasks = vec![merging];

    suspend(&mut tasks, &now(30));

    let merge = tasks[0].merge.as_ref().expect("merge state created");
    assert_eq!(merge.error.as_deref(), Some(RESTARTED_MERGE_ERROR));
    assert!(merge.instructions.is_some());
}

#[test]
fn suspend_pure_function_leaves_resting_and_terminal_tasks_untouched() {
    let mut approval = worktree_task_with_status("a", "bug-a", TaskStatus::AwaitingApproval);
    approval.started_at = Some(now(4));
    let mut awaiting = worktree_task_with_status("w", "bug-w", TaskStatus::AwaitingMerge);
    awaiting.merge = Some(TaskMerge {
        error: None,
        instructions: Some("keep".to_string()),
        started_at: Some(now(5)),
        finished_at: None,
    });
    let succeeded = task_with_status("s", "bug-s", TaskStatus::Succeeded);
    let failed = task_with_status("f", "bug-f", TaskStatus::Failed);
    let canceled = task_with_status("c", "bug-c", TaskStatus::Canceled);
    let mut tasks = vec![approval, awaiting, succeeded, failed, canceled];

    let changed = suspend(&mut tasks, &now(30));

    assert!(changed.is_empty());
    assert_eq!(tasks[0].status, TaskStatus::AwaitingApproval);
    assert_eq!(tasks[0].started_at.as_deref(), Some(now(4).as_str()));
    assert_eq!(tasks[1].status, TaskStatus::AwaitingMerge);
    assert_eq!(
        tasks[1].merge.as_ref().unwrap().instructions.as_deref(),
        Some("keep")
    );
    assert_eq!(
        tasks[1].merge.as_ref().unwrap().started_at.as_deref(),
        Some(now(5).as_str())
    );
    assert_eq!(tasks[2].status, TaskStatus::Succeeded);
    assert_eq!(tasks[3].status, TaskStatus::Failed);
    assert_eq!(tasks[4].status, TaskStatus::Canceled);
}

#[test]
fn suspend_pure_function_returns_only_modified_indexes() {
    let mut tasks = vec![
        task_with_status("q", "bug-q", TaskStatus::Queued),
        task_with_status("r", "bug-r", TaskStatus::Running),
        task_with_status("a", "bug-a", TaskStatus::AwaitingApproval),
        worktree_task_with_status("m", "bug-m", TaskStatus::Merging),
        task_with_status("s", "bug-s", TaskStatus::Succeeded),
        task_with_status("p", "bug-p", TaskStatus::Preparing),
    ];

    let changed = suspend(&mut tasks, &now(30));

    assert_eq!(changed, vec![1, 3, 5]);
    assert_eq!(tasks[0].status, TaskStatus::Queued);
    assert_eq!(tasks[1].status, TaskStatus::Queued);
    assert_eq!(tasks[2].status, TaskStatus::AwaitingApproval);
    assert_eq!(tasks[3].status, TaskStatus::AwaitingMerge);
    assert_eq!(tasks[4].status, TaskStatus::Succeeded);
    assert_eq!(tasks[5].status, TaskStatus::Queued);
}
