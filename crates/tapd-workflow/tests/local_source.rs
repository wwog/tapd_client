//! Local work items ride the same queue, review and merge state machine as
//! TAPD bugs. These tests pin the isolation: no TAPD prompts, no write-back
//! instructions, and no cross-source admission.

mod common;

use common::*;
use tapd_workflow::{
    Effect, Input, RunOutcome, Task, TaskSource, TaskSpec, TaskStatus, TerminalStatus, Workflow,
};

fn enqueue_local(workflow: &mut Workflow, task_id: &str, item: &str) -> Vec<Effect> {
    workflow.apply(Input::Enqueue {
        task_id: id(task_id),
        spec: local_spec(item),
        now: now(1),
    })
}

fn worktree_created_local(workflow: &mut Workflow, task_id: &str) -> Vec<Effect> {
    workflow.apply(Input::WorktreeCreated {
        task_id: id(task_id),
        worktree: tapd_workflow::WorktreeRef {
            path: format!("/wt/{task_id}"),
            branch: format!("local/{task_id}"),
        },
    })
}

fn local_awaiting_merge_task(task_id: &str, item: &str) -> Task {
    let mut task = Task::new(id(task_id), local_spec(item), now(0));
    task.status = TaskStatus::AwaitingMerge;
    task.worktree_path = Some(format!("/wt/{task_id}"));
    task.worktree_branch = Some(format!("local/{task_id}"));
    task
}

#[test]
fn local_worktree_task_runs_the_full_lifecycle() {
    let mut workflow = boot(worktree_config(2));
    let effects = enqueue_local(&mut workflow, "a", "wi-1");
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);
    assert_eq!(create_worktrees(&effects).len(), 1);

    worktree_created_local(&mut workflow, "a");
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);
    assert_eq!(
        workflow.task(&id("a")).unwrap().worktree_branch.as_deref(),
        Some("local/a")
    );

    agent_started(&mut workflow, "a");
    assert_eq!(status(&workflow, "a"), TaskStatus::Running);

    finish(&mut workflow, "a", true, false, &["src/a.rs"]);
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingApproval);

    // A dirty reviewed change first runs a commit-only round on the same
    // worktree; no second worktree is created.
    let effects = workflow.apply(Input::ApproveReview {
        task_id: id("a"),
        now: now(20),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);
    assert!(workflow.task(&id("a")).unwrap().commit_only);
    assert!(create_worktrees(&effects).is_empty());

    agent_started(&mut workflow, "a");
    finish(&mut workflow, "a", false, false, &[]);
    assert_eq!(status(&workflow, "a"), TaskStatus::AwaitingMerge);
    let instructions = workflow
        .task(&id("a"))
        .unwrap()
        .merge
        .as_ref()
        .unwrap()
        .instructions
        .clone()
        .expect("manual merge steps");
    assert!(instructions.contains("local/a"), "{instructions}");
    assert!(!instructions.contains("TAPD"), "{instructions}");
    assert!(!instructions.contains("tapd_"), "{instructions}");

    let effects = workflow.apply(Input::StartMerge {
        task_id: id("a"),
        now: now(30),
    });
    assert!(check_merge(&effects).is_some());
    let effects = workflow.apply(Input::MergePreconditionsChecked {
        task_id: id("a"),
        result: Ok(()),
    });
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, Effect::StartMergeAgent { .. })));
    assert_eq!(status(&workflow, "a"), TaskStatus::Merging);

    workflow.apply(Input::MergeAgentFinished {
        task_id: id("a"),
        outcome: RunOutcome::success(None),
        now: now(40),
    });
    let effects = workflow.apply(Input::BranchMergeVerified {
        task_id: id("a"),
        merged: true,
        error: None,
        commit: Some("mergeq1".to_string()),
    });
    assert_eq!(status(&workflow, "a"), TaskStatus::Succeeded);
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, Effect::RemoveWorktree { .. })));
    let records = history_records(&effects);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].status, TerminalStatus::Succeeded);
    assert_eq!(records[0].source_kind, TaskSource::LocalWorkItem);
}

#[test]
fn local_serial_task_reviews_and_commits_without_a_worktree() {
    let mut workflow = boot(serial_config());
    let effects = enqueue_local(&mut workflow, "a", "wi-2");
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);
    assert!(create_worktrees(&effects).is_empty());
    assert!(start_fix_agent(&effects).is_some());

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
    let effects = finish(&mut workflow, "a", false, false, &[]);
    assert_eq!(status(&workflow, "a"), TaskStatus::Succeeded);
    assert!(history_records(&effects).len() == 1);
    assert!(workflow.task(&id("a")).unwrap().merge.is_none());
}

#[test]
fn local_merge_texts_never_reference_the_bug_tracker() {
    let branch = "local/wi1-task0001";
    let prompt = tapd_workflow::merge_prompt("/repo", branch, TaskSource::LocalWorkItem);
    let steps =
        tapd_workflow::manual_merge_instructions("/repo", branch, TaskSource::LocalWorkItem);
    for text in [&prompt, &steps] {
        assert!(text.contains("/repo"), "{text}");
        assert!(text.contains(branch), "{text}");
        assert!(!text.contains("TAPD"), "{text}");
        assert!(!text.contains("tapd_"), "{text}");
        assert!(
            !text.contains("{{"),
            "every placeholder is replaced: {text}"
        );
    }
    assert!(steps.contains("我已手动合并"), "{steps}");
}

