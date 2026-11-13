//! 各运行时的会话监控 hook。
//!
//! 安装方式沿用 Orca：每个客户端写自己原生的 hook / 插件，hook 脚本把事件
//! POST 到桌面端的 loopback `/agent/hook` 端点。这样权限、事件和 token 都在
//! 桌面端收口，客户端只负责“什么时候触发了什么事件”。
//!
//! OMP 仍然用 `--extension` 临时挂载扩展，但扩展内部同样 POST，不再写文件。

use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tapd_i18n::{tr, tr_args};
use toml_edit::{value, DocumentMut, Item, Table};

use super::{EXTENSION_DIR, OMP_SESSION_HOOK};

/// 会话监控 hook 的接入方式。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum SessionHookKind {
    #[default]
    None,
    /// OMP：启动时用 `--extension` 挂载临时扩展。
    Omp,
    /// OpenCode：在全局插件目录写一个状态插件。
    OpenCode,
    /// Codex：`hooks.json` + `config.toml` 的 hook 信任哈希。
    Codex,
    /// Claude 系客户端：`<dir>/settings.json` 里的 `hooks` 配置。
    ClaudeSettings {
        dir: &'static str,
        /// 例如 `CLAUDE_CONFIG_DIR`；为空时用 HOME 下的 `dir`。
        env: Option<&'static str>,
        /// 该客户端支持的事件名；不同兼容实现的枚举不完全一致。
        events: &'static [&'static str],
    },
    /// Cursor：`~/.cursor/hooks.json`，字段是扁平的 `command`。
    Cursor,
    /// Gemini CLI：`~/.gemini/settings.json`，事件名是 AfterAgent 等。
    Gemini,
    /// Kimi Code：`~/.kimi-code/config.toml` 的 `[[hooks]]` 表。
    Kimi,
    /// ZCode：`~/.zcode/cli/config.json` 的 `hooks.events`。
    Zcode,
}

impl SessionHookKind {
    pub(crate) fn is_some(self) -> bool {
        self != Self::None
    }
}

/// 一次任务启动时 hook 需要追加的参数与环境变量。
pub(crate) struct HookLaunch {
    pub(crate) args: Vec<String>,
    pub(crate) envs: Vec<(String, String)>,
}

/// 共享 hook 脚本的文件名，也是判断配置项是否由本应用写入的依据。
const HOOK_SCRIPT_NAME: &str = "tapd-agent-hook.sh";
const OPENCODE_PLUGIN_NAME: &str = "tapd-session-monitor.js";
const KIMI_BLOCK_START: &str = "# >>> tapd-agent-session-hook >>>";
const KIMI_BLOCK_END: &str = "# <<< tapd-agent-session-hook <<<";

/// Claude Code 的生命周期与工具事件；兼容实现会按自己的枚举取子集。
pub(crate) const CLAUDE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Notification",
    "PostCompact",
];

/// Qwen Code / Qoder / CodeBuddy 的官方事件枚举。
pub(crate) const QWEN_EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Stop",
    "StopFailure",
    "Notification",
    "SubagentStart",
    "SubagentStop",
];

const GEMINI_EVENTS: &[&str] = &["BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool"];

const KIMI_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Stop",
    "StopFailure",
];

const ZCODE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
];

const CURSOR_EVENTS: &[&str] = &[
    "afterAgentResponse",
    "postToolUse",
    "postToolUseFailure",
    "stop",
];

/// Codex 当前识别的事件；`Interrupt` 的超时上限是 3 秒。
const CODEX_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Interrupt",
];

/// 安装/刷新客户端 hook，返回需要追加到启动命令的参数（目前只有 OMP 需要）。
pub(crate) fn prepare(data_dir: &Path, kind: SessionHookKind) -> Result<Vec<String>, String> {
    if kind == SessionHookKind::None {
        return Err(tr("agent.hook.undeclared").to_string());
    }
    if kind == SessionHookKind::Omp {
        return install_omp_extension(data_dir);
    }
    let script = write_hook_script(data_dir)?;
    install_client_hook(kind, &script)?;
    Ok(Vec::new())
}

/// OMP 扩展挂在应用数据目录，内容不变时不重复落盘。
fn install_omp_extension(data_dir: &Path) -> Result<Vec<String>, String> {
    let extension_dir = data_dir.join(EXTENSION_DIR);
    std::fs::create_dir_all(&extension_dir)
        .map_err(|error| tr_args("agent.hook.omp.dir.failed", &[&error]))?;
    let script = extension_dir.join("omp-session-monitor.ts");
    if std::fs::read_to_string(&script).ok().as_deref() != Some(OMP_SESSION_HOOK) {
        std::fs::write(&script, OMP_SESSION_HOOK)
            .map_err(|error| tr_args("agent.hook.omp.write.failed", &[&error]))?;
    }
    Ok(vec![
        "--extension".to_string(),
        script.to_string_lossy().into_owned(),
    ])
}

