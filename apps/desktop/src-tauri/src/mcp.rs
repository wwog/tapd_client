//! MCP tool dispatch running inside the desktop app.
//!
//! The sidecar speaks MCP over stdio and forwards tool calls to `/mcp/call`.
//! Every call passes the user-configurable policy (read/write, project scope,
//! allowed statuses) and is written to the local audit log.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde_json::{json, Map, Value};
use tapd_core::{
    config::McpPolicy,
    tapd::{
        api::{bug_list_url, parse_bug_list, parse_workspaces, user_workspace_url, BugQuery},
        BugListPage, Workspace,
    },
};
use tauri::AppHandle;

use crate::{
    agent::{self, ExternalClaim, ProjectAgentConfig, PromptVars},
    bug_write::{self, add_comment, load_transition_info, resolve_status_key},
    commands::session_request_json,
    mcp_audit::McpAuditEntry,
    state::SharedState,
};

const MAX_RESULTS: u32 = 50;
const DEFAULT_RESULTS: u32 = 20;

/// Prompt used by `tapd_get_bug_prompt` for external MCP clients. It mirrors
/// `agent::DEFAULT_PROMPT_TEMPLATE` but drops the review-queue flow, which only
/// exists for tasks owned by the desktop app.
const MCP_PROMPT_TEMPLATE: &str = "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n项目规则：\n{{project_rule}}\n\n协作约定：开始前先调用 tapd_claim_bug 登记占用（model 传你使用的模型名），处理期间每 15 分钟续约一次，完成后调用 tapd_release_bug；如果返回 conflict，说明桌面 Agent 正在处理，请停止并告知用户。\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频，定位根因，做最小必要修改，并遵循团队代码规范。\n2. 修改后运行相关测试或构建。\n3. 改动复杂（多文件、跨模块、涉及公共接口/数据模型/依赖/构建配置、风险较高或测试失败）时，先向用户说明方案与风险、等待确认，不要直接扩大改动范围。\n4. 提交成功后（git commit，不要 push），再用 tapd_add_bug_comment 追加评论、tapd_update_bug_status 更新状态；评论说明原因、解决方案与影响范围。\n5. 任何情况下都不要在提交成功前评论或更新 TAPD 状态。";

pub async fn handle(
    app: &AppHandle,
    state: &SharedState,
    tool: &str,
    arguments: &Value,
    client: &str,
) -> Result<Value, String> {
    let started = Instant::now();
    let policy = state.config_snapshot().mcp_policy;
    let summary = summarize_arguments(arguments);

    if let Some(message) = policy_violation(&policy, tool, arguments) {
        record_audit(
            state,
            &policy,
            tool,
            client,
            "denied",
            false,
            started,
            arguments,
            Some(message.clone()),
            summary,
        );
        tracing::info!(tool, client, ok = false, error = %message, "mcp tool denied by policy");
        return Err(message);
    }

    // The local agent must commit before it comments or changes TAPD state.
    if is_write_tool(tool) {
        if let Some(message) = crate::agent::tapd_write_block_reason(app, arguments) {
            record_audit(
                state,
                &policy,
                tool,
                client,
                "denied",
                false,
                started,
                arguments,
                Some(message.clone()),
                summary,
            );
            tracing::info!(tool, client, ok = false, error = %message, "mcp write blocked until commit");
            return Err(message);
        }
    }

    let result = dispatch(app, state, tool, arguments, client).await;
    let (decision, ok) = match &result {
        Ok(_) => ("allowed", true),
        Err(_) => ("error", false),
    };

    record_audit(
        state,
        &policy,
        tool,
        client,
        decision,
        ok,
        started,
        arguments,
        result.as_ref().err().cloned(),
        summary,
    );

    tracing::info!(
        tool,
        client,
        ok,
        duration_ms = started.elapsed().as_millis() as u64,
        error = result.as_ref().err().map(String::as_str).unwrap_or(""),
        "mcp tool call"
    );

    result
}

fn is_write_tool(tool: &str) -> bool {
    matches!(tool, "tapd_add_bug_comment" | "tapd_update_bug_status")
}

