//! 内置 Agent 的持久配置。
//!
//! 这里只保留**跨运行时仍然有意义**的三类事实：
//! - 每个 TAPD 项目对应的本地仓库路径与项目规则（MCP 匹配 `root`、内置 Agent 的
//!   working directory 都用它）；
//! - 提示词模板（缺陷修复、提交、合并、本地事项）；
//! - 工作流任务的并行执行单元；以及用户启用的同事。所有任务都在独立
//!   worktree 中运行，没有开关。
//!
//! 旧的外置 CLI 流程里的运行时、可执行路径、默认模型、访问权限、TUI 就绪 /
//! 静默阈值全部删除：内置 dsh 运行时的模型与权限在 `docs/DSH.md` 描述的
//! profile / 会话层配置，不再落到这个文件。模型供应商列表与模型目录留在这里，
//! 因为每次启动运行时都要重新渲染成 profile。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tapd_core::store::{read_json, write_json_atomic};
use tapd_i18n::{tr, tr_args};

const CONFIG_FILE: &str = "agent.json";

pub const DEFAULT_PROMPT_KEY: &str = "agent.prompt.default";

/// Local work items have no TAPD counterpart, so they use a built-in neutral
/// template instead of the user's bug template (which mentions bug.json).
pub const LOCAL_PROMPT_KEY: &str = "agent.prompt.local";

/// Per-project agent settings, edited from the project card.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectAgentConfig {
    /// Absolute local repository path used as the agent's working directory.
    pub repo_path: String,
    /// Project-specific rules. Not part of the built-in prompt: `tapd_get_bug`
    /// returns them as its own `projectRule` field for external agents.
    pub rule: String,
    /// The TAPD project's own name, filled in the first time a bug is handed
    /// over. Empty rows fall back to the repository's folder name.
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfig {
    /// TAPD workspace id -> repository path + project rules.
    pub projects: BTreeMap<String, ProjectAgentConfig>,
    pub prompt_template: String,
    /// Enabled coworkers from the bundled registry, in selection order. With
    /// team mode on it is only the roster (no prompt section); with it off the
    /// selection reaches the prompt through `{{coworker}}`.
    pub coworker_ids: Vec<String>,
    /// 团队协作：开启后新会话默认进入 Agent Team（任务板），工作由 lead 分配。
    #[serde(default)]
    pub team_enabled: bool,
    /// 同时运行的工作流任务数（1–8）。所有任务都在独立 worktree 中运行，
    /// 这里的上限只决定并发。
    #[serde(default = "default_execution_units")]
    pub execution_units: u32,
    /// 自定义模型供应商与模型目录。内置运行时启动时渲染进 profile。
    #[serde(default)]
    pub dsh_models: DshModelsConfig,
    /// 权限模式（P3）：自主 / 变更前通知 / 完全访问。运行时启动时生效。
    #[serde(default)]
    pub permission_mode: PermissionMode,
}

/// 内置 Agent 的权限模式。默认「自主」：只有风险操作才询问。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    /// 命中风险规则才请求授权。
    #[default]
    Auto,
    /// 放行，但执行前推一条通知。
    Notify,
    /// 除硬黑名单外全部放行。
    Full,
}

impl PermissionMode {
    /// Value passed to the runtime as `TAPD_DSH_PERMISSION_MODE`.
    pub fn as_env(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Notify => "notify",
            Self::Full => "full",
        }
    }

    /// Parses the wire value shared by the environment variable, the settings
    /// file and the per-session store. Unknown values are rejected, not
    /// defaulted: a typo must not silently pick a weaker mode.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "auto" => Some(Self::Auto),
            "notify" => Some(Self::Notify),
            "full" => Some(Self::Full),
            _ => None,
        }
    }
}

/// dsh `llm-pi-ai` 认的线上协议。数组顺序即界面里的展示顺序。
const PROTOCOLS: [&str; 4] = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
];

/// 当前 payload 声明的输入模态：只有文本与图片。
const MODALITIES: [&str; 2] = ["text", "image"];

/// 推理等级，从低到高。上游只认这一组。
const REASONING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// 一个自定义模型供应商，渲染成 profile 里 `providers` 字典的一项。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DshProvider {
    /// providers 字典键。界面不暴露：从名称派生，重名时加序号。
    pub id: String,
    pub name: String,
    /// OpenAI 兼容 / Responses / Anthropic / Gemini 网关的基地址。
    pub base_url: String,
    /// 取值见 [`PROTOCOLS`]。
    pub protocol: String,
    pub api_key: String,
    pub enabled: bool,
    pub models: Vec<DshModelEntry>,
}