/// 写共享 hook 脚本。URL / token / taskId 都由任务启动时的环境变量提供，
/// 所以脚本本身不含任何任务状态，安装一次即可长期复用。
#[cfg(unix)]
fn write_hook_script(data_dir: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let dir = data_dir.join("agent-hooks");
    std::fs::create_dir_all(&dir).map_err(|error| tr_args("agent.hook.dir.failed", &[&error]))?;
    let script_path = dir.join(HOOK_SCRIPT_NAME);
    let script = r#"#!/bin/sh
# tapd agent session hook：把原生 hook 事件转成桌面端的 loopback POST。 // i18n-exempt: hook script body
# 先输出空对象，Cursor / Gemini / ZCode 对 hook 输出有严格 JSON 校验； // i18n-exempt: hook script body
# curl 或桌面端不可用时也不会把会话卡住。 // i18n-exempt: hook script body
phase="$1"
session_id="$2"
printf '{}\n'
if [ -z "${TAPD_AGENT_HOOK_URL:-}" ] || [ -z "${TAPD_AGENT_HOOK_TOKEN:-}" ] || [ -z "${TAPD_AGENT_TASK_ID:-}" ]; then
  cat >/dev/null 2>&1 || :
  exit 0
fi
curl -sS -X POST "$TAPD_AGENT_HOOK_URL" \
  --connect-timeout 0.5 --max-time 2 \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Tapd-Hook-Token: $TAPD_AGENT_HOOK_TOKEN" \
  --data-urlencode "taskId=$TAPD_AGENT_TASK_ID" \
  --data-urlencode "event=$phase" \
  --data-urlencode "runtime=${TAPD_AGENT_RUNTIME:-}" \
  --data-urlencode "sessionId=$session_id" \
  --data-urlencode "willContinue=false" \
  --data-urlencode "awaitingAsyncWork=false" \
  --data-urlencode "payload@-" >/dev/null 2>&1 || :
exit 0
"#;

    if std::fs::read_to_string(&script_path).ok().as_deref() != Some(script) {
        std::fs::write(&script_path, script)
            .map_err(|error| tr_args("agent.hook.script.write.failed", &[&error]))?;
    }
    let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755));
    Ok(script_path)
}

#[cfg(not(unix))]
fn write_hook_script(_data_dir: &Path) -> Result<PathBuf, String> {
    Err(tr("agent.hook.platform.unsupported").to_string())
}

fn install_client_hook(kind: SessionHookKind, script: &Path) -> Result<(), String> {
    match kind {
        SessionHookKind::None | SessionHookKind::Omp => Ok(()),
        SessionHookKind::OpenCode => install_opencode_plugin(),
        SessionHookKind::Codex => install_codex(script),
        SessionHookKind::ClaudeSettings { dir, env, events } => {
            let path = claude_settings_path(dir, env)?;
            install_claude_like(&path, script, events)
        }
        SessionHookKind::Cursor => {
            let path = home_config_path(".cursor", "hooks.json")?;
            install_cursor(&path, script)
        }
        SessionHookKind::Gemini => {
            let path = home_config_path(".gemini", "settings.json")?;
            install_gemini(&path, script)
        }
        SessionHookKind::Kimi => {
            let path = kimi_config_path()?;
            install_kimi(&path, script)
        }
        SessionHookKind::Zcode => {
            let path = home_config_path(".zcode/cli", "config.json")?;
            install_zcode(&path, script)
        }
    }
}

// ---------------------------------------------------------------------------
// 配置路径
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, String> {
    tapd_core::paths::home_dir().map_err(|error| tr_args("agent.home.lookup.failed", &[&error]))
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn home_config_path(dir: &str, file: &str) -> Result<PathBuf, String> {
    Ok(home_dir()?.join(dir).join(file))
}

fn claude_settings_path(dir: &str, env: Option<&str>) -> Result<PathBuf, String> {
    if let Some(dir) = env.and_then(env_path) {
        // CLAUDE_CONFIG_DIR 指向存放 settings.json 的目录；也兼容直接给 .json 文件。
        return Ok(
            if dir.extension().is_some_and(|extension| extension == "json") {
                dir
            } else {
                dir.join("settings.json")
            },
        );
    }
    home_config_path(dir, "settings.json")
}

fn kimi_config_path() -> Result<PathBuf, String> {
    let home = env_path("KIMI_CODE_HOME").unwrap_or(home_dir()?.join(".kimi-code"));
    Ok(home.join("config.toml"))
}

fn codex_home() -> Result<PathBuf, String> {
    Ok(env_path("CODEX_HOME").unwrap_or(home_dir()?.join(".codex")))
}

fn opencode_plugin_path() -> Result<PathBuf, String> {
    let dir = env_path("OPENCODE_CONFIG_DIR")
        .or_else(|| env_path("XDG_CONFIG_HOME").map(|base| base.join("opencode")))
        .unwrap_or(home_dir()?.join(".config").join("opencode"));
    Ok(dir.join("plugins").join(OPENCODE_PLUGIN_NAME))
}

// ---------------------------------------------------------------------------
// OpenCode 插件
// ---------------------------------------------------------------------------

/// OpenCode 插件没有配置项，落一个全局插件文件即可。插件在没有任务环境变量
/// 时完全不发请求，所以常驻也不会影响日常使用。
const OPENCODE_PLUGIN: &str = r#"// TAPD agent session monitor: 只在桌面端启动的任务里上报回合状态。 // i18n-exempt: hook script body
import { request } from "node:http";

const post = (event, sessionId, payload = {}) => {
  const rawUrl = process.env.TAPD_AGENT_HOOK_URL;
  const token = process.env.TAPD_AGENT_HOOK_TOKEN;
  const taskId = process.env.TAPD_AGENT_TASK_ID;
  if (!rawUrl || !token || !taskId) return;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }

  const body = new URLSearchParams({
    taskId,
    event,
    runtime: process.env.TAPD_AGENT_RUNTIME || "opencode",
    sessionId: sessionId || "",
    willContinue: "false",
    awaitingAsyncWork: "false",
    payload: JSON.stringify(payload || {}),
  }).toString();

  try {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          "X-Tapd-Hook-Token": token,
        },
      },
      (res) => res.resume(),
    );
    req.on("error", () => {});
    req.write(body);
    req.end();
  } catch {
    // 桌面端还有静默完成兜底，这里失败不影响会话。
  }
};

