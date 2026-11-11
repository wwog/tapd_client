//! One-click MCP injection for external AI clients.
//!
//! Each client gets a user-scope entry pointing at the bundled `tapd-mcp`
//! sidecar:
//!
//! - opencode: `<config>/opencode.json[c]` → `mcp.tapd`
//! - Claude Code: `claude mcp add --scope user` (writes `~/.claude.json`)
//! - Cursor: `~/.cursor/mcp.json` → `mcpServers.tapd`
//! - Codex: `~/.codex/config.toml` → `[mcp_servers.tapd]`
//!
//! Every import is idempotent and backs the file up before changing it.
//! Frontend access goes through the `mcp_import_client` feature command.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use toml_edit::{value as toml_value, DocumentMut, Item, Table};

use crate::state::SharedState;

const CONFIG_SCHEMA: &str = "https://opencode.ai/config.json";
const CONFIG_JSON: &str = "opencode.json";
const CONFIG_JSONC: &str = "opencode.jsonc";
const DEBUG_PATHS_TIMEOUT: Duration = Duration::from_secs(3);

pub const CLIENT_OPENCODE: &str = "opencode";
pub const CLIENT_ZCODE: &str = "zcode";
pub const CLIENT_CLAUDE: &str = "claude";
pub const CLIENT_CURSOR: &str = "cursor";
pub const CLIENT_CODEX: &str = "codex";
pub const CLIENTS: [&str; 5] = [
    CLIENT_OPENCODE,
    CLIENT_ZCODE,
    CLIENT_CLAUDE,
    CLIENT_CURSOR,
    CLIENT_CODEX,
];

/// How a client stores the MCP server entry.
#[derive(Clone, Copy)]
enum Format {
    /// A JSON config with the entry at `segments`.
    Json {
        segments: &'static [&'static str],
        entry: fn(&str) -> Value,
        default_root: fn() -> Value,
        /// Rewrites an existing config in place (old layout -> current one).
        /// Returns true when the config changed.
        normalize: Option<fn(&mut Value) -> bool>,
        /// Where older versions wrote the same entry; still counts as imported.
        legacy_segments: Option<&'static [&'static str]>,
    },
    /// A TOML config with `[mcp_servers.tapd]`.
    Toml,
    /// Registered through the Claude Code CLI (`claude mcp add`).
    ClaudeCli,
}

struct ClientSpec {
    id: &'static str,
    label: &'static str,
    path: fn() -> Option<PathBuf>,
    missing_path_error: &'static str,
    format: Format,
}

const CLIENT_SPECS: &[ClientSpec] = &[
    ClientSpec {
        id: CLIENT_OPENCODE,
        label: "opencode",
        path: opencode_config_path,
        missing_path_error: "无法定位 opencode 配置目录（未设置 XDG_CONFIG_HOME 或 HOME）",
        format: Format::Json {
            segments: &["mcp", "tapd"],
            entry: tapd_entry,
            default_root: opencode_default_root,
            normalize: Some(migrate_opencode_servers),
            legacy_segments: Some(&["mcp", "servers", "tapd"]),
        },
    },
    ClientSpec {
        id: CLIENT_ZCODE,
        label: "ZCode",
        path: zcode_config_path,
        missing_path_error: "无法定位 ZCode 配置目录（未设置 HOME 或 USERPROFILE）",
        format: Format::Json {
            segments: &["mcp", "servers", "tapd"],
            entry: zcode_entry,
            default_root: empty_config,
            normalize: None,
            legacy_segments: None,
        },
    },
    ClientSpec {
        id: CLIENT_CLAUDE,
        label: "Claude Code",
        path: claude_config_path,
        missing_path_error:
            "无法定位 Claude Code 配置（未设置 CLAUDE_CONFIG_DIR、HOME 或 USERPROFILE）",
        format: Format::ClaudeCli,
    },
    ClientSpec {
        id: CLIENT_CURSOR,
        label: "Cursor",
        path: cursor_config_path,
        missing_path_error: "无法定位 Cursor 配置目录（未设置 HOME 或 USERPROFILE）",
        format: Format::Json {
            segments: &["mcpServers", "tapd"],
            entry: cursor_entry,
            default_root: empty_config,
            normalize: None,
            legacy_segments: None,
        },
    },
    ClientSpec {
        id: CLIENT_CODEX,
        label: "Codex",
        path: codex_config_path,
        missing_path_error: "无法定位 Codex 配置目录（未设置 CODEX_HOME、HOME 或 USERPROFILE）",
        format: Format::Toml,
    },
];

