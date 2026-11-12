mod common;

use common::*;
use tapd_workflow::{Effect, Input, TaskStatus, TerminalStatus};

fn persist_paused(effects: &[Effect]) -> Option<bool> {
    effects.iter().find_map(|effect| match effect {
        Effect::PersistPaused { paused } => Some(*paused),
        _ => None,
    })
}

fn persist_deleted(effects: &[Effect]) -> Option<&str> {
    effects.iter().find_map(|effect| match effect {
        Effect::PersistDeleted { task_id } => Some(task_id.as_str()),
        _ => None,
    })
}

fn prepared_input(task_id: &str) -> Input {
    Input::TaskPrepared {
        task_id: id(task_id),
        prompt: "修复 {{title}}".to_string(),
        json_path: format!("/tmp/{task_id}.json"),
        baseline_dirty: vec!["src/old.rs".to_string()],
        baseline_head: Some("abc123".to_string()),
    }
}

fn awaiting_review(workflow: &mut tapd_workflow::Workflow, task_id: &str, bug: &str) {
    enqueue(workflow, task_id, bug);
    agent_started(workflow, task_id);
    finish(workflow, task_id, true, false, &["src/fix.rs"]);
    assert_eq!(status(workflow, task_id), TaskStatus::AwaitingApproval);
}

#[test]
fn task_prepared_records_facts_on_a_preparing_task() {
    let mut workflow = boot(worktree_config(1));
    let effects = enqueue(&mut workflow, "a", "bug-a");
    assert_eq!(create_worktrees(&effects).len(), 1);
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);

    let effects = workflow.apply(prepared_input("a"));
    let task = workflow.task(&id("a")).unwrap();
    assert_eq!(task.prompt, "修复 {{title}}");
    assert_eq!(task.json_path, "/tmp/a.json");
    assert_eq!(task.baseline_dirty, vec!["src/old.rs".to_string()]);
    assert_eq!(task.baseline_head.as_deref(), Some("abc123"));
    assert_eq!(task.status, TaskStatus::Preparing);
    assert!(
        start_fix_agent(&effects).is_none(),
        "TaskPrepared must not start the run; the scheduler already did"
    );
    assert!(history_records(&effects).is_empty());
    let persisted = persisted_tasks(&effects);
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].id, id("a"));
    assert_eq!(persisted[0].baseline_head.as_deref(), Some("abc123"));
}

#[test]
fn task_prepared_is_rejected_outside_preparing() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    agent_started(&mut workflow, "a");
    assert_eq!(status(&workflow, "a"), TaskStatus::Running);

    let effects = workflow.apply(prepared_input("a"));
    assert!(rejected(&effects).is_some());
    assert!(workflow.task(&id("a")).unwrap().prompt.is_empty());

    let effects = workflow.apply(prepared_input("missing"));
    assert_eq!(rejected(&effects).as_deref(), Some("任务不存在"));
}

#[test]
fn session_observed_updates_a_live_task_and_persists() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    let effects = workflow.apply(Input::SessionObserved {
        task_id: id("a"),
        session_id: "session-1".to_string(),
    });
    assert_eq!(
        workflow.task(&id("a")).unwrap().agent_session_id.as_deref(),
        Some("session-1")
    );
    assert!(has_persist(&effects));
    let persisted = persisted_tasks(&effects);
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].agent_session_id.as_deref(), Some("session-1"));
}

#[test]
fn session_observed_ignores_terminal_and_unknown_tasks() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", false, false, &[]);
    assert_eq!(status(&workflow, "a"), TaskStatus::Succeeded);

    // Chosen semantics: late observations are silently dropped, matching the
    // other late host facts (AgentStarted, RunFinished, receipts).
    let effects = workflow.apply(Input::SessionObserved {
        task_id: id("a"),
        session_id: "late".to_string(),
    });
    assert!(effects.is_empty());
    assert_eq!(
        workflow.task(&id("a")).unwrap().agent_session_id,
        None,
        "terminal task must not be rewritten"
    );

    let effects = workflow.apply(Input::SessionObserved {
        task_id: id("missing"),
        session_id: "orphan".to_string(),
    });
    assert!(effects.is_empty());
}

