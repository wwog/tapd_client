//! Read-only TAPD tools: identity, project list, bug lists, bug detail and the
//! export/prompt helpers external clients start from.

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
    agent::{self, ExternalClaim, PromptVars},
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

/// Prompt used by `tapd_get_bug_prompt` for external MCP clients. It mirrors
/// `agent::DEFAULT_PROMPT_TEMPLATE` but drops the review-queue flow, which only
/// exists for tasks owned by the desktop app.
const MCP_PROMPT_TEMPLATE: &str = "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n项目规则：\n{{project_rule}}\n\n协作约定：开始前先调用 tapd_claim_bug 登记占用（model 传你使用的模型名），处理期间每 15 分钟续约一次，完成后调用 tapd_release_bug；如果返回 conflict，说明桌面 Agent 正在处理，请停止并告知用户。\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频，定位根因，做最小必要修改，并遵循团队代码规范。\n2. 修改后运行相关测试或构建。\n3. 改动复杂（多文件、跨模块、涉及公共接口/数据模型/依赖/构建配置、风险较高或测试失败）时，先向用户说明方案与风险、等待确认，不要直接扩大改动范围。\n4. 提交成功后（git commit，不要 push），再用 tapd_add_bug_comment 追加评论、tapd_update_bug_status 更新状态；评论说明原因、解决方案与影响范围。\n5. 任何情况下都不要在提交成功前评论或更新 TAPD 状态。";

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

