use tapd_workflow::{Snapshot, Task, TaskStatus, WorkflowConfig};

#[test]
fn legacy_task_json_without_new_fields_deserializes() {
    let json = r#"{
        "id": "old-1",
        "workspaceId": "ws",
        "workspaceName": "项目",
        "bugId": "123456",
        "title": "旧任务",
        "severity": "normal",
        "priority": "high",
        "jsonPath": "/data/bug.json",
        "repoPath": "/repo",
        "worktreePath": "/wt/old-1",
        "worktreeBranch": "tapd/old-1",
        "status": "awaiting_merge",
        "createdAt": "2026-01-01T00:00:00Z",
        "startedAt": "2026-01-01T00:00:01Z",
        "finishedAt": null,
        "exitCode": 0,
        "error": null,
        "prompt": "please fix",
        "source": "manual",
        "runtimeId": "claude",
        "agentSessionId": "session-1",
        "commitOnly": false,
        "baselineDirty": ["src/untracked.rs"],
        "baselineHead": "abc123",
        "extraPrompt": "keep it small",
        "attachments": ["/tmp/a.png"],
        "approval": {
            "summary": "review",
            "files": ["src/a.rs"],
            "risk": "low",
            "requestedAt": "2026-01-01T00:00:02Z",
            "approvedAt": "2026-01-01T00:00:03Z",
            "stash": "stash@{0}"
        },
        "merge": {
            "error": "conflict",
            "instructions": "merge by hand",
            "startedAt": "2026-01-01T00:00:04Z",
            "finishedAt": "2026-01-01T00:00:05Z"
        }
    }"#;

    let task: Task = serde_json::from_str(json).expect("legacy task loads");
    assert_eq!(task.id.0, "old-1");
    assert_eq!(task.spec.workspace_id, "ws");
    assert_eq!(task.spec.bug_id, "123456");
    assert_eq!(task.spec.repo_path, "/repo");
    assert_eq!(task.spec.runtime_id, "claude");
    assert_eq!(task.spec.extra_prompt, "keep it small");
    assert_eq!(task.spec.attachments, vec!["/tmp/a.png"]);
    assert_eq!(task.json_path, "/data/bug.json");
    assert_eq!(task.prompt, "please fix");
    assert_eq!(task.source, "manual");
    assert_eq!(task.agent_session_id.as_deref(), Some("session-1"));
    assert_eq!(task.exit_code, Some(0));
    assert_eq!(task.baseline_dirty, vec!["src/untracked.rs"]);
    assert_eq!(task.baseline_head.as_deref(), Some("abc123"));
    assert_eq!(task.worktree_path.as_deref(), Some("/wt/old-1"));
    assert_eq!(task.worktree_branch.as_deref(), Some("tapd/old-1"));
    assert_eq!(task.status, TaskStatus::AwaitingMerge);
    assert_eq!(task.attempt, 0);
    assert!(!task.interrupted);
    assert!(task.changes.is_none());
    assert_eq!(
        task.approval.as_ref().unwrap().stash.as_deref(),
        Some("stash@{0}")
    );
    assert_eq!(
        task.merge.as_ref().unwrap().error.as_deref(),
        Some("conflict")
    );
    assert_eq!(task.worktree().unwrap().branch, "tapd/old-1");
}

#[test]
fn legacy_task_json_missing_optional_export_fields_loads() {
    let json = r#"{
        "id": "old-2",
        "workspaceId": "ws",
        "workspaceName": "项目",
        "bugId": "1",
        "title": "t",
        "severity": "normal",
        "priority": "high",
        "repoPath": "/repo",
        "status": "queued",
        "createdAt": "2026-01-01T00:00:00Z"
    }"#;
    let task: Task = serde_json::from_str(json).expect("minimal legacy task loads");
    assert_eq!(task.json_path, "");
    assert_eq!(task.prompt, "");
    assert_eq!(task.source, "");
    assert_eq!(task.spec.runtime_id, "");
    assert!(task.spec.attachments.is_empty());
    assert_eq!(task.attempt, 0);
    assert!(!task.interrupted);
    assert!(task.changes.is_none());
}

