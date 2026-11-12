//! Read-only TAPD tools: identity, project list, bug lists and bug detail.

use std::time::Duration;

use serde_json::{json, Value};
use tapd_core::{
    tapd::{
        api::{bug_list_url, parse_bug_list, BugQuery},
        BugListPage,
    },
};
use tauri::AppHandle;

use crate::{
    agent::{self, ExternalClaim},
    commands::auth::session_request_json,
    state::SharedState,
};

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

pub(super) async fn list_projects(
    app: &AppHandle,
    state: &SharedState,
) -> Result<Value, String> {
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

    Ok(page_json(page, &workspace_id, &agent::external_claims(app)))
}

/// The delivery workflow external clients follow. This is the single source of
/// truth for claim / review / write-back order: the prompt only carries the
/// task, because flow control buried in prose is skipped. Nothing is enforced;
/// the caller decides based on the simple/complex conditions.
fn tapd_integration() -> Value {
    json!({
        "claim": "开始处理前调用 tapd_claim_bug 登记占用（model 传你使用的模型名），处理期间每 15 分钟续约一次，完成后调用 tapd_release_bug；返回 conflict 表示桌面 Agent 正在处理，请停止并告知用户。",
        "simple": "单文件或少量文件、局部改动，不涉及公共接口 / 数据模型 / 依赖 / 构建配置，且测试通过：直接 git commit（不要 push）并回写 TAPD，不必等用户复核。",
        "complex": "多文件、跨模块、涉及公共接口 / 数据模型 / 依赖 / 构建配置，或风险较高、测试失败：先向用户说明根因、方案、影响范围与风险，请用户复核并测试，明确告诉用户「改完了，等你复核和测试」；用户确认后再 commit 与回写，确认前不要 commit、不要更新 TAPD 状态；判断不了算简单还是复杂时，按复杂处理。",
        "writeBack": "回写顺序固定：先 git commit（不要 push），提交成功后再用 tapd_add_bug_comment 写原因/方案/影响，最后用 tapd_update_bug_status 更新状态；可先调用 tapd_get_bug_transitions 查看允许的下一步。任何情况下都不要在提交成功前评论或更新状态。",
        "prompt": "开始修复时调用 tapd_export_bug_md：它返回 prompt（项目规则 + 同事技能包 + 仓库路径），可直接作为本轮任务说明。",
    })
}

/// Pointers to the enabled coworkers' skill packages, shipped with bug detail
/// so an external AI reads them even when it never asks for the full prompt.
/// `Null` when no coworker is enabled.
fn coworker_skills(app: &AppHandle) -> Value {
    let config = agent::mcp_agent_config(app);
    let skills = crate::coworker::skill_refs(app, &config.coworker_ids);
    if skills.is_empty() {
        return Value::Null;
    }
    json!({
        "instruction": "动手改代码前先完整读取这些技能包（SKILL.md），按其中的规范实现与交付。",
        "skills": skills,
    })
}

pub(super) async fn get_bug(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let (workspace_id, _) = resolve_call_workspace(app, state, arguments).await?;

    let detail = crate::commands::bugs::fetch_bug_detail(app, &workspace_id, &bug_id).await?;
    let mut value = serde_json::to_value(detail).map_err(|error| error.to_string())?;
    if let Some(claim) = agent::external_claim_for_bug(app, &workspace_id, &bug_id) {
        value["externalClaim"] = serde_json::to_value(claim).unwrap_or(Value::Null);
    }
    let skills = coworker_skills(app);
    if !skills.is_null() {
        value["coworkerSkills"] = skills;
    }
    value["tapdIntegration"] = tapd_integration();
    Ok(value)
}

pub(super) async fn export_bug_md(
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

    // The package carries `prompt.md` and the rendered prompt comes back in the
    // result, so starting a fix needs no second tool call.
    let result = crate::export::run_export(
        app,
        &state.paths,
        &workspace_id,
        &bug_id,
        workspace_name,
        Some(crate::export::PromptOptions {
            root_hint: root_hint(arguments),
            instructions: string_arg(arguments, "instructions").unwrap_or_default(),
        }),
    )
    .await?;

    serde_json::to_value(result).map_err(|error| error.to_string())
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

fn page_json(page: BugListPage, workspace_id: &str, external: &[ExternalClaim]) -> Value {
    let claims: Vec<&ExternalClaim> = external
        .iter()
        .filter(|claim| claim.workspace_id == workspace_id)
        .collect();
    json!({
        "workspaceId": workspace_id,
        "total": page.total,
        "page": page.page,
        "perpage": page.perpage,
        "returned": page.bugs.len(),
        "statusMap": page.status_map,
        "bugs": page.bugs,
        "externalClaims": claims,
    })
}

#[cfg(test)]
mod tests {
    use super::tapd_integration;

    #[test]
    fn integration_hint_carries_the_workflow() {
        let hint = tapd_integration();
        for key in ["writeBack", "claim", "prompt"] {
            let text = hint[key].as_str().unwrap_or_default();
            assert!(!text.is_empty(), "{key} should not be empty");
            assert!(
                text.contains("tapd_"),
                "{key} should point at a tool so external clients find it"
            );
        }

        // The review gate lives here, not in the prompt: a caller must be able
        // to decide whether to stop for user review before committing.
        let simple = hint["simple"].as_str().unwrap_or_default();
        assert!(simple.contains("commit"), "simple path commits directly");
        let complex = hint["complex"].as_str().unwrap_or_default();
        assert!(complex.contains("复核") && complex.contains("commit"));
        assert!(
            complex.contains("不要 commit"),
            "complex path must stop before committing until the user confirms"
        );
        let write_back = hint["writeBack"].as_str().unwrap_or_default();
        assert!(write_back.contains("tapd_add_bug_comment"));
        assert!(write_back.contains("tapd_update_bug_status"));
    }
}
