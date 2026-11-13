//! 只读读取各 CLI 落盘的会话文件，投影成统一的 Chat 消息流。
//!
//! 四种运行时（Claude / Codex / OpenCode / OMP）的存储格式互不相同：
//! JSONL 按行追加、OpenCode 是 SQLite、OMP 是 JSONL。这里只做「读 + 归一」，
//! 不写任何 provider 文件，也不联网。
//!
//! 解析原则（见 docs/AGENT_CHAT.md）：
//! - 坏行跳过，缺字段降级，绝不因为一条记录阻塞整个会话；
//! - tool_result 通过 call id 回填到对应工具卡片，不新增消息；
//! - 单次读取有消息数 / 字节数上限，超出时保留最近内容并标记 `truncated`。

use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::SystemTime,
};

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use tapd_i18n::{tr, tr_args};

/// 单次读取上限：消息条数、单条文本、工具输出、总读取字节。
const MAX_MESSAGES: usize = 2000;
const MAX_TEXT: usize = 16 * 1024;
const MAX_TOOL_OUTPUT: usize = 8 * 1024;
const MAX_BYTES: u64 = 8 * 1024 * 1024;
/// 工具参数是短摘要，不需要完整序列化。
const MAX_TOOL_INPUT: usize = 320;

/// 支持 Chat 视图的运行时。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TranscriptAgent {
    Claude,
    Codex,
    OpenCode,
    Omp,
}

impl TranscriptAgent {
    /// 运行时 id → 解析器。别名与主 id 共用解析器。
    pub(super) fn from_runtime_id(runtime_id: &str) -> Option<Self> {
        match runtime_id.trim().to_ascii_lowercase().as_str() {
            "claude" | "openclaude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "opencode" | "opencode2" => Some(Self::OpenCode),
            "omp" | "pi" => Some(Self::Omp),
            _ => None,
        }
    }

    pub(super) fn source_label(self) -> &'static str {
        match self {
            Self::Claude => "claude-jsonl",
            Self::Codex => "codex-jsonl",
            Self::OpenCode => "opencode-sqlite",
            Self::Omp => "omp-jsonl",
        }
    }
}

/// 一条扁平消息；provider 的一个记录可能拆成多条。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatMessage {
    /// 稳定 id：provider 记录 id + block 序号。
    pub id: String,
    /// user | assistant | tool | system
    pub role: String,
    /// message | thinking | tool | system
    pub kind: String,
    /// RFC3339；provider 缺少时间时为空。
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<ChatTool>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChatTool {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// running | done | failed
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
}

/// transcript 的定位结果。
#[derive(Clone, Debug)]
pub(super) struct TranscriptSource {
    pub(super) agent: TranscriptAgent,
    pub(super) path: PathBuf,
    pub(super) session_id: String,
}

/// 一次解析结果。
#[derive(Clone, Debug)]
pub(super) struct TranscriptRead {
    pub(super) messages: Vec<ChatMessage>,
    pub(super) truncated: bool,
    pub(super) source: String,
    /// 文件大小 / mtime 或 SQLite 的 count+max(time)；不变时复用缓存。
    pub(super) fingerprint: String,
    /// provider 明确记录的失败原因（网络错误、重试耗尽、API 错误）。
    pub(super) error: Option<String>,
    /// 会话实际使用的模型，用于 UI 显示。
    pub(super) model: Option<String>,
}

/// 解析失败的稳定原因；命令层再拼成可读文案。
#[derive(Debug)]
pub(super) enum TranscriptError {
    UnsupportedRuntime,
    MissingSession,
    NotFound(String),
    Read(String),
    Parse(String),
}

impl TranscriptError {
    pub(super) fn message(&self) -> String {
        match self {
            Self::UnsupportedRuntime => tr("agent.chat.unsupported").to_string(),
            Self::MissingSession => tr("agent.chat.awaiting.session").to_string(),
            Self::NotFound(detail) => tr_args("agent.transcript.notFound", &[detail]),
            Self::Read(detail) => tr_args("agent.transcript.read.failed", &[detail]),
            Self::Parse(detail) => tr_args("agent.transcript.parse.failed", &[detail]),
        }
    }
}

/// 定位 transcript。`session_id` 为空时直接返回 `MissingSession`，不猜文件。
pub(super) fn resolve_source(
    runtime_id: &str,
    session_id: &str,
    cwd: &str,
) -> Result<TranscriptSource, TranscriptError> {
    let agent =
        TranscriptAgent::from_runtime_id(runtime_id).ok_or(TranscriptError::UnsupportedRuntime)?;
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(TranscriptError::MissingSession);
    }

    let path = match agent {
        TranscriptAgent::Claude => find_claude(session_id, cwd),
        TranscriptAgent::Codex => find_codex(session_id),
        TranscriptAgent::Omp => find_omp(session_id),
        TranscriptAgent::OpenCode => opencode_db_path().or_else(|| {
            // 旧版本只有 JSON storage：用 db 的同级路径作为 sentinel，
            // 读取层发现文件不存在时改走 storage 目录。
            let dir = opencode_data_dir()?;
            dir.join("storage")
                .join("message")
                .join(session_id)
                .is_dir()
                .then(|| dir.join("opencode.db"))
        }),
    }
    .ok_or_else(|| TranscriptError::NotFound(agent.source_label().to_string()))?;

    Ok(TranscriptSource {
        agent,
        path,
        session_id: session_id.to_string(),
    })
}

/// 按运行时读取并解析；指纹不变时调用方应复用缓存。
pub(super) fn read(source: &TranscriptSource) -> Result<TranscriptRead, TranscriptError> {
    match source.agent {
        TranscriptAgent::Claude => {
            let fingerprint = file_fingerprint(&source.path)?;
            let mut builder = Builder::default();
            parse_claude(&source.path, &mut builder)?;
            Ok(builder.finish(source.agent, fingerprint))
        }
        TranscriptAgent::Codex => {
            let fingerprint = file_fingerprint(&source.path)?;
            let mut builder = Builder::default();
            parse_codex(&source.path, &mut builder)?;
            Ok(builder.finish(source.agent, fingerprint))
        }
        TranscriptAgent::Omp => {
            let fingerprint = file_fingerprint(&source.path)?;
            let mut builder = Builder::default();
            parse_omp(&source.path, &mut builder)?;
            Ok(builder.finish(source.agent, fingerprint))
        }
        TranscriptAgent::OpenCode => read_opencode(source),
    }
}

/// 缓存指纹只做廉价探测：stat 或一次聚合查询。
pub(super) fn fingerprint(source: &TranscriptSource) -> Result<String, TranscriptError> {
    match source.agent {
        TranscriptAgent::OpenCode => opencode_fingerprint(&source.path, &source.session_id),
        _ => file_fingerprint(&source.path),
    }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Builder {
    messages: Vec<ChatMessage>,
    /// call id → messages 下标，用于回填工具结果。
    calls: HashMap<String, usize>,
    truncated: bool,
    /// provider 明确记录的失败原因；最后一条获胜。
    error: Option<String>,
    /// 最近出现的模型名。
    model: Option<String>,
}

impl Builder {
    fn push(&mut self, message: ChatMessage) -> usize {
        self.messages.push(message);
        self.messages.len() - 1
    }

    fn push_tool(&mut self, message: ChatMessage, call_id: Option<String>) -> usize {
        let index = self.push(message);
        if let Some(call_id) = call_id.filter(|id| !id.is_empty()) {
            self.calls.insert(call_id, index);
        }
        index
    }

    /// 把工具结果回填到对应卡片；找不到调用时返回 false。
    fn attach_result(&mut self, call_id: &str, output: String, failed: bool, at: &str) -> bool {
        let Some(index) = self.calls.get(call_id).copied() else {
            return false;
        };
        // 先取开始时间，避免同时持有 messages 的可变与不可变借用。
        let started_at = self.messages[index].at.clone();
        let Some(tool) = self.messages[index].tool.as_mut() else {
            return false;
        };
        tool.output = Some(clip(&output, MAX_TOOL_OUTPUT));
        tool.status = if failed { "failed" } else { "done" }.to_string();
        tool.duration_ms = duration_ms(&started_at, at);
        true
    }

    fn finish(mut self, agent: TranscriptAgent, fingerprint: String) -> TranscriptRead {
        if self.messages.len() > MAX_MESSAGES {
            let excess = self.messages.len() - MAX_MESSAGES;
            self.messages.drain(0..excess);
            self.truncated = true;
        }
        TranscriptRead {
            messages: self.messages,
            truncated: self.truncated,
            source: agent.source_label().to_string(),
            fingerprint,
            error: self.error,
            model: self.model,
        }
    }

    fn set_model(&mut self, model: &str) {
        let model = model.trim();
        if !model.is_empty() && model != "<synthetic>" {
            self.model = Some(clip(model, 120));
        }
    }

    fn set_error(&mut self, error: &str) {
        let error = error.trim();
        if !error.is_empty() {
            self.error = Some(clip(error, 500));
        }
    }

    /// 后续出现新的用户回合 / 成功消息时，之前的错误已被恢复，不再算失败。
    fn clear_error(&mut self) {
        self.error = None;
    }

    /// 从 provider 的 error 对象里取可读文案；用户主动中断不算失败。
    fn note_error(&mut self, value: Option<&Value>) {
        let Some(value) = value else {
            return;
        };
        let name = value.get("name").and_then(Value::as_str).unwrap_or("");
        if name == "MessageAbortedError" {
            return;
        }
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| {
                value
                    .get("data")
                    .and_then(|data| data.get("message"))
                    .and_then(Value::as_str)
            })
            .or_else(|| value.as_str());
        if let Some(message) = message.filter(|message| !message.trim().is_empty()) {
            self.set_error(message);
        }
    }
}