#[test]
fn stop_review_records_stash_error_and_pauses() {
    let mut workflow = boot(serial_config());
    awaiting_review(&mut workflow, "a", "bug-a");

    let effects = workflow.apply(Input::StopReview {
        task_id: id("a"),
        now: now(20),
        stash: Some("stash@{0}".to_string()),
        error: Some("用户停止审核".to_string()),
    });

    let task = workflow.task(&id("a")).unwrap();
    assert_eq!(task.status, TaskStatus::Canceled);
    assert_eq!(task.error.as_deref(), Some("用户停止审核"));
    assert_eq!(task.finished_at.as_deref(), Some(now(20).as_str()));
    assert_eq!(
        task.approval.as_ref().unwrap().stash.as_deref(),
        Some("stash@{0}")
    );
    assert!(workflow.paused());
    assert_eq!(persist_paused(&effects), Some(true));
    assert!(has_persist(&effects));
    assert_eq!(history_records(&effects).len(), 1);
    assert_eq!(
        history_records(&effects)[0].status,
        TerminalStatus::Canceled
    );

    // Late or duplicate stops are rejected and never append history twice.
    let duplicate = workflow.apply(Input::StopReview {
        task_id: id("a"),
        now: now(21),
        stash: None,
        error: None,
    });
    assert!(rejected(&duplicate).is_some());
    assert!(history_records(&duplicate).is_empty());
}

#[test]
fn stop_review_defaults_error_and_honours_it_only_when_awaiting_approval() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "b", "bug-b");
    let effects = workflow.apply(Input::StopReview {
        task_id: id("b"),
        now: now(20),
        stash: None,
        error: None,
    });
    assert_eq!(rejected(&effects).as_deref(), Some("任务不在待审核状态"));
    assert_eq!(status(&workflow, "b"), TaskStatus::Preparing);

    let mut workflow = boot(serial_config());
    awaiting_review(&mut workflow, "a", "bug-a");
    let effects = workflow.apply(Input::StopReview {
        task_id: id("a"),
        now: now(21),
        stash: None,
        error: None,
    });
    let task = workflow.task(&id("a")).unwrap();
    assert_eq!(task.status, TaskStatus::Canceled);
    assert_eq!(task.error.as_deref(), Some("已停止审核，改动保留在工作区"));
    assert!(task.approval.as_ref().unwrap().stash.is_none());
    assert_eq!(persist_paused(&effects), Some(true));
    assert_eq!(history_records(&effects).len(), 1);
}

#[test]
fn cancel_review_uses_the_same_terminal_path_once() {
    let mut workflow = boot(serial_config());
    awaiting_review(&mut workflow, "a", "bug-a");

    let effects = workflow.apply(Input::Cancel {
        task_id: id("a"),
        now: now(20),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::Canceled);
    assert!(workflow.paused());
    assert_eq!(persist_paused(&effects), Some(true));
    assert_eq!(history_records(&effects).len(), 1);
    assert!(workflow.task(&id("a")).unwrap().approval.is_some());

    let duplicate = workflow.apply(Input::Cancel {
        task_id: id("a"),
        now: now(21),
    });
    assert!(rejected(&duplicate).is_some());
    assert!(history_records(&duplicate).is_empty());
}

#[test]
fn delete_terminal_emits_persist_deleted() {
    let mut workflow = boot(serial_config());
    enqueue(&mut workflow, "a", "bug-a");
    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", false, false, &[]);
    assert_eq!(status(&workflow, "a"), TaskStatus::Succeeded);

    let effects = workflow.apply(Input::DeleteTerminal { task_id: id("a") });
    assert_eq!(persist_deleted(&effects), Some("a"));
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, Effect::StateChanged)));
    assert!(workflow.task(&id("a")).is_none());
    // Deleting is not a history transition.
    assert!(history_records(&effects).is_empty());

    // Live tasks cannot be deleted.
    enqueue(&mut workflow, "b", "bug-b");
    let effects = workflow.apply(Input::DeleteTerminal { task_id: id("b") });
    assert!(rejected(&effects).is_some());
    assert_eq!(persist_deleted(&effects), None);
}

#[test]
fn resume_queue_reports_the_new_pause_flag() {
    let (mut workflow, _) = boot_with(serial_config(), Vec::new(), true);
    assert!(workflow.paused());

    let effects = workflow.apply(Input::ResumeQueue { now: now(2) });
    assert_eq!(persist_paused(&effects), Some(false));
    assert!(!workflow.paused());
}