impl Default for DshProvider {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            base_url: String::new(),
            protocol: PROTOCOLS[0].to_string(),
            api_key: String::new(),
            enabled: true,
            models: Vec::new(),
        }
    }
}

/// 供应商目录里的一个模型。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DshModelEntry {
    pub id: String,
    /// 上下文窗口，单位 token。
    pub context_window: u64,
    /// 单次回复上限；`None` 交给运行时默认值。
    pub max_tokens: Option<u64>,
    /// 输入模态，`text` 恒在。
    pub input: Vec<String>,
    /// 推理等级与线上参数，按等级从低到高排列；空表示不声明。
    pub reasoning: Vec<ReasoningEffort>,
    pub enabled: bool,
}

impl Default for DshModelEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            context_window: 128_000,
            max_tokens: None,
            input: vec![MODALITIES[0].to_string()],
            reasoning: Vec::new(),
            enabled: true,
        }
    }
}

/// 一个推理等级发到线上的参数值。`off` 允许留空。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffort {
    pub level: String,
    pub wire: String,
}

/// 模型设置的全部内容：供应商列表 + 当前使用的供应商与模型。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DshModelsConfig {
    pub providers: Vec<DshProvider>,
    pub active_provider_id: String,
    pub active_model_id: String,
    /// 每个模型上次使用的思考强度，键为 `provider/model`。新会话沿用记录值。
    pub model_efforts: BTreeMap<String, String>,
}

impl DshModelsConfig {
    /// 当前使用的供应商与模型：两者都还在，并且都是启用状态。
    pub fn active(&self) -> Option<(&DshProvider, &DshModelEntry)> {
        let provider = self
            .providers
            .iter()
            .find(|item| item.id == self.active_provider_id && item.enabled)?;
        let model = provider
            .models
            .iter()
            .find(|item| item.id == self.active_model_id && item.enabled)?;
        Some((provider, model))
    }

    /// 某个模型上次使用的思考强度；没有记录或记录已失效时为 `off`。
    /// 没有推理能力的模型返回 `None`：调用方必须彻底省略 reasoningEffort，
    /// 传 `off` 会被上游当作不支持的等级而报错。
    pub fn effort_for(&self, provider_id: &str, model_id: &str) -> Option<String> {
        let model = self
            .providers
            .iter()
            .find(|provider| provider.id == provider_id)
            .and_then(|provider| provider.models.iter().find(|model| model.id == model_id))?;
        // `off` 是隐式下限，不算推理能力；只有声明了真实等级的模型才接受 effort。
        if !model
            .reasoning
            .iter()
            .any(|effort| effort.level != "off")
        {
            return None;
        }
        let key = format!("{provider_id}/{model_id}");
        let some = self.model_efforts.get(&key).cloned().unwrap_or_default();
        if some == "off" {
            return Some(some);
        }
        if !some.is_empty() && model.reasoning.iter().any(|effort| effort.level == some) {
            Some(some)
        } else {
            Some("off".to_string())
        }
    }

    /// 是否已经足够启动运行时。
    pub fn is_configured(&self) -> bool {
        self.active()
            .is_some_and(|(provider, _)| !provider.base_url.trim().is_empty())
    }

    fn sanitized(mut self) -> Self {
        let mut seen_ids: Vec<String> = Vec::new();
        let mut providers: Vec<DshProvider> = Vec::new();
        for (index, provider) in std::mem::take(&mut self.providers).into_iter().enumerate() {
            let name = provider.name.trim().to_string();
            let mut id = slug_id(&provider.id);
            if id.is_empty() {
                id = slug_id(&name);
            }
            if id.is_empty() {
                id = format!("provider-{}", index + 1);
            }
            // providers 是字典，键必须唯一；重名时给后来的加序号。
            let base_id = id.clone();
            let mut suffix = 2;
            while seen_ids.iter().any(|existing| existing == &id) {
                id = format!("{base_id}-{suffix}");
                suffix += 1;
            }
            seen_ids.push(id.clone());

            let mut seen_models: Vec<String> = Vec::new();
            let models = provider
                .models
                .into_iter()
                .filter_map(sanitize_model)
                .filter(|model| {
                    if seen_models.iter().any(|existing| existing == &model.id) {
                        return false;
                    }
                    seen_models.push(model.id.clone());
                    true
                })
                .collect();

            providers.push(DshProvider {
                name: if name.is_empty() { id.clone() } else { name },
                base_url: provider.base_url.trim().trim_end_matches('/').to_string(),
                protocol: normalize_protocol(&provider.protocol),
                api_key: provider.api_key.trim().to_string(),
                enabled: provider.enabled,
                models,
                id,
            });
        }
        self.providers = providers;
        self.active_provider_id = self.active_provider_id.trim().to_string();
        self.active_model_id = self.active_model_id.trim().to_string();
        self.sync_default();
        self.reselect_active();
        self.sanitize_efforts();
        self
    }