/// Returns a user-facing reason when the policy forbids the call.
fn policy_violation(policy: &McpPolicy, tool: &str, arguments: &Value) -> Option<String> {
    if is_write_tool(tool) && !policy.writes_enabled {
        return Some("MCP 写操作已在「MCP 策略」中关闭".to_string());
    }

    if let Some(workspace_id) = string_arg(arguments, "workspace_id") {
        if !policy.allows_workspace(&workspace_id) {
            return Some(format!("项目 {workspace_id} 不在 MCP 策略允许的项目范围内"));
        }
    }

    None
}

/// Non-sensitive snapshot of the call shape for the audit table.
fn summarize_arguments(arguments: &Value) -> Value {
    let mut summary = Map::new();
    for key in [
        "workspace_id",
        "bug_id",
        "status",
        "next_status",
        "owner",
        "root",
        "model",
        "limit",
        "page",
        "only_unresolved",
        "tone",
        "waitSeconds",
    ] {
        if let Some(value) = arguments.get(key) {
            summary.insert(key.to_string(), value.clone());
        }
    }
    if let Some(comment) = arguments.get("comment").and_then(Value::as_str) {
        summary.insert(
            "commentChars".to_string(),
            Value::from(comment.chars().count() as u64),
        );
    }
    if let Some(fields) = arguments.get("fields").and_then(Value::as_array) {
        summary.insert("fields".to_string(), Value::from(fields.len() as u64));
    }
    if let Some(blocks) = arguments.get("blocks").and_then(Value::as_array) {
        summary.insert("blocks".to_string(), Value::from(blocks.len() as u64));
    }
    if let Some(actions) = arguments.get("actions").and_then(Value::as_array) {
        summary.insert("actions".to_string(), Value::from(actions.len() as u64));
    }
    if let Some(files) = arguments.get("files").and_then(Value::as_array) {
        summary.insert("files".to_string(), Value::from(files.len() as u64));
    }
    if let Some(summary_text) = arguments.get("summary").and_then(Value::as_str) {
        summary.insert(
            "summaryChars".to_string(),
            Value::from(summary_text.chars().count() as u64),
        );
    }
    Value::Object(summary)
}

#[allow(clippy::too_many_arguments)]
fn record_audit(
    state: &SharedState,
    policy: &McpPolicy,
    tool: &str,
    client: &str,
    decision: &str,
    ok: bool,
    started: Instant,
    arguments: &Value,
    error: Option<String>,
    summary: Value,
) {
    if !policy.audit_enabled {
        return;
    }

    let entry = McpAuditEntry {
        id: uuid::Uuid::new_v4().simple().to_string(),
        ts: chrono::Local::now().to_rfc3339(),
        tool: tool.to_string(),
        client: client.to_string(),
        decision: decision.to_string(),
        ok,
        duration_ms: started.elapsed().as_millis() as u64,
        workspace_id: string_arg(arguments, "workspace_id"),
        bug_id: string_arg(arguments, "bug_id"),
        error,
        summary,
    };

    if let Err(error) = state.mcp_audit.record(entry) {
        tracing::warn!(%error, "failed to persist MCP audit entry");
    }
}

