//! Read-only TAPD tools: identity, project list, bug lists, and the bug detail
//! export that also renders the fix prompt.

use std::{path::Path, time::Duration};

use serde_json::{json, Value};
use tapd_core::tapd::{
    api::{bug_list_url, parse_bug_list, BugQuery},
    BugListPage,
};
use tauri::AppHandle;

use crate::{agent, commands::auth::session_request_json, state::SharedState};

use super::{
    args::{root_hint, string_arg, string_array},
    session::{
        allowed_workspaces, default_workspace_id, load_context, match_workspace_by_root,
        resolve_call_workspace, resolve_me,
    },
};

const MAX_RESULTS: u32 = 50;
const DEFAULT_RESULTS: u32 = 20;

pub(super) async fn whoami(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let (user, workspaces) = load_context(app).await?;
    let policy = state.config_snapshot().mcp_policy;
    let allowed = allowed_workspaces(&policy, workspaces);
    let default_workspace = default_workspace_id(state, &allowed, &policy);

    let agent_config = agent::mcp_agent_config(app);
    let local_projects: Vec<Value> = agent_config
        .projects
        .iter()
        .filter(|(_, project)| !project.repo_path.trim().is_empty())
        .map(|(workspace_id, project)| {
            json!({ "workspaceId": workspace_id, "repoPath": project.repo_path })
        })
        .collect();
    let matched_workspace = root_hint(arguments)
        .and_then(|root| match_workspace_by_root(&agent_config.projects, &root));

    Ok(json!({
        "nick": user.get("user_nick").and_then(Value::as_str).unwrap_or_default(),
        "userId": user.get("user_id").and_then(Value::as_str).unwrap_or_default(),
        "company": user.get("company").and_then(Value::as_str).unwrap_or_default(),
        "defaultWorkspaceId": default_workspace,
        "workspaces": allowed.len(),
        "localProjects": local_projects,
        "matchedWorkspaceId": matched_workspace,
    }))
}

pub(super) async fn list_projects(app: &AppHandle, state: &SharedState) -> Result<Value, String> {
    let (_, workspaces) = load_context(app).await?;
    let policy = state.config_snapshot().mcp_policy;
    let allowed = allowed_workspaces(&policy, workspaces);
    serde_json::to_value(allowed).map_err(|error| error.to_string())
}

pub(super) async fn list_bugs(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    bug_page(app, state, arguments, false).await
}

pub(super) async fn list_my_bugs(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    bug_page(app, state, arguments, true).await
}

/// Shared body of `tapd_list_bugs` / `tapd_list_my_bugs`; the two tools differ
/// only in whether the owner filter is forced to `me`.
async fn bug_page(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
    force_me: bool,
) -> Result<Value, String> {
    let (workspace_id, _) = resolve_call_workspace(app, state, arguments).await?;
    let page = query_bugs(app, state, &workspace_id, arguments, force_me).await?;

    Ok(page_json(page, &workspace_id))
}

/// Exports the bug package and returns everything a fixing agent needs: the
/// package paths, the coworker skills it may follow, the project rule and the
/// rendered prompt.
pub(super) async fn get_bug(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let (workspace_id, workspaces) = resolve_call_workspace(app, state, arguments).await?;
    let workspace_name = string_arg(arguments, "workspace_name").or_else(|| {
        workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .map(|workspace| workspace.name.clone())
    });

    // The detail is needed for both the export and the prompt, so it is fetched
    // once and handed to the export instead of letting it fetch again.
    let detail = crate::commands::bugs::fetch_bug_detail(app, &workspace_id, &bug_id).await?;
    let agent_config = agent::mcp_agent_config(app);
    let skills = crate::coworker::skill_map(app, &agent_config.coworker_ids);
    let rule = agent_config
        .projects
        .get(&workspace_id)
        .map(|project| project.rule.as_str())
        .unwrap_or_default();
    let project_rule = project_rule_text(!skills.is_empty(), rule);

    let label =
        crate::export::paths::workspace_label(workspace_name.clone(), &detail, &workspace_id);
    let export =
        crate::export::export_detail(app, &state.paths, &workspace_id, workspace_name, &detail)
            .await?;

    let root = root_hint(arguments);
    let prompt = crate::export::prompt::render(
        app,
        crate::export::prompt::PromptContext {
            workspace_id: &workspace_id,
            workspace_name: &label,
            root_hint: root.as_deref(),
            json_path: Path::new(&export.bug_json),
            detail: &detail,
        },
    );

    Ok(json!({
        "warnings": export.warnings,
        "downloadedBytes": export.downloaded_bytes,
        "bugJson": export.bug_json,
        "assetCount": export.asset_count,
        "skills": skills,
        "projectRule": project_rule,
        "prompt": prompt,
    }))
}

