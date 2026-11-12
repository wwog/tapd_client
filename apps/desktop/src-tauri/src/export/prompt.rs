//! The fix prompt that ships with an export.
//!
//! `tapd_export_bug_md` writes it next to `bug.md` and also returns the text, so
//! an external AI gets the project rules, the repo path and the coworker skills
//! in the same call that exports the package — no separate prompt tool needed.

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tapd_core::tapd::BugDetail;

use crate::agent::{self, PromptVars};

/// The task prompt for an external AI. Flow control (claim, review gate,
/// commit-then-write-back order) deliberately stays out of here: it lives in
/// the `tapdIntegration` block of `tapd_get_bug`, where models actually read it.
const MCP_PROMPT_TEMPLATE: &str = "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情文件：{{md_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n项目规则：\n{{project_rule}}\n\n{{coworker}}\n\n要求：\n1. 先完整阅读 bug.md 和 assets/ 下的截图、视频，定位根因，做最小必要修改，并遵循团队代码规范。\n2. 修改后运行相关测试或构建。\n\n交付流程（认领、简单/复杂改动的复核条件、commit 与回写顺序）见 tapd_get_bug 返回的 tapdIntegration，按它执行。";

pub struct PromptContext<'a> {
    pub workspace_id: &'a str,
    /// Display name used in `{{workspace_name}}` (workspace name, else id).
    pub workspace_name: &'a str,
    /// Caller's working directory (`root`); used when the project has no
    /// configured local folder.
    pub root_hint: Option<&'a str>,
    /// Extra instructions from the MCP caller, appended to the prompt.
    pub instructions: String,
    pub detail: &'a BugDetail,
}

/// Renders the prompt and writes it to `<export_dir>/prompt.md`.
pub fn write(
    app: &AppHandle,
    export_dir: &Path,
    md_path: &Path,
    ctx: PromptContext<'_>,
) -> Result<(String, PathBuf), String> {
    let agent_config = agent::mcp_agent_config(app);
    let project = agent_config.projects.get(ctx.workspace_id);
    let repo_path = project
        .map(|project| project.repo_path.trim().to_string())
        .filter(|path| !path.is_empty())
        .or_else(|| ctx.root_hint.map(str::to_string))
        .unwrap_or_else(|| "（当前工作目录）".to_string());
    let project_rule = project
        .map(|project| project.rule.trim().to_string())
        .unwrap_or_default();

    let vars = PromptVars {
        task_id: String::new(),
        title: ctx.detail.summary.title.clone(),
        md_path: md_path.to_string_lossy().to_string(),
        repo_path,
        workspace_name: ctx.workspace_name.to_string(),
        bug_id: ctx.detail.summary.id.clone(),
        severity: label_or_raw(
            &ctx.detail.summary.severity_label,
            &ctx.detail.summary.severity,
        ),
        priority: label_or_raw(
            &ctx.detail.summary.priority_label,
            &ctx.detail.summary.priority,
        ),
        project_rule,
        user_prompt: ctx.instructions,
        attachments: Vec::new(),
        coworker: crate::coworker::prompt_section(app, &agent_config.coworker_ids),
    };

    let prompt = agent::render_prompt(MCP_PROMPT_TEMPLATE, &vars);
    let path = export_dir.join("prompt.md");
    std::fs::write(&path, &prompt).map_err(|error| format!("写入 prompt.md 失败：{error}"))?;
    Ok((prompt, path))
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

#[cfg(test)]
mod tests {
    use super::{label_or_raw, MCP_PROMPT_TEMPLATE};
    use crate::agent::{render_prompt, PromptVars};

    #[test]
    fn labels_prefer_the_human_readable_value() {
        assert_eq!(label_or_raw("严重", "serious"), "严重");
        assert_eq!(label_or_raw("  ", "serious"), "serious");
        assert_eq!(label_or_raw("", " "), "");
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
            coworker: "协作同事：\n- 程序员｜Author：一起写".to_string(),
        };
        let prompt = render_prompt(MCP_PROMPT_TEMPLATE, &vars);
        assert!(prompt.contains("按钮错位"));
        assert!(prompt.contains("/exports/bug.md"));
        assert!(prompt.contains("/repo"));
        assert!(prompt.contains("先跑 pnpm test"));
        assert!(prompt.contains("程序员｜Author"));
        assert!(!prompt.contains("{{"));
        // External clients cannot pause the desktop review queue.
        assert!(!prompt.contains("tapd_request_review"));
        // Flow control lives in `tapdIntegration`, not in the task prompt.
        assert!(!prompt.contains("tapd_claim_bug"));
        assert!(prompt.contains("tapdIntegration"));
    }
}