let sawActivity = false;
let sawUserPrompt = false;
let attention = false;
let lastError = "";
const startedAt = Date.now();
const rootSessions = new Set();
const childSessions = new Set();
const messageRoles = new Map();
const userPromptPosted = new Set();
const toolStates = new Map();
const toolStarted = new Set();
const lastAssistant = new Map();
const lastModel = new Map();

const clip = (value, limit) => {
  if (value == null) return "";
  let text = value;
  if (typeof text !== "string") {
    try {
      text = JSON.stringify(text);
    } catch {
      return "";
    }
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};

// 长会话里消息/工具 key 会持续增长，只保留最近的一小段。
const cap = (map, limit = 512) => {
  while (map.size > limit) map.delete(map.keys().next().value);
};

export const TapdSessionMonitor = async () => ({
  event: async ({ event }) => {
    if (!event?.type) return;
    if (!process.env.TAPD_AGENT_HOOK_URL) return;
    const sessionID = event.properties?.sessionID;
    const isRoot = (id) => !id || rootSessions.size === 0 || rootSessions.has(id);
    if (event.type === "session.created") {
      const info = event.properties?.info;
      if (!info?.id) return;
      if (info.parentID) {
        childSessions.add(info.id);
        // 子会话 id 不能覆盖主任务的 resume session id。
        post("SubagentStart", "", { agent_id: info.id, subagent_type: info.title || "" });
      } else {
        rootSessions.add(info.id);
        post("SessionStart", info.id, { message: "会话已启动" }); // i18n-exempt: hook script body
      }
      return;
    }
    if (event.type === "session.deleted") {
      const deletedID = event.properties?.info?.id || event.properties?.sessionID;
      if (!deletedID) return;
      if (rootSessions.delete(deletedID)) {
        post("SessionEnd", deletedID, {});
      } else if (childSessions.delete(deletedID)) {
        post("SubagentStop", "", { agent_id: deletedID });
      }
      return;
    }
    if (!isRoot(sessionID)) {
      // 子会话只上报 SubagentStop；工具/消息细节不污染主任务状态。
      if (event.type === "session.idle" && childSessions.delete(sessionID)) {
        post("SubagentStop", "", { agent_id: sessionID });
      }
      return;
    }
    if (event.type === "session.status") {
      const status = event.properties?.status;
      const type = typeof status === "string" ? status : status?.type;
      // 只用 busy/retry 判断「本轮真的开始了」；启动时加载历史消息不会触发。
      if (type === "busy" || type === "retry") {
        sawUserPrompt = true;
        sawActivity = true;
        attention = false;
        lastError = "";
        if (type === "retry") {
          post("Notification", sessionID, { message: "正在重试" }); // i18n-exempt: hook script body
        } else {
          post("AgentStart", sessionID, {});
        }
      }
      return;
    }
    if (event.type === "message.updated") {
      const info = event.properties?.info;
      if (info?.id && info.role) messageRoles.set(info.id, info.role);
      if (info?.modelID && sessionID) lastModel.set(sessionID, info.modelID);
      cap(messageRoles);
      cap(lastModel);
      const created = info?.time?.created;
      // 历史会话加载也会发 user message；只认插件启动之后创建的消息。
      if (info?.role === "user" && typeof created === "number" && created >= startedAt - 2000) {
        sawUserPrompt = true;
        sawActivity = true;
        attention = false;
        lastError = "";
      }
      return;
    }
    if (event.type === "message.part.updated") {
      const part = event.properties?.part;
      if (!part) return;
      if (part.type === "text") {
        const role = messageRoles.get(part.messageID);
        if (role === "user" && part.text && !userPromptPosted.has(part.messageID)) {
          userPromptPosted.add(part.messageID);
          cap(userPromptPosted);
          // 历史会话加载时也会发 text part；只有本轮 busy 之后才上报。
          if (sawUserPrompt) {
            post("UserPromptSubmit", sessionID, {
              prompt: clip(part.text, 200),
              model: lastModel.get(sessionID),
            });
          }
        } else if (role === "assistant" && part.text && sawUserPrompt) {
          lastAssistant.set(sessionID, clip(part.text, 400));
          cap(lastAssistant);
        }
        return;
      }
      if (part.type === "tool") {
        const key = part.callID || part.id || `${part.tool}:${sessionID}`;
        const status = part.state?.status || "";
        if (toolStates.get(key) === status) return;
        toolStates.set(key, status);
        cap(toolStates);
        if (status === "running" || status === "pending") {
          if (toolStarted.has(key)) return;
          toolStarted.add(key);
          cap(toolStarted);
          // 能执行工具说明提示词已经被处理，启动阶段的 idle 不再算本轮结束。
          sawUserPrompt = true;
          sawActivity = true;
          attention = false;
          lastError = "";
          post("PreToolUse", sessionID, {
            tool_name: part.tool,
            tool_input: part.state?.input,
            model: lastModel.get(sessionID),
          });
        } else if (status === "completed") {
          toolStarted.delete(key);
          post("PostToolUse", sessionID, {
            tool_name: part.tool,
            tool_response: part.state?.output,
            model: lastModel.get(sessionID),
          });
        } else if (status === "error") {
          toolStarted.delete(key);
          post("PostToolUseFailure", sessionID, {
            tool_name: part.tool,
            error: part.state?.error || "工具执行失败", // i18n-exempt: hook script body
            model: lastModel.get(sessionID),
          });
        }
        return;
      }
      return;
    }
    if (event.type === "permission.asked") {
      sawActivity = true;
      attention = true;
      const permission = event.properties?.permission || {};
      post("PermissionRequest", sessionID, {
        tool_name: permission.type || permission.tool || "",
        message: permission.title || permission.message || "等待权限确认", // i18n-exempt: hook script body
      });
      return;
    }
    if (event.type === "question.asked") {
      sawActivity = true;
      attention = true;
      const question =
        event.properties?.questions?.[0]?.question ||
        event.properties?.question ||
        event.properties?.message ||
        "等待用户回答"; // i18n-exempt: hook script body
      post("QuestionAsked", sessionID, { message: clip(question, 200) });
      return;
    }
    if (
      event.type === "permission.replied" ||
      event.type === "question.replied" ||
      event.type === "question.rejected"
    ) {
      attention = false;
      post("PermissionResolved", sessionID, {});
      return;
    }
    if (
      event.type === "session.next.prompt.admitted" ||
      event.type === "session.next.step.started"
    ) {
      // 只有真正处理过用户提示词后才允许 idle 结束本轮；启动时的 idle 不算。
      sawUserPrompt = true;
      sawActivity = true;
      lastError = "";
      const prompt = event.properties?.prompt?.text;
      if (prompt) {
        post("UserPromptSubmit", sessionID, {
          prompt: clip(prompt, 200),
          model: lastModel.get(sessionID),
        });
      }
      return;
    }
    if (event.type === "session.error") {
      const error = event.properties?.error || event.properties?.message || "会话执行出错"; // i18n-exempt: hook script body
      lastError = clip(error, 200);
      post("SessionError", sessionID, { error: lastError });
      return;
    }
    if (event.type === "session.idle") {
      if (attention || !sawUserPrompt || !sawActivity) return;
      sawUserPrompt = false;
      sawActivity = false;
      const message = lastAssistant.get(sessionID) || "";
      lastAssistant.delete(sessionID);
      // 出错后没有恢复就直接 idle，按失败收尾，不能标记成完成。
      if (lastError) {
        post("StopFailure", sessionID, { error: lastError });
        lastError = "";
      } else {
        post("Stop", sessionID, { message });
      }
    }
  },
});
"#;

fn install_opencode_plugin() -> Result<(), String> {
    write_opencode_plugin(&opencode_plugin_path()?)
}

fn write_opencode_plugin(path: &Path) -> Result<(), String> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(OPENCODE_PLUGIN) {
        return Ok(());
    }
    write_atomic(path, OPENCODE_PLUGIN.as_bytes())
        .map_err(|error| tr_args("agent.hook.opencode.write.failed", &[&error]))
}

