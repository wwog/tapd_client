//! Coworker packages: bundled personas plus skill packages.
//!
//! Layout (see `assets/coworker/README.md`):
//!
//! ```text
//! assets/coworker/<id>/coworker.json
//! assets/coworker/<id>/avatar.png
//! assets/coworker/<id>/skills/<skill>/SKILL.md
//! ```
//!
//! The folder name is the only id source. A broken package or skill is skipped
//! and reported as a warning so one contribution cannot hide the others.
//! Selected coworkers are stored in `agent.json` and rendered into the prompt by
//! [`prompt_section`] / `agent::render_prompt`.

use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::{agent::AgentCore, state::SharedState};

const REGISTRY_DIR: &str = "coworker";
const MANIFEST_FILE: &str = "coworker.json";
const SKILL_FILE: &str = "SKILL.md";
const MAX_AVATAR_BYTES: u64 = 512 * 1024;
/// Upper bound so a misconfigured client cannot make every prompt huge.
pub const MAX_ENABLED_COWORKERS: usize = 12;

/// One coworker as written on disk. `avatar` and skill `path` are resolved
/// absolute paths; they never come from the manifest verbatim.
#[derive(Clone, Debug)]
pub struct Coworker {
    pub id: String,
    pub name: String,
    pub role: String,
    pub title: String,
    pub description: String,
    pub accent: String,
    pub avatar: PathBuf,
    pub skills: Vec<Skill>,
}

#[derive(Clone, Debug)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// Absolute path to `SKILL.md`.
    pub path: PathBuf,
}

/// Result of scanning the bundled directory. `warnings` is user-visible: a
/// package that failed to load must not look like it never existed.
#[derive(Debug, Default)]
pub struct Registry {
    pub coworkers: Vec<Coworker>,
    pub warnings: Vec<String>,
}

impl Registry {
    pub fn get(&self, id: &str) -> Option<&Coworker> {
        self.coworkers.iter().find(|coworker| coworker.id == id)
    }

    /// Prompt block for the selected coworkers, in selection order. Unknown ids
    /// are ignored so a removed package cannot fail the task.
    pub fn prompt_section(&self, ids: &[String]) -> String {
        let selected: Vec<&Coworker> = ids.iter().filter_map(|id| self.get(id.trim())).collect();
        if selected.is_empty() {
            return String::new();
        }

        let mut out =
            String::from("协作同事（各司其职；开工前先读取对应技能包的 SKILL.md，并遵照执行）：");
        for coworker in selected {
            out.push_str("\n- ");
            out.push_str(coworker.role.trim());
            out.push('｜');
            out.push_str(coworker.name.trim());
            let description = coworker.description.trim();
            if !description.is_empty() {
                out.push('：');
                out.push_str(description);
            }
            if coworker.skills.is_empty() {
                continue;
            }
            out.push_str("\n  技能包：");
            for skill in &coworker.skills {
                out.push_str("\n  - ");
                out.push_str(&skill.name);
                out.push('：');
                out.push_str(&skill.path.to_string_lossy());
            }
        }
        out
    }
}

/// One skill package as handed to an external AI: a live pointer (absolute
/// `SKILL.md`) when the caller can read the bundle, plus a bundle-relative copy
/// when the skill was exported along with a bug.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRef {
    pub coworker_id: String,
    pub coworker_name: String,
    pub role: String,
    pub name: String,
    pub description: String,
    /// Absolute path to the bundled `SKILL.md`.
    pub path: String,
    /// `SKILL.md` inside the receiving export package (`skills/<coworker>/<skill>/SKILL.md`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
}

impl Registry {
    /// Skill pointers for `ids`, in selection order. Coworkers without skills
    /// contribute nothing; a role/name pair is repeated per skill, which keeps
    /// the payload flat for the caller.
    pub fn skill_refs(&self, ids: &[String]) -> Vec<SkillRef> {
        let selected: Vec<&Coworker> = ids.iter().filter_map(|id| self.get(id.trim())).collect();
        let mut refs = Vec::new();
        for coworker in selected {
            for skill in &coworker.skills {
                refs.push(SkillRef {
                    coworker_id: coworker.id.clone(),
                    coworker_name: coworker.name.clone(),
                    role: coworker.role.clone(),
                    name: skill.name.clone(),
                    description: skill.description.clone(),
                    path: skill.path.to_string_lossy().to_string(),
                    relative_path: None,
                });
            }
        }
        refs
    }
}

