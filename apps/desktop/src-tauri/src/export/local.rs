//! Local work-item package: the single file an agent reads for a local task.
//!
//! Local projects have no TAPD counterpart, so there is no bug fetch and no
//! media download — only the item fields the user typed in the client. The
//! built-in agent flow calls this when a local item is handed to a session.

use std::path::PathBuf;

use serde::Serialize;
use tapd_core::{export::ascii_slug, paths::AppPaths};

/// Content of `quest.json`. Camel-case keys match the rest of the payload the
/// agent reads; the description is the work item text plus any compose-sheet
/// notes, so the package carries one description and not two.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalExportDocument {
    pub id: String,
    pub title: String,
    pub description: String,
    /// `low` / `normal` / `high`; the agent reads it from the package.
    pub importance: String,
    pub project_id: String,
    pub project_name: String,
    pub repo_path: String,
    /// Project rules the agent must follow; also appended to the prompt.
    pub project_rule: String,
    pub created_at: String,
}

/// Writes `<exports>/<project slug>/<item ref>/quest.json` atomically and
/// returns the file path.
pub(crate) fn run_local_export(
    paths: &AppPaths,
    doc: &LocalExportDocument,
) -> Result<PathBuf, String> {
    let path = local_export_dir(paths, doc).join("quest.json");
    tapd_core::store::write_json_atomic(&path, doc).map_err(|error| error.to_string())?;
    Ok(path)
}

/// Directory for one work item. Both components are ASCII-only so the path
/// stays portable; a component without usable ASCII falls back to the id (or a
/// fixed token) instead of producing an empty directory name.
pub(crate) fn local_export_dir(paths: &AppPaths, doc: &LocalExportDocument) -> PathBuf {
    let project = {
        let slug = ascii_slug(&doc.project_name);
        if slug.is_empty() {
            ascii_component(&doc.project_id, "local")
        } else {
            slug
        }
    };
    paths
        .exports_dir
        .join(project)
        .join(ascii_component(&doc.id, "item"))
}

fn ascii_component(value: &str, fallback: &str) -> String {
    let slug = ascii_slug(value);
    if slug.is_empty() {
        fallback.to_string()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn doc() -> LocalExportDocument {
        LocalExportDocument {
            id: "wi-7f3a91".to_string(),
            title: "修复登录页错位".to_string(),
            description: "登录按钮在小屏上溢出\n\n顺带核对错误提示".to_string(),
            importance: "high".to_string(),
            project_id: "proj-local-1".to_string(),
            project_name: "本地项目".to_string(),
            repo_path: "/repos/app".to_string(),
            project_rule: "先跑 cargo test".to_string(),
            created_at: "2026-11-16T00:00:00Z".to_string(),
        }
    }

    fn paths(export_root: &str) -> AppPaths {
        AppPaths {
            data_dir: PathBuf::from("/tmp/tapd"),
            logs_dir: PathBuf::from("/tmp/tapd/logs"),
            captures_dir: PathBuf::from("/tmp/tapd/captures"),
            exports_dir: PathBuf::from(export_root),
            worktrees_dir: PathBuf::from("/tmp/tapd/worktrees"),
            runtime_file: PathBuf::from("/tmp/tapd/runtime.json"),
            config_file: PathBuf::from("/tmp/tapd/config.json"),
        }
    }

    #[test]
    fn export_path_is_ascii_and_uses_fallbacks() {
        let dir = local_export_dir(&paths("/exports"), &doc());
        assert_eq!(
            dir,
            PathBuf::from("/exports/proj-local-1/wi-7f3a91"),
            "a non-ASCII project name falls back to its id"
        );
        assert!(dir
            .components()
            .all(|component| component.as_os_str().to_str().is_some_and(str::is_ascii)));
        assert_eq!(dir.join("quest.json").file_name().unwrap(), "quest.json");
    }

    #[test]
    fn export_path_keeps_the_project_name_slug() {
        let mut doc = doc();
        doc.project_name = "Local App".to_string();
        let dir = local_export_dir(&paths("/exports"), &doc);
        assert_eq!(dir, PathBuf::from("/exports/Local-App/wi-7f3a91"));
    }

    #[test]
    fn quest_json_is_camel_case_pretty_json() {
        let root = std::env::temp_dir().join(format!(
            "tapd-local-export-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let path = run_local_export(&paths(root.to_str().unwrap()), &doc()).expect("export");
        let raw = std::fs::read_to_string(&path).expect("read quest.json");
        assert!(raw.starts_with("{\n"), "pretty JSON");
        let json: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(json["id"], "wi-7f3a91");
        assert_eq!(json["projectId"], "proj-local-1");
        assert_eq!(json["repoPath"], "/repos/app");
        assert_eq!(json["projectRule"], "先跑 cargo test");
        assert_eq!(json["importance"], "high");
        assert_eq!(json["title"], "修复登录页错位");
        assert!(json.get("project_id").is_none(), "keys are camelCase");
        assert_eq!(
            Path::new(&path).parent().map(Path::to_path_buf),
            Some(local_export_dir(&paths(root.to_str().unwrap()), &doc()))
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