// ---------------------------------------------------------------------------
// 文件 / 路径工具
// ---------------------------------------------------------------------------

fn file_fingerprint(path: &Path) -> Result<String, TranscriptError> {
    let metadata = fs::metadata(path)
        .map_err(|error| TranscriptError::Read(format!("{}：{error}", path.display())))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    Ok(format!(
        "{}:{}:{}",
        path.display(),
        metadata.len(),
        modified
    ))
}

/// 逐行读取 JSONL，并限制读取字节数。
///
/// 超过预算时从文件尾部开始读：会话是追加写入的，最新内容在末尾；
/// 从头读会把最近的工具调用全部丢掉。
fn for_each_jsonl(path: &Path, mut visit: impl FnMut(Value)) -> Result<bool, TranscriptError> {
    let mut file = fs::File::open(path)
        .map_err(|error| TranscriptError::Read(format!("{}：{error}", path.display())))?;
    let length = file
        .metadata()
        .map_err(|error| TranscriptError::Read(error.to_string()))?
        .len();
    let truncated = length > MAX_BYTES;
    if truncated {
        file.seek(SeekFrom::Start(length - MAX_BYTES))
            .map_err(|error| TranscriptError::Read(error.to_string()))?;
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| TranscriptError::Read(error.to_string()))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.split('\n');
    if truncated {
        // 从中间开始时第一行多半是残缺的 JSON，丢掉。
        lines.next();
    }
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            visit(value);
        }
    }
    Ok(truncated)
}

fn home_dir() -> Option<PathBuf> {
    tapd_core::paths::home_dir().ok()
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn xdg_data_home() -> Option<PathBuf> {
    env_dir("XDG_DATA_HOME").or_else(|| home_dir().map(|home| home.join(".local").join("share")))
}

fn find_claude(session_id: &str, cwd: &str) -> Option<PathBuf> {
    let projects = match env_dir("CLAUDE_CONFIG_DIR") {
        Some(dir) => dir.join("projects"),
        None => home_dir()?.join(".claude").join("projects"),
    };
    let file_name = format!("{session_id}.jsonl");

    // 常见路径：session id 就是文件名，位于任一 project bucket 下。
    if let Ok(entries) = fs::read_dir(&projects) {
        for entry in entries.flatten() {
            let candidate = entry.path().join(&file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 兜底：按 cwd 找到 bucket，取其中最新且 sessionId 匹配的记录。
    let encoded = encode_claude_path(cwd);
    let prefix: String = encoded.chars().take(200).collect();
    let mut best: Option<(SystemTime, PathBuf, bool)> = None;
    if let Ok(entries) = fs::read_dir(&projects) {
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if name != encoded && !name.starts_with(&prefix) {
                continue;
            }
            let Ok(files) = fs::read_dir(entry.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                let modified = file
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                let matches = claude_record_matches(&path, session_id);
                let better = match &best {
                    None => true,
                    Some((current, _, current_matches)) => {
                        (matches && !current_matches)
                            || (matches == *current_matches && modified > *current)
                    }
                };
                if better {
                    best = Some((modified, path, matches));
                }
            }
        }
    }
    // sessionId 不匹配的文件属于别的会话，宁可不展示也不能串会话。
    best.filter(|(_, _, matches)| *matches)
        .map(|(_, path, _)| path)
}

/// 只读文件开头几条，确认记录里的 sessionId 是否是目标会话。
fn claude_record_matches(path: &Path, session_id: &str) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    // 会话开头的 attachment / 元数据行可能没有 sessionId，多读几行更稳。
    for _ in 0..8 {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value.get("sessionId").and_then(Value::as_str) == Some(session_id) {
            return true;
        }
        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            break;
        }
    }
    false
}

/// Claude 的 project bucket 编码：非字母数字逐个替换成 `-`，不折叠。
fn encode_claude_path(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { '-' })
        .collect()
}

fn find_codex(session_id: &str) -> Option<PathBuf> {
    let root = match env_dir("CODEX_HOME") {
        Some(dir) => dir,
        None => home_dir()?.join(".codex"),
    }
    .join("sessions");
    find_session_file(&root, session_id, &|stem| stem.contains(session_id), 6)
}

fn find_omp(session_id: &str) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Some(dir) = env_dir("OMP_CODING_AGENT_DIR") {
        // 环境变量可能指向 agent 根、.omp 根或 sessions 根。
        for candidate in [
            dir.join("sessions"),
            dir.join("agent").join("sessions"),
            dir.clone(),
        ] {
            if candidate.is_dir() {
                roots.push(candidate);
            }
        }
    }
    if let Some(data) = xdg_data_home() {
        roots.push(data.join("omp").join("sessions"));
    }
    if let Some(home) = home_dir() {
        roots.push(home.join(".omp").join("agent").join("sessions"));
        if let Ok(profiles) = fs::read_dir(home.join(".omp").join("profiles")) {
            for entry in profiles.flatten() {
                roots.push(entry.path().join("agent").join("sessions"));
                roots.push(entry.path().join("sessions"));
            }
        }
    }
    if let Some(data) = xdg_data_home() {
        if let Ok(profiles) = fs::read_dir(data.join("omp").join("profiles")) {
            for entry in profiles.flatten() {
                roots.push(entry.path().join("sessions"));
            }
        }
    }

    let suffix = format!("_{session_id}");
    for root in roots {
        // 子 Agent 目录名可能命中父 id，读取时会跳过 subagent 目录。
        if let Some(found) = find_session_file(
            &root,
            session_id,
            &|stem| stem == session_id || stem.ends_with(&suffix),
            6,
        ) {
            return Some(found);
        }
    }
    None
}

/// 递归找文件名最匹配的一个；返回 mtime 最新的。
fn find_session_file(
    root: &Path,
    session_id: &str,
    match_stem: &dyn Fn(&str) -> bool,
    depth: usize,
) -> Option<PathBuf> {
    find_session_file_inner(root, session_id, match_stem, depth).map(|(_, path)| path)
}

fn find_session_file_inner(
    root: &Path,
    session_id: &str,
    match_stem: &dyn Fn(&str) -> bool,
    depth: usize,
) -> Option<(SystemTime, PathBuf)> {
    if depth == 0 || !root.is_dir() {
        return None;
    }
    let mut best: Option<(SystemTime, PathBuf)> = None;
    let Ok(entries) = fs::read_dir(root) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            let name = entry.file_name();
            if name
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains("subagent")
            {
                continue;
            }
            // 用命中的文件 mtime 比较，而不是目录 mtime。
            if let Some((modified, found)) =
                find_session_file_inner(&path, session_id, match_stem, depth - 1)
            {
                if best
                    .as_ref()
                    .map(|(current, _)| modified > *current)
                    .unwrap_or(true)
                {
                    best = Some((modified, found));
                }
            }
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !match_stem(stem) || !path.to_string_lossy().contains(session_id) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if best
            .as_ref()
            .map(|(current, _)| modified > *current)
            .unwrap_or(true)
        {
            best = Some((modified, path));
        }
    }
    best
}

