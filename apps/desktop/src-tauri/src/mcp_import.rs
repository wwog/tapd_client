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
//!
//! Layout: this module holds the client table and the public entry points,
//! [`paths`] locates config files, [`merge`] does the JSON merge/backup/write,
//! and [`formats`] owns the per-client payloads and non-JSON formats.

mod formats;
mod merge;
mod paths;
#[cfg(test)]
mod test_support;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::state::SharedState;

use merge::{ensure_json_entry, json_command_matches, MergeOutcome};
use paths::opencode_config_path;

const CONFIG_SCHEMA: &str = "https://opencode.ai/config.json";
const CONFIG_JSON: &str = "opencode.json";
const CONFIG_JSONC: &str = "opencode.jsonc";

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
            entry: formats::tapd_entry,
            default_root: formats::opencode_default_root,
            normalize: Some(formats::migrate_opencode_servers),
            legacy_segments: Some(&["mcp", "servers", "tapd"]),
        },
    },
    ClientSpec {
        id: CLIENT_ZCODE,
        label: "ZCode",
        path: paths::zcode_config_path,
        missing_path_error: "无法定位 ZCode 配置目录（未设置 HOME 或 USERPROFILE）",
        format: Format::Json {
            segments: &["mcp", "servers", "tapd"],
            entry: formats::zcode_entry,
            default_root: formats::empty_config,
            normalize: None,
            legacy_segments: None,
        },
    },
    ClientSpec {
        id: CLIENT_CLAUDE,
        label: "Claude Code",
        path: paths::claude_config_path,
        missing_path_error:
            "无法定位 Claude Code 配置（未设置 CLAUDE_CONFIG_DIR、HOME 或 USERPROFILE）",
        format: Format::ClaudeCli,
    },
    ClientSpec {
        id: CLIENT_CURSOR,
        label: "Cursor",
        path: paths::cursor_config_path,
        missing_path_error: "无法定位 Cursor 配置目录（未设置 HOME 或 USERPROFILE）",
        format: Format::Json {
            segments: &["mcpServers", "tapd"],
            entry: formats::cursor_entry,
            default_root: formats::empty_config,
            normalize: None,
            legacy_segments: None,
        },
    },
    ClientSpec {
        id: CLIENT_CODEX,
        label: "Codex",
        path: paths::codex_config_path,
        missing_path_error: "无法定位 Codex 配置目录（未设置 CODEX_HOME、HOME 或 USERPROFILE）",
        format: Format::Toml,
    },
];

fn client_spec(client: &str) -> Option<&'static ClientSpec> {
    CLIENT_SPECS.iter().find(|spec| spec.id == client)
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
        Format::Toml => formats::ensure_codex_in_file(path, command_path),
        Format::ClaudeCli => formats::ensure_claude_mcp(path, command_path),
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
        Format::Toml => formats::codex_imported_in(path, command_path),
        Format::ClaudeCli => formats::claude_imported_in(path, command_path),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_import::test_support::{backup_files, cleanup, ensure_for, temp_dir};
    use serde_json::json;

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
}
