//! 内置 Agent 的持久配置。
//!
//! 这里只保留**跨运行时仍然有意义**的三类事实：
//! - 每个 TAPD 项目对应的本地仓库路径与项目规则（MCP 匹配 `root`、内置 Agent 的
//!   working directory 都用它）；
//! - 提示词模板（缺陷修复、提交、合并、本地事项）；
//! - Git worktree 隔离与并行执行单元；以及用户启用的同事。
//!
//! 旧的外置 CLI 流程里的运行时、可执行路径、默认模型、访问权限、TUI 就绪 /
//! 静默阈值全部删除：内置 dsh 运行时的模型与权限在 `docs/DSH.md` 描述的
//! profile / 会话层配置，不再落到这个文件。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tapd_core::store::{read_json, write_json_atomic};
use tapd_i18n::{tr, tr_args};

const CONFIG_FILE: &str = "agent.json";

pub const DEFAULT_PROMPT_KEY: &str = "agent.prompt.default";

/// Per-project agent settings, edited from the project card.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectAgentConfig {
    /// Absolute local repository path used as the agent's working directory.
    pub repo_path: String,
    /// Project-specific rules. Not part of the built-in prompt: `tapd_get_bug`
    /// returns them as its own `projectRule` field for external agents.
    pub rule: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfig {
    /// Legacy map kept only for migration; use `projects` instead.
    pub repo_mappings: BTreeMap<String, String>,
    /// TAPD workspace id -> repository path + project rules.
    pub projects: BTreeMap<String, ProjectAgentConfig>,
    pub prompt_template: String,
    /// Enabled coworkers from the bundled registry, in selection order. Their
    /// roles and skill packages are appended to every task prompt.
    pub coworker_ids: Vec<String>,
    /// 每个任务在独立的 git worktree 中运行。关闭时并发固定为 1。
    #[serde(default)]
    pub worktree_enabled: bool,
    /// 同时运行的任务数；仅在开启 worktree 时生效。
    #[serde(default = "default_execution_units")]
    pub execution_units: u32,
}

/// Worktree 开启后默认并行两个任务：再多也不利于排查。
fn default_execution_units() -> u32 {
    2
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            repo_mappings: BTreeMap::new(),
            projects: BTreeMap::new(),
            prompt_template: tr(DEFAULT_PROMPT_KEY).to_string(),
            coworker_ids: Vec::new(),
            worktree_enabled: false,
            execution_units: default_execution_units(),
        }
    }
}

impl AgentConfig {
    fn sanitized(mut self) -> Self {
        if self.prompt_template.trim().is_empty()
            || template_uses_removed_contract(&self.prompt_template)
        {
            self.prompt_template = tr(DEFAULT_PROMPT_KEY).to_string();
        }

        self.coworker_ids = normalize_coworker_ids(std::mem::take(&mut self.coworker_ids));
        self.execution_units = self.execution_units.clamp(1, 8);

        // Migrate the old id -> path map into per-project settings once.
        for (workspace_id, path) in std::mem::take(&mut self.repo_mappings) {
            let path = path.trim().to_string();
            if path.is_empty() {
                continue;
            }
            self.projects
                .entry(workspace_id)
                .or_insert_with(ProjectAgentConfig::default)
                .repo_path = path;
        }

        self.projects = self
            .projects
            .into_iter()
            .map(|(workspace_id, project)| {
                let repo_path = project.repo_path.trim().to_string();
                let rule = project.rule.trim().to_string();
                (workspace_id, ProjectAgentConfig { repo_path, rule })
            })
            .filter(|(_, project)| !project.repo_path.is_empty() || !project.rule.is_empty())
            .collect();

        self
    }

    /// How many tasks may run in parallel. Without worktree isolation the
    /// tasks would share one working tree, so the queue stays serial.
    ///
    /// Used by the worktree task flow (P4); kept here so the rule lives with
    /// the settings it depends on.
    #[allow(dead_code)]
    pub(crate) fn effective_execution_units(&self) -> usize {
        if self.worktree_enabled {
            self.execution_units.clamp(1, 8) as usize
        } else {
            1
        }
    }
}

fn config_file(data_dir: &Path) -> PathBuf {
    data_dir.join(CONFIG_FILE)
}