    /// Drops remembered levels for models that no longer exist and levels a
    /// model does not declare. A stale entry would otherwise silently pick a
    /// level the route rejects.
    fn sanitize_efforts(&mut self) {
        let known: Vec<(String, Vec<String>)> = self
            .providers
            .iter()
            .map(|provider| {
                (
                    provider.id.clone(),
                    provider
                        .models
                        .iter()
                        .filter(|model| model.enabled)
                        .map(|model| model.id.clone())
                        .collect(),
                )
            })
            .collect();
        self.model_efforts = std::mem::take(&mut self.model_efforts)
            .into_iter()
            .filter(|(key, level)| {
                if !REASONING_LEVELS.iter().any(|item| *item == level) {
                    return false;
                }
                key.split_once('/').is_some_and(|(provider_id, model_id)| {
                    known.iter().any(|(id, models)| {
                        id == provider_id && models.iter().any(|model| model == model_id)
                    })
                })
            })
            .collect();
    }

    /// The provider list is the priority order and so is each provider's model
    /// list: the first enabled provider's first enabled model is the default.
    /// Reordering either list is how a default is chosen, so the pointer is
    /// always derived here instead of being kept from an older layout.
    fn sync_default(&mut self) {
        let Some((provider, model)) = self
            .providers
            .iter()
            .filter(|provider| provider.enabled)
            .find_map(|provider| {
                provider
                    .models
                    .iter()
                    .find(|model| model.enabled)
                    .map(|model| (provider, model))
            })
        else {
            return;
        };
        self.active_provider_id = provider.id.clone();
        self.active_model_id = model.id.clone();
    }

    /// 指针必须指向一个真正可用的模型；悬空时回落到第一个启用的。
    fn reselect_active(&mut self) {
        if self.active().is_some() {
            return;
        }
        let picked = self
            .providers
            .iter()
            .filter(|provider| provider.enabled)
            .find_map(|provider| {
                provider
                    .models
                    .iter()
                    .find(|model| model.enabled)
                    .map(|model| (provider, model))
            });
        match picked {
            Some((provider, model)) => {
                self.active_provider_id = provider.id.clone();
                self.active_model_id = model.id.clone();
            }
            // 没有可用模型时，只要供应商还在就把指针停在它身上，
            // 「当前供应商」不会莫名跳到别处。
            None => {
                let known = self
                    .providers
                    .iter()
                    .any(|provider| provider.id == self.active_provider_id);
                self.active_model_id.clear();
                if !known {
                    self.active_provider_id.clear();
                }
            }
        }
    }
}

/// profiles are dictionary keys and credential refs; keep them boring. Only
/// `[a-z0-9-]` survives so the per-provider environment variable stays
/// injective (`-` is the one character that becomes `_`).
fn slug_id(raw: &str) -> String {
    let mut out = String::new();
    for (index, ch) in raw.trim().chars().enumerate() {
        let allowed = ch.is_ascii_alphanumeric() || ch == '-';
        if allowed && !(index == 0 && ch.is_ascii_digit()) {
            out.push(ch.to_ascii_lowercase());
        }
    }
    out
}

/// Whitelists the wire protocol; the two spellings the old form offered are
/// accepted as aliases so a saved `anthropic` keeps working.
fn normalize_protocol(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "openai-responses" | "responses" => "openai-responses",
        "anthropic" | "anthropic-messages" => "anthropic-messages",
        "gemini" | "google" | "google-generative-ai" => "google-generative-ai",
        _ => "openai-completions",
    }
    .to_string()
}