fn client_spec(client: &str) -> Option<&'static ClientSpec> {
    CLIENT_SPECS.iter().find(|spec| spec.id == client)
}

/// Location of the opencode global config, if it can be discovered.
///
/// Asks the CLI first (`opencode debug paths`), because XDG overrides and
/// custom installs are only visible to opencode itself. Falls back to the
/// conventional XDG/home locations.
pub fn opencode_config_path() -> Option<PathBuf> {
    config_path_from_cli().or_else(fallback_config_path)
}

/// Ensures the tapd MCP server is present in the opencode global config.
///
/// Returns `{ path, backupPath, changed, imported }`, matching the frontend
/// `McpImportResult` contract.
pub fn ensure_opencode_mcp(command_path: &str) -> Result<Value, String> {
    if command_path.trim().is_empty() {
        return Err("sidecar 路径为空，无法写入 opencode 配置".to_string());
    }

    let spec = client_spec(CLIENT_OPENCODE).expect("opencode spec is present");
    ensure_client_at(spec, command_path)
}

/// Config file used by `client`, when it can be located.
pub fn client_config_path(client: &str) -> Option<PathBuf> {
    client_spec(client).and_then(|spec| (spec.path)())
}

/// Whether the config file at `path` already registers this sidecar.
pub fn imported_in_path(client: &str, path: &Path, command_path: &str) -> bool {
    client_spec(client).is_some_and(|spec| imported_in_file(spec, path, command_path))
}

/// Ensures the tapd MCP server is present in the client's user-scope config.
///
/// Returns `{ path, backupPath, changed, imported }`, matching the frontend
/// `McpImportResult` contract.
pub fn ensure_client_mcp(client: &str, command_path: &str) -> Result<Value, String> {
    if command_path.trim().is_empty() {
        return Err("sidecar 路径为空，无法写入客户端配置".to_string());
    }

    let spec = client_spec(client).ok_or_else(|| format!("未知的 MCP 客户端：{client}"))?;
    ensure_client_at(spec, command_path)
}

fn ensure_client_at(spec: &ClientSpec, command_path: &str) -> Result<Value, String> {
    let path = (spec.path)().ok_or_else(|| spec.missing_path_error.to_string())?;
    let outcome = ensure_in_file(spec, &path, command_path)?;
    Ok(import_result(&path, outcome))
}

fn ensure_in_file(
    spec: &ClientSpec,
    path: &Path,
    command_path: &str,
) -> Result<MergeOutcome, String> {
    match spec.format {
        Format::Json {
            segments,
            entry,
            default_root,
            normalize,
            ..
        } => ensure_json_entry(
            path,
            segments,
            entry(command_path),
            default_root(),
            spec.label,
            normalize,
        ),
        Format::Toml => ensure_codex_in_file(path, command_path),
        Format::ClaudeCli => ensure_claude_mcp(path, command_path),
    }
}

fn imported_in_file(spec: &ClientSpec, path: &Path, command_path: &str) -> bool {
    match spec.format {
        Format::Json {
            segments,
            legacy_segments,
            ..
        } => {
            json_command_matches(path, segments, command_path)
                || legacy_segments
                    .is_some_and(|legacy| json_command_matches(path, legacy, command_path))
        }
        Format::Toml => codex_imported_in(path, command_path),
        Format::ClaudeCli => claude_imported_in(path, command_path),
    }
}

fn import_result(path: &Path, outcome: MergeOutcome) -> Value {
    json!({
        "path": path.to_string_lossy(),
        "backupPath": outcome.backup_path.map(|path| path.to_string_lossy().to_string()),
        "changed": outcome.changed,
        "imported": true,
    })
}

pub async fn command(_state: &SharedState, name: &str, payload: Value) -> Result<Value, String> {
    match name {
        "mcp_import_client" => {
            let client = payload
                .get("client")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if !CLIENTS.contains(&client.as_str()) {
                return Err(format!("未知的 MCP 客户端：{client}"));
            }
            let command_path = crate::commands::sidecar_command_path();
            tokio::task::spawn_blocking(move || ensure_client_mcp(&client, &command_path))
                .await
                .map_err(|error| format!("导入任务中断：{error}"))?
        }
        other => Err(format!("unknown mcp command: {other}")),
    }
}