/// Manifest as written by contributors. Unknown fields are rejected so a typo
/// (`skill` instead of `skills`) fails loudly during review instead of silently
/// producing a coworker without skills.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    name: String,
    role: String,
    #[serde(default)]
    title: String,
    description: String,
    avatar: String,
    #[serde(default)]
    accent: String,
    #[serde(default)]
    skills: Vec<String>,
}

/// Resolves the bundled directory: repository assets in debug builds, the
/// Tauri resource directory in release bundles.
pub fn registry_dir(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../assets/coworker");
        if dev.is_dir() {
            return Some(dev);
        }
    }
    app.path()
        .resolve(REGISTRY_DIR, BaseDirectory::Resource)
        .ok()
        .filter(|path| path.is_dir())
}

/// Loads every package under `dir`. Io/parse failures become warnings.
pub fn load_dir(dir: &Path) -> Registry {
    let mut registry = Registry::default();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            registry
                .warnings
                .push(format!("无法读取同事目录 {}：{error}", dir.display()));
            return registry;
        }
    };

    let mut paths: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.is_dir())
        .collect();
    paths.sort();

    for path in paths {
        let id = match path.file_name().and_then(|name| name.to_str()) {
            Some(id) if valid_id(id) => id.to_string(),
            Some(id) => {
                registry.warnings.push(format!(
                    "忽略非法同事目录名「{id}」：只用小写字母、数字、连字符"
                ));
                continue;
            }
            None => continue,
        };
        match load_package(&path, &id) {
            Ok((coworker, warnings)) => {
                registry.coworkers.push(coworker);
                registry.warnings.extend(warnings);
            }
            Err(error) => registry.warnings.push(format!("{id}：{error}")),
        }
    }
    registry
}

pub fn load(app: &AppHandle) -> Registry {
    match registry_dir(app) {
        Some(dir) => load_dir(&dir),
        None => {
            let mut registry = Registry::default();
            registry.warnings.push("未找到内置同事包目录".to_string());
            registry
        }
    }
}

/// Prompt block for `ids`, using the current bundled registry. Empty when
/// nothing valid is selected.
pub fn prompt_section(app: &AppHandle, ids: &[String]) -> String {
    if ids.is_empty() {
        // Every task calls this; do not scan the bundle when nobody is enabled.
        return String::new();
    }
    load(app).prompt_section(ids)
}

/// Live skill pointers for MCP results. Empty when nothing is selected, so a
/// caller that never enabled a coworker sees no extra payload.
pub fn skill_refs(app: &AppHandle, ids: &[String]) -> Vec<SkillRef> {
    if ids.is_empty() {
        return Vec::new();
    }
    load(app).skill_refs(ids)
}

/// Copies the selected skill packages into `<export_dir>/skills/<coworker>/<skill>/`
/// so an exported bug keeps its skills even after the bundle is upgraded or the
/// selection changes, and returns refs pointing at those copies.
pub fn copy_skills(
    app: &AppHandle,
    ids: &[String],
    export_dir: &Path,
) -> (Vec<SkillRef>, Vec<String>) {
    let mut refs = skill_refs(app, ids);
    let mut warnings = Vec::new();
    if refs.is_empty() {
        return (refs, warnings);
    }

    let root = export_dir.join("skills");
    let mut budget = CopyBudget::default();
    for skill in &mut refs {
        let Some(source) = Path::new(&skill.path).parent() else {
            warnings.push(format!("{}：技能 {} 路径无效", skill.coworker_id, skill.name));
            continue;
        };
        let Some(dir_name) = source.file_name().and_then(|name| name.to_str()) else {
            warnings.push(format!("{}：技能 {} 目录名无效", skill.coworker_id, skill.name));
            continue;
        };
        let dest = root.join(&skill.coworker_id).join(dir_name);
        match copy_dir(source, &dest, 0, &mut budget) {
            Ok(()) => {
                skill.relative_path = Some(format!(
                    "skills/{}/{dir_name}/{SKILL_FILE}",
                    skill.coworker_id
                ));
            }
            Err(error) => warnings.push(format!(
                "{}：技能 {} 未复制：{error}",
                skill.coworker_id, skill.name
            )),
        }
    }
    (refs, warnings)
}

