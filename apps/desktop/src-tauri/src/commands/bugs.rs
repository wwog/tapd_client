//! Bug detail/history and workspace-member reads used by the bug commands.

use std::time::Duration;

use tapd_core::tapd::{
    api::{bug_detail_body, bug_detail_url, parse_bug_detail, parse_workspace_members},
    changes_list_url, parse_changes_html, BugDetail, BugSummary, ChangeHistory,
    WorkspaceMember,
};
use tauri::{AppHandle, Manager};

use super::auth::{session_request_json, session_request_text};

/// Whether the main window has keyboard focus right now.
pub(super) fn main_window_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false)
}

pub(super) async fn fetch_workspace_members(
    app: &AppHandle,
    url: String,
) -> Result<Vec<WorkspaceMember>, String> {
    let root = session_request_json(app, "GET", &url, None, Duration::from_secs(30)).await?;
    Ok(parse_workspace_members(&root))
}

/// Loads a bug together with its change history.
///
/// The history lives in a legacy HTML page, so a failure there only degrades
/// that section instead of failing the whole detail.
pub(crate) async fn fetch_bug_detail(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<BugDetail, String> {
    let body = bug_detail_body(workspace_id, bug_id);
    let url = bug_detail_url();
    let detail_future =
        session_request_json(app, "POST", &url, Some(body), Duration::from_secs(45));
    let changes_future = fetch_change_history(app, workspace_id, bug_id);

    let (root, changes) = tokio::join!(detail_future, changes_future);
    let mut detail = parse_bug_detail(&root?)?;
    detail.changes = changes.unwrap_or_else(|error| ChangeHistory {
        error: Some(error),
        ..ChangeHistory::default()
    });

    Ok(detail)
}

/// List-row fields for the 处理中 view.
///
/// Same request as the detail, minus the legacy change-history pages: the table
/// only renders summary fields, and those pages make a per-row call several
/// times more expensive than it needs to be.
pub(crate) async fn fetch_bug_summary(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<BugSummary, String> {
    let body = bug_detail_body(workspace_id, bug_id);
    let url = bug_detail_url();
    let root =
        session_request_json(app, "POST", &url, Some(body), Duration::from_secs(45)).await?;
    Ok(parse_bug_detail(&root)?.summary)
}

/// The legacy page returns at most one page of changes per request.
const MAX_CHANGE_PAGES: u32 = 10;

async fn fetch_change_history(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<ChangeHistory, String> {
    let mut history = ChangeHistory::default();
    let mut previous_first_seq: Option<u32> = None;

    for page in 1..=MAX_CHANGE_PAGES {
        let http = session_request_text(
            app,
            "GET",
            &changes_list_url(workspace_id, bug_id, page),
            None,
            Duration::from_secs(30),
        )
        .await?;
        let parsed = parse_changes_html(&http.body)?;

        if page == 1 {
            history.total = parsed.total;
        }
        let Some(first_seq) = parsed.changes.first().map(|change| change.seq) else {
            break;
        };
        // Guard against the server ignoring `page` and repeating the first page.
        if page > 1 && previous_first_seq == Some(first_seq) {
            break;
        }
        previous_first_seq = Some(first_seq);

        for change in parsed.changes {
            if history
                .changes
                .iter()
                .any(|existing| existing.seq == change.seq)
            {
                continue;
            }
            history.changes.push(change);
        }

        if history.changes.len() as u32 >= history.total {
            break;
        }
    }

    if history.total < history.changes.len() as u32 {
        history.total = history.changes.len() as u32;
    }

    Ok(history)
}