/// Runs `opencode debug paths` and parses the config entry out of its output.
fn config_path_from_cli() -> Option<PathBuf> {
    let stdout = run_with_timeout("opencode", &["debug", "paths"], DEBUG_PATHS_TIMEOUT)?;
    parse_debug_paths(&stdout)
}

/// Runs a command, killing it after `timeout` and returning its stdout.
fn run_with_timeout(binary: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = command_with_user_path(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Parses the label/path table printed by `opencode debug paths`.
///
/// Example (opencode v2):
/// ```text
/// home       /Users/me
/// config     /Users/me/.config/opencode
/// data       /Users/me/.local/share/opencode
/// ```
/// Some builds print a full config file path instead of the directory; both
/// `opencode.json` and `opencode.jsonc` are accepted.
fn parse_debug_paths(output: &str) -> Option<PathBuf> {
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((label, rest)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        if !is_config_label(label) {
            continue;
        }
        let value = rest
            .split_whitespace()
            .find(|token| token.starts_with('/') || token.starts_with('~'));
        if let Some(value) = value {
            return Some(resolve_config_path(&expand_home(value)));
        }
    }

    // Fallback: a bare path to a config file (no label column).
    output
        .split_whitespace()
        .find(|token| is_config_file_name(Path::new(token)) && token.contains('/'))
        .map(|token| expand_home(token))
}

fn is_config_label(label: &str) -> bool {
    let normalized: String = label
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    normalized.starts_with("config")
}

fn expand_home(value: &str) -> PathBuf {
    tapd_core::paths::expand_home(value)
}

/// The CLI may print either the config directory or the config file itself.
fn resolve_config_path(path: &Path) -> PathBuf {
    if is_config_file_name(path) || has_config_extension(path) {
        path.to_path_buf()
    } else {
        config_file_for_dir(path)
    }
}

fn is_config_file_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case(CONFIG_JSON) || name.eq_ignore_ascii_case(CONFIG_JSONC)
        })
}

fn has_config_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("json") || extension.eq_ignore_ascii_case("jsonc")
        })
}

/// opencode supports both files; prefer `opencode.jsonc` when it exists.
fn config_file_for_dir(dir: &Path) -> PathBuf {
    let jsonc = dir.join(CONFIG_JSONC);
    if jsonc.is_file() {
        jsonc
    } else {
        dir.join(CONFIG_JSON)
    }
}

fn fallback_config_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            tapd_core::paths::home_dir()
                .ok()
                .map(|home| home.join(".config"))
        })?;
    Some(config_file_for_dir(&base.join("opencode")))
}

/// Claude Code's user-scope config. `CLAUDE_CONFIG_DIR` replaces the directory
/// that holds `.claude.json` when set.
fn claude_config_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty()) {
        let dir = PathBuf::from(dir);
        return Some(
            if dir.extension().is_some_and(|extension| extension == "json") {
                dir
            } else {
                dir.join(".claude.json")
            },
        );
    }
    tapd_core::paths::home_dir()
        .ok()
        .map(|home| home.join(".claude.json"))
}

/// ZCode's user-scope config; workspace scope lives in `<repo>/.zcode/config.json`.
fn zcode_config_path() -> Option<PathBuf> {
    tapd_core::paths::home_dir()
        .ok()
        .map(|home| home.join(".zcode").join("cli").join("config.json"))
}

fn cursor_config_path() -> Option<PathBuf> {
    tapd_core::paths::home_dir()
        .ok()
        .map(|home| home.join(".cursor").join("mcp.json"))
}

fn codex_config_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(dir).join("config.toml"));
    }
    tapd_core::paths::home_dir()
        .ok()
        .map(|home| home.join(".codex").join("config.toml"))
}

/// GUI apps inherit a minimal `PATH` on macOS, so `claude` / `opencode` are
/// only found when the child gets the user's shell `PATH`.
fn command_with_user_path(binary: &str) -> Command {
    let mut command = Command::new(binary);
    command.env("PATH", crate::shell_path::user_path());
    command
}

#[derive(Debug)]
struct MergeOutcome {
    changed: bool,
    backup_path: Option<PathBuf>,
}

fn tapd_entry(command_path: &str) -> Value {
    json!({ "type": "local", "command": [command_path] })
}

fn zcode_entry(command_path: &str) -> Value {
    json!({ "type": "stdio", "command": command_path })
}

