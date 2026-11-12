//! Bug export pipeline: fetch the bug, lay out the package directory, download
//! media and write `bug.md` / `bug.json` (+ `prompt.md` when asked).
//!
//! Directory naming lives in [`paths`], a single asset transfer in
//! [`download`] and the fix prompt in [`prompt`]; this file only sequences them.

use std::{collections::HashSet, time::Duration};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tapd_core::{
    export::{collect_media, render_markdown, MediaAsset},
    tapd::BugDetail,
};

use crate::coworker::SkillRef;
use crate::{media, session, state::SharedState};

mod download;
pub(crate) mod paths;
mod prompt;

use download::download_one;
use paths::{bug_export_dir, bug_reference, workspace_label};
use prompt::PromptContext;


const MAX_TOTAL_BYTES: u64 = 300 * 1024 * 1024;

/// Heading that carries the skill pointers in `bug.md`. It is always the last
/// section, so a re-export can replace it by truncating from this marker.
const SKILLS_MARKER: &str = "## 协作同事技能包";

/// What the caller wants in `prompt.md`. `None` skips the prompt entirely (the
/// desktop Agent already builds its own).
#[derive(Clone, Debug, Default)]
pub struct PromptOptions {
    /// Caller's working directory, used when the project has no local folder.
    pub root_hint: Option<String>,
    /// Extra instructions from the caller, appended to the prompt.
    pub instructions: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub dir: String,
    pub markdown_path: String,
    pub asset_count: usize,
    pub downloaded_bytes: u64,
    /// Rendered fix prompt; `None` when the caller skipped it.
    pub prompt: Option<String>,
    pub prompt_path: Option<String>,
    /// Skill packages copied into `<dir>/skills/`; empty when no coworker is on.
    pub skills: Vec<SkillRef>,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn export_bug_md(
    app: AppHandle,
    state: State<'_, SharedState>,
    workspace_id: String,
    bug_id: String,
    workspace_name: Option<String>,
) -> Result<ExportResult, String> {
    run_export(
        &app,
        &state.paths,
        &workspace_id,
        &bug_id,
        workspace_name,
        // A human exporting a package is handing it to an AI: ship the prompt.
        Some(PromptOptions::default()),
    )
    .await
}

pub async fn run_export(
    app: &AppHandle,
    paths: &tapd_core::paths::AppPaths,
    workspace_id: &str,
    bug_id: &str,
    workspace_name: Option<String>,
    prompt_options: Option<PromptOptions>,
) -> Result<ExportResult, String> {
    let detail = fetch_detail(app, workspace_id, bug_id).await?;
    let label = workspace_label(workspace_name, &detail, workspace_id);
    let bug_ref = bug_reference(&detail.summary);
    let bug_dir = bug_export_dir(
        paths,
        workspace_id,
        &label,
        &bug_ref,
        &detail.summary.title,
    );

    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| "会话窗口尚未创建".to_string())?;
    let cookie = session::cookie_header(&window)?;

    let assets_dir = bug_dir.join("assets");
    std::fs::create_dir_all(&assets_dir).map_err(|error| error.to_string())?;

    let client = reqwest::Client::builder()
        .user_agent(media::USER_AGENT)
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| error.to_string())?;

    let media = collect_media(&detail);
    let mut assets: Vec<MediaAsset> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut used_names: HashSet<String> = HashSet::new();
    let mut total_bytes: u64 = 0;
    let mut media_index = 0usize;

    for item in media {
        if total_bytes >= MAX_TOTAL_BYTES {
            warnings.push("已达到导出总大小上限，剩余资源未下载".to_string());
            break;
        }

        media_index += 1;
        match download_one(
            &client,
            &cookie,
            &item,
            media_index,
            &assets_dir,
            &mut used_names,
        )
        .await
        {
            Ok(asset) => {
                total_bytes += asset.size;
                assets.push(asset);
            }
            Err(error) => warnings.push(format!("{}：{}", item.filename_hint, error)),
        }
    }

    let markdown = render_markdown(&detail, &assets, &label);
    let markdown_path = bug_dir.join("bug.md");
    std::fs::write(&markdown_path, markdown).map_err(|error| error.to_string())?;

    let json_path = bug_dir.join("bug.json");
    let json = serde_json::to_vec_pretty(&detail).map_err(|error| error.to_string())?;
    std::fs::write(&json_path, json).map_err(|error| error.to_string())?;

    // Skills land next to `bug.md` and the section in `bug.md` points at the
    // copies, so an external AI that only reads the package still finds them.
    let skills = sync_skills(app, &bug_dir);
    warnings.extend(skills.warnings.clone());

    // The prompt is written last so it can reference the final `bug.md` and the
    // skill copies that were just refreshed.
    let (rendered_prompt, prompt_path) = match prompt_options {
        Some(options) => match prompt::write(
            app,
            &bug_dir,
            &markdown_path,
            PromptContext {
                workspace_id,
                workspace_name: &label,
                root_hint: options.root_hint.as_deref(),
                instructions: options.instructions,
                detail: &detail,
            },
        ) {
            Ok((text, path)) => (Some(text), Some(path.to_string_lossy().to_string())),
            Err(error) => {
                warnings.push(format!("修复提示词未生成：{error}"));
                (None, None)
            }
        },
        None => (None, None),
    };

    tracing::info!(
        bug_id,
        assets = assets.len(),
        bytes = total_bytes,
        skills = skills.refs.len(),
        prompt = rendered_prompt.is_some(),
        path = %bug_dir.display(),
        "bug exported"
    );

    Ok(ExportResult {
        dir: bug_dir.to_string_lossy().to_string(),
        markdown_path: markdown_path.to_string_lossy().to_string(),
        asset_count: assets.len(),
        downloaded_bytes: total_bytes,
        prompt: rendered_prompt,
        prompt_path,
        skills: skills.refs,
        warnings,
    })
}

