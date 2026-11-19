//! Contract tests: normalization, state transitions and the stored JSON shape.

use serde_json::json;

use crate::{
    project_id, work_item_id, LocalError, LocalProject, WorkItem, WorkItemImportance,
    WorkItemStatus,
};

const NOW: &str = "2026-01-01T09:00:00Z";
const LATER: &str = "2026-01-02T09:00:00Z";

fn project() -> LocalProject {
    LocalProject::new(project_id("p1"), "  Notes  ", "  /repos/notes  ", NOW).unwrap()
}

fn item() -> WorkItem {
    WorkItem::new(
        work_item_id("w1"),
        project().id,
        "  Ship it  ",
        "  body  ",
        WorkItemImportance::Normal,
        NOW,
    )
    .unwrap()
}

#[test]
fn new_project_trims_name_and_path() {
    let project = project();
    assert_eq!(project.id, "lp_p1");
    assert_eq!(project.name, "Notes");
    assert_eq!(project.repo_path, "/repos/notes");
    assert_eq!(project.created_at, NOW);
    assert_eq!(project.updated_at, NOW);
}

#[test]
fn project_without_name_or_path_is_rejected() {
    assert_eq!(
        LocalProject::new("lp_p1".into(), "   ", "/repos/notes", NOW).unwrap_err(),
        LocalError::EmptyProjectName
    );
    assert_eq!(
        LocalProject::new("lp_p1".into(), "Notes", "  ", NOW).unwrap_err(),
        LocalError::EmptyRepoPath
    );
}

#[test]
fn rename_and_move_to_touch_only_their_field() {
    let mut project = project();

    project.rename(" Journal ", LATER).unwrap();
    assert_eq!(project.name, "Journal");
    assert_eq!(project.repo_path, "/repos/notes");
    assert_eq!(project.updated_at, LATER);
    assert_eq!(project.created_at, NOW);

    project.move_to("/repos/journal", LATER).unwrap();
    assert_eq!(project.repo_path, "/repos/journal");
    assert_eq!(project.name, "Journal");

    assert_eq!(
        project.rename(" ", LATER).unwrap_err(),
        LocalError::EmptyProjectName
    );
    assert_eq!(
        project.move_to("", LATER).unwrap_err(),
        LocalError::EmptyRepoPath
    );
}

#[test]
fn derive_project_name_uses_the_last_component() {
    assert_eq!(
        LocalProject::derive_project_name("/Users/me/code/notes"),
        "notes"
    );
    assert_eq!(
        LocalProject::derive_project_name("/Users/me/code/notes/"),
        "notes"
    );
    assert_eq!(
        LocalProject::derive_project_name("  /Users/me/code/notes//  "),
        "notes"
    );
    assert_eq!(LocalProject::derive_project_name("notes"), "notes");
    assert_eq!(LocalProject::derive_project_name("   "), "local");
    assert_eq!(LocalProject::derive_project_name(""), "local");
}

#[test]
fn new_work_item_is_pending() {
    let item = item();
    assert_eq!(item.id, "lw_w1");
    assert_eq!(item.project_id, "lp_p1");
    assert_eq!(item.title, "Ship it");
    assert_eq!(item.description, "body");
    assert_eq!(item.status, WorkItemStatus::Pending);
    assert_eq!(item.agent_task_id, None);
    assert_eq!(item.created_at, NOW);
    assert_eq!(item.updated_at, NOW);
}

#[test]
fn work_item_without_title_is_rejected() {
    assert_eq!(
        WorkItem::new(
            "lw_w1".into(),
            "lp_p1".into(),
            "  ",
            "body",
            WorkItemImportance::Normal,
            NOW
        )
        .unwrap_err(),
        LocalError::EmptyTitle
    );
}

#[test]
fn edit_updates_only_supplied_fields() {
    let mut item = item();

    item.edit(Some(" Ship it twice "), None, None, LATER).unwrap();
    assert_eq!(item.title, "Ship it twice");
    assert_eq!(item.description, "body");
    assert_eq!(item.updated_at, LATER);

    item.edit(None, Some("new body"), None, LATER).unwrap();
    assert_eq!(item.title, "Ship it twice");
    assert_eq!(item.description, "new body");

    item.edit(None, Some(""), None, LATER).unwrap();
    assert_eq!(item.description, "");

    assert_eq!(item.created_at, NOW);
}

#[test]
fn edit_with_empty_title_keeps_the_item_untouched() {
    let mut item = item();
    assert_eq!(
        item.edit(Some(" "), Some("new body"), None, LATER).unwrap_err(),
        LocalError::EmptyTitle
    );
    assert_eq!(item.title, "Ship it");
    assert_eq!(item.description, "body");
    assert_eq!(item.updated_at, NOW);
}

#[test]
fn attach_task_starts_the_item() {
    let mut item = item();
    item.attach_task(" t1 ", LATER).unwrap();
    assert_eq!(item.agent_task_id.as_deref(), Some("t1"));
    assert_eq!(item.status, WorkItemStatus::InProgress);
    assert_eq!(item.updated_at, LATER);
}