/// Reads the settings file. Missing or malformed files yield defaults; the
/// caller never has to distinguish "fresh install" from "user cleared it".
pub fn load(data_dir: &Path) -> AgentConfig {
    read_json::<AgentConfig>(&config_file(data_dir))
        .unwrap_or_default()
        .sanitized()
}

pub fn save(data_dir: &Path, config: &AgentConfig) -> std::io::Result<()> {
    write_json_atomic(&config_file(data_dir), &config.clone().sanitized())
}

/// Snapshot for callers that only hold an `AppHandle` (MCP bridge, fs, export).
pub fn config_for(app: &tauri::AppHandle) -> AgentConfig {
    use tauri::Manager;
    app.try_state::<std::sync::Arc<crate::state::AppState>>()
        .map(|state| load(&state.paths.data_dir))
        .unwrap_or_default()
}

/// Persists settings through the `AppHandle` path used by feature commands.
pub fn save_for(app: &tauri::AppHandle, config: &AgentConfig) -> Result<AgentConfig, String> {
    use tauri::Manager;
    let state = app
        .try_state::<std::sync::Arc<crate::state::AppState>>()
        .ok_or_else(|| "app state unavailable".to_string())?;
    save(&state.paths.data_dir, config).map_err(|error| error.to_string())?;
    Ok(load(&state.paths.data_dir))
}