fn opencode_data_dir() -> Option<PathBuf> {
    xdg_data_home().map(|data| data.join("opencode"))
}

fn opencode_db_path() -> Option<PathBuf> {
    if let Some(path) = env_dir("OPENCODE_DB") {
        return Some(path);
    }
    let data = opencode_data_dir()?;
    let primary = data.join("opencode.db");
    if primary.is_file() {
        return Some(primary);
    }
    // 同时探测 opencode-*.db。
    let entries = fs::read_dir(&data).ok()?;
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("opencode-") || !name.ends_with(".db") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if best
            .as_ref()
            .map(|(current, _)| modified > *current)
            .unwrap_or(true)
        {
            best = Some((modified, entry.path()));
        }
    }
    best.map(|(_, path)| path)
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

fn parse_claude(path: &Path, builder: &mut Builder) -> Result<(), TranscriptError> {
    let truncated = for_each_jsonl(path, |record| {
        if record.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return;
        }
        if record.get("isMeta").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let at = record
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let id = record
            .get("uuid")
            .or_else(|| record.get("message").and_then(|message| message.get("id")))
            .and_then(Value::as_str)
            .unwrap_or_default();

        let Some(message) = record.get("message") else {
            return;
        };
        if let Some(model) = message.get("model").and_then(Value::as_str) {
            builder.set_model(model);
        }
        let is_api_error = record.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true);
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        match record.get("type").and_then(Value::as_str) {
            Some("user") => parse_claude_user(message, id, &at, builder),
            Some("assistant") => parse_claude_assistant(message, id, &at, builder),
            _ => {
                if role == "user" {
                    parse_claude_user(message, id, &at, builder);
                } else if role == "assistant" {
                    parse_claude_assistant(message, id, &at, builder);
                }
            }
        }
        // 错误记录之后再出现正常回合，说明已经恢复；只有最后一条错误算失败。
        if is_api_error {
            let text = content_text(message.get("content"), 500);
            if text.trim().is_empty() {
                builder.note_error(record.get("error"));
            } else {
                builder.set_error(&text);
            }
        } else if role == "assistant" {
            builder.clear_error();
        } else if role == "user" && !content_has_tool_result(message) {
            builder.clear_error();
        }
    })?;
    if truncated {
        builder.truncated = true;
    }
    Ok(())
}

fn parse_claude_user(message: &Value, id: &str, at: &str, builder: &mut Builder) {
    let content = message.get("content");
    if let Some(text) = content.and_then(Value::as_str) {
        if !is_injected_text(text) {
            builder.push(ChatMessage {
                id: format!("{id}:user"),
                role: "user".to_string(),
                kind: "message".to_string(),
                at: at.to_string(),
                text: Some(clip(text, MAX_TEXT)),
                tool: None,
            });
        }
        return;
    }
    let Some(blocks) = content.and_then(Value::as_array) else {
        return;
    };
    for (index, block) in blocks.iter().enumerate() {
        match block.get("type").and_then(Value::as_str) {
            Some("tool_result") => {
                let call_id = block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let output = content_text(block.get("content"), MAX_TOOL_OUTPUT);
                let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
                if !builder.attach_result(call_id, output.clone(), failed, at) {
                    if output.is_empty() {
                        continue;
                    }
                    builder.push(ChatMessage {
                        id: format!("{id}:result:{index}"),
                        role: "tool".to_string(),
                        kind: "tool".to_string(),
                        at: at.to_string(),
                        text: None,
                        tool: Some(ChatTool {
                            name: "result".to_string(),
                            input: None,
                            output: Some(clip(&output, MAX_TOOL_OUTPUT)),
                            status: if failed { "failed" } else { "done" }.to_string(),
                            duration_ms: None,
                            call_id: Some(call_id.to_string()),
                        }),
                    });
                }
            }
            Some("text") => {
                let Some(text) = block.get("text").and_then(Value::as_str) else {
                    continue;
                };
                if is_injected_text(text) {
                    continue;
                }
                builder.push(ChatMessage {
                    id: format!("{id}:{index}"),
                    role: "user".to_string(),
                    kind: "message".to_string(),
                    at: at.to_string(),
                    text: Some(clip(text, MAX_TEXT)),
                    tool: None,
                });
            }
            _ => {}
        }
    }
}

fn parse_claude_assistant(message: &Value, id: &str, at: &str, builder: &mut Builder) {
    let content = message.get("content");
    if let Some(text) = content.and_then(Value::as_str) {
        if !text.trim().is_empty() {
            builder.push(ChatMessage {
                id: format!("{id}:assistant"),
                role: "assistant".to_string(),
                kind: "message".to_string(),
                at: at.to_string(),
                text: Some(clip(text, MAX_TEXT)),
                tool: None,
            });
        }
        return;
    }
    let Some(blocks) = content.and_then(Value::as_array) else {
        return;
    };
    for (index, block) in blocks.iter().enumerate() {
        match block.get("type").and_then(Value::as_str) {
            Some("thinking") => {
                let Some(text) = block.get("thinking").and_then(Value::as_str) else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                builder.push(ChatMessage {
                    id: format!("{id}:thinking:{index}"),
                    role: "assistant".to_string(),
                    kind: "thinking".to_string(),
                    at: at.to_string(),
                    text: Some(clip(text, MAX_TEXT)),
                    tool: None,
                });
            }
            Some("text") => {
                let Some(text) = block.get("text").and_then(Value::as_str) else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                builder.push(ChatMessage {
                    id: format!("{id}:{index}"),
                    role: "assistant".to_string(),
                    kind: "message".to_string(),
                    at: at.to_string(),
                    text: Some(clip(text, MAX_TEXT)),
                    tool: None,
                });
            }
            Some("tool_use") => {
                let call_id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                builder.push_tool(
                    ChatMessage {
                        id: format!("{id}:tool:{index}"),
                        role: "tool".to_string(),
                        kind: "tool".to_string(),
                        at: at.to_string(),
                        text: None,
                        tool: Some(ChatTool {
                            name,
                            input: readable_input(block.get("input")),
                            output: None,
                            status: "running".to_string(),
                            duration_ms: None,
                            call_id: Some(call_id.clone()).filter(|id| !id.is_empty()),
                        }),
                    },
                    Some(call_id),
                );
            }
            _ => {}
        }
    }
}

/// 这条用户记录是否只是工具结果（不是新的用户指令）。
fn content_has_tool_result(message: &Value) -> bool {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        })
        .unwrap_or(false)
}