// ---------------------------------------------------------------------------
// Claude 系 settings.json
// ---------------------------------------------------------------------------

/// Claude、Qwen、OpenClaude、Qoder、CodeBuddy 共用同一套 hook 结构：
/// `hooks.<Event>[].hooks[].command`。事件列表由描述符提供，命令统一转调
/// 共享脚本，由服务端按事件名归一化。
fn install_claude_like(path: &Path, script: &Path, events: &[&str]) -> Result<(), String> {
    let mut root = read_json_object(path)?;
    let hooks = root
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| tr_args("agent.hook.field.notObject", &[&path.display()]))?;

    // 先清掉本应用写入的所有旧项（事件列表可能变化），再按当前列表追加。
    remove_all_managed_entries(hooks);
    for event in events {
        append_command_hook(hooks, event, &hook_command(script, event, false))?;
    }

    write_json_config_if_changed(path, &Value::Object(root))
}

/// Gemini CLI 的事件名与 Claude 不同，结构相同。
fn install_gemini(path: &Path, script: &Path) -> Result<(), String> {
    let mut root = read_json_object(path)?;
    let hooks = root
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| tr_args("agent.hook.field.notObject", &[&path.display()]))?;

    remove_all_managed_entries(hooks);
    for event in GEMINI_EVENTS {
        append_command_hook(hooks, event, &hook_command(script, event, false))?;
    }

    write_json_config_if_changed(path, &Value::Object(root))
}

