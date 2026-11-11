//! JSON config merge, backup and atomic write.
//!
//! Import must be idempotent: an entry that already matches is left alone and
//! no backup is created. A real change first copies the previous file to
//! `<file>.bak-<unix-ts>`, then replaces the file through a sibling temp file +
//! rename, so a crash mid-write cannot truncate the config.

use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value};

use super::CONFIG_JSON;

#[derive(Debug)]
pub(super) struct MergeOutcome {
    pub(super) changed: bool,
    pub(super) backup_path: Option<PathBuf>,
}

/// Merges `desired` at `segments` inside a JSON config file.
///
/// - missing file: starts from `default_root` (no backup to make)
/// - existing but unparseable file: errors without touching it
/// - unchanged entry: returns early with `changed: false` and no backup
/// - any change: copies the old file to `<file>.bak-<unix-ts>`, then writes
///   atomically via a sibling temp file + rename
pub(super) fn ensure_json_entry(
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

pub(super) fn read_existing(path: &Path, label: &str) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取 {label} 配置失败：{error}")),
    }
}

/// Best-effort JSON read used by the "is it imported?" probes: a missing,
/// unreadable or unparseable file simply reads as absent.
pub(super) fn read_json(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(super) fn backup_existing(path: &Path, exists: bool) -> Result<Option<PathBuf>, String> {
    if !exists {
        return Ok(None);
    }
    let backup = backup_path_for(path);
    std::fs::copy(path, &backup).map_err(|error| format!("备份配置失败：{error}"))?;
    Ok(Some(backup))
}

/// Whether a JSON config already points at `command_path` at `segments`.
pub(super) fn json_command_matches(path: &Path, segments: &[&str], command_path: &str) -> bool {
    let pointer = format!("/{}/command", segments.join("/"));
    read_json(path).is_some_and(|config| {
        config
            .pointer(&pointer)
            .is_some_and(|value| command_matches(value, command_path))
    })
}

/// A command entry is either the executable itself or an argv array.
pub(super) fn command_matches(value: &Value, command_path: &str) -> bool {
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

pub(super) fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
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