/// 注入文本（system-reminder、hook 输出）不算用户消息。
fn is_injected_text(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with("<system-reminder>")
        || text.starts_with("<local-command")
        || text.starts_with("<command-name>")
        || text.starts_with("<EXTREMELY_IMPORTANT>")
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

fn parse_codex(path: &Path, builder: &mut Builder) -> Result<(), TranscriptError> {
    let mut last_agent_message: Option<(String, String)> = None;
    let truncated = for_each_jsonl(path, |record| {
        let at = record
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let Some(payload) = record.get("payload") else {
            return;
        };
        match record.get("type").and_then(Value::as_str) {
            Some("response_item") => parse_codex_response_item(payload, &at, builder),
            Some("event_msg") => {
                let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
                if kind == "item_completed" {
                    parse_codex_item(payload, &at, builder);
                } else if kind == "task_complete" {
                    // Codex 在重试耗尽 / 模型不可用时把错误写进 task_complete。
                    if payload.get("error").is_some_and(|error| !error.is_null()) {
                        builder.note_error(payload.get("error"));
                    } else {
                        builder.clear_error();
                    }
                    if let Some(text) = payload.get("last_agent_message").and_then(Value::as_str) {
                        if !text.trim().is_empty() {
                            last_agent_message = Some((at.clone(), text.to_string()));
                        }
                    }
                } else if kind == "turn_aborted" {
                    // 用户主动中断由取消流程处理；其余 aborted 视为失败。
                    let reason = payload.get("reason").and_then(Value::as_str).unwrap_or("");
                    if reason != "interrupted" {
                        if payload.get("error").is_some() {
                            builder.note_error(payload.get("error"));
                        } else if !reason.is_empty() {
                            builder.set_error(reason);
                        }
                    }
                }
            }
            Some("turn_context") => {
                // 新回合开始，上一轮的瞬时错误已经被恢复流程消化。
                builder.clear_error();
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    builder.set_model(model);
                }
            }
            _ => {}
        }
    })?;
    // 只有在完全没有 assistant 文本时才用 task_complete 兜底，避免重复。
    if let Some((at, text)) = last_agent_message {
        let has_assistant = builder
            .messages
            .iter()
            .any(|message| message.role == "assistant" && message.kind == "message");
        if !has_assistant {
            builder.push(ChatMessage {
                id: "task_complete".to_string(),
                role: "assistant".to_string(),
                kind: "message".to_string(),
                at,
                text: Some(clip(&text, MAX_TEXT)),
                tool: None,
            });
        }
    }
    if truncated {
        builder.truncated = true;
    }
    Ok(())
}

fn parse_codex_response_item(payload: &Value, at: &str, builder: &mut Builder) {
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match payload.get("type").and_then(Value::as_str) {
        Some("message") => {
            let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                return;
            }
            if role == "user" {
                builder.clear_error();
            }
            let text = content_text(payload.get("content"), MAX_TEXT);
            if text.trim().is_empty() {
                return;
            }
            builder.push(ChatMessage {
                id: format!("{id}:{role}"),
                role: role.to_string(),
                kind: "message".to_string(),
                at: at.to_string(),
                text: Some(text),
                tool: None,
            });
        }
        Some("reasoning") => {
            let text = payload
                .get("summary")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n\n")
                })
                .unwrap_or_default();
            if text.trim().is_empty() {
                return;
            }
            builder.push(ChatMessage {
                id: format!("{id}:thinking"),
                role: "assistant".to_string(),
                kind: "thinking".to_string(),
                at: at.to_string(),
                text: Some(clip(&text, MAX_TEXT)),
                tool: None,
            });
        }
        Some("custom_tool_call") | Some("function_call") => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let normalized = name.to_ascii_lowercase().replace(['_', '-'], "");
            // exec 系列的真实命令在 item_completed 里，重复卡片只会制造噪音；
            // 提问工具由 PendingPrompt 呈现。
            if matches!(
                normalized.as_str(),
                "exec" | "shell" | "bash" | "command" | "execcommand" | "runcommand"
            ) || super::prompt::is_question_tool(name)
            {
                return;
            }
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let input = payload.get("input").or_else(|| payload.get("arguments"));
            builder.push_tool(
                ChatMessage {
                    id: format!("{id}:tool"),
                    role: "tool".to_string(),
                    kind: "tool".to_string(),
                    at: at.to_string(),
                    text: None,
                    tool: Some(ChatTool {
                        name: name.to_string(),
                        input: readable_input(input),
                        output: None,
                        status: "running".to_string(),
                        duration_ms: None,
                        call_id: Some(call_id.clone()).filter(|id| !id.is_empty()),
                    }),
                },
                Some(call_id),
            );
        }
        Some("custom_tool_call_output") | Some("function_call_output") => {
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let output = content_text(payload.get("output"), MAX_TOOL_OUTPUT);
            builder.attach_result(call_id, output, false, at);
        }
        _ => {}
    }
}

fn parse_codex_item(payload: &Value, at: &str, builder: &mut Builder) {
    let Some(item) = payload.get("item") else {
        return;
    };
    let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
    let id = item.get("id").and_then(Value::as_str).unwrap_or(kind);
    let started = payload.get("started_at_ms").and_then(Value::as_i64);
    let completed = payload.get("completed_at_ms").and_then(Value::as_i64);
    let duration = match (started, completed) {
        (Some(start), Some(end)) if end >= start => Some((end - start) as u64),
        _ => None,
    };
    let status = item
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| payload.get("status").and_then(Value::as_str))
        .unwrap_or("completed");

    match kind {
        "CommandExecution" => {
            let parts: Vec<&str> = item
                .get("command")
                .and_then(Value::as_array)
                .map(|parts| parts.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            // Codex 用 `[/bin/zsh, -lc, 真实命令]` 启动；展示真实命令而不是壳前缀。
            let command = if parts.len() >= 3 && matches!(parts[1], "-lc" | "-c") {
                parts[2..].join(" ")
            } else {
                parts.join(" ")
            };
            let output = item
                .get("aggregated_output")
                .and_then(Value::as_str)
                .unwrap_or_default();
            builder.push(ChatMessage {
                id: format!("{id}:exec"),
                role: "tool".to_string(),
                kind: "tool".to_string(),
                at: at.to_string(),
                text: None,
                tool: Some(ChatTool {
                    name: "exec".to_string(),
                    input: Some(clip(&command, MAX_TOOL_INPUT)),
                    output: Some(clip(output, MAX_TOOL_OUTPUT)),
                    status: tool_status(status),
                    duration_ms: duration.or_else(|| {
                        item.get("duration")
                            .and_then(|value| value.get("secs").and_then(Value::as_u64))
                            .map(|secs| secs * 1000)
                    }),
                    call_id: None,
                }),
            });
        }
        "FileChange" => {
            let Some(changes) = item.get("changes").and_then(Value::as_object) else {
                return;
            };
            let paths: Vec<&str> = changes.keys().map(String::as_str).collect();
            let diff = changes
                .values()
                .find_map(|change| change.get("unified_diff").and_then(Value::as_str))
                .or_else(|| {
                    changes
                        .values()
                        .find_map(|change| change.get("content").and_then(Value::as_str))
                })
                .unwrap_or_default();
            builder.push(ChatMessage {
                id: format!("{id}:edit"),
                role: "tool".to_string(),
                kind: "tool".to_string(),
                at: at.to_string(),
                text: None,
                tool: Some(ChatTool {
                    name: "edit".to_string(),
                    input: Some(clip(&paths.join("\n"), MAX_TOOL_INPUT)),
                    output: Some(clip(diff, MAX_TOOL_OUTPUT)),
                    status: tool_status(status),
                    duration_ms: duration,
                    call_id: None,
                }),
            });
        }
        "McpToolCall" => {
            let server = item.get("server").and_then(Value::as_str).unwrap_or("");
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("mcp");
            let output = item
                .get("result")
                .and_then(|result| result.get("content"))
                .map(|content| content_text(Some(content), MAX_TOOL_OUTPUT))
                .unwrap_or_default();
            builder.push(ChatMessage {
                id: format!("{id}:mcp"),
                role: "tool".to_string(),
                kind: "tool".to_string(),
                at: at.to_string(),
                text: None,
                tool: Some(ChatTool {
                    name: if server.is_empty() {
                        tool.to_string()
                    } else {
                        format!("{server}.{tool}")
                    },
                    input: readable_input(item.get("arguments")),
                    output: Some(clip(&output, MAX_TOOL_OUTPUT)),
                    status: tool_status(status),
                    duration_ms: duration,
                    call_id: None,
                }),
            });
        }
        _ => {}
    }
}

fn tool_status(status: &str) -> String {
    let status = status.to_ascii_lowercase();
    if status.contains("fail") || status.contains("error") || status.contains("cancel") {
        "failed".to_string()
    } else if status.contains("complete")
        || status.contains("success")
        || status.contains("done")
        || status.contains("finish")
    {
        "done".to_string()
    } else {
        "running".to_string()
    }
}

