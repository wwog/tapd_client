//! Review-request capsule card for the built-in agent.
//!
//! A workflow task that reached `awaiting_review` raises one card here; the
//! Agent page keeps owning the full review UI (docs/AGENT_TASK_FLOW.md §7).
//! The card is a shortcut: 查看 selects the session, 通过 runs
//! `dsh_task_approve`, 丢弃 runs `dsh_task_cancel { stash: true }`.
//!
//! One card per session: the tag is `dsh-review:<sessionId>`, and `raise_ai`
//! replaces a pending card carrying the same tag. `settle` removes the card
//! when the review is finished anywhere else (button in the Agent page,
//! cancel, or a new turn that moved the task back to `running`).
//!
//! The two entry points are deliberately fire-and-forget: a missing card must
//! never fail a workflow transition. The main agent wires them at the state
//! boundaries (see the report in the task description); this module does not
//! call back into `dsh::tasks`.

use serde_json::Value;
use tapd_i18n::{tr, tr_args};
use tauri::AppHandle;

use super::{
    model::{AiAction, AiBlock, AiField, AiPayload, AiTone},
    service,
};
use crate::dsh::tasks::DshTask;

/// Tag namespace: `dsh-review:<sessionId>`.
const TAG_PREFIX: &str = "dsh-review:";
/// Longest title shown in the card heading. The heading is one line in the
/// island, and the full title stays in the task list.
const MAX_TITLE_CHARS: usize = 80;
/// The card is a summary, not the review screen: the Agent page shows the
/// complete text.
const MAX_SUMMARY_CHARS: usize = 360;
/// Field values are rendered one line each; the UI scrolls long values.
const MAX_FIELD_CHARS: usize = 120;

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

/// The tag that identifies a session's review card.
pub(super) fn tag_for(session_id: &str) -> String {
    format!("{TAG_PREFIX}{}", session_id.trim())
}

/// Reads the session id out of a tag created by [`tag_for`].
pub(super) fn session_from_tag(tag: &str) -> Option<&str> {
    tag.trim()
        .strip_prefix(TAG_PREFIX)
        .map(str::trim)
        .filter(|session_id| !session_id.is_empty())
}

/// `+12 −3 · 4 files`; localized so the count reads naturally.
fn change_stats(changes: &crate::dsh::tasks::TaskChanges) -> String {
    tr_args(
        "notify.review.stats",
        &[&changes.files, &changes.additions, &changes.deletions],
    )
}

/// Builds the title and payload. Pure so the card shape is unit-testable
/// without an app handle.
fn card(task: &DshTask) -> (String, AiPayload) {
    let title = tr_args(
        "notify.review.title",
        &[&truncate(&task.title, MAX_TITLE_CHARS)],
    );

    let mut fields: Vec<AiField> = Vec::new();
    if let Some(project) = task
        .project
        .as_ref()
        .filter(|project| !project.name.trim().is_empty())
    {
        fields.push(AiField {
            label: tr("notify.review.project").to_string(),
            value: truncate(project.name.trim(), MAX_FIELD_CHARS),
        });
    }
    if let Some(branch) = task
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        fields.push(AiField {
            label: tr("notify.review.branch").to_string(),
            value: truncate(branch, MAX_FIELD_CHARS),
        });
    }
    if let Some(changes) = task.changes.as_ref() {
        fields.push(AiField {
            label: tr("notify.review.changes").to_string(),
            value: change_stats(changes),
        });
    }

    let mut blocks = Vec::new();
    if !fields.is_empty() {
        blocks.push(AiBlock::Fields { fields });
    }
    let summary = task
        .review
        .as_ref()
        .map(|review| review.summary.trim())
        .filter(|summary| !summary.is_empty());
    if let Some(summary) = summary {
        blocks.push(AiBlock::Text {
            text: truncate(summary, MAX_SUMMARY_CHARS),
        });
    }

    let payload = AiPayload {
        // A pending review is a decision waiting for the user.
        tone: AiTone::Warning,
        client: tr("notify.review.client").to_string(),
        blocks,
        // One row of three: 查看 / 通过 / 丢弃.
        actions: vec![
            AiAction {
                id: "view".to_string(),
                label: tr("notify.review.view").to_string(),
                style: "secondary".to_string(),
                description: None,
            },
            AiAction {
                id: "approve".to_string(),
                label: tr("notify.review.approve").to_string(),
                style: "primary".to_string(),
                description: None,
            },
            AiAction {
                id: "discard".to_string(),
                label: tr("notify.review.discard").to_string(),
                style: "danger".to_string(),
                description: None,
            },
        ],
        stack_actions: false,
        allow_custom: false,
        tag: Some(tag_for(&task.id)),
        resolution: None,
    };

    (title, payload)
}

/// Raises (or replaces) the review card for `task`.
///
/// Call from the boundary that moved the task to `awaiting_review`. Repeated
/// calls for the same session replace the pending card in place, so a refreshed
/// change count does not stack cards.
pub fn raise(app: &AppHandle, task: &DshTask) {
    // Kept for symmetry with `settle` and a stable call site; the notification
    // service owns the window, so there is nothing to do with the handle here.
    let _ = app;
    let Ok(service) = service() else {
        return;
    };
    let (title, payload) = card(task);
    if let Err(error) = service.raise_ai(title, payload, false) {
        // AI notifications can be turned off; a workflow must not fail for it.
        tracing::debug!(%error, session = %task.id, "review card not raised");
    }
}