/// Source of truth for "不要复制一个巨大的技能包进导出目录".
const MAX_SKILL_FILES: usize = 400;
const MAX_SKILL_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SKILL_DEPTH: usize = 6;

#[derive(Default)]
struct CopyBudget {
    files: usize,
    bytes: u64,
}

/// Copies a skill directory. Symlinks are skipped instead of followed so a
/// hand-edited package cannot pull files from outside its own directory.
fn copy_dir(
    source: &Path,
    dest: &Path,
    depth: usize,
    budget: &mut CopyBudget,
) -> Result<(), String> {
    if depth > MAX_SKILL_DEPTH {
        return Err("目录层级过深".to_string());
    }
    fs::create_dir_all(dest).map_err(|error| error.to_string())?;
    let entries = fs::read_dir(source).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => return Err(error.to_string()),
        };
        if file_type.is_symlink() {
            continue;
        }
        let target = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir(&entry.path(), &target, depth + 1, budget)?;
            continue;
        }
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        if budget.files >= MAX_SKILL_FILES || budget.bytes + size > MAX_SKILL_BYTES {
            return Err("技能包超过复制上限".to_string());
        }
        fs::copy(entry.path(), &target).map_err(|error| error.to_string())?;
        budget.files += 1;
        budget.bytes += size;
    }
    Ok(())
}

fn load_package(dir: &Path, id: &str) -> Result<(Coworker, Vec<String>), String> {
    let raw = fs::read_to_string(dir.join(MANIFEST_FILE))
        .map_err(|error| format!("读取 {MANIFEST_FILE} 失败：{error}"))?;
    let manifest: Manifest =
        serde_json::from_str(&raw).map_err(|error| format!("{MANIFEST_FILE} 格式错误：{error}"))?;
    if manifest.schema_version != 1 {
        return Err(format!(
            "不支持的 schemaVersion：{}（当前为 1）",
            manifest.schema_version
        ));
    }

    let name = required(&manifest.name, "name")?;
    let role = required(&manifest.role, "role")?;
    let description = required(&manifest.description, "description")?;
    ensure_length(&name, 24, "name")?;
    ensure_length(&role, 12, "role")?;
    ensure_length(manifest.title.trim(), 40, "title")?;
    ensure_length(&description, 200, "description")?;

    let mut warnings = Vec::new();
    let base = fs::canonicalize(dir).map_err(|error| format!("无法解析同事目录：{error}"))?;

    let avatar = resolve_relative(&base, &manifest.avatar)
        .and_then(|path| {
            if path.is_file() {
                Ok(path)
            } else {
                Err(format!("头像不存在：{}", manifest.avatar))
            }
        })
        .map_err(|error| format!("avatar：{error}"))?;

    let mut skills = Vec::new();
    let mut seen = Vec::new();
    for raw_skill in &manifest.skills {
        match load_skill(&base, raw_skill) {
            Ok(skill) => {
                if seen.contains(&skill.path) {
                    continue;
                }
                seen.push(skill.path.clone());
                skills.push(skill);
            }
            Err(error) => warnings.push(format!("{id}：技能 {} 未加载：{error}", raw_skill.trim())),
        }
    }

    let accent = manifest.accent.trim().to_ascii_lowercase();
    let accent = if accent.is_empty() || valid_accent(&accent) {
        accent
    } else {
        warnings.push(format!("{id}：accent 不是 #rrggbb，已忽略"));
        String::new()
    };

    Ok((
        Coworker {
            id: id.to_string(),
            name,
            role,
            title: manifest.title.trim().to_string(),
            description,
            accent,
            avatar,
            skills,
        },
        warnings,
    ))
}