/// Normalizes one catalog entry; `None` drops an entry with no usable id.
fn sanitize_model(mut entry: DshModelEntry) -> Option<DshModelEntry> {
    let id = entry.id.trim().to_string();
    if id.is_empty() {
        return None;
    }

    let mut input: Vec<String> = Vec::new();
    let declared: Vec<String> = std::mem::take(&mut entry.input)
        .into_iter()
        .map(|modality| modality.trim().to_ascii_lowercase())
        .collect();
    // Rebuilt from the whitelist so the order is stable and text leads; an
    // empty list would read upstream as "not declared", not "text only".
    for modality in MODALITIES {
        let mandatory = modality == MODALITIES[0];
        if mandatory || declared.iter().any(|item| item == modality) {
            input.push(modality.to_string());
        }
    }

    let mut reasoning: Vec<ReasoningEffort> = Vec::new();
    for effort in std::mem::take(&mut entry.reasoning) {
        let level = effort.level.trim().to_ascii_lowercase();
        if !REASONING_LEVELS.iter().any(|item| *item == level) {
            continue;
        }
        if reasoning.iter().any(|item| item.level == level) {
            continue;
        }
        let wire = effort.wire.trim().to_string();
        // Upstream rejects an empty wire value for every level but `off`.
        if level != "off" && wire.is_empty() {
            continue;
        }
        reasoning.push(ReasoningEffort { level, wire });
    }
    reasoning.sort_by_key(|effort| {
        REASONING_LEVELS
            .iter()
            .position(|item| *item == effort.level)
            .unwrap_or(usize::MAX)
    });
    // A ladder offering only `off` is rejected upstream; read it as undeclared.
    if reasoning.len() == 1 && reasoning[0].level == "off" {
        reasoning.clear();
    }
    // Every declared ladder offers `off`: pi-ai only accepts a level the map
    // declares, and the picker's floor is "no reasoning". An empty wire is the
    // documented way to declare it without sending a parameter.
    if !reasoning.is_empty() && reasoning[0].level != "off" {
        reasoning.insert(
            0,
            ReasoningEffort {
                level: "off".to_string(),
                wire: String::new(),
            },
        );
    }

    Some(DshModelEntry {
        id,
        context_window: entry.context_window.clamp(1_024, 4_000_000),
        max_tokens: entry
            .max_tokens
            .map(|tokens| tokens.clamp(1, 4_000_000)),
        input,
        reasoning,
        enabled: entry.enabled,
    })
}

/// 默认并行两个工作流任务：再多也不利于排查。
fn default_execution_units() -> u32 {
    2
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            projects: BTreeMap::new(),
            prompt_template: tr(DEFAULT_PROMPT_KEY).to_string(),
            coworker_ids: Vec::new(),
            team_enabled: false,
            execution_units: default_execution_units(),
            dsh_models: DshModelsConfig::default(),
            permission_mode: PermissionMode::Auto,
        }
    }
}

impl AgentConfig {
    fn sanitized(mut self) -> Self {
        if self.prompt_template.trim().is_empty() {
            self.prompt_template = tr(DEFAULT_PROMPT_KEY).to_string();
        }

        self.coworker_ids = normalize_coworker_ids(std::mem::take(&mut self.coworker_ids));
        self.execution_units = self.execution_units.clamp(1, 8);
        self.dsh_models = std::mem::take(&mut self.dsh_models).sanitized();

        self.projects = self
            .projects
            .into_iter()
            .map(|(workspace_id, project)| {
                let repo_path = project.repo_path.trim().to_string();
                let rule = project.rule.trim().to_string();
                let name = project.name.trim().to_string();
                (
                    workspace_id,
                    ProjectAgentConfig {
                        repo_path,
                        rule,
                        name,
                    },
                )
            })
            .filter(|(_, project)| {
                !project.repo_path.is_empty() || !project.rule.is_empty() || !project.name.is_empty()
            })
            .collect();

        self
    }
}

fn config_file(data_dir: &Path) -> PathBuf {
    data_dir.join(CONFIG_FILE)
}

/// Reads the settings file. Missing or malformed files yield defaults; the
/// caller never has to distinguish "fresh install" from "user cleared it".
pub fn load(data_dir: &Path) -> AgentConfig {
    let mut config = read_json::<AgentConfig>(&config_file(data_dir)).unwrap_or_default();
    // Before sanitizing: the scripted provider has to exist for a saved choice
    // of it to survive the "does the active provider resolve" repair. The port
    // moves between launches, so it is refreshed here rather than stored.
    #[cfg(debug_assertions)]
    if let Some(port) = crate::dsh::test_agent::port() {
        crate::dsh::test_agent::inject(&mut config, port);
    }
    config.sanitized()
}

pub fn save(data_dir: &Path, config: &AgentConfig) -> std::io::Result<()> {
    write_json_atomic(&config_file(data_dir), &config.clone().sanitized())
}