/// Backwards-compatible name used by the MCP bridge and project-root matching.
pub fn mcp_agent_config(app: &tauri::AppHandle) -> AgentConfig {
    config_for(app)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Current settings. The editor lives in the project card / agent settings
/// page; the built-in runtime reads the same file.
#[tauri::command]
pub async fn agent_settings_get(app: tauri::AppHandle) -> Result<AgentConfig, String> {
    Ok(config_for(&app))
}

/// Replaces the settings. The saved value is sanitized (legacy prompt
/// contracts, empty project entries, unit bounds).
#[tauri::command]
pub async fn agent_settings_set(
    app: tauri::AppHandle,
    config: AgentConfig,
) -> Result<AgentConfig, String> {
    save_for(&app, &config)
}

// ---------------------------------------------------------------------------
// Feature-command surface (companion / paired phone)
// ---------------------------------------------------------------------------

/// `settings_agent_get` / `settings_agent_set` over `feature_command`.
///
/// The phone may edit worktree isolation and execution units; the desktop's
/// prompt template and project rules stay desktop-only.
pub async fn command(
    app: &tauri::AppHandle,
    name: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use serde_json::json;

    match name {
        "settings_agent_get" => Ok(json!({ "config": config_for(app) })),
        "settings_agent_set" => {
            let patch: Patch = serde_json::from_value(payload)
                .map_err(|error| error.to_string())?;
            if patch.worktree_enabled.is_none() && patch.execution_units.is_none() {
                return Err("no supported field".to_string());
            }
            let mut config = config_for(app);
            if let Some(enabled) = patch.worktree_enabled {
                config.worktree_enabled = enabled;
            }
            if let Some(units) = patch.execution_units {
                config.execution_units = units;
            }
            Ok(json!({ "config": save_for(app, &config)? }))
        }
        other => Err(format!("unknown settings command: {other}")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Patch {
    #[serde(default)]
    worktree_enabled: Option<bool>,
    #[serde(default)]
    execution_units: Option<u32>,
}

// ---------------------------------------------------------------------------
// Prompt rendering (pure, unit tested)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptVars {
    /// Agent task id, kept for templates that want to mention it.
    pub task_id: String,
    pub title: String,
    pub json_path: String,
    pub repo_path: String,
    pub workspace_name: String,
    pub bug_id: String,
    pub severity: String,
    pub priority: String,
    /// Extra instructions from the compose sheet, rendered as Markdown.
    pub user_prompt: String,
    /// Absolute resource paths; inserted into the prompt as a path list.
    pub attachments: Vec<String>,
    /// Enabled coworkers and their skill package paths; empty when none is on.
    pub coworker: String,
}

/// Replaces `{{variable}}` placeholders; unknown placeholders are left intact.
///
/// Coworker skills (`{{coworker}}`) use a slot-or-append policy: an explicit
/// placeholder keeps placement under the template's control, otherwise the whole
/// section is appended.
pub fn render_prompt(template: &str, vars: &PromptVars) -> String {
    let attachments = render_attachments(&vars.attachments);
    let pairs = [
        ("task_id", vars.task_id.as_str()),
        ("title", vars.title.as_str()),
        ("json_path", vars.json_path.as_str()),
        ("repo_path", vars.repo_path.as_str()),
        ("workspace_name", vars.workspace_name.as_str()),
        ("bug_id", vars.bug_id.as_str()),
        ("severity", vars.severity.as_str()),
        ("priority", vars.priority.as_str()),
        ("user_prompt", vars.user_prompt.as_str()),
        ("attachments", attachments.as_str()),
        ("coworker", vars.coworker.as_str()),
    ];

    let has_prompt_slot = template.contains("{{user_prompt}}");
    let has_attachments_slot = template.contains("{{attachments}}");
    let has_coworker_slot = template.contains("{{coworker}}");
    let mut rendered = template.to_string();
    for (key, value) in pairs {
        rendered = rendered.replace(&format!("{{{{{key}}}}}"), value);
    }

    // Coworker skills use the same policy: an explicit slot keeps placement
    // under the template's control, otherwise the whole section is appended.
    let coworker = vars.coworker.trim();
    if !has_coworker_slot && !coworker.is_empty() {
        rendered.push_str("\n\n");
        rendered.push_str(coworker);
    }

    // The compose sheet works with any template: when the global template has
    // no explicit slot, append its sections instead of dropping the user input.
    let user_prompt = vars.user_prompt.trim();
    if !has_prompt_slot && !user_prompt.is_empty() {
        rendered.push_str(tr("agent.prompt.user.notes"));
        rendered.push_str(user_prompt);
    }
    if !has_attachments_slot && !attachments.is_empty() {
        rendered.push_str(tr("agent.prompt.attachments.header"));
        rendered.push_str(&attachments);
    }
    rendered
}

/// One path per line, labelled by kind. Only paths are passed to the agent.
fn render_attachments(paths: &[String]) -> String {
    paths
        .iter()
        .filter(|path| !path.trim().is_empty())
        .map(|path| {
            tr_args(
                "agent.prompt.attachment.line",
                &[&attachment_kind(path), &path.trim()],
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn attachment_kind(path: &str) -> &'static str {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "heic" | "svg" => {
            tr("agent.attachment.image")
        }
        "mp4" | "mov" | "webm" | "m4v" | "avi" | "mkv" => tr("agent.attachment.video"),
        _ => tr("agent.attachment.file"),
    }
}

/// Templates that still point at removed tools or placeholders cannot work.
/// Replacing them is validation, not a migration: no old template text is kept.
fn template_uses_removed_contract(template: &str) -> bool {
    [
        "{{md_path}}",
        "{{project_rule}}",
        "tapd_request_review",
        "agent_task_report",
        "tapd_claim_bug",
        "tapd_release_bug",
        "tapd_export_bug_md",
    ]
    .iter()
    .any(|marker| template.contains(marker))
}

fn normalize_coworker_ids(values: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        let id = value.trim();
        if id.is_empty() || out.iter().any(|item| item == id) {
            continue;
        }
        out.push(id.to_string());
        if out.len() >= crate::coworker::MAX_ENABLED_COWORKERS {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_known_placeholders_and_keeps_unknown_ones() {
        let vars = PromptVars {
            task_id: "task-1".into(),
            title: "标题".into(),
            json_path: "/tmp/bug.json".into(),
            repo_path: "/repo".into(),
            workspace_name: "ws".into(),
            bug_id: "1001".into(),
            severity: "high".into(),
            priority: "P1".into(),
            user_prompt: String::new(),
            attachments: Vec::new(),
            coworker: String::new(),
        };
        let out = render_prompt("{{task_id}} {{bug_id}} {{unknown}}", &vars);
        assert_eq!(out, "task-1 1001 {{unknown}}");
    }

    #[test]
    fn legacy_contract_template_is_replaced() {
        let config = AgentConfig {
            prompt_template: "run tapd_claim_bug first".into(),
            ..Default::default()
        }
        .sanitized();
        assert!(!config.prompt_template.contains("tapd_claim_bug"));
    }

    #[test]
    fn legacy_repo_mappings_become_projects() {
        let mut config = AgentConfig::default();
        config.repo_mappings.insert("ws".into(), " /repo ".into());
        let config = config.sanitized();
        assert_eq!(config.projects["ws"].repo_path, "/repo");
        assert!(config.repo_mappings.is_empty());
    }
}