/// Outcome of copying coworker skills into an export directory.
struct SkillsSync {
    refs: Vec<SkillRef>,
    warnings: Vec<String>,
}

/// Copies the enabled coworkers' skills into `export_dir/skills/` and rewrites
/// the trailing skill section of `bug.md`. Safe to call on an existing package:
/// files are overwritten and the section is replaced, not stacked.
fn sync_skills(app: &AppHandle, export_dir: &std::path::Path) -> SkillsSync {
    let ids = crate::agent::mcp_agent_config(app).coworker_ids;
    let (refs, mut warnings) = crate::coworker::copy_skills(app, &ids, export_dir);

    let md_path = export_dir.join("bug.md");
    match std::fs::read_to_string(&md_path) {
        Ok(markdown) => {
            let updated = with_skills_section(markdown, &refs);
            if let Err(error) = std::fs::write(&md_path, updated) {
                warnings.push(format!("技能包章节写入 bug.md 失败：{error}"));
            }
        }
        Err(error) => warnings.push(format!("读取 bug.md 失败：{error}")),
    }

    SkillsSync { refs, warnings }
}

/// Appends (or replaces) the skill section. `bug.md` is written by the export
/// pipeline and then re-read here, so the marker also removes a stale list when
/// the coworker selection changed between exports.
fn with_skills_section(markdown: String, skills: &[SkillRef]) -> String {
    let mut base = markdown;
    if let Some(index) = base.find(SKILLS_MARKER) {
        base.truncate(index);
    }
    let mut out = base.trim_end().to_string();
    if skills.is_empty() {
        return format!("{out}\n");
    }

    out.push_str("\n\n");
    out.push_str(SKILLS_MARKER);
    out.push_str("\n\n开工前先完整读取以下技能包，按其中的规范修改代码与交付：\n");
    for skill in skills {
        out.push_str("\n- ");
        out.push_str(skill.role.trim());
        out.push('｜');
        out.push_str(skill.coworker_name.trim());
        out.push('：');
        out.push_str(&skill.name);
        let description = skill.description.trim();
        if !description.is_empty() {
            out.push('（');
            out.push_str(description);
            out.push('）');
        }
        out.push_str("\n  ");
        out.push_str(
            skill
                .relative_path
                .as_deref()
                .unwrap_or(skill.path.as_str()),
        );
    }
    out.push('\n');
    out
}

async fn fetch_detail(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<BugDetail, String> {
    crate::commands::bugs::fetch_bug_detail(app, workspace_id, bug_id).await
}

#[cfg(test)]
mod tests {
    use super::{with_skills_section, SKILLS_MARKER};
    use crate::coworker::SkillRef;

    fn skill(name: &str, relative: Option<&str>) -> SkillRef {
        SkillRef {
            coworker_id: "author".to_string(),
            coworker_name: "Author".to_string(),
            role: "程序员".to_string(),
            name: name.to_string(),
            description: "按工程规范写".to_string(),
            path: format!("/bundle/skills/{name}/SKILL.md"),
            relative_path: relative.map(str::to_string),
        }
    }

    #[test]
    fn skills_section_is_appended_and_then_replaced() {
        let once = with_skills_section(
            "# 缺陷\n\n正文\n".to_string(),
            &[skill("demo", Some("skills/author/demo/SKILL.md"))],
        );
        assert!(once.starts_with("# 缺陷"));
        assert!(once.contains(SKILLS_MARKER));
        assert!(once.contains("程序员｜Author：demo"));
        assert!(once.contains("skills/author/demo/SKILL.md"));

        let twice = with_skills_section(
            once,
            &[skill("ui", Some("skills/author/ui/SKILL.md"))],
        );
        assert_eq!(twice.matches(SKILLS_MARKER).count(), 1, "never stacks");
        assert!(twice.contains("skills/author/ui/SKILL.md"));
        assert!(!twice.contains("skills/author/demo/SKILL.md"));
    }

    #[test]
    fn empty_selection_drops_the_section() {
        let with = with_skills_section("# 缺陷\n".to_string(), &[skill("demo", None)]);
        assert!(with.contains("/bundle/skills/demo/SKILL.md"), "absolute fallback");
        let without = with_skills_section(with, &[]);
        assert!(!without.contains(SKILLS_MARKER));
        assert!(without.trim_end().ends_with("# 缺陷"));
    }
}