async fn dispatch(
    app: &AppHandle,
    state: &SharedState,
    tool: &str,
    arguments: &Value,
    client: &str,
) -> Result<Value, String> {
    // The set of valid names comes from the shared manifest. Every manifest
    // entry must have a handler below; `dispatch_covers_every_manifest_tool`
    // fails the build if the two tables drift apart.
    if tapd_core::mcp::tool(tool).is_none() {
        return Err(format!("tool `{tool}` is not available"));
    }

    match tool {
        "tapd_whoami" => whoami(app, state, arguments).await,
        "tapd_list_projects" => list_projects(app, state).await,
        "tapd_list_bugs" => list_bugs(app, state, arguments).await,
        "tapd_list_my_bugs" => list_my_bugs(app, state, arguments).await,
        "tapd_get_bug" => get_bug(app, state, arguments).await,
        "tapd_export_bug_md" => export_bug_md(app, state, arguments).await,
        "tapd_get_bug_prompt" => get_bug_prompt(app, state, arguments).await,
        "tapd_get_bug_transitions" => get_bug_transitions(app, state, arguments).await,
        "tapd_add_bug_comment" => add_bug_comment(app, state, arguments).await,
        "tapd_update_bug_status" => update_bug_status(app, state, arguments).await,
        // External AI ownership: mutual exclusion with the local queue.
        "tapd_claim_bug" => claim_bug(app, state, arguments, client).await,
        "tapd_release_bug" => release_bug(app, state, arguments, client).await,
        // Local-only: no TAPD session or workspace scope involved.
        "tapd_notify_user" => crate::notification::mcp_notify(arguments, client).await,
        "tapd_wait_notification" => crate::notification::mcp_wait(arguments).await,
        // Local agent only: pauses the running task for a commit decision.
        "tapd_request_review" => crate::agent::request_review_from_mcp(app, arguments).await,
        // Local agent only: explicit lifecycle report for generic TUI runtimes.
        "agent_task_report" => crate::agent::task_report_from_mcp(app, arguments).await,
        // Only reachable when a manifest entry was added without a handler;
        // the manifest test below catches that case.
        other => Err(format!("tool `{other}` is not available")),
    }
}

