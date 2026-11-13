#![allow(dead_code)]

use tapd_workflow::{
    ChangeSet, Effect, Input, RecoveryPolicy, RunOutcome, Snapshot, Task, TaskId, TaskSpec,
    TaskStatus, Workflow, WorkflowConfig, WorktreeRef,
};

pub fn now(seconds: u32) -> String {
    format!("2026-01-01T00:00:{seconds:02}Z")
}

pub fn spec(bug: &str) -> TaskSpec {
    TaskSpec {
        workspace_id: "ws".to_string(),
        workspace_name: "项目".to_string(),
        bug_id: bug.to_string(),
        title: format!("缺陷 {bug}"),
        severity: "normal".to_string(),
        priority: "high".to_string(),
        repo_path: "/repo".to_string(),
        runtime_id: "runtime".to_string(),
        model: String::new(),
        permission_mode: String::new(),
        source: "manual".to_string(),
        extra_prompt: String::new(),
        attachments: Vec::new(),
    }
}

pub fn worktree_config(units: u32) -> WorkflowConfig {
    WorkflowConfig {
        worktree_enabled: true,
        execution_units: units,
        recovery_policy: RecoveryPolicy::default(),
    }
}

pub fn serial_config() -> WorkflowConfig {
    WorkflowConfig {
        worktree_enabled: false,
        execution_units: 4,
        recovery_policy: RecoveryPolicy::default(),
    }
}

pub fn boot(config: WorkflowConfig) -> Workflow {
    boot_with(config, Vec::new(), false).0
}

pub fn boot_with(
    config: WorkflowConfig,
    tasks: Vec<Task>,
    paused: bool,
) -> (Workflow, Vec<Effect>) {
    let mut workflow = Workflow::with_config(config.clone());
    let effects = workflow.apply(Input::SystemEntered { now: now(0) });
    assert!(matches!(effects.as_slice(), [Effect::LoadSnapshot]));
    let effects = workflow.apply(Input::SnapshotLoaded {
        snapshot: Snapshot {
            schema_version: 1,
            config,
            paused,
            tasks,
            generation: 0,
        },
    });
    (workflow, effects)
}

pub fn id(value: &str) -> TaskId {
    TaskId::from(value)
}

pub fn enqueue(workflow: &mut Workflow, task_id: &str, bug: &str) -> Vec<Effect> {
    workflow.apply(Input::Enqueue {
        task_id: id(task_id),
        spec: spec(bug),
        now: now(1),
    })
}

pub fn worktree_created(workflow: &mut Workflow, task_id: &str) -> Vec<Effect> {
    workflow.apply(Input::WorktreeCreated {
        task_id: id(task_id),
        worktree: WorktreeRef {
            path: format!("/wt/{task_id}"),
            branch: format!("tapd/{task_id}"),
        },
    })
}

pub fn agent_started(workflow: &mut Workflow, task_id: &str) -> Vec<Effect> {
    workflow.apply(Input::AgentStarted {
        task_id: id(task_id),
    })
}

pub fn finish(
    workflow: &mut Workflow,
    task_id: &str,
    dirty: bool,
    committed: bool,
    files: &[&str],
) -> Vec<Effect> {
    workflow.apply(Input::RunFinished {
        task_id: id(task_id),
        outcome: RunOutcome::success(Some(ChangeSet::new(
            files.iter().map(|file| file.to_string()).collect(),
            dirty,
            committed,
        ))),
        now: now(10),
    })
}

pub fn finish_outcome(workflow: &mut Workflow, task_id: &str, outcome: RunOutcome) -> Vec<Effect> {
    workflow.apply(Input::RunFinished {
        task_id: id(task_id),
        outcome,
        now: now(10),
    })
}

/// Queues a worktree task and drives it through worktree creation and agent
/// startup, leaving it `Running`.
pub fn running_worktree_task(workflow: &mut Workflow, task_id: &str, bug: &str) {
    enqueue(workflow, task_id, bug);
    worktree_created(workflow, task_id);
    agent_started(workflow, task_id);
}

pub fn task_with_status(task_id: &str, bug: &str, status: TaskStatus) -> Task {
    let mut task = Task::new(id(task_id), spec(bug), now(0));
    task.status = status;
    task
}

pub fn worktree_task_with_status(task_id: &str, bug: &str, status: TaskStatus) -> Task {
    let mut task = task_with_status(task_id, bug, status);
    task.worktree_path = Some(format!("/wt/{task_id}"));
    task.worktree_branch = Some(format!("tapd/{task_id}"));
    task
}

pub fn status(workflow: &Workflow, task_id: &str) -> TaskStatus {
    workflow.task(&id(task_id)).expect("task exists").status
}

pub fn rejected(effects: &[Effect]) -> Option<String> {
    effects.iter().find_map(|effect| match effect {
        Effect::Rejected { message } => Some(message.clone()),
        _ => None,
    })
}

pub fn history_records(effects: &[Effect]) -> Vec<&tapd_workflow::HistoryRecord> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::AppendHistory { record } => Some(record),
            _ => None,
        })
        .collect()
}

pub fn has_persist(effects: &[Effect]) -> bool {
    effects
        .iter()
        .any(|effect| matches!(effect, Effect::PersistChanged { .. }))
}

pub fn persisted_tasks(effects: &[Effect]) -> Vec<&Task> {
    effects
        .iter()
        .flat_map(|effect| match effect {
            Effect::PersistChanged { tasks } => tasks.iter().collect::<Vec<_>>(),
            _ => Vec::new(),
        })
        .collect()
}

pub fn start_fix_agent(effects: &[Effect]) -> Option<&Effect> {
    effects
        .iter()
        .find(|effect| matches!(effect, Effect::StartFixAgent { .. }))
}

pub fn create_worktrees(effects: &[Effect]) -> Vec<&Effect> {
    effects
        .iter()
        .filter(|effect| matches!(effect, Effect::CreateWorktree { .. }))
        .collect()
}

pub fn check_merge(effects: &[Effect]) -> Option<tapd_workflow::EffectId> {
    effects.iter().find_map(|effect| match effect {
        Effect::CheckMergePreconditions { effect, .. } => Some(*effect),
        _ => None,
    })
}