#[test]
fn suspend_reports_the_pause_flag_for_shutdown() {
    let mut workflow = boot(serial_config());
    let effects = workflow.apply(Input::Suspend { now: now(5) });
    assert_eq!(persist_paused(&effects), Some(false));
    assert!(!workflow.paused());
}

#[test]
fn active_task_id_priority_matches_the_host_console() {
    // AwaitingApproval outranks AwaitingMerge, which outranks Queued.
    let mut done = task_with_status("done", "b1", TaskStatus::Succeeded);
    done.finished_at = Some(now(3));
    let tasks = vec![
        done,
        task_with_status("queued", "b2", TaskStatus::Queued),
        task_with_status("merge", "b3", TaskStatus::AwaitingMerge),
        task_with_status("waiting", "b4", TaskStatus::AwaitingApproval),
    ];
    let (workflow, _) = boot_with(serial_config(), tasks, true);
    assert_eq!(
        workflow.active_task_id().map(|task_id| task_id.as_str()),
        Some("waiting")
    );

    let tasks = vec![
        task_with_status("queued", "b1", TaskStatus::Queued),
        task_with_status("merge", "b2", TaskStatus::AwaitingMerge),
    ];
    let (workflow, _) = boot_with(serial_config(), tasks, true);
    assert_eq!(
        workflow.active_task_id().map(|task_id| task_id.as_str()),
        Some("merge")
    );

    // An active (running/preparing) task wins over every decision state and
    // the queue. Worktrees are used so a pending review does not block the
    // serial queue.
    let tasks = vec![
        task_with_status("queued", "b1", TaskStatus::Queued),
        task_with_status("waiting", "b2", TaskStatus::AwaitingApproval),
    ];
    let (mut workflow, _) = boot_with(worktree_config(1), tasks, true);
    workflow.apply(Input::ResumeQueue { now: now(2) });
    assert_eq!(status(&workflow, "queued"), TaskStatus::Preparing);
    assert_eq!(
        workflow.active_task_id().map(|task_id| task_id.as_str()),
        Some("queued")
    );

    // Terminal fallback is the most recently inserted task.
    let tasks = vec![
        task_with_status("old", "b1", TaskStatus::Failed),
        task_with_status("new", "b2", TaskStatus::Succeeded),
    ];
    let (workflow, _) = boot_with(serial_config(), tasks, true);
    assert_eq!(
        workflow.active_task_id().map(|task_id| task_id.as_str()),
        Some("new")
    );
    assert!(tapd_workflow::Workflow::new().active_task_id().is_none());
}

#[test]
fn history_returns_terminal_tasks_newest_first() {
    let mut older = task_with_status("older", "b1", TaskStatus::Succeeded);
    older.created_at = now(1);
    older.finished_at = Some(now(5));
    let mut newer = task_with_status("newer", "b2", TaskStatus::Failed);
    newer.created_at = now(2);
    newer.finished_at = Some(now(9));
    let tasks = vec![
        older,
        newer,
        task_with_status("queued", "b3", TaskStatus::Queued),
        task_with_status("waiting", "b4", TaskStatus::AwaitingApproval),
    ];
    let (workflow, _) = boot_with(serial_config(), tasks, true);

    let history = workflow.history();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].id, id("newer"));
    assert_eq!(history[1].id, id("older"));
}

#[test]
fn history_falls_back_to_created_at_then_insertion_order() {
    let mut first = task_with_status("first", "b1", TaskStatus::Succeeded);
    first.created_at = now(1);
    let mut second = task_with_status("second", "b2", TaskStatus::Canceled);
    second.created_at = now(2);
    let mut tied_older = task_with_status("tied-older", "b3", TaskStatus::Failed);
    tied_older.created_at = now(3);
    let mut tied_newer = task_with_status("tied-newer", "b4", TaskStatus::Failed);
    tied_newer.created_at = now(3);

    let tasks = vec![first, second, tied_older, tied_newer];
    let (workflow, _) = boot_with(serial_config(), tasks, true);

    let history = workflow.history();
    let ids: Vec<&str> = history.iter().map(|task| task.id.as_str()).collect();
    assert_eq!(ids, vec!["tied-newer", "tied-older", "second", "first"]);
}
