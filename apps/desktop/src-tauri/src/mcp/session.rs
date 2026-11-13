//! TAPD session context and project selection.
//!
//! Every TAPD-backed tool starts by loading the current user + workspace list
//! and resolving *which* project the call targets: an explicit id, a local
//! repository hint, the last selected project, or the first policy-allowed one.
//! That precedence is user-visible, so it lives in exactly one place.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

use serde_json::Value;
use tapd_core::{
    config::McpPolicy,
    tapd::{
        api::{parse_workspaces, user_workspace_url},
        Workspace,
    },
};
use tapd_i18n::{tr, tr_args};
use tauri::AppHandle;

use crate::{agent, commands::auth::session_request_json, state::SharedState};

use super::args::{root_hint, root_is_cwd_hint, string_arg};

/// Loads the identity response: the current TAPD user plus every workspace it
/// can reach.
pub(super) async fn load_context(app: &AppHandle) -> Result<(Value, Vec<Workspace>), String> {
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

/// Loads the identity context and resolves the project this call targets.
///
/// Handlers that need both get them in the same order the individual steps
/// used to run: context first, then the workspace, then their own work.
pub(super) async fn resolve_call_workspace(
    app: &AppHandle,
    state: &SharedState,
    arguments: &Value,
) -> Result<(String, Vec<Workspace>), String> {
    let (_, workspaces) = load_context(app).await?;
    let workspace_id = resolve_workspace(app, state, &workspaces, arguments)?;
    Ok((workspace_id, workspaces))
}

/// Workspaces the MCP policy allows, keeping the TAPD order.
pub(super) fn allowed_workspaces(policy: &McpPolicy, workspaces: Vec<Workspace>) -> Vec<Workspace> {
    workspaces
        .into_iter()
        .filter(|workspace| policy.allows_workspace(&workspace.id))
        .collect()
}

pub(super) async fn resolve_me(
    app: &AppHandle,
    state: &SharedState,
) -> Result<Option<String>, String> {
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

/// Resolves the project for a call.
///
/// Precedence: explicit `workspace_id`, then a `root`/cwd hint matched against
/// the configured local folders, then the last selected project, then the
/// first allowed one. A hint the sidecar filled from its own cwd is
/// best-effort; an explicit root fails loudly.
pub(super) fn resolve_workspace(
    app: &AppHandle,
    state: &SharedState,
    workspaces: &[Workspace],
    arguments: &Value,
) -> Result<String, String> {
    let policy = state.config_snapshot().mcp_policy;

    if let Some(workspace_id) = string_arg(arguments, "workspace_id") {
        if !workspace_id.is_empty() {
            if !policy.allows_workspace(&workspace_id) {
                return Err(tr_args("app.mcp.project.allowed",
                    &[&workspace_id],
                ));
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
                    return Err(tr_args("app.mcp.project.access",
                        &[&root, &workspace_id],
                    ));
                }
                if !policy.allows_workspace(&workspace_id) {
                    return Err(tr_args("app.mcp.project.folder",
                        &[&root, &workspace_id],
                    ));
                }
                return Ok(workspace_id);
            }
            None if !root_is_cwd_hint(arguments) => {
                return Err(tr_args("app.mcp.folder.unmatched",
                    &[&root],
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
        .ok_or_else(|| tr("app.mcp.no.project").to_string())
}

/// Default project reported by `tapd_whoami`: the last selected one when it is
/// still reachable, otherwise the first allowed project.
pub(super) fn default_workspace_id(
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

/// Resolves the project whose configured repository contains (or is contained
/// by) `root`. Exact matches win, then the closest surrounding project. A
/// parent root only matches when exactly one project lives beneath it, so a
/// shared parent never picks a sibling project by accident.
pub(super) fn match_workspace_by_root(
    projects: &BTreeMap<String, agent::ProjectAgentConfig>,
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

#[cfg(test)]
mod tests {
    use super::match_workspace_by_root;
    use crate::agent::ProjectAgentConfig;
    use std::collections::BTreeMap;
    use std::path::Path;

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
}