/// ZCode 把事件放在 `hooks.events` 下，并且必须显式 `hooks.enabled = true`。
/// `${CLAUDE_SESSION_ID}` 由 ZCode 在命令里展开，可以直接传给 sidecar。
fn install_zcode(path: &Path, script: &Path) -> Result<(), String> {
    let mut root = read_json_object(path)?;
    let hooks = root
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| tr_args("agent.hook.field.notObject", &[&path.display()]))?;
    hooks
        .entry("enabled".to_string())
        .or_insert(Value::Bool(true));
    if hooks.get("enabled") != Some(&Value::Bool(true)) {
        // 用户显式关闭 hooks 时不擅自打开，只记录失败让任务退回静默兜底。
        return Err(tr_args("agent.hook.zcode.disabled", &[&path.display()]));
    }
    let events = hooks
        .entry("events".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let events = events
        .as_object_mut()
        .ok_or_else(|| tr_args("agent.hook.events.notObject", &[&path.display()]))?;

    remove_all_managed_entries(events);
    for event in ZCODE_EVENTS {
        // ZCode 会把 ${CLAUDE_SESSION_ID} 展开到命令里，作为第二个参数传下去。
        append_command_hook(events, event, &hook_command(script, event, true))?;
    }

    write_json_config_if_changed(path, &Value::Object(root))
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/// Cursor 的 hooks.json 用扁平 `command`，并强制要求 `version`。
fn install_cursor(path: &Path, script: &Path) -> Result<(), String> {
    let mut root = read_json_object(path)?;
    root.entry("version".to_string())
        .or_insert(Value::Number(1.into()));
    let hooks = root
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| tr_args("agent.hook.field.notObject", &[&path.display()]))?;

    remove_all_managed_entries(hooks);
    // Cursor 的 beforeSubmitPrompt / preToolUse 需要明确的 allow 响应；
    // 这里只装响应为 {} 的事后事件，避免影响用户在非 TAPD 会话里的权限流程。
    for event in CURSOR_EVENTS {
        append_flat_hook(hooks, event, &hook_command(script, event, false))?;
    }

    write_json_config_if_changed(path, &Value::Object(root))
}

// ---------------------------------------------------------------------------
// Codex（hooks.json + config.toml 信任哈希）
// ---------------------------------------------------------------------------

fn install_codex(script: &Path) -> Result<(), String> {
    let home = codex_home()?;
    install_codex_at(&home.join("hooks.json"), &home.join("config.toml"), script)
}

/// 写 hooks.json 前先写信任表，避免 Codex 看到待确认的 hook。
///
/// Codex 按 `sourcePath:eventLabel:groupIndex:handlerIndex` 记录审批，哈希来自
/// handler 的规范化 JSON。这里只追加/替换本应用的组，保留用户的 hook 位置。
fn install_codex_at(hooks_path: &Path, config_path: &Path, script: &Path) -> Result<(), String> {
    let mut root = read_json_object(hooks_path)?;
    let hooks = root
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks
        .as_object_mut()
        .ok_or_else(|| tr_args("agent.hook.field.notObject", &[&hooks_path.display()]))?;

    let mut trust_entries = Vec::new();
    for event in CODEX_EVENTS {
        let timeout = codex_timeout(event);
        let command = hook_command(script, event, false);
        let definition = json!({
            "hooks": [{
                "type": "command",
                "command": command,
                "timeout": timeout
            }]
        });
        let entries = hooks
            .entry((*event).to_string())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| tr_args("agent.hook.notArray", &[&event]))?;

        let managed: Vec<usize> = entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry_uses_managed_script(entry))
            .map(|(index, _)| index)
            .collect();
        let group_index = match managed.first().copied() {
            Some(index) => {
                entries[index] = definition;
                // 旧版本可能留下多份本应用条目，只保留第一份。
                for duplicate in managed.iter().skip(1).rev() {
                    entries.remove(*duplicate);
                }
                index
            }
            None => {
                entries.push(definition);
                entries.len() - 1
            }
        };
        trust_entries.push((event.to_string(), group_index, command, timeout));
    }

    let source = canonical_hook_source(hooks_path);
    write_codex_trust(config_path, &source, &trust_entries)?;
    write_json_config_if_changed(hooks_path, &Value::Object(root))
}

fn canonical_hook_source(path: &Path) -> String {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let parent = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    parent
        .join(path.file_name().unwrap_or_default())
        .to_string_lossy()
        .into_owned()
}