#[test]
fn tapd_merge_texts_are_unchanged() {
    let branch = "tapd/01234567-abcdef01";
    let prompt = tapd_workflow::merge_prompt("/repo", branch, TaskSource::TapdBug);
    let steps = tapd_workflow::manual_merge_instructions("/repo", branch, TaskSource::TapdBug);
    assert!(prompt.contains("tapd_add_bug_comment"), "{prompt}");
    assert!(prompt.contains("tapd_update_bug_status"), "{prompt}");
    assert!(prompt.contains("TAPD 回写"), "{prompt}");
    assert!(steps.contains("TAPD"), "{steps}");
    assert!(steps.contains("我已手动合并"), "{steps}");
}

#[test]
fn local_items_dedupe_on_the_project_and_item_pair() {
    let mut workflow = boot(serial_config());
    enqueue_local(&mut workflow, "a", "wi-1");
    assert_eq!(status(&workflow, "a"), TaskStatus::Preparing);

    let effects = workflow.apply(Input::Enqueue {
        task_id: id("b"),
        spec: local_spec("wi-1"),
        now: now(2),
    });
    assert!(
        rejected(&effects).unwrap().contains("未结束"),
        "{effects:?}"
    );
    assert_eq!(workflow.tasks().len(), 1);

    // The same item id in another local project is a different pair.
    let mut other_project = local_spec("wi-1");
    other_project.workspace_id = "another-local-project".to_string();
    let effects = workflow.apply(Input::Enqueue {
        task_id: id("c"),
        spec: other_project,
        now: now(3),
    });
    assert!(rejected(&effects).is_none());
    assert_eq!(workflow.tasks().len(), 2);
}

#[test]
fn recovery_restores_a_local_merge_without_tracker_steps() {
    let mut task = local_awaiting_merge_task("a", "wi-1");
    task.status = TaskStatus::Merging;
    let (workflow, _) = boot_with(worktree_config(1), vec![task], false);

    let task = workflow.task(&id("a")).expect("task restored");
    assert_eq!(task.status, TaskStatus::AwaitingMerge);
    let merge = task.merge.as_ref().expect("merge state");
    assert_eq!(merge.error.as_deref(), Some("客户端重启，合并已中止"));
    let instructions = merge.instructions.as_deref().expect("manual steps");
    assert!(instructions.contains("local/a"), "{instructions}");
    assert!(!instructions.contains("TAPD"), "{instructions}");
    assert!(!instructions.contains("tapd_"), "{instructions}");
}

#[test]
fn suspend_parks_a_local_merge_with_local_steps() {
    let task = local_awaiting_merge_task("a", "wi-1");
    let (mut workflow, _) = boot_with(worktree_config(1), vec![task], false);

    workflow.apply(Input::StartMerge {
        task_id: id("a"),
        now: now(30),
    });
    let effects = workflow.apply(Input::MergePreconditionsChecked {
        task_id: id("a"),
        result: Ok(()),
    });
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, Effect::StartMergeAgent { .. })));
    assert_eq!(status(&workflow, "a"), TaskStatus::Merging);

    let effects = workflow.apply(Input::Suspend { now: now(40) });
    assert!(persisted_tasks(&effects)
        .iter()
        .any(|task| task.status == TaskStatus::AwaitingMerge));
    let task = workflow.task(&id("a")).expect("task kept");
    assert_eq!(task.status, TaskStatus::AwaitingMerge);
    let instructions = task
        .merge
        .as_ref()
        .and_then(|merge| merge.instructions.as_deref())
        .expect("manual steps");
    assert!(instructions.contains("local/a"), "{instructions}");
    assert!(!instructions.contains("TAPD"), "{instructions}");
    assert!(!instructions.contains("tapd_"), "{instructions}");
}

#[test]
fn task_source_serializes_snake_case_and_defaults_to_tapd() {
    assert_eq!(
        serde_json::to_value(TaskSource::LocalWorkItem).unwrap(),
        "local_work_item"
    );
    assert_eq!(
        serde_json::to_value(TaskSource::TapdBug).unwrap(),
        "tapd_bug"
    );

    let spec: TaskSpec =
        serde_json::from_str(r#"{"workspaceId":"ws","bugId":"1"}"#).expect("legacy spec loads");
    assert_eq!(spec.source_kind, TaskSource::TapdBug);

    let task: Task = serde_json::from_str(
        r#"{
            "id": "t-1",
            "workspaceId": "local-project",
            "workspaceName": "本地项目",
            "bugId": "wi-1",
            "title": "事项",
            "severity": "",
            "priority": "",
            "repoPath": "/repo",
            "status": "queued",
            "createdAt": "2026-01-01T00:00:00Z",
            "sourceKind": "local_work_item"
        }"#,
    )
    .expect("local task loads");
    assert_eq!(task.spec.source_kind, TaskSource::LocalWorkItem);
    assert_eq!(
        serde_json::to_value(&task).unwrap()["sourceKind"],
        "local_work_item"
    );
}

#[test]
fn project_rule_defaults_empty_and_roundtrips_flat() {
    let legacy: TaskSpec =
        serde_json::from_str(r#"{"workspaceId":"ws","bugId":"1"}"#).expect("legacy spec loads");
    assert_eq!(legacy.project_rule, "", "old JSON has no project rule");

    let mut spec = local_spec("wi-1");
    spec.project_rule = "先跑 cargo test".to_string();
    let task = Task::new(id("t-rule"), spec, now(0));

    let value = serde_json::to_value(&task).unwrap();
    assert_eq!(value["projectRule"], "先跑 cargo test");
    assert!(value.get("spec").is_none(), "spec stays flattened");

    let back: Task = serde_json::from_value(value).unwrap();
    assert_eq!(back.spec.project_rule, "先跑 cargo test");
}