/// Snapshot for callers that only hold an `AppHandle` (MCP bridge, fs, export).
pub fn config_for(app: &tauri::AppHandle) -> AgentConfig {
    use tauri::Manager;
    let Ok(state) = app
        .try_state::<std::sync::Arc<crate::state::AppState>>()
        .ok_or(())
    else {
        return AgentConfig::default();
    };
    load(&state.paths.data_dir)
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

/// Replaces the settings. The saved value is sanitized (empty project entries,
/// unit bounds). A running runtime adopts a changed catalog immediately; a
/// stopped one renders it at its next start.
#[tauri::command]
pub async fn agent_settings_set(
    app: tauri::AppHandle,
    config: AgentConfig,
) -> Result<AgentConfig, String> {
    let before = config_for(&app).execution_units;
    let saved = save_for(&app, &config)?;
    use tauri::Manager;
    if let Some(state) = app.try_state::<std::sync::Arc<crate::dsh::runtime::RuntimeState>>() {
        // A failed live apply is not a failed save: the drift flag then keeps
        // the restart button on screen, which is the honest fallback.
        if let Err(error) = state.sync_catalog(&app, &saved).await {
            tracing::warn!(%error, "model catalog was not applied to the running runtime");
        }
        // A model saved while the runtime was down (it refuses to start
        // without one) brings it up now instead of asking for another Retry.
        // `ensure_ready` serialises with the boot guard, so a start already in
        // flight is awaited rather than duplicated. A terminal environment
        // failure (Node or payload missing) is left to its own notice: retrying
        // it on every settings save would only repeat the same error.
        let status = state.status();
        let needs_start = match status.phase {
            crate::dsh::runtime::Phase::Stopped | crate::dsh::runtime::Phase::Starting => true,
            crate::dsh::runtime::Phase::Failed => {
                status.error_code.as_deref() == Some("model_missing")
            }
            crate::dsh::runtime::Phase::Ready => false,
        };
        if saved.dsh_models.is_configured() && needs_start {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = crate::dsh::feature::start(&app).await {
                    tracing::warn!(%error, "runtime was not started after the model was saved");
                }
            });
        }
    }
    // Raising the cap should start queued work immediately, not wait for the
    // next enqueue. Lowering it never interrupts a running task.
    if saved.execution_units > before {
        if let Err(error) = crate::dsh::tasks::schedule(&app).await {
            tracing::warn!(%error, "queued tasks were not rescheduled");
        }
    }
    Ok(saved)
}

/// Records the last model pick as the default for the sessions that start next.
///
/// The app's rule is positional — the first enabled provider's first enabled
/// model is the default — so the picked pair is moved to the front of both
/// lists instead of storing a second pointer. The reasoning level rides along
/// in the same write, keeping a slider pick and the route change atomic.
/// Existing sessions are untouched: their own `model/selection` stays durable.
#[tauri::command]
pub async fn agent_model_default_set(
    app: tauri::AppHandle,
    provider_id: String,
    model_id: String,
    level: Option<String>,
) -> Result<AgentConfig, String> {
    let mut config = config_for(&app);
    let provider_id = provider_id.trim().to_string();
    let model_id = model_id.trim().to_string();

    if let Some(index) = config
        .dsh_models
        .providers
        .iter()
        .position(|provider| provider.id == provider_id)
    {
        let mut provider = config.dsh_models.providers.remove(index);
        if let Some(model_index) = provider.models.iter().position(|model| model.id == model_id) {
            let model = provider.models.remove(model_index);
            provider.models.insert(0, model);
            config.dsh_models.active_provider_id = provider_id.clone();
            config.dsh_models.active_model_id = model_id.clone();
        }
        config.dsh_models.providers.insert(0, provider);
    }

    let key = format!("{provider_id}/{model_id}");
    match level.map(|level| level.trim().to_string()) {
        Some(level) if !level.is_empty() => {
            config.dsh_models.model_efforts.insert(key, level);
        }
        _ => {
            config.dsh_models.model_efforts.remove(&key);
        }
    }
    save_for(&app, &config)
}

// ---------------------------------------------------------------------------
// Feature-command surface (companion / paired phone)
// ---------------------------------------------------------------------------

/// `settings_agent_get` / `settings_agent_set` over `feature_command`.
///
/// The phone may edit the execution-unit cap; the model
/// providers (API keys included), prompt template and project rules stay
/// desktop-only. The response is a projection for exactly that reason:
/// returning the whole config would put every provider key on the paired wire.
pub async fn command(
    app: &tauri::AppHandle,
    name: &str,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use serde_json::json;

    match name {
        "settings_agent_get" => Ok(json!({ "config": companion_view(&config_for(app)) })),
        "settings_agent_models" => {
            Ok(json!({ "models": companion_models(&config_for(app)) }))
        }
        "settings_agent_set" => {
            let patch: Patch = serde_json::from_value(payload)
                .map_err(|error| error.to_string())?;
            let Some(units) = patch.execution_units else {
                return Err("no supported field".to_string());
            };
            let mut config = config_for(app);
            let before = config.execution_units;
            config.execution_units = units;
            let saved = save_for(app, &config)?;
            if saved.execution_units > before {
                if let Err(error) = crate::dsh::tasks::schedule(app).await {
                    tracing::warn!(%error, "queued tasks were not rescheduled");
                }
            }
            Ok(json!({ "config": companion_view(&saved) }))
        }
        other => Err(format!("unknown settings command: {other}")),
    }
}