fn write_codex_trust(
    config_path: &Path,
    source: &str,
    entries: &[(String, usize, String, u64)],
) -> Result<(), String> {
    let existing = match std::fs::read_to_string(config_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(tr_args(
                "agent.config.read.failed",
                &[&config_path.display(), &error],
            ))
        }
    };
    let mut doc: DocumentMut = existing.parse().map_err(|error| {
        tr_args(
            "agent.config.parse.failed",
            &[&config_path.display(), &error],
        )
    })?;

    let hooks = doc.entry("hooks").or_insert(Item::Table(Table::new()));
    let hooks = hooks
        .as_table_mut()
        .ok_or_else(|| tr_args("agent.hook.field.notTable", &[&config_path.display()]))?;
    let state = hooks.entry("state").or_insert(Item::Table(Table::new()));
    let state = state
        .as_table_mut()
        .ok_or_else(|| tr_args("agent.hook.state.notTable", &[&config_path.display()]))?;

    for (event, group_index, command, timeout) in entries {
        let label = codex_event_label(event)
            .ok_or_else(|| tr_args("agent.hook.codex.trust.missing", &[event]))?;
        let key = format!("{source}:{label}:{group_index}:0");
        let mut table = Table::new();
        table["enabled"] = value(true);
        table["trusted_hash"] = value(codex_trust_hash(label, command, *timeout));
        state.insert(&key, Item::Table(table));
    }

    let rendered = doc.to_string();
    if rendered != existing {
        backup_existing(config_path)?;
        write_atomic(config_path, rendered.as_bytes()).map_err(|error| {
            tr_args(
                "agent.config.write.failed",
                &[&config_path.display(), &error],
            )
        })?;
    }
    Ok(())
}

fn codex_event_label(event: &str) -> Option<&'static str> {
    match event {
        "SessionStart" => Some("session_start"),
        "UserPromptSubmit" => Some("user_prompt_submit"),
        "PreToolUse" => Some("pre_tool_use"),
        "PermissionRequest" => Some("permission_request"),
        "PostToolUse" => Some("post_tool_use"),
        "SubagentStart" => Some("subagent_start"),
        "SubagentStop" => Some("subagent_stop"),
        "Stop" => Some("stop"),
        "Interrupt" => Some("interrupt"),
        _ => None,
    }
}

fn codex_timeout(event: &str) -> u64 {
    // Codex 把 Interrupt 的 timeout 规范到 1..=3 秒，其余最大 600。
    if event == "Interrupt" {
        3
    } else {
        10
    }
}

/// 与 Codex 的发现逻辑保持一致：handler 的规范化 JSON 做 SHA-256。
fn codex_trust_hash(label: &str, command: &str, timeout: u64) -> String {
    let command = serde_json::to_string(command).unwrap_or_else(|_| "\"\"".to_string());
    let handler =
        format!(r#"{{"async":false,"command":{command},"timeout":{timeout},"type":"command"}}"#);
    let identity = format!(
        r#"{{"event_name":{},"hooks":[{handler}]}}"#,
        serde_json::to_string(label).unwrap_or_else(|_| "\"\"".to_string())
    );
    let digest = Sha256::digest(identity.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    format!("sha256:{hex}")
}

// ---------------------------------------------------------------------------
// Kimi（TOML 标记块）
// ---------------------------------------------------------------------------

/// Kimi 用 `[[hooks]]` 表。用标记块包住本应用的表，卸载/刷新都只动块内内容，
/// 不重写用户已有的 TOML。
fn install_kimi(path: &Path, script: &Path) -> Result<(), String> {
    let existing = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(tr_args(
                "agent.config.read.failed",
                &[&path.display(), &error],
            ))
        }
    };
    let without_block = remove_marked_block(&existing, KIMI_BLOCK_START, KIMI_BLOCK_END);
    let mut entries = Vec::new();
    for event in KIMI_EVENTS {
        let command = toml_string(&hook_command(script, event, false));
        // Kimi 在新建会话的首个提示词上会等待 SessionStart，只让 resume 触发。
        let matcher = if *event == "SessionStart" {
            "matcher = \"^resume$\"\n"
        } else {
            ""
        };
        entries.push(format!(
            "[[hooks]]\nevent = \"{event}\"\n{matcher}command = {command}\ntimeout = 10"
        ));
    }
    let block = format!(
        "{KIMI_BLOCK_START}\n{}\n{KIMI_BLOCK_END}\n",
        entries.join("\n\n")
    );
    let next = if without_block.trim().is_empty() {
        block
    } else {
        format!("{}\n{}", without_block.trim_end(), block)
    };
    if next != existing {
        write_atomic(path, next.as_bytes())
            .map_err(|error| tr_args("agent.hook.kimi.write.failed", &[&error]))?;
    }
    Ok(())
}

fn remove_marked_block(text: &str, start: &str, end: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut inside = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed == start {
            inside = true;
            continue;
        }
        if trimmed == end {
            inside = false;
            continue;
        }
        if !inside {
            output.push_str(line);
            output.push('\n');
        }
    }
    output
}

fn toml_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("\"{escaped}\"")
}

// ---------------------------------------------------------------------------
// JSON / 通用工具
// ---------------------------------------------------------------------------