#[test]
fn attach_task_rejects_an_empty_task_id() {
    let mut item = item();
    assert_eq!(
        item.attach_task("  ", LATER).unwrap_err(),
        LocalError::EmptyTaskId
    );
    assert_eq!(item.agent_task_id, None);
    assert_eq!(item.status, WorkItemStatus::Pending);
}

#[test]
fn clear_task_keeps_the_user_status() {
    let mut item = item();
    item.attach_task("t1", NOW).unwrap();
    item.clear_task(LATER);
    assert_eq!(item.agent_task_id, None);
    assert_eq!(item.status, WorkItemStatus::InProgress);
    assert_eq!(item.updated_at, LATER);
}

#[test]
fn new_project_has_no_rule() {
    assert_eq!(project().rule, "");
}

#[test]
fn set_rule_trims_caps_and_clears() {
    let mut project = project();

    project.set_rule("  先跑 cargo fmt  ", LATER);
    assert_eq!(project.rule, "先跑 cargo fmt");
    assert_eq!(project.updated_at, LATER);

    project.set_rule("   ", LATER);
    assert_eq!(project.rule, "", "empty text clears the rule");

    let long = "规".repeat(20_050);
    project.set_rule(&long, LATER);
    assert_eq!(project.rule.chars().count(), 20_000);
}

#[test]
fn set_status_moves_the_item() {
    let mut item = item();
    item.set_status(WorkItemStatus::InProgress, LATER);
    assert_eq!(item.status, WorkItemStatus::InProgress);
    assert_eq!(item.updated_at, LATER);
}

#[test]
fn status_roundtrips_through_its_text() {
    for status in [
        WorkItemStatus::Pending,
        WorkItemStatus::InProgress,
        WorkItemStatus::Done,
    ] {
        assert_eq!(WorkItemStatus::parse(status.as_str()), Some(status));
    }
    assert_eq!(
        WorkItemStatus::parse("pending"),
        Some(WorkItemStatus::Pending)
    );
    assert_eq!(
        WorkItemStatus::parse("in_progress"),
        Some(WorkItemStatus::InProgress)
    );
    assert_eq!(WorkItemStatus::parse("done"), Some(WorkItemStatus::Done));
    assert_eq!(WorkItemStatus::parse("Pending"), None);
}

#[test]
fn importance_roundtrips_and_defaults_to_normal() {
    for importance in [
        WorkItemImportance::Low,
        WorkItemImportance::Normal,
        WorkItemImportance::High,
    ] {
        assert_eq!(
            WorkItemImportance::parse(importance.as_str()),
            Some(importance)
        );
    }
    assert_eq!(WorkItemImportance::parse("urgent"), None);
    assert_eq!(WorkItemImportance::default(), WorkItemImportance::Normal);
}

#[test]
fn complete_marks_the_item_done() {
    let mut item = item();
    item.attach_task("t1", NOW).unwrap();
    item.complete(LATER);
    assert_eq!(item.status, WorkItemStatus::Done);
    assert_eq!(item.updated_at, LATER);
}

#[test]
fn ids_carry_their_prefix() {
    assert_eq!(project_id("abc"), "lp_abc");
    assert_eq!(project_id(" abc "), "lp_abc");
    assert_eq!(work_item_id("abc"), "lw_abc");
    assert_eq!(work_item_id(" abc "), "lw_abc");
}

#[test]
fn project_json_is_camel_case() {
    assert_eq!(
        serde_json::to_value(project()).unwrap(),
        json!({
            "id": "lp_p1",
            "name": "Notes",
            "repoPath": "/repos/notes",
            "rule": "",
            "createdAt": NOW,
            "updatedAt": NOW,
        })
    );
}

#[test]
fn project_json_carries_the_rule() {
    let mut project = project();
    project.set_rule("跑 cargo test", LATER);
    let value = serde_json::to_value(&project).unwrap();
    assert_eq!(value["rule"], "跑 cargo test");

    let from_json: LocalProject = serde_json::from_value(value).unwrap();
    assert_eq!(from_json.rule, "跑 cargo test");
}

#[test]
fn work_item_json_is_camel_case_with_snake_case_status() {
    let mut attached = item();
    attached.attach_task("t1", LATER).unwrap();

    assert_eq!(
        serde_json::to_value(&attached).unwrap(),
        json!({
            "id": "lw_w1",
            "projectId": "lp_p1",
            "title": "Ship it",
            "description": "body",
            "status": "in_progress",
            "importance": "normal",
            "agentTaskId": "t1",
            "createdAt": NOW,
            "updatedAt": LATER,
        })
    );

    let stored = json!({
        "id": "lw_w1",
        "projectId": "lp_p1",
        "title": "Ship it",
        "description": "body",
        "status": "pending",
        "agentTaskId": null,
        "createdAt": NOW,
        "updatedAt": NOW,
    });
    assert_eq!(serde_json::from_value::<WorkItem>(stored).unwrap(), item());
}