/// The only settings the paired phone renders and edits.
fn companion_view(config: &AgentConfig) -> serde_json::Value {
    serde_json::json!({
        "executionUnits": config.execution_units,
    })
}

/// The sanitized model catalog for the phone's composer picker
/// (`settings_agent_models`): providers and models the session picker lists,
/// plus the active route and remembered reasoning levels. Like
/// [`companion_view`], this is a projection on purpose — a provider's API key
/// and protocol wiring never cross the paired wire.
fn companion_models(config: &AgentConfig) -> serde_json::Value {
    let providers: Vec<serde_json::Value> = config
        .dsh_models
        .providers
        .iter()
        .map(|provider| {
            let models: Vec<serde_json::Value> = provider
                .models
                .iter()
                .map(|model| {
                    let levels: Vec<&str> = model
                        .reasoning
                        .iter()
                        .map(|effort| effort.level.as_str())
                        .collect();
                    serde_json::json!({
                        "id": model.id,
                        "contextWindow": model.context_window,
                        "input": model.input,
                        "reasoning": levels,
                        "enabled": model.enabled,
                    })
                })
                .collect();
            serde_json::json!({
                "id": provider.id,
                "name": provider.name,
                "baseUrl": provider.base_url,
                "enabled": provider.enabled,
                "models": models,
            })
        })
        .collect();
    serde_json::json!({
        "providers": providers,
        "activeProviderId": config.dsh_models.active_provider_id,
        "activeModelId": config.dsh_models.active_model_id,
        "modelEfforts": config.dsh_models.model_efforts,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Patch {
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
    /// Coworker roster for the solo path. Empty while team collaboration is on:
    /// work is then assigned on the board instead of announced in the prompt.
    pub coworker: String,
}

/// Replaces `{{variable}}` placeholders; unknown placeholders are left intact.
///
/// Coworker skills (`{{coworker}}`) use a slot-or-append policy: an explicit
/// placeholder keeps placement under the template's control, otherwise the whole
/// section is appended. The value is empty in team mode, so both cases collapse.
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
    fn a_learned_project_name_survives_the_sanitizer() {
        let mut config = AgentConfig::default();
        config.projects.insert(
            "ws".into(),
            ProjectAgentConfig {
                repo_path: " /repo ".into(),
                rule: " rule ".into(),
                name: " 优衣库 ".into(),
            },
        );
        let config = config.sanitized();
        let project = config.projects.get("ws").expect("project kept");
        assert_eq!(project.name, "优衣库");
        assert_eq!(project.repo_path, "/repo");
        assert_eq!(project.rule, "rule");
    }

    #[test]
    fn provider_ids_stay_unique_and_boring() {
        let config = AgentConfig {
            dsh_models: DshModelsConfig {
                providers: vec![
                    DshProvider {
                        id: "Gateway".into(),
                        name: "A".into(),
                        base_url: "https://a".into(),
                        models: vec![model("m")],
                        ..Default::default()
                    },
                    DshProvider {
                        id: "gateway".into(),
                        name: "B".into(),
                        base_url: "https://b".into(),
                        models: vec![model("m")],
                        ..Default::default()
                    },
                    DshProvider {
                        id: String::new(),
                        name: String::new(),
                        base_url: "https://c".into(),
                        models: vec![model("m")],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
            ..Default::default()
        }
        .sanitized();

        let ids: Vec<&str> = config
            .dsh_models
            .providers
            .iter()
            .map(|provider| provider.id.as_str())
            .collect();
        assert_eq!(ids, vec!["gateway", "gateway-2", "provider-3"]);
        // An unnamed provider still renders as something readable.
        assert_eq!(config.dsh_models.providers[2].name, "provider-3");
        // No pointer was supplied, so the first usable model wins.
        assert_eq!(config.dsh_models.active_provider_id, "gateway");
        assert_eq!(config.dsh_models.active_model_id, "m");
    }

    #[test]
    fn active_pointer_falls_back_to_a_usable_model() {
        let mut config = DshModelsConfig {
            providers: vec![DshProvider {
                id: "gateway".into(),
                name: "Gateway".into(),
                base_url: "https://a".into(),
                models: vec![
                    DshModelEntry {
                        id: "off".into(),
                        enabled: false,
                        ..Default::default()
                    },
                    model("on"),
                ],
                ..Default::default()
            }],
            active_provider_id: "gone".into(),
            active_model_id: "off".into(),
            ..Default::default()
        }
        .sanitized();
        assert_eq!(config.active_provider_id, "gateway");
        assert_eq!(config.active_model_id, "on");
        assert!(config.is_configured());

        // Disabling the provider leaves nothing to run.
        config.providers[0].enabled = false;
        let config = config.sanitized();
        assert!(!config.is_configured());
        assert_eq!(config.active_provider_id, "gateway");
        assert!(config.active_model_id.is_empty());
    }

    #[test]
    fn the_first_provider_supplies_the_default_model() {
        let provider = |id: &str, models: Vec<DshModelEntry>| DshProvider {
            id: id.into(),
            name: id.into(),
            base_url: format!("https://{id}.example/v1"),
            models,
            ..Default::default()
        };
        let mut config = DshModelsConfig {
            providers: vec![
                provider("first", vec![model("f1"), model("f2")]),
                provider("second", vec![model("s1")]),
            ],
            // A pointer left on the second provider is repaired to the first.
            active_provider_id: "second".into(),
            active_model_id: "s1".into(),
            ..Default::default()
        }
        .sanitized();
        assert_eq!(config.active_provider_id, "first");
        assert_eq!(config.active_model_id, "f1");

        // A pointer naming another model is repaired too: the first enabled
        // model of the first enabled provider is the default.
        config.active_model_id = "f2".into();
        let mut config = config.sanitized();
        assert_eq!(config.active_provider_id, "first");
        assert_eq!(config.active_model_id, "f1");

        // Disabling the first provider promotes the next one.
        config.providers[0].enabled = false;
        let config = config.sanitized();
        assert_eq!(config.active_provider_id, "second");
        assert_eq!(config.active_model_id, "s1");

        // Reordering the list changes which provider is first, so the default
        // follows the new order.
        let mut reordered = DshModelsConfig {
            providers: vec![
                provider("second", vec![model("s1")]),
                provider("first", vec![model("f1")]),
            ],
            active_provider_id: "second".into(),
            active_model_id: "s1".into(),
            ..Default::default()
        };
        reordered.providers.swap(0, 1);
        let reordered = reordered.sanitized();
        assert_eq!(reordered.active_provider_id, "first");
        assert_eq!(reordered.active_model_id, "f1");
    }

    #[test]
    fn models_are_normalized_to_what_upstream_accepts() {
        let config = DshModelsConfig {
            providers: vec![DshProvider {
                id: "gateway".into(),
                name: "Gateway".into(),
                base_url: "https://a/".into(),
                models: vec![
                    DshModelEntry {
                        id: " vision ".into(),
                        input: vec!["image".into(), "video".into(), "TEXT".into()],
                        reasoning: vec![
                            ReasoningEffort {
                                level: "high".into(),
                                wire: " high ".into(),
                            },
                            ReasoningEffort {
                                level: "low".into(),
                                wire: String::new(),
                            },
                            ReasoningEffort {
                                level: "medium".into(),
                                wire: "medium".into(),
                            },
                            ReasoningEffort {
                                level: "bogus".into(),
                                wire: "x".into(),
                            },
                        ],
                        ..Default::default()
                    },
                    DshModelEntry {
                        id: "  ".into(),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }],
            ..Default::default()
        }
        .sanitized();

        let entry = &config.providers[0].models[0];
        assert_eq!(entry.id, "vision");
        // Video is not a modality this payload serves; text is mandatory.
        assert_eq!(entry.input, vec!["text", "image"]);
        // `low` has no wire value and `bogus` is not a level; `off` is declared
        // for every ladder so the picker can turn reasoning off.
        assert_eq!(
            entry
                .reasoning
                .iter()
                .map(|effort| (effort.level.as_str(), effort.wire.as_str()))
                .collect::<Vec<_>>(),
            vec![("off", ""), ("medium", "medium"), ("high", "high")]
        );
        // Blank ids are dropped, not kept as empty rows.
        assert_eq!(config.providers[0].models.len(), 1);
    }

    #[test]
    fn effort_for_omits_level_for_non_reasoning_models() {
        // Two models: one discovered with no ladder, one with a real ladder.
        // The remembered entries exist for both, but only the reasoning model
        // may be given an effort — `off` on the other fails upstream.
        let config = DshModelsConfig {
            providers: vec![DshProvider {
                id: "p".into(),
                models: vec![
                    DshModelEntry {
                        id: "plain".into(),
                        ..Default::default()
                    },
                    DshModelEntry {
                        id: "smart".into(),
                        reasoning: vec![
                            ReasoningEffort {
                                level: "off".into(),
                                wire: String::new(),
                            },
                            ReasoningEffort {
                                level: "high".into(),
                                wire: "high".into(),
                            },
                        ],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }],
            model_efforts: [
                ("p/plain".to_string(), "off".to_string()),
                ("p/smart".to_string(), "high".to_string()),
            ]
            .into_iter()
            .collect(),
            ..Default::default()
        };

        assert_eq!(config.effort_for("p", "plain"), None);
        assert_eq!(config.effort_for("p", "smart").as_deref(), Some("high"));
        // An undeclared remembered level falls back to `off`, not omission.
        let mut changed = config.clone();
        changed
            .model_efforts
            .insert("p/smart".to_string(), "bogus".to_string());
        assert_eq!(changed.effort_for("p", "smart").as_deref(), Some("off"));
        // A remembered level on a now-unknown model resolves to nothing.
        assert_eq!(config.effort_for("p", "missing"), None);
    }

    #[test]
    fn a_lone_off_level_reads_as_undeclared() {
        let entry = sanitize_model(DshModelEntry {
            id: "plain".into(),
            reasoning: vec![ReasoningEffort {
                level: "off".into(),
                wire: String::new(),
            }],
            ..Default::default()
        })
        .expect("model survives");
        assert!(entry.reasoning.is_empty());
    }

    /// The phone's model catalog is a projection: no API key, no protocol
    /// wiring, just the route data the composer picker renders.
    #[test]
    fn companion_models_stays_sanitized() {
        let mut config = AgentConfig::default();
        config.dsh_models.providers.push(DshProvider {
            id: "p".into(),
            name: "Provider".into(),
            base_url: "https://example.com/v1".into(),
            protocol: "openai-completions".into(),
            api_key: "secret".into(),
            enabled: true,
            models: vec![DshModelEntry {
                id: "m".into(),
                context_window: 64_000,
                ..Default::default()
            }],
        });
        config.dsh_models.active_provider_id = "p".into();
        config.dsh_models.active_model_id = "m".into();

        let wire = companion_models(&config);
        let body = wire.to_string();
        assert!(!body.contains("secret"));
        assert!(!body.contains("openai-completions"));
        assert_eq!(wire["activeProviderId"], "p");
        assert_eq!(wire["activeModelId"], "m");
        assert_eq!(wire["providers"][0]["baseUrl"], "https://example.com/v1");
        assert_eq!(wire["providers"][0]["models"][0]["contextWindow"], 64_000);
        assert_eq!(wire["providers"][0]["models"][0]["reasoning"], serde_json::json!([]));
    }

    fn model(id: &str) -> DshModelEntry {
        DshModelEntry {
            id: id.to_string(),
            ..Default::default()
        }
    }

    /// The shape the configuration tab sends: camelCase keys, nullable
    /// `maxTokens`, `input` as an array, reasoning as level/wire pairs.
    #[test]
    fn a_test_agent_pointer_survives_sanitizing() {
        let mut config = AgentConfig::default();
        crate::dsh::test_agent::inject(&mut config, 1234);
        config.dsh_models.active_provider_id = "test-agent".into();
        config.dsh_models.active_model_id = "TestAgent".into();
        let config = config.sanitized();
        assert_eq!(config.dsh_models.active_provider_id, "test-agent");
        assert_eq!(config.dsh_models.active_model_id, "TestAgent");
        assert!(config.dsh_models.is_configured());
    }

    #[test]
    fn the_wire_shape_matches_the_frontend() {
        let wire = serde_json::json!({
            "dshModels": {
                "providers": [{
                    "id": "opencode-go",
                    "name": "OpenCode Go",
                    "baseUrl": "https://opencode.ai/zen/go/v1",
                    "protocol": "anthropic-messages",
                    "apiKey": "secret",
                    "enabled": true,
                    "models": [{
                        "id": "deepseek-v4.1-flash",
                        "contextWindow": 1_000_000,
                        "maxTokens": null,
                        "input": ["text", "image"],
                        "reasoning": [{ "level": "low", "wire": "low" }],
                        "enabled": true
                    }]
                }],
                "activeProviderId": "opencode-go",
                "activeModelId": "deepseek-v4.1-flash"
            }
        });

        let config: AgentConfig = serde_json::from_value(wire).expect("frontend payload parses");
        assert_eq!(
            config
                .dsh_models
                .active()
                .map(|(provider, model)| (provider.id.as_str(), model.id.as_str())),
            Some(("opencode-go", "deepseek-v4.1-flash"))
        );
        assert!(config.dsh_models.is_configured());

        // A null `maxTokens` means "runtime default", not zero.
        let saved = serde_json::to_value(AgentConfig {
            dsh_models: config.dsh_models,
            ..Default::default()
        })
        .expect("config serializes");
        assert!(saved.get("dshModel").is_none(), "legacy field must not be written");
        assert_eq!(
            saved["dshModels"]["providers"][0]["models"][0]["maxTokens"],
            serde_json::Value::Null
        );
    }
}