async fn whoami(app: &AppHandle, state: &SharedState, arguments: &Value) -> Result<Value, String> {
    let (user, workspaces) = load_context(app).await?;
    let policy = state.config_snapshot().mcp_policy;
    let allowed: Vec<Workspace> = workspaces
        .into_iter()
        .filter(|workspace| policy.allows_workspace(&workspace.id))
        .collect();
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

async fn list_projects(app: &AppHandle, state: &SharedState) -> Result<Value, String> {
    let (_, workspaces) = load_context(app).await?;
    let policy = state.config_snapshot().mcp_policy;
    let allowed: Vec<Workspace> = workspaces
        .into_iter()
        .filter(|workspace| policy.allows_workspace(&workspace.id))
        .collect();
    serde_json::to_value(allowed).map_err(|error| error.to_string())
}

async fn list_bugs(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(app, state, &workspaces, arguments)?;
    let page = query_bugs(app, state, &workspace_id, arguments, false).await?;

    Ok(page_json(page, &workspace_id, &agent::external_claims(app)))
}

async fn list_my_bugs(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(app, state, &workspaces, arguments)?;
    let page = query_bugs(app, state, &workspace_id, arguments, true).await?;

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

async fn get_bug(app: &AppHandle, state: &SharedState, arguments: &Value) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(app, state, &workspaces, arguments)?;

    let detail = crate::commands::fetch_bug_detail(app, &workspace_id, &bug_id).await?;
    let mut value = serde_json::to_value(detail).map_err(|error| error.to_string())?;
    if let Some(claim) = agent::external_claim_for_bug(app, &workspace_id, &bug_id) {
        value["externalClaim"] = serde_json::to_value(claim).unwrap_or(Value::Null);
    }
    value["tapdIntegration"] = tapd_integration();
    Ok(value)
}

async fn export_bug_md(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(app, state, &workspaces, arguments)?;
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
async fn get_bug_prompt(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(app, state, &workspaces, arguments)?;
    let detail = crate::commands::fetch_bug_detail(app, &workspace_id, &bug_id).await?;
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
        crate::export::find_existing_export(
            &state.paths,
            &workspace_id,
            &crate::export::bug_reference(&detail.summary),
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
    query.owner = match owner.as_deref() {
        Some("all") | Some("") | None => None,
        Some("me") => resolve_me(app, state).await?,
        Some(nick) => Some(nick.to_string()),
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

async fn load_context(app: &AppHandle) -> Result<(Value, Vec<Workspace>), String> {
    let root = session_request_json(
        app,
        "GET",
        &user_workspace_url("0"),
        None,
        Duration::from_secs(30),
    )
    .await?;

    let user = root
        .pointer("/data/get_current_user_ret/data")
        .cloned()
        .ok_or_else(|| "unexpected identity response".to_string())?;
    let workspaces = parse_workspaces(&root)?;

    Ok((user, workspaces))
}

async fn resolve_me(app: &AppHandle, state: &SharedState) -> Result<Option<String>, String> {
    if let Some(me) = state.config_snapshot().me {
        return Ok(Some(me));
    }

    let (user, _) = load_context(app).await?;
    let nick = user
        .get("user_nick")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();

    if nick.is_empty() {
        return Ok(None);
    }

    let _ = state.update_config(|config| config.me = Some(nick.clone()));

    Ok(Some(nick))
}

fn resolve_workspace(
    app: &AppHandle,
    state: &SharedState,
    workspaces: &[Workspace],
    arguments: &Value,
) -> Result<String, String> {
    let policy = state.config_snapshot().mcp_policy;

    if let Some(workspace_id) = string_arg(arguments, "workspace_id") {
        if !workspace_id.is_empty() {
            if !policy.allows_workspace(&workspace_id) {
                return Err(format!("项目 {workspace_id} 不在 MCP 策略允许的项目范围内"));
            }
            return Ok(workspace_id);
        }
    }

    if let Some(root) = root_hint(arguments) {
        let projects = agent::mcp_agent_config(app).projects;
        match match_workspace_by_root(&projects, &root) {
            Some(workspace_id) => {
                if !workspaces
                    .iter()
                    .any(|workspace| workspace.id == workspace_id)
                {
                    return Err(format!(
                        "目录 {root} 匹配到项目 {workspace_id}，但当前账号无法访问该项目"
                    ));
                }
                if !policy.allows_workspace(&workspace_id) {
                    return Err(format!(
                        "目录 {root} 匹配到项目 {workspace_id}，但该项目不在 MCP 策略允许的项目范围内"
                    ));
                }
                return Ok(workspace_id);
            }
            // A cwd hint is best-effort; an explicit root should fail loudly.
            None if !root_is_cwd_hint(arguments) => {
                return Err(format!(
                    "无法根据目录 {root} 匹配 TAPD 项目：请在对应项目的「本地文件夹」中配置该目录，或显式传 workspace_id"
                ));
            }
            None => {}
        }
    }

    if let Some(workspace_id) = state.config_snapshot().last_workspace_id {
        if workspaces
            .iter()
            .any(|workspace| workspace.id == workspace_id)
            && policy.allows_workspace(&workspace_id)
        {
            return Ok(workspace_id);
        }
    }

    workspaces
        .iter()
        .find(|workspace| policy.allows_workspace(&workspace.id))
        .map(|workspace| workspace.id.clone())
        .ok_or_else(|| "没有符合 MCP 策略的可用项目".to_string())
}

/// Directory the caller is working in: `root` (preferred), or its aliases.
fn root_hint(arguments: &Value) -> Option<String> {
    ["root", "repo_path", "repoPath", "cwd"]
        .iter()
        .find_map(|key| string_arg(arguments, key))
}

/// The sidecar marks a `root` it filled from its own process cwd. Such a hint
/// may fall back to the last selected project instead of failing.
fn root_is_cwd_hint(arguments: &Value) -> bool {
    string_arg(arguments, "rootSource").as_deref() == Some("cwd")
}

/// Resolves the project whose configured repository contains (or is contained
/// by) `root`. Exact matches win, then the closest surrounding project. A
/// parent root only matches when exactly one project lives beneath it, so a
/// shared parent never picks a sibling project by accident.
fn match_workspace_by_root(
    projects: &BTreeMap<String, ProjectAgentConfig>,
    root: &str,
) -> Option<String> {
    let root = normalize_path(root)?;
    let mut exact: Vec<&str> = Vec::new();
    let mut around: Vec<(&str, usize)> = Vec::new();
    let mut contains: Vec<(&str, usize)> = Vec::new();

    for (workspace_id, project) in projects {
        let Some(repo) = normalize_path(&project.repo_path) else {
            continue;
        };
        let len = repo.as_os_str().len();
        if repo == root {
            exact.push(workspace_id.as_str());
        } else if is_inside(&root, &repo) {
            // The caller works inside this repo.
            around.push((workspace_id.as_str(), len));
        } else if is_inside(&repo, &root) {
            // This repo lives inside the caller's directory.
            contains.push((workspace_id.as_str(), len));
        }
    }

    if !exact.is_empty() {
        return match exact.as_slice() {
            [workspace_id] => Some((*workspace_id).to_string()),
            _ => None,
        };
    }

    // A single nested project is a real match; several siblings are ambiguous.
    if let [project] = contains.as_slice() {
        around.push(*project);
    }

    let deepest = around.iter().map(|(_, len)| *len).max()?;
    let winners: Vec<&str> = around
        .iter()
        .filter(|(_, len)| *len == deepest)
        .map(|(workspace_id, _)| *workspace_id)
        .collect();

    match winners.as_slice() {
        [workspace_id] => Some((*workspace_id).to_string()),
        _ => None,
    }
}

/// Canonical form when possible (resolves `/var` vs `/private/var` and
/// symlinks); falls back to a lexical trim so non-existent paths still compare.
fn normalize_path(value: &str) -> Option<PathBuf> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let expanded = tapd_core::paths::expand_home(value);

    if let Ok(canonical) = expanded.canonicalize() {
        return Some(canonical);
    }

    let trimmed = expanded.to_string_lossy();
    let trimmed = trimmed.trim_end_matches('/');
    let trimmed = if trimmed.is_empty() { "/" } else { trimmed };
    Some(PathBuf::from(trimmed))
}

/// Component-wise containment, so `/repo/app2` is not inside `/repo/app`.
fn is_inside(child: &Path, parent: &Path) -> bool {
    child != parent && child.starts_with(parent)
}

// ---------------------------------------------------------------------------
// Write-back tools (comments / status)
// ---------------------------------------------------------------------------

async fn get_bug_transitions(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(app, state, &workspaces, arguments)?;

    let info = load_transition_info(app, &workspace_id, &bug_id).await?;
    let transitions: Vec<Value> = info
        .transitions
        .iter()
        .map(|(key, label)| json!({ "key": key, "label": label }))
        .collect();

    Ok(json!({
        "bugId": bug_id,
        "currentStatus": info.current_status,
        "currentLabel": info.status_alias.get(&info.current_status),
        "statusOptions": info.status_alias,
        "transitions": transitions,
    }))
}

async fn add_bug_comment(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let comment = string_arg(arguments, "comment")
        .or_else(|| string_arg(arguments, "body"))
        .ok_or_else(|| "comment is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(app, state, &workspaces, arguments)?;

    let data = add_comment(app, &workspace_id, &bug_id, &comment).await?;
    Ok(json!({
        "ok": true,
        "bugId": bug_id,
        "comment": data,
    }))
}

async fn update_bug_status(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let target_input = string_arg(arguments, "status")
        .or_else(|| string_arg(arguments, "next_status"))
        .ok_or_else(|| "status is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(app, state, &workspaces, arguments)?;
    // The working accept workflow sends an empty array; keep the same shape
    // unless the caller supplies explicit transition fields.
    let fields = arguments
        .get("fields")
        .cloned()
        .unwrap_or_else(|| json!([]));

    // Comment first so a rejected transition still leaves the reason on record.
    let comment = string_arg(arguments, "comment");
    if let Some(comment) = comment.as_deref() {
        add_comment(app, &workspace_id, &bug_id, comment).await?;
    }

    let info = load_transition_info(app, &workspace_id, &bug_id).await?;
    let target = resolve_status_key(&target_input, &info)?;
    let policy = state.config_snapshot().mcp_policy;
    if !policy.allowed_statuses.is_empty()
        && !policy.allows_status(&target)
        && !policy.allows_status(&target_input)
    {
        return Err(format!(
            "状态「{}」不在 MCP 策略的状态白名单中",
            target_input
        ));
    }

    let outcome =
        bug_write::perform_transition(app, &workspace_id, &bug_id, &target, &fields).await?;

    Ok(json!({
        "ok": true,
        "bugId": bug_id,
        "from": outcome.original_status,
        "status": outcome.status,
        "label": outcome.label,
        "changed": !outcome.steps.is_empty(),
        "steps": outcome.steps,
        "commented": comment.is_some(),
    }))
}

// ---------------------------------------------------------------------------
// External AI ownership (claim / release)
// ---------------------------------------------------------------------------

/// Registers an external AI claim so the desktop queue yields the bug and the
/// list shows who is working on it.
async fn claim_bug(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
    client: &str,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(app, state, &workspaces, arguments)?;

    let request = agent::ExternalClaimRequest {
        workspace_id,
        bug_id,
        title: string_arg(arguments, "title").unwrap_or_default(),
        client: client.to_string(),
        model: string_arg(arguments, "model").unwrap_or_default(),
        status: string_arg(arguments, "status").unwrap_or_default(),
        note: string_arg(arguments, "note").unwrap_or_default(),
    };
    agent::claim_external_from_mcp(app, request).await
}

async fn release_bug(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
    client: &str,
) -> Result<Value, String> {
    let bug_id = string_arg(arguments, "bug_id").ok_or_else(|| "bug_id is required".to_string())?;
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(app, state, &workspaces, arguments)?;

    agent::release_external_from_mcp(
        app,
        agent::ExternalReleaseRequest {
            workspace_id,
            bug_id,
            client: Some(client.to_string()),
        },
    )
}

fn default_workspace_id(
    state: &SharedState,
    workspaces: &[Workspace],
    policy: &McpPolicy,
) -> Option<String> {
    state
        .config_snapshot()
        .last_workspace_id
        .filter(|id| {
            workspaces.iter().any(|workspace| &workspace.id == id) && policy.allows_workspace(id)
        })
        .or_else(|| {
            workspaces
                .iter()
                .find(|workspace| policy.allows_workspace(&workspace.id))
                .map(|workspace| workspace.id.clone())
        })
}

fn string_arg(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn string_array(arguments: &Value, key: &str) -> Vec<String> {
    arguments
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod policy_tests {
    use super::{
        match_workspace_by_root, policy_violation, root_hint, root_is_cwd_hint,
        summarize_arguments, tapd_integration, MCP_PROMPT_TEMPLATE,
    };
    use crate::agent::{render_prompt, ProjectAgentConfig, PromptVars};
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::path::Path;
    use tapd_core::config::McpPolicy;

    #[test]
    fn writes_can_be_disabled() {
        let args = json!({ "bug_id": "1", "comment": "hello" });
        let mut policy = McpPolicy::default();
        assert!(policy_violation(&policy, "tapd_add_bug_comment", &args).is_none());

        policy.writes_enabled = false;
        assert!(policy_violation(&policy, "tapd_add_bug_comment", &args).is_some());
        // Read tools stay available.
        assert!(policy_violation(&policy, "tapd_get_bug", &args).is_none());
    }

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
    fn project_allowlist_is_enforced() {
        let policy = McpPolicy {
            allowed_workspace_ids: vec!["45336192".to_string()],
            ..McpPolicy::default()
        };
        assert!(policy_violation(
            &policy,
            "tapd_get_bug",
            &json!({ "workspace_id": "45336192" })
        )
        .is_none());
        assert!(
            policy_violation(&policy, "tapd_get_bug", &json!({ "workspace_id": "999" })).is_some()
        );
    }

    #[test]
    fn audit_summary_never_contains_comment_text() {
        let summary = summarize_arguments(&json!({
            "bug_id": "1",
            "comment": "secret body",
            "status": "resolved"
        }));
        assert_eq!(summary["bug_id"], "1");
        assert_eq!(summary["status"], "resolved");
        assert_eq!(summary["commentChars"], 11);
        assert!(summary.get("comment").is_none());
    }

    fn project(repo_path: &Path) -> ProjectAgentConfig {
        ProjectAgentConfig {
            repo_path: repo_path.to_string_lossy().to_string(),
            rule: String::new(),
        }
    }

    #[test]
    fn matches_project_by_exact_nested_and_ambiguous_roots() {
        let base = std::env::temp_dir().join(format!("tapd-root-{}", uuid::Uuid::new_v4()));
        let repo = base.join("repo");
        let nested = repo.join("apps").join("desktop");
        let other = base.join("other");
        std::fs::create_dir_all(&nested).expect("nested dir");
        std::fs::create_dir_all(&other).expect("other dir");

        let mut projects = BTreeMap::new();
        projects.insert("111".to_string(), project(&repo));
        projects.insert("222".to_string(), project(&other));

        let lookup = |path: &Path| match_workspace_by_root(&projects, &path.to_string_lossy());
        assert_eq!(lookup(&repo).as_deref(), Some("111"));
        assert_eq!(lookup(&nested).as_deref(), Some("111"));
        // Two configured repos sit under `base`, so a parent root is ambiguous.
        assert_eq!(lookup(&base), None);
        assert_eq!(match_workspace_by_root(&projects, "/no/such/dir"), None);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn deepest_project_wins_when_repos_nest() {
        let base = std::env::temp_dir().join(format!("tapd-nest-{}", uuid::Uuid::new_v4()));
        let outer = base.join("monorepo");
        let inner = outer.join("apps").join("web");
        std::fs::create_dir_all(&inner).expect("inner dir");

        let mut projects = BTreeMap::new();
        projects.insert("outer".to_string(), project(&outer));
        projects.insert("inner".to_string(), project(&inner));

        let root = inner.join("src");
        std::fs::create_dir_all(&root).expect("src dir");
        assert_eq!(
            match_workspace_by_root(&projects, &root.to_string_lossy()).as_deref(),
            Some("inner")
        );

        // A project nested under the caller's directory still beats the parent
        // repo the caller is also inside.
        let apps = outer.join("apps");
        assert_eq!(
            match_workspace_by_root(&projects, &apps.to_string_lossy()).as_deref(),
            Some("inner")
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn root_hint_reads_aliases_and_marks_cwd_source() {
        assert_eq!(root_hint(&json!({ "root": "/a" })).as_deref(), Some("/a"));
        assert_eq!(
            root_hint(&json!({ "repo_path": "/b" })).as_deref(),
            Some("/b")
        );
        assert_eq!(root_hint(&json!({ "cwd": " " })), None);
        assert!(root_is_cwd_hint(&json!({ "rootSource": "cwd" })));
        assert!(!root_is_cwd_hint(&json!({ "root": "/a" })));
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

#[cfg(test)]
mod manifest_tests {
    use tapd_core::mcp;

    /// Mirrors the arms in [`super::dispatch`]. The test below fails when this
    /// list and `tapd_core::mcp::TOOLS` drift apart in either direction.
    const DISPATCHED_TOOLS: [&str; 16] = [
        "tapd_whoami",
        "tapd_list_projects",
        "tapd_list_bugs",
        "tapd_list_my_bugs",
        "tapd_get_bug",
        "tapd_export_bug_md",
        "tapd_get_bug_prompt",
        "tapd_get_bug_transitions",
        "tapd_add_bug_comment",
        "tapd_update_bug_status",
        "tapd_claim_bug",
        "tapd_release_bug",
        "tapd_notify_user",
        "tapd_wait_notification",
        "tapd_request_review",
        "agent_task_report",
    ];

    #[test]
    fn dispatch_covers_every_manifest_tool() {
        let manifest: Vec<&str> = mcp::names().collect();
        assert_eq!(manifest.len(), DISPATCHED_TOOLS.len());

        for name in &manifest {
            assert!(
                DISPATCHED_TOOLS.contains(name),
                "manifest tool `{name}` has no dispatch arm"
            );
        }
        for name in DISPATCHED_TOOLS {
            assert!(
                mcp::tool(name).is_some(),
                "dispatch arm `{name}` is missing from tapd_core::mcp::TOOLS"
            );
        }
    }
}