/// Dismisses the pending review card for `session_id`, if any.
///
/// Call when the review stops being pending: approved, canceled, or reopened
/// for another turn. Cards already acted on are left untouched (`finish_ai`
/// keeps the first decision).
pub fn settle(app: &AppHandle, session_id: &str) {
    let _ = app;
    let Ok(service) = service() else {
        return;
    };
    let settled = service.finish_ai_by_tag(&tag_for(session_id), "dismissed");
    if settled > 0 {
        tracing::debug!(session = session_id, cards = settled, "review card settled");
    }
}

/// `dsh-review:` tags are the only cards this module acts on; the action
/// handler uses this to recognize its own cards.
pub(super) fn review_session(tag: Option<&str>) -> Option<String> {
    tag.and_then(session_from_tag).map(str::to_string)
}

/// The review card's `task` field for a command reply: the workflow result is
/// already `{ task }`; a missing field stays `null` instead of failing a click
/// that actually succeeded.
pub(super) fn task_field(result: &Value) -> Value {
    result.get("task").cloned().unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsh::tasks::{
        ProjectKind, TaskChanges, TaskKind, TaskProject, TaskReview, Workflow,
    };
    use dsh_host::transcript::SessionStatus;

    fn task() -> DshTask {
        DshTask {
            id: "session-1".to_string(),
            kind: TaskKind::Bug,
            project: Some(TaskProject {
                id: "123".to_string(),
                name: "支付项目".to_string(),
                kind: ProjectKind::Tapd,
            }),
            title: "登录失败".to_string(),
            bug_id: Some("1001".to_string()),
            workflow: Workflow::AwaitingReview,
            status: SessionStatus::Idle,
            repo_path: "/repo".to_string(),
            worktree_path: Some("/repo/.worktrees/session-1".to_string()),
            branch: Some("tapd/1001".to_string()),
            json_path: "/tmp/bug.json".to_string(),
            created_at: "2026-11-18 10:00:00".to_string(),
            updated_at: "2026-11-18 10:05:00".to_string(),
            message_count: 3,
            changes: Some(TaskChanges {
                files: 4,
                additions: 12,
                deletions: 3,
            }),
            review: Some(TaskReview {
                summary: "空指针导致登录失败".to_string(),
                verification: None,
                risks: None,
                files: vec!["src/login.rs".to_string()],
            }),
            finalize: None,
        }
    }

    #[test]
    fn card_carries_the_review_shape() {
        let (title, payload) = card(&task());
        assert!(title.contains("登录失败"));
        assert_eq!(payload.tone, AiTone::Warning);
        assert_eq!(payload.tag.as_deref(), Some("dsh-review:session-1"));
        assert!(!payload.stack_actions);
        assert!(!payload.allow_custom);
        assert_eq!(
            payload
                .actions
                .iter()
                .map(|action| (action.id.as_str(), action.style.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("view", "secondary"),
                ("approve", "primary"),
                ("discard", "danger"),
            ]
        );

        let fields = payload
            .blocks
            .iter()
            .find_map(|block| match block {
                AiBlock::Fields { fields } => Some(fields),
                _ => None,
            })
            .expect("fields block");
        assert_eq!(fields.len(), 3);
        assert_eq!(fields[0].value, "支付项目");
        assert_eq!(fields[1].value, "tapd/1001");
        assert!(fields[2].value.contains("4"));
        assert!(fields[2].value.contains("12"));
        assert!(fields[2].value.contains("3"));

        assert!(payload.blocks.iter().any(|block| matches!(
            block,
            AiBlock::Text { text } if text == "空指针导致登录失败"
        )));
    }

    #[test]
    fn card_omits_missing_context_and_truncates_the_summary() {
        let mut task = task();
        task.project = None;
        task.branch = None;
        task.changes = None;
        let summary = "x".repeat(MAX_SUMMARY_CHARS + 10);
        task.review = Some(TaskReview {
            summary,
            verification: None,
            risks: None,
            files: Vec::new(),
        });

        let (_, payload) = card(&task);
        // No fields means no empty block: the summary text stands alone.
        assert_eq!(payload.blocks.len(), 1);
        match &payload.blocks[0] {
            AiBlock::Text { text } => {
                assert_eq!(text.chars().count(), MAX_SUMMARY_CHARS);
                assert!(text.ends_with('…'));
            }
            other => panic!("unexpected block: {other:?}"),
        }
    }

    #[test]
    fn card_without_review_keeps_only_the_context_fields() {
        let mut task = task();
        task.review = None;
        let (_, payload) = card(&task);
        assert!(payload
            .blocks
            .iter()
            .all(|block| matches!(block, AiBlock::Fields { .. })));
    }

    #[test]
    fn tags_round_trip_and_reject_foreign_cards() {
        assert_eq!(tag_for("abc"), "dsh-review:abc");
        assert_eq!(session_from_tag("dsh-review:abc"), Some("abc"));
        assert_eq!(session_from_tag("dsh-review:"), None);
        assert_eq!(session_from_tag("dsh-policy-notice"), None);
        assert_eq!(
            review_session(Some("dsh-review:abc")).as_deref(),
            Some("abc")
        );
        assert_eq!(review_session(Some("dsh-policy-notice")), None);
        assert_eq!(review_session(None), None);
    }
}