/// OpenCode v2 用 `model:{id,providerID}`，v1 用扁平的 `modelID/providerID`。
fn opencode_model(data: &Value) -> Option<String> {
    let (provider, id) = match data.get("model") {
        Some(model) => (
            model.get("providerID").and_then(Value::as_str),
            model.get("id").and_then(Value::as_str),
        ),
        None => (
            data.get("providerID").and_then(Value::as_str),
            data.get("modelID").and_then(Value::as_str),
        ),
    };
    match (provider, id) {
        (Some(provider), Some(id)) => Some(format!("{provider}/{id}")),
        (_, Some(id)) => Some(id.to_string()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// OMP
// ---------------------------------------------------------------------------

fn parse_omp(path: &Path, builder: &mut Builder) -> Result<(), TranscriptError> {
    let truncated = for_each_jsonl(path, |record| {
        let record_type = record.get("type").and_then(Value::as_str).unwrap_or("");
        if record_type == "model_change" {
            if let Some(model) = record.get("model").and_then(Value::as_str) {
                builder.set_model(model);
            }
            return;
        }
        if record_type != "message" {
            return;
        }
        let at = record
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                record
                    .get("message")
                    .and_then(|message| message.get("timestamp"))
                    .and_then(Value::as_i64)
                    .map(ms_to_rfc3339)
            })
            .unwrap_or_default();
        let id = record.get("id").and_then(Value::as_str).unwrap_or_default();
        let Some(message) = record.get("message") else {
            return;
        };
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        match role {
            "user" => {
                builder.clear_error();
                let text = content_text(message.get("content"), MAX_TEXT);
                if text.trim().is_empty() || is_injected_text(&text) {
                    return;
                }
                builder.push(ChatMessage {
                    id: format!("{id}:user"),
                    role: "user".to_string(),
                    kind: "message".to_string(),
                    at: at.clone(),
                    text: Some(text),
                    tool: None,
                });
            }
            "assistant" => {
                if let Some(model) = message.get("model").and_then(Value::as_str) {
                    builder.set_model(model);
                }
                // 重试耗尽 / 网络错误以 stopReason=error + errorMessage 落盘；
                // aborted 是用户主动中断，交给取消流程。
                let error = (message.get("stopReason").and_then(Value::as_str) == Some("error"))
                    .then(|| message.get("errorMessage").and_then(Value::as_str))
                    .flatten();
                parse_omp_assistant(message, id, &at, builder);
                if let Some(error) = error {
                    builder.set_error(error);
                } else {
                    builder.clear_error();
                }
            }
            "toolResult" => {
                let call_id = message
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let output = content_text(message.get("content"), MAX_TOOL_OUTPUT);
                let failed = message.get("isError").and_then(Value::as_bool) == Some(true);
                builder.attach_result(call_id, output, failed, &at);
            }
            _ => {}
        }
    })?;
    if truncated {
        builder.truncated = true;
    }
    Ok(())
}

fn parse_omp_assistant(message: &Value, id: &str, at: &str, builder: &mut Builder) {
    let Some(blocks) = message.get("content").and_then(Value::as_array) else {
        return;
    };
    for (index, block) in blocks.iter().enumerate() {
        match block.get("type").and_then(Value::as_str) {
            Some("thinking") => {
                let Some(text) = block.get("thinking").and_then(Value::as_str) else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                builder.push(ChatMessage {
                    id: format!("{id}:thinking:{index}"),
                    role: "assistant".to_string(),
                    kind: "thinking".to_string(),
                    at: at.to_string(),
                    text: Some(clip(text, MAX_TEXT)),
                    tool: None,
                });
            }
            Some("text") => {
                let Some(text) = block.get("text").and_then(Value::as_str) else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                builder.push(ChatMessage {
                    id: format!("{id}:{index}"),
                    role: "assistant".to_string(),
                    kind: "message".to_string(),
                    at: at.to_string(),
                    text: Some(clip(text, MAX_TEXT)),
                    tool: None,
                });
            }
            Some("toolCall") => {
                let call_id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                builder.push_tool(
                    ChatMessage {
                        id: format!("{id}:tool:{index}"),
                        role: "tool".to_string(),
                        kind: "tool".to_string(),
                        at: at.to_string(),
                        text: None,
                        tool: Some(ChatTool {
                            name,
                            input: readable_input(block.get("arguments")),
                            output: None,
                            status: "running".to_string(),
                            duration_ms: None,
                            call_id: Some(call_id.clone()).filter(|id| !id.is_empty()),
                        }),
                    },
                    Some(call_id),
                );
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

fn open_connection(path: &Path) -> Result<Connection, TranscriptError> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| TranscriptError::Read(format!("{}：{error}", path.display())))?;
    // WAL 库被正在运行的 OpenCode 占用时短暂等待，读不到再返回错误。
    let _ = connection.busy_timeout(std::time::Duration::from_millis(500));
    Ok(connection)
}

fn has_table(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .is_ok()
}

fn opencode_fingerprint(path: &Path, session_id: &str) -> Result<String, TranscriptError> {
    if !path.is_file() {
        // JSON storage 兜底：目录新增文件会更新 mtime，count 变化也能兜底。
        let dir = path
            .parent()
            .map(|root| root.join("storage").join("message").join(session_id))
            .unwrap_or_else(|| PathBuf::from(session_id));
        let count = fs::read_dir(&dir)
            .map(|entries| entries.flatten().count())
            .unwrap_or(0);
        let modified = fs::metadata(&dir)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        return Ok(format!("json:{}:{count}:{modified}", dir.display()));
    }
    let connection = open_connection(path)?;
    if has_table(&connection, "session_message") {
        let row: Option<(i64, i64)> = connection
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(time_created), 0)
                 FROM session_message WHERE session_id = ?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        return Ok(format!(
            "v2:{}:{}:{}",
            path.display(),
            row.map(|(count, _)| count).unwrap_or(0),
            row.map(|(_, at)| at).unwrap_or(0)
        ));
    }
    if has_table(&connection, "message") {
        let row: Option<(i64, i64)> = connection
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(time_created), 0)
                 FROM message WHERE session_id = ?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        return Ok(format!(
            "v1:{}:{}:{}",
            path.display(),
            row.map(|(count, _)| count).unwrap_or(0),
            row.map(|(_, at)| at).unwrap_or(0)
        ));
    }
    Ok(format!("json:{}", path.display()))
}

fn read_opencode(source: &TranscriptSource) -> Result<TranscriptRead, TranscriptError> {
    let fingerprint = opencode_fingerprint(&source.path, &source.session_id)?;
    let mut builder = Builder::default();
    if !source.path.is_file() {
        parse_opencode_json(&source.path, &source.session_id, &mut builder)?;
        return Ok(builder.finish(source.agent, format!("{fingerprint}:{}", source.session_id)));
    }
    let connection = open_connection(&source.path)?;
    if has_table(&connection, "session_message") {
        parse_opencode_v2(&connection, &source.session_id, &mut builder)?;
    } else if has_table(&connection, "message") && has_table(&connection, "part") {
        parse_opencode_v1(&connection, &source.session_id, &mut builder)?;
    } else {
        parse_opencode_json(&source.path, &source.session_id, &mut builder)?;
    }
    Ok(builder.finish(source.agent, format!("{fingerprint}:{}", source.session_id)))
}

fn parse_opencode_v2(
    connection: &Connection,
    session_id: &str,
    builder: &mut Builder,
) -> Result<(), TranscriptError> {
    let mut statement = connection
        .prepare(
            "SELECT id, type, data, time_created FROM session_message
             WHERE session_id = ?1 ORDER BY time_created DESC, seq DESC LIMIT 4000",
        )
        .map_err(|error| TranscriptError::Parse(error.to_string()))?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| TranscriptError::Parse(error.to_string()))?;

    let mut records = Vec::new();
    let mut seen = 0usize;
    for row in rows.flatten() {
        records.push(row);
        seen += 1;
        if seen >= 4000 {
            break;
        }
    }
    // 查询是倒序取最近 4000 条，这里翻回时间顺序。
    for (id, kind, data, created) in records.into_iter().rev() {
        let Ok(data) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        let at = data
            .get("time")
            .and_then(|time| time.get("created"))
            .and_then(Value::as_i64)
            .unwrap_or(created);
        let at = ms_to_rfc3339(at);
        match kind.as_str() {
            "user" => {
                builder.clear_error();
                let text = data.get("text").and_then(Value::as_str).unwrap_or("");
                if text.trim().is_empty() {
                    continue;
                }
                builder.push(ChatMessage {
                    id: format!("{id}:user"),
                    role: "user".to_string(),
                    kind: "message".to_string(),
                    at,
                    text: Some(clip(text, MAX_TEXT)),
                    tool: None,
                });
            }
            "assistant" => parse_opencode_v2_assistant(&id, &data, &at, builder),
            _ => {}
        }
    }
    Ok(())
}

