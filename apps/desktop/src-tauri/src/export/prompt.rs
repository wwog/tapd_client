//! The fix prompt that ships with `tapd_get_bug`.
//!
//! The prompt is rendered, not written: the package holds only `bug.json` and
//! `assets/`, and the MCP result carries the text so an external AI can start
//! from it directly. Project rules and coworker skills stay out of the template
//! — `tapd_get_bug` returns them as separate fields.

use std::path::Path;

use tapd_core::tapd::BugDetail;
use tauri::AppHandle;

use crate::agent::{self, PromptVars};

const MCP_PROMPT_TEMPLATE: &str = "请修复 TAPD 缺陷：{{title}}\n缺陷详情：{{json_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n要求：\n1. 先完整阅读缺陷详情（bug.json）和 assets/ 下的截图、视频。\n2. 定位根因，做最小必要修改。\n3. 修复时请遵循团队代码规范，确保代码可读、可维护。\n4. 判断改动复杂度：\n   - 简单任务：单文件或少量文件、局部改动，不涉及公共接口 / 数据模型 / 依赖 / 构建配置，且测试通过。直接 git commit（不要 push），然后用 tapd_add_bug_comment 说明原因、方案与影响范围，并用 tapd_update_bug_status 更新状态；可先调用 tapd_get_bug_transitions 查看允许的下一步。\n   - 复杂任务：多文件、跨模块、涉及公共接口 / 数据模型 / 依赖 / 构建配置，或风险较高、测试失败。不要 commit，也不要评论或更新 TAPD；说明根因、方案、影响范围与风险，交给用户复核和测试。\n5. 任何情况下都不要在提交成功前评论或更新 TAPD 状态。"; // i18n-exempt: prompt template sent to the agent

pub struct PromptContext<'a> {
    /// Project the bug belongs to; also how the local folder is found.
    pub workspace_id: &'a str,
    /// Display name used in `{{workspace_name}}` (workspace name, else id).
    pub workspace_name: &'a str,
    /// Caller's working directory (`root`); used when the project has no
    /// configured local folder.
    pub root_hint: Option<&'a str>,
    /// Absolute `bug.json` path written by the export.
    pub json_path: &'a Path,
    pub detail: &'a BugDetail,
}

/// Renders the task prompt for an external AI.
pub fn render(app: &AppHandle, ctx: PromptContext<'_>) -> String {
    let agent_config = agent::mcp_agent_config(app);
    let project = agent_config.projects.get(ctx.workspace_id);
    let repo_path = project
        .map(|project| project.repo_path.trim().to_string())
        .filter(|path| !path.is_empty())
        .or_else(|| ctx.root_hint.map(str::to_string))
        .unwrap_or_else(|| "（当前工作目录）".to_string()); // i18n-exempt: prompt content

    let vars = PromptVars {
        task_id: String::new(),
        title: ctx.detail.summary.title.clone(),
        json_path: ctx.json_path.to_string_lossy().to_string(),
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
        user_prompt: String::new(),
        attachments: Vec::new(),
        coworker: String::new(),
    };

    agent::render_prompt(MCP_PROMPT_TEMPLATE, &vars)
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

    fn vars() -> PromptVars {
        PromptVars {
            task_id: String::new(),
            title: "按钮错位".to_string(),
            json_path: "/exports/UU/bug.json".to_string(),
            repo_path: "/repo".to_string(),
            workspace_name: "UU".to_string(),
            bug_id: "42".to_string(),
            severity: "严重".to_string(),
            priority: "高".to_string(),
            user_prompt: String::new(),
            attachments: Vec::new(),
            coworker: String::new(),
        }
    }

    #[test]
    fn labels_prefer_the_human_readable_value() {
        assert_eq!(label_or_raw("严重", "serious"), "严重");
        assert_eq!(label_or_raw("  ", "serious"), "serious");
        assert_eq!(label_or_raw("", " "), "");
    }

    #[test]
    fn mcp_prompt_template_carries_paths_and_flow() {
        let prompt = render_prompt(MCP_PROMPT_TEMPLATE, &vars());
        assert!(prompt.contains("按钮错位"));
        assert!(prompt.contains("/exports/UU/bug.json"));
        assert!(prompt.contains("/repo"));
        assert!(!prompt.contains("{{"), "every placeholder is replaced");
        // Flow control now lives in the prompt itself, not in a MCP field.
        assert!(prompt.contains("tapd_add_bug_comment"));
        assert!(prompt.contains("tapd_update_bug_status"));
        assert!(prompt.contains("不要 commit"));
        assert!(!prompt.contains("tapdIntegration"));
        // Removed tools must not be referenced any more.
        assert!(!prompt.contains("tapd_request_review"));
        assert!(!prompt.contains("agent_task_report"));
        assert!(!prompt.contains("tapd_claim_bug"));
        assert!(!prompt.contains("项目规则"));
    }
}