fn load_skill(base: &Path, raw: &str) -> Result<Skill, String> {
    let dir = resolve_relative(base, raw)?;
    if !dir.is_dir() {
        return Err("技能包必须是目录".to_string());
    }
    let path = dir.join(SKILL_FILE);
    if !path.is_file() {
        return Err(format!("缺少 {SKILL_FILE}"));
    }
    let markdown =
        fs::read_to_string(&path).map_err(|error| format!("读取 {SKILL_FILE} 失败：{error}"))?;
    let (name, description) = frontmatter(&markdown);
    let name = name
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            dir.file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "skill".to_string());
    Ok(Skill {
        name,
        description: description.unwrap_or_default(),
        path,
    })
}

/// Reads the tiny YAML frontmatter skills use. Only `name` and `description`
/// are needed, so a full YAML dependency (and its edge cases) is not worth it.
fn frontmatter(markdown: &str) -> (Option<String>, Option<String>) {
    let mut lines = markdown.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        let line = line.trim_end();
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value
            .trim()
            .trim_matches(|character| character == '"' || character == '\'')
            .trim();
        let value = if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        };
        match key.trim() {
            "name" if name.is_none() => name = value,
            "description" if description.is_none() => description = value,
            _ => {}
        }
    }
    (name, description)
}

fn required(value: &str, field: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{field} 不能为空"))
    } else {
        Ok(value.to_string())
    }
}

/// Mirrors the schema's `maxLength`; the prompt is built from these fields, so
/// a hand-edited package must not be able to inflate it.
fn ensure_length(value: &str, max: usize, field: &str) -> Result<(), String> {
    if value.chars().count() > max {
        Err(format!("{field} 不能超过 {max} 字"))
    } else {
        Ok(())
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_accent(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Joins a manifest-relative path and refuses anything that can escape the
/// package directory (absolute paths, `..`, Windows prefixes, symlinks).
fn resolve_relative(base: &Path, raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("路径为空".to_string());
    }
    let relative = Path::new(raw);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("路径必须是包内相对路径：{raw}"));
    }
    let path = base.join(relative);
    let resolved =
        fs::canonicalize(&path).map_err(|error| format!("无法解析路径 {raw}：{error}"))?;
    if !resolved.starts_with(base) {
        return Err(format!("路径超出同事目录：{raw}"));
    }
    Ok(resolved)
}