/// `projectRule` payload: the skill hint first, then the configured rule.
/// Empty when the project has neither skills nor a rule.
fn project_rule_text(has_skills: bool, rule: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    if has_skills {
        parts.push("技能规则：按需使用 skills 对象。".to_string());
    }
    let rule = rule.trim();
    if !rule.is_empty() {
        parts.push(format!("项目规则：\n{rule}"));
    }
    parts.join("\n\n")
}

async fn query_bugs(
    app: &AppHandle,
    state: &SharedState,
    workspace_id: &str,
    arguments: &Value,
    force_me: bool,
) -> Result<BugListPage, String> {
    let mut query = BugQuery::new(workspace_id);

    let owner = if force_me {
        Some("me".to_string())
    } else {
        string_arg(arguments, "owner")
    };
    query.owners = match owner.as_deref() {
        Some("all") | Some("") | None => Vec::new(),
        Some("me") => resolve_me(app, state).await?.into_iter().collect(),
        Some(nick) => vec![nick.to_string()],
    };

    query.statuses = string_array(arguments, "statuses");
    query.priorities = string_array(arguments, "priorities");
    query.severities = string_array(arguments, "severities");
    query.keyword = string_arg(arguments, "keyword");
    query.modified_after = string_arg(arguments, "modified_after");
    query.created_after = string_arg(arguments, "created_after");

    let only_unresolved = arguments
        .get("only_unresolved")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if query.statuses.is_empty() && only_unresolved {
        query.statuses = vec![
            "new".to_string(),
            "in_progress".to_string(),
            "reopened".to_string(),
        ];
    }

    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .unwrap_or(DEFAULT_RESULTS)
        .clamp(1, MAX_RESULTS);
    query.page = arguments
        .get("page")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .unwrap_or(1)
        .max(1);
    // The TAPD endpoint coerces anything below 20 up to 20; trim locally.
    query.perpage = limit.clamp(20, MAX_RESULTS);

    let root = session_request_json(
        app,
        "POST",
        &bug_list_url(),
        Some(query.body()),
        Duration::from_secs(45),
    )
    .await?;

    let mut page = parse_bug_list(&root)?;
    page.bugs.truncate(limit as usize);
    Ok(page)
}

fn page_json(page: BugListPage, workspace_id: &str) -> Value {
    json!({
        "workspaceId": workspace_id,
        "total": page.total,
        "page": page.page,
        "perpage": page.perpage,
        "returned": page.bugs.len(),
        "statusMap": page.status_map,
        "bugs": page.bugs,
    })
}

#[cfg(test)]
mod tests {
    use super::project_rule_text;

    #[test]
    fn project_rule_combines_skill_hint_and_rule() {
        assert_eq!(
            project_rule_text(true, "先跑 cargo test"),
            "技能规则：按需使用 skills 对象。\n\n项目规则：\n先跑 cargo test"
        );
        assert_eq!(
            project_rule_text(true, "  "),
            "技能规则：按需使用 skills 对象。"
        );
        assert_eq!(
            project_rule_text(false, "先跑 cargo test"),
            "项目规则：\n先跑 cargo test"
        );
        assert_eq!(project_rule_text(false, ""), "");
    }
}