#[test]
fn new_task_serializes_flat_camel_case_json() {
    let mut task = Task::new(
        tapd_workflow::TaskId::from("a"),
        tapd_workflow::TaskSpec {
            workspace_id: "ws".to_string(),
            workspace_name: "项目".to_string(),
            bug_id: "1".to_string(),
            title: "t".to_string(),
            severity: "normal".to_string(),
            priority: "high".to_string(),
            repo_path: "/repo".to_string(),
            runtime_id: "rt".to_string(),
            ..Default::default()
        },
        "2026-01-01T00:00:00Z".to_string(),
    );
    task.status = TaskStatus::AwaitingApproval;
    task.attempt = 2;
    task.interrupted = true;
    task.changes = Some(tapd_workflow::ChangeSet::new(
        vec!["src/a.rs".to_string()],
        true,
        false,
    ));

    let value: serde_json::Value = serde_json::to_value(&task).unwrap();
    assert_eq!(value["workspaceId"], "ws");
    assert_eq!(value["bugId"], "1");
    assert_eq!(value["runtimeId"], "rt");
    assert_eq!(value["status"], "awaiting_approval");
    assert_eq!(value["attempt"], 2);
    assert_eq!(value["interrupted"], true);
    assert_eq!(value["changes"]["dirty"], true);
    assert!(value.get("spec").is_none(), "spec must stay flattened");

    let reloaded: Task = serde_json::from_value(value).unwrap();
    assert_eq!(reloaded, task);
}

#[test]
fn legacy_snapshot_without_generation_loads() {
    let json = r#"{
        "schemaVersion": 1,
        "config": {
            "worktreeEnabled": true,
            "executionUnits": 3
        },
        "paused": false,
        "tasks": []
    }"#;
    let snapshot: Snapshot = serde_json::from_str(json).expect("legacy snapshot loads");
    assert_eq!(snapshot.schema_version, 1);
    assert!(snapshot.config.worktree_enabled);
    assert_eq!(snapshot.config.execution_units, 3);
    assert_eq!(snapshot.config.recovery_policy, Default::default());
    assert_eq!(snapshot.generation, 0);
}

#[test]
fn task_status_uses_snake_case_keys() {
    let cases = [
        (TaskStatus::Queued, "\"queued\""),
        (TaskStatus::Preparing, "\"preparing\""),
        (TaskStatus::Running, "\"running\""),
        (TaskStatus::AwaitingApproval, "\"awaiting_approval\""),
        (TaskStatus::AwaitingMerge, "\"awaiting_merge\""),
        (TaskStatus::Merging, "\"merging\""),
        (TaskStatus::Succeeded, "\"succeeded\""),
        (TaskStatus::Failed, "\"failed\""),
        (TaskStatus::Canceled, "\"canceled\""),
    ];
    for (status, expected) in cases {
        assert_eq!(serde_json::to_string(&status).unwrap(), expected);
    }
}

#[test]
fn task_merge_and_approval_default_missing_fields() {
    let merge: tapd_workflow::TaskMerge = serde_json::from_str("{}").unwrap();
    assert!(merge.error.is_none());
    let approval: tapd_workflow::TaskApproval = serde_json::from_str("{}").unwrap();
    assert_eq!(approval.summary, "");
    assert!(approval.files.is_empty());
}

#[test]
fn config_defaults_match_the_desktop_settings() {
    let config = WorkflowConfig::default();
    assert!(!config.worktree_enabled);
    assert_eq!(config.execution_units, 2);
    assert!(config.recovery_policy.auto_retry_interrupted);
    assert_eq!(config.recovery_policy.max_auto_retry, 3);
}