/// Hoists `mcp.servers.<name>` entries into `mcp.<name>` and drops the
/// wrapper. Direct entries win so a user's existing config is never replaced.
///
/// opencode v2.2.x validates `mcp` as a map of server configs. The older
/// `mcp.servers.<name>` wrapper is read as a server named `servers` and makes
/// startup fail (`Missing key mcp.servers.enabled`), so an existing wrapper is
/// migrated to direct entries on the next import.
fn migrate_opencode_servers(config: &mut Value) -> bool {
    let Some(mcp) = config.get_mut("mcp").and_then(Value::as_object_mut) else {
        return false;
    };
    match mcp.remove("servers") {
        Some(Value::Object(entries)) => {
            for (name, server) in entries {
                mcp.entry(name).or_insert(server);
            }
            true
        }
        Some(other) => {
            // Not the wrapper shape; put it back untouched.
            mcp.insert("servers".to_string(), other);
            false
        }
        None => false,
    }
}

fn cursor_entry(command_path: &str) -> Value {
    json!({ "command": command_path })
}

fn opencode_default_root() -> Value {
    json!({ "$schema": CONFIG_SCHEMA })
}

fn empty_config() -> Value {
    json!({})
}

/// Merges `[mcp_servers.tapd]` into Codex's `config.toml`, preserving the
/// rest of the document (comments and formatting included).
fn ensure_codex_in_file(path: &Path, command_path: &str) -> Result<MergeOutcome, String> {
    let existing = read_existing(path, "Codex")?;
    let mut document = match &existing {
        Some(raw) => raw.parse::<DocumentMut>().map_err(|error| {
            format!(
                "无法解析 {}：{error}。为避免破坏已有内容，未做任何修改。",
                path.display()
            )
        })?,
        None => DocumentMut::new(),
    };

    if codex_command(&document) == Some(command_path) {
        return Ok(MergeOutcome {
            changed: false,
            backup_path: None,
        });
    }

    let servers = document
        .as_table_mut()
        .entry("mcp_servers")
        .or_insert(Item::Table(Table::new()));
    let servers = servers
        .as_table_mut()
        .ok_or_else(|| "Codex 配置中的 mcp_servers 不是表，未做任何修改".to_string())?;
    let tapd = servers.entry("tapd").or_insert(Item::Table(Table::new()));
    let tapd = tapd
        .as_table_mut()
        .ok_or_else(|| "Codex 配置中的 mcp_servers.tapd 不是表，未做任何修改".to_string())?;
    tapd.insert("command", toml_value(command_path));

    let backup_path = backup_existing(path, existing.is_some())?;
    write_atomic(path, document.to_string().as_bytes())?;

    Ok(MergeOutcome {
        changed: true,
        backup_path,
    })
}

fn codex_command(document: &DocumentMut) -> Option<&str> {
    document
        .get("mcp_servers")?
        .as_table()?
        .get("tapd")?
        .as_table()?
        .get("command")?
        .as_str()
}

/// Registers the sidecar through the Claude Code CLI (`--scope user`).
fn ensure_claude_mcp(path: &Path, command_path: &str) -> Result<MergeOutcome, String> {
    if claude_imported_in(path, command_path) {
        return Ok(MergeOutcome {
            changed: false,
            backup_path: None,
        });
    }

    let backup_path = backup_existing(path, path.is_file())?;

    // A stale entry with a different command would make `add` fail; drop it
    // first. Errors are ignored (the entry may not exist).
    if claude_has_tapd(path) {
        let _ = command_with_user_path("claude")
            .args(["mcp", "remove", "--scope", "user", "tapd"])
            .stdin(Stdio::null())
            .output();
    }

    let output = command_with_user_path("claude")
        .args([
            "mcp",
            "add",
            "--scope",
            "user",
            "--transport",
            "stdio",
            "tapd",
            "--",
            command_path,
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("未找到 claude 命令（需要安装 Claude Code CLI）：{error}"))?;
    if !output.status.success() {
        // Restore the exact file we saw before `remove`/`add` ran.
        if let Some(backup) = &backup_path {
            let _ = std::fs::copy(backup, path);
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        return Err(format!(
            "claude mcp add 失败：{}",
            if stderr.is_empty() {
                "未知错误"
            } else {
                stderr
            }
        ));
    }

    Ok(MergeOutcome {
        changed: true,
        backup_path,
    })
}

fn claude_has_tapd(path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(config) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    config.pointer("/mcpServers/tapd").is_some()
}

fn claude_imported_in(path: &Path, command_path: &str) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(config) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    config
        .pointer("/mcpServers/tapd")
        .is_some_and(|entry| claude_entry_matches(entry, command_path))
}

fn claude_entry_matches(entry: &Value, command_path: &str) -> bool {
    entry
        .get("command")
        .is_some_and(|value| command_matches(value, command_path))
        || entry
            .get("args")
            .is_some_and(|value| command_matches(value, command_path))
}

fn codex_imported_in(path: &Path, command_path: &str) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(document) = raw.parse::<DocumentMut>() else {
        return false;
    };
    codex_command(&document) == Some(command_path)
}

