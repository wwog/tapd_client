//! `local_*` feature commands.
//!
//! Every command is routed through `feature_router::dispatch`, so the desktop
//! feature windows and the paired phone share one surface. SQLite and
//! directory IO hop to `spawn_blocking`: the async command path never blocks
//! the runtime on disk.

use std::path::Path;

use serde_json::{json, Value};
use tapd_i18n::{tr, tr_args};
use tauri::AppHandle;

use crate::state::SharedState;

use super::store::now_rfc3339;

pub async fn dispatch(
    app: &AppHandle,
    state: &SharedState,
    name: &str,
    payload: Value,
) -> Result<Value, String> {
    match name {
        "local_projects_list" => projects_list(state).await,
        "local_project_create" => project_create(state, &payload).await,
        "local_project_update" => project_update(state, &payload).await,
        "local_project_delete" => project_delete(state, &payload).await,
        "local_items_list" => items_list(state, &payload).await,
        "local_item_create" => item_create(state, &payload).await,
        "local_item_update" => item_update(state, &payload).await,
        "local_item_delete" => item_delete(state, &payload).await,
        "local_item_enqueue" => item_enqueue(app, state, &payload).await,
        "local_browse_dirs" => browse_dirs(state, &payload).await,
        other => Err(format!("unknown local command: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

async fn projects_list(state: &SharedState) -> Result<Value, String> {
    let store = state.local.clone();
    let projects = blocking(move || store.projects()).await?;
    Ok(json!({ "projects": projects }))
}

async fn project_create(state: &SharedState, payload: &Value) -> Result<Value, String> {
    let repo_path = required_str(payload, "repoPath")?;
    let name = optional_str(payload, "name").filter(|name| !name.is_empty());
    let rule = optional_str(payload, "rule");
    let store = state.local.clone();
    let project =
        blocking(move || store.create_project(name.as_deref(), &repo_path, rule.as_deref()))
            .await?;
    Ok(json!({ "project": project }))
}

async fn project_update(state: &SharedState, payload: &Value) -> Result<Value, String> {
    let id = required_str(payload, "id")?;
    let name = optional_str(payload, "name");
    let repo_path = optional_str(payload, "repoPath");
    // An empty rule is meaningful (the user cleared it), so it is not filtered
    // like an empty name would be.
    let rule = payload
        .get("rule")
        .and_then(Value::as_str)
        .map(str::to_string);
    let store = state.local.clone();
    let project = blocking(move || {
        store.update_project(&id, name.as_deref(), repo_path.as_deref(), rule.as_deref())
    })
    .await?;
    Ok(json!({ "project": project }))
}

async fn project_delete(state: &SharedState, payload: &Value) -> Result<Value, String> {
    let id = required_str(payload, "id")?;
    let store = state.local.clone();
    blocking(move || store.delete_project(&id)).await?;
    Ok(json!({ "deleted": true }))
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

async fn items_list(state: &SharedState, payload: &Value) -> Result<Value, String> {
    let project_id = required_str(payload, "projectId")?;
    let store = state.local.clone();
    let items = blocking(move || store.items(&project_id)).await?;
    Ok(json!({ "items": items }))
}

async fn item_create(state: &SharedState, payload: &Value) -> Result<Value, String> {
    let project_id = required_str(payload, "projectId")?;
    let title = required_str(payload, "title")?;
    let description = optional_str(payload, "description");
    let store = state.local.clone();
    let item =
        blocking(move || store.create_item(&project_id, &title, description.as_deref())).await?;
    Ok(json!({ "item": item }))
}

async fn item_update(state: &SharedState, payload: &Value) -> Result<Value, String> {
    let id = required_str(payload, "id")?;
    let title = optional_str(payload, "title");
    // An empty description is meaningful (the user cleared it), so it is not
    // filtered like an empty name would be.
    let description = payload
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string);
    let status = optional_str(payload, "status");
    let store = state.local.clone();
    let item = blocking(move || {
        store.update_item(
            &id,
            title.as_deref(),
            description.as_deref(),
            status.as_deref(),
        )
    })
    .await?;
    Ok(json!({ "item": item }))
}

async fn item_delete(state: &SharedState, payload: &Value) -> Result<Value, String> {
    let id = required_str(payload, "id")?;
    let store = state.local.clone();
    blocking(move || store.delete_item(&id)).await?;
    Ok(json!({ "deleted": true }))
}

/// Enqueues an agent task for one item.
///
/// The task is created first; the item is only linked after `enqueue_local`
/// succeeds. A rejected enqueue therefore leaves the item exactly as it was.
async fn item_enqueue(
    app: &AppHandle,
    state: &SharedState,
    payload: &Value,
) -> Result<Value, String> {
    let id = required_str(payload, "id")?;
    let extra_prompt = optional_str(payload, "extraPrompt");
    let runtime_id = optional_str(payload, "runtimeId");
    let model = optional_str(payload, "model");
    let permission_mode = optional_str(payload, "permissionMode");
    let attachments = payload
        .get("attachments")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        });

    let store = state.local.clone();
    let (item, project) = blocking(move || store.item_with_project(&id)).await?;

    let request = crate::agent::LocalEnqueueRequest {
        project_id: project.id.clone(),
        project_name: project.name.clone(),
        work_item_id: item.id.clone(),
        title: item.title.clone(),
        description: item.description.clone(),
        repo_path: project.repo_path.clone(),
        project_rule: project.rule.clone(),
        created_at: item.created_at.clone(),
        extra_prompt,
        attachments,
        runtime_id,
        model,
        permission_mode,
        source: Some("local".to_string()),
    };
    let task = crate::agent::enqueue_local(app, state, request).await?;

    let now = now_rfc3339();
    let store = state.local.clone();
    let item_id = item.id.clone();
    let task_id = task.id.clone();
    let item = blocking(move || store.attach_task(&item_id, &task_id, &now)).await?;
    Ok(json!({ "task": task, "item": item }))
}

// ---------------------------------------------------------------------------
// Directory browse (the phone may call this)
// ---------------------------------------------------------------------------

/// Lists directories for the local-project picker, then enforces the same
/// allowlist the phone must respect: the home folder or an existing local
/// project repository. This endpoint must never become arbitrary filesystem
/// browsing.
async fn browse_dirs(state: &SharedState, payload: &Value) -> Result<Value, String> {
    let requested = optional_str(payload, "path");
    // Check before listing: otherwise a forbidden path could still reveal its
    // entries through error timing even though the response is rejected.
    if let Some(path) = requested.as_deref().filter(|path| !path.is_empty()) {
        let expanded = tapd_core::paths::expand_home(path);
        ensure_browsable(state, &expanded.to_string_lossy())?;
    }
    let listing = blocking(move || crate::commands::list_dirs(requested)).await?;
    let listing =
        serde_json::to_value(listing).map_err(|error| tr_args("local.store.failed", &[&error]))?;
    let path = listing
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    ensure_browsable(state, &path)?;

    // At an allowlist root the real parent is outside the sandbox; returning
    // null keeps the picker's "up" button from offering a forbidden folder.
    let parent = listing
        .get("parent")
        .and_then(Value::as_str)
        .filter(|parent| ensure_browsable(state, parent).is_ok())
        .map(|parent| Value::String(parent.to_string()))
        .unwrap_or(Value::Null);
    let entries = listing.get("entries").cloned().unwrap_or_else(|| json!([]));
    Ok(json!({ "path": path, "parent": parent, "entries": entries }))
}

/// Rejects a listed directory unless it is inside the home folder or inside a
/// local project. `Path::starts_with` compares whole components, so
/// `/Users/me2` is not accepted for `/Users/me`.
fn ensure_browsable(state: &SharedState, path: &str) -> Result<(), String> {
    let target = Path::new(path)
        .canonicalize()
        .map_err(|_| tr("local.browse.forbidden").to_string())?;
    let mut roots = Vec::new();
    if let Ok(home) = tapd_core::paths::home_dir() {
        if let Ok(home) = home.canonicalize() {
            roots.push(home);
        }
    }
    // An unavailable store narrows browsing to home instead of opening it up.
    for repo_path in state.local.repo_paths().unwrap_or_default() {
        if let Ok(root) = Path::new(&repo_path).canonicalize() {
            roots.push(root);
        }
    }
    if is_browsable(&target, &roots) {
        Ok(())
    } else {
        Err(tr("local.browse.forbidden").to_string())
    }
}

/// Pure containment rule for the browse boundary: a target is allowed when it
/// is one of the roots or lives below one of them.
fn is_browsable(target: &Path, roots: &[std::path::PathBuf]) -> bool {
    roots.iter().any(|root| target.starts_with(root))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Runs one store or filesystem operation off the async runtime.
async fn blocking<T: Send + 'static>(
    run: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(run)
        .await
        .map_err(|error| tr_args("local.store.failed", &[&error]))?
}

fn optional_str(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
}

/// A field the command cannot work without. Only presence is enforced here;
/// an empty value is a domain error (`local.project.path`, `local.item.title`,
/// ...), so the message names the actual problem.
fn required_str(payload: &Value, key: &str) -> Result<String, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| tr_args("local.request.missing", &[&key]))
}

#[cfg(test)]
mod tests {
    use super::is_browsable;
    use std::path::{Path, PathBuf};

    #[test]
    fn browse_allowlist_compares_path_components() {
        let roots = vec![PathBuf::from("/Users/me"), PathBuf::from("/repos/notes")];

        assert!(is_browsable(Path::new("/Users/me"), &roots));
        assert!(is_browsable(Path::new("/Users/me/code/app"), &roots));
        assert!(is_browsable(Path::new("/repos/notes/src"), &roots));

        // `/Users/me2` only shares a string prefix with `/Users/me`.
        assert!(!is_browsable(Path::new("/Users/me2"), &roots));
        assert!(!is_browsable(Path::new("/repos"), &roots));
        assert!(!is_browsable(Path::new("/etc"), &roots));
    }
}