fn avatar_data_url(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取头像失败：{error}"))?;
    if metadata.len() > MAX_AVATAR_BYTES {
        return Err(format!("头像不能超过 {}KB", MAX_AVATAR_BYTES / 1024));
    }
    let bytes = fs::read(path).map_err(|error| format!("读取头像失败：{error}"))?;
    let mime = image_mime(&bytes, path)?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Sniffs the actual bytes first: contributors rename images often enough that
/// the extension alone would produce a data URL the webview may refuse.
fn image_mime(bytes: &[u8], path: &Path) -> Result<&'static str, String> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Ok("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Ok("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Ok("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok("image/webp");
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    let head = head.trim_start();
    if head.starts_with("<svg") || head.starts_with("<?xml") {
        return Ok("image/svg+xml");
    }
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        "gif" => Ok("image/gif"),
        "svg" => Ok("image/svg+xml"),
        other => Err(format!("不支持的图片格式：{other}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoworkerView {
    id: String,
    name: String,
    role: String,
    title: String,
    description: String,
    accent: String,
    avatar: Option<String>,
    skills: Vec<SkillView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillView {
    name: String,
    description: String,
    path: String,
}

impl CoworkerView {
    fn from_coworker(coworker: &Coworker, warnings: &mut Vec<String>) -> Self {
        let avatar = match avatar_data_url(&coworker.avatar) {
            Ok(url) => Some(url),
            Err(error) => {
                warnings.push(format!("{}：头像未加载：{error}", coworker.id));
                None
            }
        };
        Self {
            id: coworker.id.clone(),
            name: coworker.name.clone(),
            role: coworker.role.clone(),
            title: coworker.title.clone(),
            description: coworker.description.clone(),
            accent: coworker.accent.clone(),
            avatar,
            skills: coworker
                .skills
                .iter()
                .map(|skill| SkillView {
                    name: skill.name.clone(),
                    description: skill.description.clone(),
                    path: skill.path.to_string_lossy().to_string(),
                })
                .collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectRequest {
    #[serde(default)]
    ids: Vec<String>,
}

pub async fn command(
    app: &AppHandle,
    _state: &SharedState,
    name: &str,
    payload: Value,
) -> Result<Value, String> {
    let core = app
        .try_state::<std::sync::Arc<AgentCore>>()
        .ok_or_else(|| "Agent 模块尚未初始化".to_string())?;

    match name {
        "coworker_list" => {
            let registry = load(app);
            let mut warnings = registry.warnings.clone();
            let coworkers: Vec<CoworkerView> = registry
                .coworkers
                .iter()
                .map(|coworker| CoworkerView::from_coworker(coworker, &mut warnings))
                .collect();
            // A package removed by an upgrade must not stay visible as selected.
            let selected_ids: Vec<String> = core
                .selected_coworker_ids()
                .into_iter()
                .filter(|id| registry.get(id).is_some())
                .collect();
            let prompt_section = registry.prompt_section(&selected_ids);
            Ok(json!({
                "coworkers": coworkers,
                "selectedIds": selected_ids,
                "promptSection": prompt_section,
                "warnings": warnings,
            }))
        }
        "coworker_select" => {
            let request: SelectRequest = serde_json::from_value(payload)
                .map_err(|error| format!("无效的同事选择：{error}"))?;
            let registry = load(app);
            let selected: Vec<String> = request
                .ids
                .iter()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .filter(|id| registry.get(id).is_some())
                .collect();
            let config = core.set_coworker_ids(selected)?;
            let prompt_section = registry.prompt_section(&config.coworker_ids);
            Ok(json!({
                "selectedIds": config.coworker_ids,
                "promptSection": prompt_section,
            }))
        }
        other => Err(format!("unknown feature command: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tapd-coworker-test-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write_package(root: &Path, id: &str, manifest: &str, skill: Option<&str>) {
        let dir = root.join(id);
        fs::create_dir_all(&dir).expect("create package");
        fs::write(dir.join(MANIFEST_FILE), manifest).expect("write manifest");
        fs::write(dir.join("avatar.png"), b"png").expect("write avatar");
        if let Some(markdown) = skill {
            let skill_dir = dir.join("skills/demo");
            fs::create_dir_all(&skill_dir).expect("create skill");
            fs::write(skill_dir.join(SKILL_FILE), markdown).expect("write skill");
        }
    }

    #[test]
    fn frontmatter_reads_name_and_description() {
        let (name, description) =
            frontmatter("---\nname: demo\ndescription: \"一句话描述\"\n---\n# 正文");
        assert_eq!(name.as_deref(), Some("demo"));
        assert_eq!(description.as_deref(), Some("一句话描述"));
        assert_eq!(frontmatter("# 没有 frontmatter").0, None);
    }

    #[test]
    fn relative_paths_cannot_escape_the_package() {
        let root = temp_dir("escape");
        fs::create_dir_all(root.join("skills/demo")).unwrap();
        fs::write(root.join("skills/demo/SKILL.md"), "---\nname: demo\n---").unwrap();
        let base = fs::canonicalize(&root).unwrap();
        assert!(resolve_relative(&base, "../outside").is_err());
        assert!(resolve_relative(&base, "/etc/passwd").is_err());
        assert!(resolve_relative(&base, "skills/demo").is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn registry_keeps_valid_packages_and_warns_about_broken_ones() {
        let root = temp_dir("registry");
        write_package(
            &root,
            "author",
            r#"{"schemaVersion":1,"name":"Author","role":"程序员","description":"一起写代码","avatar":"avatar.png","skills":["skills/demo"]}"#,
            Some("---\nname: demo\ndescription: 技能说明\n---\n"),
        );
        fs::create_dir_all(root.join("broken")).unwrap();
        fs::write(root.join("broken/coworker.json"), "{}").unwrap();

        let registry = load_dir(&root);
        assert_eq!(registry.coworkers.len(), 1);
        assert_eq!(registry.coworkers[0].id, "author");
        assert_eq!(registry.coworkers[0].skills[0].name, "demo");
        assert_eq!(registry.warnings.len(), 1);
        assert!(registry.warnings[0].contains("broken"));

        let section = registry.prompt_section(&["author".to_string(), "missing".to_string()]);
        assert!(section.contains("程序员｜Author：一起写代码"));
        assert!(section.contains("SKILL.md"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skill_refs_point_at_the_bundled_skill() {
        let root = temp_dir("refs");
        write_package(
            &root,
            "author",
            r#"{"schemaVersion":1,"name":"Author","role":"程序员","description":"一起写代码","avatar":"avatar.png","skills":["skills/demo"]}"#,
            Some("---\nname: demo\ndescription: 技能说明\n---\n"),
        );
        let registry = load_dir(&root);

        let refs = registry.skill_refs(&["author".to_string(), "missing".to_string()]);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].coworker_id, "author");
        assert_eq!(refs[0].coworker_name, "Author");
        assert_eq!(refs[0].role, "程序员");
        assert_eq!(refs[0].description, "技能说明");
        assert!(refs[0].path.ends_with("SKILL.md"));
        assert!(refs[0].relative_path.is_none(), "live pointers are absolute");
        assert!(registry.skill_refs(&[]).is_empty());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copy_dir_copies_nested_skill_files() {
        let source = temp_dir("copy-src");
        fs::create_dir_all(source.join("references")).unwrap();
        fs::write(source.join(SKILL_FILE), "skill").unwrap();
        fs::write(source.join("references/notes.md"), "notes").unwrap();

        let copy_root = temp_dir("copy-dst");
        let dest = copy_root.join("skills/author/demo");
        let mut budget = CopyBudget::default();
        copy_dir(&source, &dest, 0, &mut budget).unwrap();

        assert!(dest.join(SKILL_FILE).is_file());
        assert!(dest.join("references/notes.md").is_file());
        assert_eq!(budget.files, 2);
        fs::remove_dir_all(source).unwrap();
        fs::remove_dir_all(copy_root).unwrap();
    }

    #[test]
    fn broken_skill_is_skipped_without_losing_the_coworker() {
        let root = temp_dir("skill");
        write_package(
            &root,
            "author",
            r#"{"schemaVersion":1,"name":"Author","role":"设计","description":"看界面","avatar":"avatar.png","skills":["skills/missing"]}"#,
            None,
        );
        let registry = load_dir(&root);
        assert_eq!(registry.coworkers.len(), 1);
        assert!(registry.coworkers[0].skills.is_empty());
        assert_eq!(registry.warnings.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn id_and_accent_are_validated() {
        assert!(valid_id("author"));
        assert!(valid_id("ui-designer-2"));
        assert!(!valid_id("Author"));
        assert!(!valid_id("ui_designer"));
        assert!(valid_accent("#0ea5e9"));
        assert!(!valid_accent("0ea5e9"));
    }

    #[test]
    fn bundled_packages_load_without_warnings() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../assets/coworker");
        let registry = load_dir(&dir);
        assert!(
            registry.warnings.is_empty(),
            "bundled coworker warnings: {:?}",
            registry.warnings
        );
        let author = registry.get("author").expect("bundled author package");
        assert_eq!(author.role, "程序员");
        assert_eq!(author.skills[0].name, "wwog-engineering");

        let section = registry.prompt_section(&["author".to_string()]);
        assert!(section.contains("程序员｜Author"));
        assert!(section.contains("wwog-engineering："));
        assert!(section.contains("SKILL.md"));
    }
}