/// Merges `desired` at `segments` inside a JSON config file.
///
/// - missing file: starts from `default_root` (no backup to make)
/// - existing but unparseable file: errors without touching it
/// - unchanged entry: returns early with `changed: false` and no backup
/// - any change: copies the old file to `<file>.bak-<unix-ts>`, then writes
///   atomically via a sibling temp file + rename
fn ensure_json_entry(
    path: &Path,
    segments: &[&str],
    desired: Value,
    default_root: Value,
    label: &str,
    normalize: Option<fn(&mut Value) -> bool>,
) -> Result<MergeOutcome, String> {
    let existing = read_existing(path, label)?;
    let (mut config, existed) = match existing {
        Some(raw) => {
            let value: Value = serde_json::from_str(&raw).map_err(|error| {
                format!(
                    "无法解析 {}（可能是带注释的 JSONC）：{error}。为避免破坏已有内容，未做任何修改。",
                    path.display()
                )
            })?;
            if !value.is_object() {
                return Err(format!(
                    "{} 的根节点不是 JSON 对象，未做任何修改",
                    path.display()
                ));
            }
            (value, true)
        }
        None => (default_root, false),
    };

    // Migrate an older layout first: the write below is needed even when the
    // entry itself already matches, because the wrapper has to go away.
    let changed = normalize.is_some_and(|normalize| normalize(&mut config));

    let pointer = format!("/{}", segments.join("/"));
    if config.pointer(&pointer) == Some(&desired) {
        return if changed {
            write_json_config(path, &config, existed).map(|backup_path| MergeOutcome {
                changed: true,
                backup_path,
            })
        } else {
            Ok(MergeOutcome {
                changed: false,
                backup_path: None,
            })
        };
    }

    let mut cursor = config
        .as_object_mut()
        .ok_or_else(|| format!("{} 的根节点不是 JSON 对象", path.display()))?;
    let (last, parents) = segments
        .split_last()
        .ok_or_else(|| "配置路径为空".to_string())?;
    for (index, segment) in parents.iter().enumerate() {
        let next = cursor
            .entry((*segment).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        cursor = next.as_object_mut().ok_or_else(|| {
            format!(
                "{label} 配置中的 {} 字段不是对象，未做任何修改",
                segments[..=index].join(".")
            )
        })?;
    }
    cursor.insert((*last).to_string(), desired);

    let backup_path = write_json_config(path, &config, existed)?;

    Ok(MergeOutcome {
        changed: true,
        backup_path,
    })
}

/// Serializes `config`, backs up the previous file and writes it atomically.
fn write_json_config(
    path: &Path,
    config: &Value,
    existed: bool,
) -> Result<Option<PathBuf>, String> {
    let mut rendered = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    rendered.push('\n');
    let backup_path = backup_existing(path, existed)?;
    write_atomic(path, rendered.as_bytes())?;
    Ok(backup_path)
}

fn read_existing(path: &Path, label: &str) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取 {label} 配置失败：{error}")),
    }
}

fn backup_existing(path: &Path, exists: bool) -> Result<Option<PathBuf>, String> {
    if !exists {
        return Ok(None);
    }
    let backup = backup_path_for(path);
    std::fs::copy(path, &backup).map_err(|error| format!("备份配置失败：{error}"))?;
    Ok(Some(backup))
}

fn json_command_matches(path: &Path, segments: &[&str], command_path: &str) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(config) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    let pointer = format!("/{}/command", segments.join("/"));
    config
        .pointer(&pointer)
        .is_some_and(|value| command_matches(value, command_path))
}

fn command_matches(value: &Value, command_path: &str) -> bool {
    match value {
        Value::Array(items) => items.iter().any(|item| item.as_str() == Some(command_path)),
        Value::String(item) => item == command_path,
        _ => false,
    }
}