/// Non-binding reminder shipped with bug detail so external clients discover
/// the write-back and ownership flow even if they never call
/// `tapd_get_bug_prompt`. Nothing is enforced: the caller may skip it.
fn tapd_integration() -> Value {
    json!({
        "writeBack": "修复并 commit 后，用 tapd_add_bug_comment 写原因/方案/影响，再用 tapd_update_bug_status 更新状态；可先调用 tapd_get_bug_transitions 查看允许的下一步。",
        "claim": "开始处理前可调用 tapd_claim_bug 登记占用（每 15 分钟续约），完成后调用 tapd_release_bug。",
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

    let result =
        crate::export::run_export(app, &state.paths, &workspace_id, &bug_id, workspace_name)
            .await?;

    serde_json::to_value(result).map_err(|error| error.to_string())
}

/// Renders the same prompt the desktop Agent would receive, so an external AI
/// can start from the exported `bug.md`, the project rule and the local repo.
pub(super) async fn get_bug_prompt(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let (workspace_id, workspaces) = resolve_call_workspace(app, state, arguments).await?;
    let detail = crate::commands::bugs::fetch_bug_detail(app, &workspace_id, &bug_id).await?;
    let workspace_name = workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .map(|workspace| workspace.name.clone())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| detail.workspace_name.clone());

    let refresh = arguments
        .get("refresh")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut warnings: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    let mut exported = false;
    let mut reused = false;
    let mut asset_count = 0usize;
    let mut dir: Option<String> = None;
    let mut md_path: Option<String> = None;

    let existing = if refresh {
        None
    } else {
        crate::export::paths::find_existing_export(
            &state.paths,
            &workspace_id,
            &crate::export::paths::bug_reference(&detail.summary),
            &detail.summary.id,
        )
    };

    if let Some(existing) = existing {
        reused = true;
        md_path = Some(existing.join("bug.md").to_string_lossy().to_string());
        asset_count = std::fs::read_dir(existing.join("assets"))
            .map(|entries| entries.flatten().count())
            .unwrap_or(0);
        dir = Some(existing.to_string_lossy().to_string());
    } else {
        match crate::export::run_export(
            app,
            &state.paths,
            &workspace_id,
            &detail.summary.id,
            Some(workspace_name.clone()),
        )
        .await
        {
            Ok(result) => {
                exported = true;
                md_path = Some(result.markdown_path);
                asset_count = result.asset_count;
                dir = Some(result.dir);
                warnings.extend(result.warnings);
            }
            Err(error) => warnings.push(format!("导出缺陷详情失败：{error}")),
        }
    }

    let agent_config = agent::mcp_agent_config(app);
    let project = agent_config.projects.get(&workspace_id);
    let repo_path = project
        .map(|project| project.repo_path.trim().to_string())
        .filter(|path| !path.is_empty())
        .or_else(|| root_hint(arguments))
        .unwrap_or_else(|| "（当前工作目录）".to_string());
    let project_rule = project
        .map(|project| project.rule.trim().to_string())
        .unwrap_or_default();

    let (kind, template) = match string_arg(arguments, "template") {
        Some(custom) => ("custom".to_string(), custom),
        None if string_arg(arguments, "kind").as_deref() == Some("agent") => {
            ("agent".to_string(), agent_config.prompt_template.clone())
        }
        None => ("mcp".to_string(), MCP_PROMPT_TEMPLATE.to_string()),
    };
    if template.contains("{{task_id}}") {
        notes.push(
            "外部 MCP 客户端没有活动 Agent 任务，{{task_id}} 为空，也无法调用 tapd_request_review；复杂改动请先向用户说明方案。"
                .to_string(),
        );
    }

    let md_path_value = md_path
        .clone()
        .unwrap_or_else(|| "（导出失败，请调用 tapd_export_bug_md）".to_string());
    let vars = PromptVars {
        task_id: String::new(),
        title: detail.summary.title.clone(),
        md_path: md_path_value,
        repo_path: repo_path.clone(),
        workspace_name: workspace_name.clone(),
        bug_id: detail.summary.id.clone(),
        severity: label_or_raw(&detail.summary.severity_label, &detail.summary.severity),
        priority: label_or_raw(&detail.summary.priority_label, &detail.summary.priority),
        project_rule,
        user_prompt: string_arg(arguments, "instructions").unwrap_or_default(),
        attachments: Vec::new(),
    };
    let prompt = agent::render_prompt(&template, &vars);

    Ok(json!({
        "prompt": prompt,
        "kind": kind,
        "bugId": detail.summary.id,
        "title": detail.summary.title,
        "workspaceId": workspace_id,
        "workspaceName": workspace_name,
        "repoPath": repo_path,
        "mdPath": md_path,
        "dir": dir,
        "assetCount": asset_count,
        "exported": exported,
        "reused": reused,
        "warnings": warnings,
        "notes": notes,
    }))
}

/// Human label when TAPD sent one, otherwise the raw key.
fn label_or_raw(label: &str, raw: &str) -> String {
    let label = label.trim();
    if label.is_empty() {
        raw.trim().to_string()
    } else {
        label.to_string()
    }
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
    use super::{tapd_integration, MCP_PROMPT_TEMPLATE};
    use crate::agent::{render_prompt, PromptVars};

    #[test]
    fn integration_hint_is_advisory() {
        let hint = tapd_integration();
        for key in ["writeBack", "claim"] {
            let text = hint[key].as_str().unwrap_or_default();
            assert!(!text.is_empty(), "{key} should not be empty");
            assert!(text.contains("tapd_"), "{key} should name the tools");
        }
    }

    #[test]
    fn mcp_prompt_template_carries_paths_and_rule() {
        let vars = PromptVars {
            task_id: String::new(),
            title: "按钮错位".to_string(),
            md_path: "/exports/bug.md".to_string(),
            repo_path: "/repo".to_string(),
            workspace_name: "UU".to_string(),
            bug_id: "42".to_string(),
            severity: "严重".to_string(),
            priority: "高".to_string(),
            project_rule: "先跑 pnpm test".to_string(),
            user_prompt: String::new(),
            attachments: Vec::new(),
        };
        let prompt = render_prompt(MCP_PROMPT_TEMPLATE, &vars);
        assert!(prompt.contains("按钮错位"));
        assert!(prompt.contains("/exports/bug.md"));
        assert!(prompt.contains("/repo"));
        assert!(prompt.contains("先跑 pnpm test"));
        assert!(!prompt.contains("{{"));
        // External clients cannot pause the desktop review queue.
        assert!(!prompt.contains("tapd_request_review"));
    }
}