fn parse_opencode_v2_assistant(id: &str, data: &Value, at: &str, builder: &mut Builder) {
    if let Some(model) = opencode_model(data) {
        builder.set_model(&model);
    }
    // 最后一条 assistant 消息的 error 才算本轮失败；之前的错误已被后续消息恢复。
    builder.clear_error();
    builder.note_error(data.get("error"));
    let Some(blocks) = data.get("content").and_then(Value::as_array) else {
        return;
    };
    for (index, block) in blocks.iter().enumerate() {
        match block.get("type").and_then(Value::as_str) {
            Some("reasoning") => {
                let Some(text) = block.get("text").and_then(Value::as_str) else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                builder.push(ChatMessage {
                    id: format!("{id}:thinking:{index}"),
                    role: "assistant".to_string(),
                    kind: "thinking".to_string(),
                    at: at.to_string(),
                    text: Some(clip(text, MAX_TEXT)),
                    tool: None,
                });
            }
            Some("text") => {
                let Some(text) = block.get("text").and_then(Value::as_str) else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                builder.push(ChatMessage {
                    id: format!("{id}:{index}"),
                    role: "assistant".to_string(),
                    kind: "message".to_string(),
                    at: at.to_string(),
                    text: Some(clip(text, MAX_TEXT)),
                    tool: None,
                });
            }
            Some("tool") => {
                let state = block.get("state");
                let name = block
                    .get("name")
                    .or_else(|| block.get("tool"))
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                let call_id = block
                    .get("id")
                    .or_else(|| block.get("callID"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let output = state
                    .and_then(|state| {
                        state
                            .get("output")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .or_else(|| {
                                state
                                    .get("content")
                                    .map(|content| content_text(Some(content), MAX_TOOL_OUTPUT))
                            })
                    })
                    .unwrap_or_default();
                let status = state
                    .and_then(|state| state.get("status"))
                    .and_then(Value::as_str)
                    .unwrap_or("completed");
                let duration = state
                    .and_then(|state| state.get("time"))
                    .map(|time| {
                        duration_between(
                            time.get("start").and_then(Value::as_i64),
                            time.get("end").and_then(Value::as_i64),
                        )
                    })
                    .unwrap_or(None);
                builder.push_tool(
                    ChatMessage {
                        id: format!("{id}:tool:{index}"),
                        role: "tool".to_string(),
                        kind: "tool".to_string(),
                        at: at.to_string(),
                        text: None,
                        tool: Some(ChatTool {
                            name: name.to_string(),
                            input: state.and_then(|state| readable_input(state.get("input"))),
                            output: Some(clip(&output, MAX_TOOL_OUTPUT))
                                .filter(|text| !text.is_empty()),
                            status: tool_status(status),
                            duration_ms: duration,
                            call_id: Some(call_id.clone()).filter(|id| !id.is_empty()),
                        }),
                    },
                    Some(call_id),
                );
            }
            _ => {}
        }
    }
}

fn parse_opencode_v1(
    connection: &Connection,
    session_id: &str,
    builder: &mut Builder,
) -> Result<(), TranscriptError> {
    // parts 按 session 一次取回，避免每条 message 一次查询。
    let mut parts: HashMap<String, Vec<(i64, Value)>> = HashMap::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT message_id, time_created, data FROM part
                 WHERE session_id = ?1 ORDER BY time_created DESC LIMIT 8000",
            )
            .map_err(|error| TranscriptError::Parse(error.to_string()))?;
        let rows = statement
            .query_map([session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| TranscriptError::Parse(error.to_string()))?;
        for (message_id, created, data) in rows.flatten() {
            let Ok(data) = serde_json::from_str::<Value>(&data) else {
                continue;
            };
            parts.entry(message_id).or_default().push((created, data));
        }
    }
    for values in parts.values_mut() {
        values.sort_by_key(|(created, _)| *created);
    }

    let mut statement = connection
        .prepare(
            "SELECT id, time_created, data FROM message
             WHERE session_id = ?1 ORDER BY time_created DESC LIMIT 2000",
        )
        .map_err(|error| TranscriptError::Parse(error.to_string()))?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| TranscriptError::Parse(error.to_string()))?;
    let mut messages = Vec::new();
    for row in rows.flatten() {
        messages.push(row);
    }
    for (id, created, data) in messages.into_iter().rev() {
        let Ok(data) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        let role = data.get("role").and_then(Value::as_str).unwrap_or("");
        let at = data
            .get("time")
            .and_then(|time| time.get("created"))
            .and_then(Value::as_i64)
            .unwrap_or(created);
        let at = ms_to_rfc3339(at);
        let blocks = parts.get(&id).cloned().unwrap_or_default();
        match role {
            "user" => {
                builder.clear_error();
                let text = blocks
                    .iter()
                    .filter(|(_, part)| part.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|(_, part)| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                if text.trim().is_empty() {
                    continue;
                }
                builder.push(ChatMessage {
                    id: format!("{id}:user"),
                    role: "user".to_string(),
                    kind: "message".to_string(),
                    at,
                    text: Some(clip(&text, MAX_TEXT)),
                    tool: None,
                });
            }
            "assistant" => {
                if let Some(model) = opencode_model(&data) {
                    builder.set_model(&model);
                }
                builder.clear_error();
                builder.note_error(data.get("error"));
                for (index, (part_at, part)) in blocks.iter().enumerate() {
                    let part_at = ms_to_rfc3339(*part_at);
                    match part.get("type").and_then(Value::as_str) {
                        Some("reasoning") => {
                            let Some(text) = part.get("text").and_then(Value::as_str) else {
                                continue;
                            };
                            if text.trim().is_empty() {
                                continue;
                            }
                            builder.push(ChatMessage {
                                id: format!("{id}:thinking:{index}"),
                                role: "assistant".to_string(),
                                kind: "thinking".to_string(),
                                at: part_at,
                                text: Some(clip(text, MAX_TEXT)),
                                tool: None,
                            });
                        }
                        Some("text") => {
                            let Some(text) = part.get("text").and_then(Value::as_str) else {
                                continue;
                            };
                            if text.trim().is_empty() {
                                continue;
                            }
                            builder.push(ChatMessage {
                                id: format!("{id}:{index}"),
                                role: "assistant".to_string(),
                                kind: "message".to_string(),
                                at: part_at,
                                text: Some(clip(text, MAX_TEXT)),
                                tool: None,
                            });
                        }
                        Some("tool") => {
                            let state = part.get("state");
                            let name = part
                                .get("tool")
                                .or_else(|| part.get("name"))
                                .and_then(Value::as_str)
                                .unwrap_or("tool");
                            let call_id = part
                                .get("callID")
                                .or_else(|| part.get("id"))
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            let output = state
                                .and_then(|state| {
                                    state
                                        .get("output")
                                        .and_then(Value::as_str)
                                        .map(str::to_string)
                                        .or_else(|| {
                                            state.get("content").map(|content| {
                                                content_text(Some(content), MAX_TOOL_OUTPUT)
                                            })
                                        })
                                })
                                .unwrap_or_default();
                            let status = state
                                .and_then(|state| state.get("status"))
                                .and_then(Value::as_str)
                                .unwrap_or("completed");
                            let duration = state
                                .and_then(|state| state.get("time"))
                                .map(|time| {
                                    duration_between(
                                        time.get("start").and_then(Value::as_i64),
                                        time.get("end").and_then(Value::as_i64),
                                    )
                                })
                                .unwrap_or(None);
                            builder.push_tool(
                                ChatMessage {
                                    id: format!("{id}:tool:{index}"),
                                    role: "tool".to_string(),
                                    kind: "tool".to_string(),
                                    at: part_at,
                                    text: None,
                                    tool: Some(ChatTool {
                                        name: name.to_string(),
                                        input: state
                                            .and_then(|state| readable_input(state.get("input"))),
                                        output: Some(clip(&output, MAX_TOOL_OUTPUT))
                                            .filter(|text| !text.is_empty()),
                                        status: tool_status(status),
                                        duration_ms: duration,
                                        call_id: Some(call_id.clone()).filter(|id| !id.is_empty()),
                                    }),
                                },
                                Some(call_id),
                            );
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// 旧版 OpenCode 的 JSON storage 兜底：只还原文本，没有工具也不报错。
fn parse_opencode_json(
    path: &Path,
    session_id: &str,
    builder: &mut Builder,
) -> Result<(), TranscriptError> {
    let root = path
        .parent()
        .ok_or_else(|| TranscriptError::Parse(tr("agent.transcript.opencode.dir").to_string()))?;
    let messages = root.join("storage").join("message").join(session_id);
    let entries =
        fs::read_dir(&messages).map_err(|error| TranscriptError::NotFound(error.to_string()))?;
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect();
    // 旧版文件名不保证可按字典序还原时间，按 mtime 排序更稳。
    files.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
    });
    for path in files {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(data) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let role = data.get("role").and_then(Value::as_str).unwrap_or("");
        let parts = data.get("parts").and_then(Value::as_array);
        if let Some(parts) = parts {
            for (index, part) in parts.iter().enumerate() {
                let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
                if kind == "text" {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        if !text.trim().is_empty() {
                            builder.push(ChatMessage {
                                id: format!("{session_id}:{role}:{index}"),
                                role: role.to_string(),
                                kind: "message".to_string(),
                                at: String::new(),
                                text: Some(clip(text, MAX_TEXT)),
                                tool: None,
                            });
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

fn clip(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    // 按字节上限截断，同时落在字符边界上，避免切断多字节字符。
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        let next = index + ch.len_utf8();
        if next > limit {
            break;
        }
        end = next;
    }
    format!("{}…", &text[..end])
}

/// 取 content 数组 / 字符串里的可读文本。
fn content_text(value: Option<&Value>, limit: usize) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match value {
        Value::String(text) => clip(text, limit),
        Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                if let Some(text) = item.as_str() {
                    parts.push(text.to_string());
                } else if let Some(text) = item.get("text").and_then(Value::as_str) {
                    parts.push(text.to_string());
                } else if let Some(text) = item.get("content").and_then(Value::as_str) {
                    parts.push(text.to_string());
                }
            }
            clip(&parts.join("\n"), limit)
        }
        Value::Object(_) => {
            let text = value
                .get("text")
                .or_else(|| value.get("output"))
                .or_else(|| value.get("content"))
                .map(|inner| content_text(Some(inner), limit))
                .unwrap_or_default();
            if text.is_empty() {
                clip(&value.to_string(), limit)
            } else {
                text
            }
        }
        other => clip(&other.to_string(), limit),
    }
}

/// 工具参数摘要：优先命令 / 路径 / 查询，否则压缩 JSON。
fn readable_input(value: Option<&Value>) -> Option<String> {
    const KEYS: &[&str] = &[
        "command",
        "cmd",
        "file_path",
        "filePath",
        "path",
        "pattern",
        "query",
        "url",
        "description",
        "i",
        "intent",
    ];
    let value = value?;
    if let Value::Object(object) = value {
        for key in KEYS {
            if let Some(found) = object.get(*key) {
                let text = match found {
                    Value::String(text) => text.clone(),
                    Value::Array(items) => items
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" "),
                    other => other.to_string(),
                };
                if !text.trim().is_empty() {
                    return Some(clip(&text, MAX_TOOL_INPUT));
                }
            }
        }
    }
    let text = match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    Some(clip(&text, MAX_TOOL_INPUT)).filter(|text| !text.is_empty())
}

fn duration_ms(start: &str, end: &str) -> Option<u64> {
    let start = DateTime::parse_from_rfc3339(start).ok()?;
    let end = DateTime::parse_from_rfc3339(end).ok()?;
    let millis = (end - start).num_milliseconds();
    (millis >= 0).then_some(millis as u64)
}

fn duration_between(start: Option<i64>, end: Option<i64>) -> Option<u64> {
    match (start, end) {
        (Some(start), Some(end)) if end >= start => Some((end - start) as u64),
        _ => None,
    }
}

fn ms_to_rfc3339(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let nanos = (millis.rem_euclid(1000) * 1_000_000) as u32;
    Utc.timestamp_opt(seconds, nanos)
        .single()
        .map(|time| time.to_rfc3339())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(kind: &str, text: &str) -> Value {
        json!({
            "type": "assistant",
            "uuid": "u1",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": { "role": "assistant", "content": [
                { "type": kind, "text": text }
            ]}
        })
    }

    fn parse_jsonl_for_test(agent: TranscriptAgent, records: &[Value]) -> Builder {
        let mut builder = Builder::default();
        for record in records {
            match agent {
                TranscriptAgent::Claude => {
                    if record.get("isSidechain").and_then(Value::as_bool) == Some(true)
                        || record.get("isMeta").and_then(Value::as_bool) == Some(true)
                    {
                        continue;
                    }
                    let at = record
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let id = record
                        .get("uuid")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let message = &record["message"];
                    match record.get("type").and_then(Value::as_str) {
                        Some("user") => parse_claude_user(message, id, at, &mut builder),
                        _ => parse_claude_assistant(message, id, at, &mut builder),
                    }
                }
                TranscriptAgent::Omp => {
                    let at = record["timestamp"].as_str().unwrap_or_default();
                    let id = record.get("id").and_then(Value::as_str).unwrap_or_default();
                    let message = &record["message"];
                    match message.get("role").and_then(Value::as_str) {
                        Some("user") => {
                            let text = content_text(message.get("content"), MAX_TEXT);
                            builder.push(ChatMessage {
                                id: format!("{id}:user"),
                                role: "user".into(),
                                kind: "message".into(),
                                at: at.into(),
                                text: Some(text),
                                tool: None,
                            });
                        }
                        Some("toolResult") => {
                            builder.attach_result(
                                message["toolCallId"].as_str().unwrap_or_default(),
                                content_text(message.get("content"), MAX_TOOL_OUTPUT),
                                message["isError"].as_bool() == Some(true),
                                at,
                            );
                        }
                        _ => parse_omp_assistant(message, id, at, &mut builder),
                    }
                }
                _ => {}
            }
        }
        builder
    }

    #[test]
    fn claude_merges_tool_use_and_result_with_duration() {
        let records = vec![
            json!({
                "type": "assistant",
                "uuid": "a1",
                "timestamp": "2026-01-01T00:00:00Z",
                "message": { "role": "assistant", "content": [
                    { "type": "thinking", "thinking": "先看看文件" },
                    { "type": "tool_use", "id": "toolu_1", "name": "Bash",
                      "input": { "command": "cargo test" } }
                ]}
            }),
            json!({
                "type": "user",
                "uuid": "u1",
                "timestamp": "2026-01-01T00:00:02Z",
                "message": { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_1", "content": "ok" }
                ]}
            }),
        ];
        let builder = parse_jsonl_for_test(TranscriptAgent::Claude, &records);
        assert_eq!(builder.messages.len(), 2);
        assert_eq!(builder.messages[0].kind, "thinking");
        let tool = builder.messages[1].tool.as_ref().expect("tool card");
        assert_eq!(tool.status, "done");
        assert_eq!(tool.output.as_deref(), Some("ok"));
        assert_eq!(tool.duration_ms, Some(2000));
    }

    #[test]
    fn claude_skips_sidechain_and_injected_text() {
        let records = vec![json!({
            "type": "user",
            "isSidechain": true,
            "uuid": "s1",
            "message": { "role": "user", "content": "子 Agent" }
        })];
        let builder = parse_jsonl_for_test(TranscriptAgent::Claude, &records);
        assert!(builder.messages.is_empty());

        let mut builder = Builder::default();
        parse_claude_user(
            &json!({ "role": "user", "content": "<system-reminder>x</system-reminder>" }),
            "u1",
            "",
            &mut builder,
        );
        assert!(builder.messages.is_empty());
    }

    #[test]
    fn omp_matches_tool_results_and_marks_errors() {
        let records = vec![
            json!({
                "type": "message", "id": "m1", "timestamp": "2026-01-01T00:00:00Z",
                "message": { "role": "assistant", "content": [
                    { "type": "toolCall", "id": "call_1", "name": "bash",
                      "arguments": { "command": "false", "i": "检查" } }
                ]}
            }),
            json!({
                "type": "message", "id": "m2", "timestamp": "2026-01-01T00:00:01Z",
                "message": { "role": "toolResult", "toolCallId": "call_1",
                             "isError": true, "content": [{ "type": "text", "text": "failed" }] }
            }),
        ];
        let builder = parse_jsonl_for_test(TranscriptAgent::Omp, &records);
        let tool = builder.messages[0].tool.as_ref().expect("tool card");
        assert_eq!(tool.status, "failed");
        assert_eq!(tool.duration_ms, Some(1000));
        assert_eq!(tool.input.as_deref(), Some("false"));
    }

    #[test]
    fn codex_command_execution_becomes_a_tool_card() {
        let mut builder = Builder::default();
        parse_codex_item(
            &json!({
                "type": "item_completed",
                "started_at_ms": 1000,
                "completed_at_ms": 3500,
                "item": {
                    "type": "CommandExecution",
                    "id": "exec-1",
                    "command": ["/bin/zsh", "-lc", "cargo test"],
                    "aggregated_output": "ok",
                    "status": "completed"
                }
            }),
            "2026-01-01T00:00:03Z",
            &mut builder,
        );
        let tool = builder.messages[0].tool.as_ref().expect("tool card");
        assert_eq!(tool.name, "exec");
        assert_eq!(tool.status, "done");
        assert_eq!(tool.duration_ms, Some(2500));
        assert!(tool.input.as_deref().unwrap().contains("cargo test"));
    }

    #[test]
    fn opencode_v2_assistant_blocks_are_flattened() {
        let mut builder = Builder::default();
        let connection = Connection::open_in_memory().expect("sqlite");
        connection
            .execute_batch(
                "CREATE TABLE session_message (
                    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
                    time_created INTEGER, time_updated INTEGER, data TEXT
                );",
            )
            .expect("schema");
        connection
            .execute(
                "INSERT INTO session_message VALUES ('m1','s1','assistant',1,1000,1000,?1)",
                [json!({
                    "time": { "created": 1000 },
                    "content": [
                        { "type": "reasoning", "text": "想一想" },
                        { "type": "text", "text": "开始" },
                        { "type": "tool", "id": "call_1", "name": "bash",
                          "state": { "status": "completed", "input": { "command": "ls" },
                                     "output": "a\nb",
                                     "time": { "start": 1000, "end": 1500 } } }
                    ]
                })
                .to_string()],
            )
            .expect("insert");
        parse_opencode_v2(&connection, "s1", &mut builder).expect("parse");
        assert_eq!(builder.messages.len(), 3);
        assert_eq!(
            builder.messages[2].tool.as_ref().unwrap().duration_ms,
            Some(500)
        );
    }

    #[test]
    fn opencode_reports_provider_errors_and_models() {
        let mut builder = Builder::default();
        let connection = Connection::open_in_memory().expect("sqlite");
        connection
            .execute_batch(
                "CREATE TABLE session_message (
                    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
                    time_created INTEGER, time_updated INTEGER, data TEXT
                );",
            )
            .expect("schema");
        connection
            .execute(
                "INSERT INTO session_message VALUES ('m1','s1','assistant',1,1000,1000,?1)",
                [json!({
                    "time": { "created": 1000 },
                    "model": { "id": "deepseek-v4.1-flash", "providerID": "opencode-go" },
                    "error": { "name": "APIError", "data": { "message": "rate limited" } },
                    "content": []
                })
                .to_string()],
            )
            .expect("insert");
        parse_opencode_v2(&connection, "s1", &mut builder).expect("parse");
        assert_eq!(builder.error.as_deref(), Some("rate limited"));
        assert_eq!(
            builder.model.as_deref(),
            Some("opencode-go/deepseek-v4.1-flash")
        );
    }

    #[test]
    fn claude_path_encoding_replaces_each_separator() {
        assert_eq!(encode_claude_path("/Users/omi/a_b"), "-Users-omi-a-b");
    }

    #[test]
    fn clips_respect_character_boundaries() {
        let text = "中文消息".repeat(10);
        let clipped = clip(&text, 7);
        assert!(clipped.chars().count() <= 8);
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn message_matches_test_helper_shape() {
        let record = message("text", "hello");
        assert_eq!(record["message"]["content"][0]["text"], "hello");
    }

    #[test]
    fn finds_the_matching_session_file_recursively() {
        let root = std::env::temp_dir().join(format!(
            "tapd-transcript-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let nested = root.join("2026").join("01");
        fs::create_dir_all(&nested).expect("temp dir");
        fs::write(nested.join("other-session.jsonl"), "{}").expect("write");
        let target = nested.join("rollout-2026-01-01-abc_xyz.jsonl");
        fs::write(&target, "{}").expect("write");

        let found = find_session_file(&root, "abc", &|stem| stem.contains("abc"), 6);
        assert_eq!(found.as_deref(), Some(target.as_path()));

        let missing = find_session_file(&root, "nope", &|stem| stem.contains("nope"), 6);
        assert!(missing.is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn provider_errors_and_models_are_extracted() {
        let root = std::env::temp_dir().join(format!(
            "tapd-transcript-error-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&root).expect("temp dir");

        // Claude：synthetic assistant 消息表示 API / 模型错误。
        let claude = root.join("claude.jsonl");
        fs::write(
            &claude,
            format!(
                "{}\n",
                json!({
                    "type": "assistant",
                    "uuid": "a1",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "isApiErrorMessage": true,
                    "message": {
                        "role": "assistant",
                        "model": "<synthetic>",
                        "content": [{ "type": "text", "text": "API Error: overloaded" }]
                    }
                })
            ),
        )
        .expect("write");
        let mut builder = Builder::default();
        parse_claude(&claude, &mut builder).expect("claude parses");
        assert_eq!(builder.error.as_deref(), Some("API Error: overloaded"));

        // Codex：task_complete.error + turn_context.model。
        let codex = root.join("codex.jsonl");
        fs::write(
            &codex,
            format!(
                "{}\n{}\n",
                json!({
                    "type": "turn_context",
                    "payload": { "model": "gpt-6-astra" }
                }),
                json!({
                    "type": "event_msg",
                    "timestamp": "2026-01-01T00:00:01Z",
                    "payload": {
                        "type": "task_complete",
                        "error": { "message": "Selected model is at capacity" }
                    }
                })
            ),
        )
        .expect("write");
        let mut builder = Builder::default();
        parse_codex(&codex, &mut builder).expect("codex parses");
        assert_eq!(
            builder.error.as_deref(),
            Some("Selected model is at capacity")
        );
        assert_eq!(builder.model.as_deref(), Some("gpt-6-astra"));

        // OMP：stopReason=error 的重试耗尽记录。
        let omp = root.join("omp.jsonl");
        fs::write(
            &omp,
            format!(
                "{}\n{}\n",
                json!({
                    "type": "model_change",
                    "model": "opencode-go/deepseek-v4.1-flash"
                }),
                json!({
                    "type": "message",
                    "id": "m1",
                    "timestamp": "2026-01-01T00:00:01Z",
                    "message": {
                        "role": "assistant",
                        "model": "deepseek-v4.1-flash",
                        "stopReason": "error",
                        "errorMessage": "ECONNRESET: socket closed",
                        "content": []
                    }
                })
            ),
        )
        .expect("write");
        let mut builder = Builder::default();
        parse_omp(&omp, &mut builder).expect("omp parses");
        assert_eq!(builder.error.as_deref(), Some("ECONNRESET: socket closed"));
        assert_eq!(builder.model.as_deref(), Some("deepseek-v4.1-flash"));

        let _ = fs::remove_dir_all(&root);
    }
}