fn hook_command(script: &Path, phase: &str, with_session_env: bool) -> String {
    let script = shell_quote(&script.to_string_lossy());
    if with_session_env {
        format!("/bin/sh {script} {phase} \"${{CLAUDE_SESSION_ID}}\"")
    } else {
        format!("/bin/sh {script} {phase}")
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn read_json_object(path: &Path) -> Result<Map<String, Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            let value: Value = serde_json::from_str(&raw).map_err(|error| {
                tr_args("agent.config.parse.failed", &[&path.display(), &error])
            })?;
            value
                .as_object()
                .cloned()
                .ok_or_else(|| tr_args("agent.config.root.notObject", &[&path.display()]))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(tr_args(
            "agent.config.read.failed",
            &[&path.display(), &error],
        )),
    }
}

fn write_json_config_if_changed(path: &Path, value: &Value) -> Result<(), String> {
    let mut rendered = serde_json::to_string_pretty(value)
        .map_err(|error| tr_args("agent.config.serialize.failed", &[&error]))?;
    rendered.push('\n');
    if std::fs::read_to_string(path).ok().as_deref() == Some(rendered.as_str()) {
        return Ok(());
    }
    backup_existing(path)?;
    write_atomic(path, rendered.as_bytes())
        .map_err(|error| tr_args("agent.config.write.failed", &[&path.display(), &error]))
}

fn backup_existing(path: &Path) -> Result<(), String> {
    let Ok(_) = std::fs::metadata(path) else {
        return Ok(());
    };
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let backup = path.with_file_name(format!("{name}.bak-tapd-{nanos}"));
    if !backup.exists() {
        std::fs::copy(path, &backup)
            .map_err(|error| tr_args("agent.config.backup.failed", &[&path.display(), &error]))?;
    }
    Ok(())
}

fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp = parent.join(format!(".{name}.tmp-{}-{nanos}", std::process::id()));
    if let Err(error) = std::fs::write(&temp, contents) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    if let Ok(metadata) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&temp, metadata.permissions());
    }
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

/// 清理所有事件里的本应用 hook；事件列表变化时也能移除旧版本留下的项。
fn remove_all_managed_entries(hooks: &mut Map<String, Value>) {
    let events: Vec<String> = hooks.keys().cloned().collect();
    for event in events {
        remove_managed_entries(hooks, &event);
    }
}

/// 删除某个事件下由本应用脚本写入的 hook 项，保留用户自己的 hook。
fn remove_managed_entries(hooks: &mut Map<String, Value>, event: &str) {
    let Some(entries) = hooks.get_mut(event).and_then(Value::as_array_mut) else {
        return;
    };
    entries.retain(|entry| !entry_uses_managed_script(entry));
    if entries.is_empty() {
        hooks.remove(event);
    }
}

fn entry_uses_managed_script(entry: &Value) -> bool {
    if let Some(command) = entry.get("command").and_then(Value::as_str) {
        return command.contains(HOOK_SCRIPT_NAME);
    }
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|command| command.contains(HOOK_SCRIPT_NAME))
            })
        })
}

