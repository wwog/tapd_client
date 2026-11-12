//! Client-specific payloads and formats: the JSON entry each client expects,
//! opencode's legacy layout migration, Codex's TOML table and Claude Code's
//! CLI-managed registration.

use std::path::Path;
use std::process::Stdio;

use serde_json::{json, Value};
use toml_edit::{value as toml_value, DocumentMut, Item, Table};

use super::{
    merge::{
        backup_existing, command_matches, read_existing, read_json, write_atomic, MergeOutcome,
    },
    paths::command_with_user_path,
    CONFIG_SCHEMA,
};

pub(super) fn tapd_entry(command_path: &str) -> Value {
    json!({ "type": "local", "command": [command_path] })
}

pub(super) fn zcode_entry(command_path: &str) -> Value {
    json!({ "type": "stdio", "command": command_path })
}

pub(super) fn cursor_entry(command_path: &str) -> Value {
    json!({ "command": command_path })
}

/// 标准 `mcpServers` stdio 条目（Gemini CLI / Qwen Code / Kimi Code）。
pub(super) fn stdio_entry(command_path: &str) -> Value {
    json!({ "command": command_path })
}

/// OMP 的 mcp.json 显式声明 transport。
pub(super) fn omp_entry(command_path: &str) -> Value {
    json!({ "type": "stdio", "command": command_path })
}

pub(super) fn opencode_default_root() -> Value {
    json!({ "$schema": CONFIG_SCHEMA })
}

pub(super) fn empty_config() -> Value {
    json!({})
}

/// Hoists `mcp.servers.<name>` entries into `mcp.<name>` and drops the
/// wrapper. Direct entries win so a user's existing config is never replaced.
///
/// opencode v2.2.x validates `mcp` as a map of server configs. The older
/// `mcp.servers.<name>` wrapper is read as a server named `servers` and makes
/// startup fail (`Missing key mcp.servers.enabled`), so an existing wrapper is
/// migrated to direct entries on the next import.
pub(super) fn migrate_opencode_servers(config: &mut Value) -> bool {
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

/// Merges `[mcp_servers.tapd]` into Codex's `config.toml`, preserving the
/// rest of the document (comments and formatting included).
pub(super) fn ensure_codex_in_file(
    path: &Path,
    command_path: &str,
) -> Result<MergeOutcome, String> {
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

pub(super) fn codex_imported_in(path: &Path, command_path: &str) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(document) = raw.parse::<DocumentMut>() else {
        return false;
    };
    codex_command(&document) == Some(command_path)
}

/// Registers the sidecar through the Claude Code CLI (`--scope user`).
pub(super) fn ensure_claude_mcp(
    path: &Path,
    command_path: &str,
) -> Result<MergeOutcome, String> {
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
    read_json(path).is_some_and(|config| config.pointer("/mcpServers/tapd").is_some())
}

pub(super) fn claude_imported_in(path: &Path, command_path: &str) -> bool {
    read_json(path).is_some_and(|config| {
        config
            .pointer("/mcpServers/tapd")
            .is_some_and(|entry| claude_entry_matches(entry, command_path))
    })
}

fn claude_entry_matches(entry: &Value, command_path: &str) -> bool {
    entry
        .get("command")
        .is_some_and(|value| command_matches(value, command_path))
        || entry
            .get("args")
            .is_some_and(|value| command_matches(value, command_path))
}

#[cfg(test)]
mod tests {
    use super::claude_has_tapd;
    use crate::mcp_import::test_support::{backup_files, cleanup, ensure_for, temp_dir};
    use crate::mcp_import::{client_spec, Format, CLIENT_CLAUDE, CLIENT_CODEX};

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
        assert!(super::codex_imported_in(&path, "/opt/tapd-mcp"));
        assert!(!super::codex_imported_in(&path, "/opt/other"));

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
        assert!(super::claude_imported_in(&path, "/opt/tapd-mcp"));
        assert!(!super::claude_imported_in(&path, "/opt/other"));
        assert!(claude_has_tapd(&path));

        // Some Claude versions store the executable under `args`.
        std::fs::write(
            &path,
            r#"{"mcpServers":{"tapd":{"type":"stdio","command":"npx","args":["/opt/tapd-mcp"]}}}"#,
        )
        .unwrap();
        assert!(super::claude_imported_in(&path, "/opt/tapd-mcp"));

        assert!(!super::claude_imported_in(
            &dir.join("missing.json"),
            "/opt/tapd-mcp"
        ));

        cleanup(&dir);
    }
}