fn backup_path_for(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(CONFIG_JSON);
    path.with_file_name(format!("{name}.bak-{}", unix_timestamp()))
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;

    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(CONFIG_JSON);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp = parent.join(format!(".{name}.tmp-{}-{nanos}", std::process::id()));

    if let Err(error) = std::fs::write(&temp, contents) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("写入配置失败：{error}"));
    }

    // Replacing a file through rename would otherwise reset its mode.
    if let Ok(metadata) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&temp, metadata.permissions());
    }

    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("保存配置失败：{error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "tapd-mcp-import-{name}-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn backup_files(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .expect("read temp dir")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.to_string_lossy().contains(".bak-"))
            .collect()
    }

    fn ensure_for(client: &str, path: &Path, command_path: &str) -> Result<MergeOutcome, String> {
        ensure_in_file(
            client_spec(client).expect("known client"),
            path,
            command_path,
        )
    }

    #[test]
    fn client_specs_match_public_client_list() {
        let ids: Vec<&str> = CLIENT_SPECS.iter().map(|spec| spec.id).collect();
        assert_eq!(ids.as_slice(), &CLIENTS[..]);
    }

    #[test]
    fn json_clients_write_exact_entries_and_are_idempotent() {
        let command = "/Applications/TAPD/tapd-mcp";
        let cases = [
            (
                CLIENT_OPENCODE,
                json!({
                    "$schema": CONFIG_SCHEMA,
                    "mcp": { "tapd": { "type": "local", "command": [command] } }
                }),
            ),
            (
                CLIENT_ZCODE,
                json!({
                    "mcp": { "servers": { "tapd": { "type": "stdio", "command": command } } }
                }),
            ),
            (
                CLIENT_CURSOR,
                json!({ "mcpServers": { "tapd": { "command": command } } }),
            ),
        ];

        for (client, expected) in cases {
            let dir = temp_dir(client);
            let path = dir.join("config.json");

            let outcome = ensure_for(client, &path, command).expect("first import");
            assert!(outcome.changed, "{client}: first import must write");
            assert!(
                outcome.backup_path.is_none(),
                "{client}: new file has no backup"
            );

            let written: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(written, expected, "{client}: exact generated config");

            assert!(
                imported_in_path(client, &path, command),
                "{client}: entry detected"
            );
            assert!(
                !imported_in_path(client, &path, "/opt/other"),
                "{client}: other command rejected"
            );

            let before = std::fs::read_to_string(&path).unwrap();
            let second = ensure_for(client, &path, command).expect("second import");
            assert!(!second.changed, "{client}: second import is a no-op");
            assert!(second.backup_path.is_none(), "{client}: no backup on no-op");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
            assert!(
                backup_files(&dir).is_empty(),
                "{client}: no backup files on no-op"
            );

            cleanup(&dir);
        }
    }

    #[test]
    fn merge_preserves_other_settings() {
        let dir = temp_dir("merge");
        let path = dir.join(CONFIG_JSON);
        let original = json!({
            "$schema": CONFIG_SCHEMA,
            "model": "anthropic/claude",
            "mcp": { "servers": { "other": { "type": "local", "command": ["other"] } } }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&original).unwrap()).unwrap();

        let outcome = ensure_for(CLIENT_OPENCODE, &path, "/Applications/TAPD/tapd-mcp").unwrap();
        assert!(outcome.changed);
        let backup = outcome.backup_path.expect("backup created");
        assert!(backup.is_file());
        assert!(backup.to_string_lossy().contains(".bak-"));

        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written.get("model"), Some(&json!("anthropic/claude")));
        // The legacy wrapper is migrated to direct entries.
        assert_eq!(
            written.pointer("/mcp/other/command"),
            Some(&json!(["other"]))
        );
        assert!(written.pointer("/mcp/servers").is_none());
        assert_eq!(
            written.pointer("/mcp/tapd"),
            Some(&json!({ "type": "local", "command": ["/Applications/TAPD/tapd-mcp"] }))
        );
        assert!(imported_in_path(
            CLIENT_OPENCODE,
            &path,
            "/Applications/TAPD/tapd-mcp"
        ));
        assert!(!imported_in_path(
            CLIENT_OPENCODE,
            &path,
            "/Applications/TAPD/other"
        ));

        cleanup(&dir);
    }

    #[test]
    fn migrates_legacy_servers_wrapper_without_losing_entries() {
        let dir = temp_dir("migrate");
        let path = dir.join(CONFIG_JSON);
        let original = json!({
            "$schema": CONFIG_SCHEMA,
            "mcp": {
                "servers": {
                    "codegraph": {
                        "type": "local",
                        "command": ["codegraph", "serve", "--mcp"],
                        "disabled": false
                    },
                    "tapd": { "type": "local", "command": ["/old/tapd-mcp"] }
                }
            }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&original).unwrap()).unwrap();

        let spec = client_spec(CLIENT_OPENCODE).expect("opencode spec");
        let outcome = ensure_in_file(spec, &path, "/new/tapd-mcp").unwrap();
        assert!(outcome.changed);

        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(written.pointer("/mcp/servers").is_none());
        assert_eq!(
            written.pointer("/mcp/codegraph/command"),
            Some(&json!(["codegraph", "serve", "--mcp"]))
        );
        assert_eq!(
            written.pointer("/mcp/tapd/command"),
            Some(&json!(["/new/tapd-mcp"]))
        );
        assert!(imported_in_file(spec, &path, "/new/tapd-mcp"));

        cleanup(&dir);
    }

    #[test]
    fn missing_file_creates_parent_dirs_and_defaults() {
        let dir = temp_dir("missing");
        let path = dir.join("nested").join("opencode").join(CONFIG_JSON);

        let outcome = ensure_for(CLIENT_OPENCODE, &path, "/opt/tapd-mcp").unwrap();
        assert!(outcome.changed);
        assert!(outcome.backup_path.is_none());

        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written.get("$schema"), Some(&json!(CONFIG_SCHEMA)));
        assert_eq!(
            written.pointer("/mcp/tapd"),
            Some(&json!({ "type": "local", "command": ["/opt/tapd-mcp"] }))
        );

        cleanup(&dir);
    }

    #[test]
    fn invalid_json_is_rejected_without_changes() {
        let dir = temp_dir("invalid");
        let path = dir.join(CONFIG_JSONC);
        let original =
            "{\n  // JSONC comment\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n";
        std::fs::write(&path, original).unwrap();

        let error = ensure_for(CLIENT_OPENCODE, &path, "/opt/tapd-mcp").unwrap_err();
        assert!(error.contains("JSON"), "unexpected error: {error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(backup_files(&dir).is_empty());

        cleanup(&dir);
    }

    #[test]
    fn non_object_mcp_is_rejected_without_changes() {
        let dir = temp_dir("shape");
        let path = dir.join(CONFIG_JSON);
        let original = r#"{"mcp": "not-an-object"}"#;
        std::fs::write(&path, original).unwrap();

        let error = ensure_for(CLIENT_OPENCODE, &path, "/opt/tapd-mcp").unwrap_err();
        assert!(error.contains("mcp"), "unexpected error: {error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(backup_files(&dir).is_empty());

        cleanup(&dir);
    }

    #[test]
    fn detects_existing_entry_and_ignores_missing_or_bad_files() {
        let dir = temp_dir("detect");
        let path = dir.join(CONFIG_JSON);
        std::fs::write(
            &path,
            r#"{"mcp":{"servers":{"tapd":{"type":"local","command":["/opt/tapd-mcp"]}}}}"#,
        )
        .unwrap();

        assert!(imported_in_path(CLIENT_OPENCODE, &path, "/opt/tapd-mcp"));
        assert!(!imported_in_path(CLIENT_OPENCODE, &path, "/opt/other"));
        assert!(!imported_in_path(
            CLIENT_OPENCODE,
            &dir.join("missing.json"),
            "/opt/tapd-mcp"
        ));

        let broken = dir.join("broken.json");
        std::fs::write(&broken, "{ // comment\n}").unwrap();
        assert!(!imported_in_path(CLIENT_OPENCODE, &broken, "/opt/tapd-mcp"));

        cleanup(&dir);
    }

    #[test]
    fn rejects_empty_command_and_unknown_client() {
        assert_eq!(
            ensure_client_mcp(CLIENT_OPENCODE, " ").unwrap_err(),
            "sidecar 路径为空，无法写入客户端配置"
        );
        assert_eq!(
            ensure_opencode_mcp(" ").unwrap_err(),
            "sidecar 路径为空，无法写入 opencode 配置"
        );
        assert_eq!(
            ensure_client_mcp("unknown", "/opt/tapd-mcp").unwrap_err(),
            "未知的 MCP 客户端：unknown"
        );
    }

    #[test]
    fn parses_labeled_debug_paths() {
        let output = "\
home       /Users/me
data       /Users/me/.local/share/opencode
cache      /Users/me/.cache/opencode
config     /Users/me/.config/opencode
state      /Users/me/.local/state/opencode
db         /Users/me/.local/share/opencode/opencode.db
";
        assert_eq!(
            parse_debug_paths(output),
            Some(PathBuf::from("/Users/me/.config/opencode/opencode.json"))
        );
    }

    #[test]
    fn parses_config_file_path_in_debug_output() {
        let output = "config file /Users/me/.config/opencode/opencode.jsonc\n";
        assert_eq!(
            parse_debug_paths(output),
            Some(PathBuf::from("/Users/me/.config/opencode/opencode.jsonc"))
        );

        let unlabeled = "/Users/me/.config/opencode/opencode.json\n";
        assert_eq!(
            parse_debug_paths(unlabeled),
            Some(PathBuf::from("/Users/me/.config/opencode/opencode.json"))
        );
    }

    #[test]
    fn codex_merge_preserves_other_entries_and_is_idempotent() {
        let dir = temp_dir("codex");
        let path = dir.join("config.toml");
        std::fs::write(
            &path,
            "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other\"\n",
        )
        .unwrap();

        assert!(matches!(
            client_spec(CLIENT_CODEX).expect("codex spec").format,
            Format::Toml
        ));

        let first = ensure_for(CLIENT_CODEX, &path, "/opt/tapd-mcp").unwrap();
        assert!(first.changed);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            concat!(
                "model = \"gpt-5\"\n",
                "\n",
                "[mcp_servers.other]\n",
                "command = \"other\"\n",
                "\n",
                "[mcp_servers.tapd]\n",
                "command = \"/opt/tapd-mcp\"\n",
            )
        );
        assert!(imported_in_path(CLIENT_CODEX, &path, "/opt/tapd-mcp"));
        assert!(!imported_in_path(CLIENT_CODEX, &path, "/opt/other"));

        let before = std::fs::read_to_string(&path).unwrap();
        let second = ensure_for(CLIENT_CODEX, &path, "/opt/tapd-mcp").unwrap();
        assert!(!second.changed);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        cleanup(&dir);
    }

    #[test]
    fn codex_rejects_invalid_toml_without_changes() {
        let dir = temp_dir("codex-invalid");
        let path = dir.join("config.toml");
        let original = "model = [unterminated\n";
        std::fs::write(&path, original).unwrap();

        let error = ensure_for(CLIENT_CODEX, &path, "/opt/tapd-mcp").unwrap_err();
        assert!(error.contains("无法解析"), "unexpected error: {error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(backup_files(&dir).is_empty());

        cleanup(&dir);
    }

    #[test]
    fn detects_claude_user_scope_entries() {
        let dir = temp_dir("claude");
        let path = dir.join(".claude.json");
        std::fs::write(
            &path,
            r#"{"mcpServers":{"tapd":{"type":"stdio","command":"/opt/tapd-mcp","args":[]}}}"#,
        )
        .unwrap();

        assert!(matches!(
            client_spec(CLIENT_CLAUDE).expect("claude spec").format,
            Format::ClaudeCli
        ));
        assert!(imported_in_path(CLIENT_CLAUDE, &path, "/opt/tapd-mcp"));
        assert!(!imported_in_path(CLIENT_CLAUDE, &path, "/opt/other"));
        assert!(claude_has_tapd(&path));

        // Some Claude versions store the executable under `args`.
        std::fs::write(
            &path,
            r#"{"mcpServers":{"tapd":{"type":"stdio","command":"npx","args":["/opt/tapd-mcp"]}}}"#,
        )
        .unwrap();
        assert!(imported_in_path(CLIENT_CLAUDE, &path, "/opt/tapd-mcp"));

        assert!(!imported_in_path(
            CLIENT_CLAUDE,
            &dir.join("missing.json"),
            "/opt/tapd-mcp"
        ));

        cleanup(&dir);
    }

    #[test]
    fn prefers_jsonc_in_config_directory() {
        let dir = temp_dir("jsonc-preference");
        let jsonc = dir.join(CONFIG_JSONC);
        std::fs::write(&jsonc, "{}").unwrap();

        assert_eq!(config_file_for_dir(&dir), jsonc);

        cleanup(&dir);
    }
}