/// Claude 系：`{"hooks": [{"type":"command","command": ...}]}`。
fn append_command_hook(
    hooks: &mut Map<String, Value>,
    event: &str,
    command: &str,
) -> Result<(), String> {
    let entries = hooks
        .entry(event.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let entries = entries
        .as_array_mut()
        .ok_or_else(|| tr_args("agent.hook.notArray", &[&event]))?;
    entries.push(json!({
        "hooks": [{
            "type": "command",
            "command": command,
            "timeout": 10
        }]
    }));
    Ok(())
}

/// Cursor：`{"hooks": [{"command": ...}]}`。
fn append_flat_hook(
    hooks: &mut Map<String, Value>,
    event: &str,
    command: &str,
) -> Result<(), String> {
    let entries = hooks
        .entry(event.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let entries = entries
        .as_array_mut()
        .ok_or_else(|| tr_args("agent.hook.notArray", &[&event]))?;
    entries.push(json!({ "command": command, "timeout": 10 }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tapd-agent-hooks-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn script(dir: &Path) -> PathBuf {
        dir.join(HOOK_SCRIPT_NAME)
    }

    #[test]
    fn claude_hooks_are_idempotent_and_keep_user_hooks() {
        let dir = temp_dir("hook-claude");
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-hook"}]}]}}"#,
        )
        .unwrap();

        install_claude_like(&path, &script(&dir), CLAUDE_EVENTS).unwrap();
        install_claude_like(&path, &script(&dir), CLAUDE_EVENTS).unwrap();

        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let stop = value.pointer("/hooks/Stop").unwrap().as_array().unwrap();
        assert_eq!(stop.len(), 2, "user hook + one managed hook");
        assert!(stop
            .iter()
            .any(|entry| entry.to_string().contains("user-hook")));
        let managed = value.to_string().matches(HOOK_SCRIPT_NAME).count();
        assert_eq!(managed, CLAUDE_EVENTS.len(), "one entry per event");
        assert!(value.pointer("/hooks/PreToolUse").is_some());

        cleanup(&dir);
    }

    #[test]
    fn cursor_uses_flat_command_and_version() {
        let dir = temp_dir("hook-cursor");
        let path = dir.join("hooks.json");
        install_cursor(&path, &script(&dir)).unwrap();

        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value.get("version"), Some(&Value::Number(1.into())));
        assert!(value
            .pointer("/hooks/stop/0/command")
            .and_then(Value::as_str)
            .is_some_and(|command| command.contains(HOOK_SCRIPT_NAME)));

        cleanup(&dir);
    }

    #[test]
    fn zcode_installs_events_and_keeps_user_events() {
        let dir = temp_dir("hook-zcode");
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            r#"{"hooks":{"enabled":true,"events":{"Stop":[{"hooks":[{"type":"command","command":"user"}]}]}}}"#,
        )
        .unwrap();

        install_zcode(&path, &script(&dir)).unwrap();
        install_zcode(&path, &script(&dir)).unwrap();

        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value.pointer("/hooks/enabled"), Some(&Value::Bool(true)));
        let stop = value
            .pointer("/hooks/events/Stop")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(stop.len(), 2);
        assert!(stop
            .iter()
            .any(|entry| entry.to_string().contains("\"user\"")));
        assert!(value.pointer("/hooks/events/SessionStart").is_some());

        cleanup(&dir);
    }

    #[test]
    fn kimi_marker_block_is_replaced_not_duplicated() {
        let dir = temp_dir("hook-kimi");
        let path = dir.join("config.toml");
        std::fs::write(&path, "theme = \"dark\"\n").unwrap();

        install_kimi(&path, &script(&dir)).unwrap();
        install_kimi(&path, &script(&dir)).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("theme = \"dark\""));
        assert_eq!(text.matches(KIMI_BLOCK_START).count(), 1);
        assert_eq!(text.matches("[[hooks]]").count(), KIMI_EVENTS.len());
        assert_eq!(text.matches(HOOK_SCRIPT_NAME).count(), KIMI_EVENTS.len());

        cleanup(&dir);
    }

    #[test]
    fn opencode_plugin_is_written_and_idempotent() {
        let dir = temp_dir("hook-opencode");
        let path = dir.join(OPENCODE_PLUGIN_NAME);

        write_opencode_plugin(&path).unwrap();
        write_opencode_plugin(&path).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), OPENCODE_PLUGIN);
        cleanup(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn hook_script_points_at_the_loopback_endpoint_and_is_idempotent() {
        let dir = temp_dir("hook-script");
        let path = write_hook_script(&dir).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();

        assert!(content.contains("TAPD_AGENT_HOOK_URL"));
        assert!(content.contains("X-Tapd-Hook-Token"));
        assert!(content.contains("curl"));
        write_hook_script(&dir).unwrap();
        assert_eq!(content, std::fs::read_to_string(&path).unwrap());
        cleanup(&dir);
    }

    #[test]
    fn codex_trust_hash_matches_the_canonical_json() {
        assert_eq!(
            codex_trust_hash("stop", "/bin/sh '/tmp/tapd-agent-hook.sh' Stop", 10),
            "sha256:cc52c912dd3539454e0ec50529025b15919fadbc9385e330986ff8c49804c343"
        );
        assert_eq!(
            codex_trust_hash(
                "interrupt",
                "/bin/sh '/tmp/tapd-agent-hook.sh' Interrupt",
                3
            ),
            "sha256:6dbf036a8d491b17989d6c6f5f741b83779423de7b0a4c2267fab4d6b2ffb64a"
        );
    }

    #[test]
    fn codex_hooks_and_trust_are_idempotent_and_keep_user_hooks() {
        let dir = temp_dir("hook-codex");
        let hooks_path = dir.join("hooks.json");
        let config_path = dir.join("config.toml");
        let script = script(&dir);
        std::fs::write(
            &hooks_path,
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-hook"}]}]}}"#,
        )
        .unwrap();
        std::fs::write(
            &config_path,
            "model = \"gpt-5\"\n\n[hooks.state.\"user-key\"]\nenabled = true\ntrusted_hash = \"sha256:user\"\n",
        )
        .unwrap();

        install_codex_at(&hooks_path, &config_path, &script).unwrap();
        let hooks_after = std::fs::read_to_string(&hooks_path).unwrap();
        let config_after = std::fs::read_to_string(&config_path).unwrap();
        install_codex_at(&hooks_path, &config_path, &script).unwrap();
        assert_eq!(hooks_after, std::fs::read_to_string(&hooks_path).unwrap());
        assert_eq!(config_after, std::fs::read_to_string(&config_path).unwrap());

        let hooks: Value = serde_json::from_str(&hooks_after).unwrap();
        let stop = hooks.pointer("/hooks/Stop").unwrap().as_array().unwrap();
        assert_eq!(stop.len(), 2, "user hook + ours");
        assert!(stop[0].to_string().contains("user-hook"));
        assert!(stop[1].to_string().contains(HOOK_SCRIPT_NAME));

        let source = canonical_hook_source(&hooks_path);
        let doc: DocumentMut = config_after.parse().unwrap();
        let state = doc["hooks"]["state"].as_table().expect("state table");
        assert!(state.contains_key("user-key"));
        assert!(state.contains_key(&format!("{source}:stop:1:0")));
        assert!(state.contains_key(&format!("{source}:interrupt:0:0")));
        assert!(config_after.contains("trusted_hash"));

        cleanup(&dir);
    }
}
