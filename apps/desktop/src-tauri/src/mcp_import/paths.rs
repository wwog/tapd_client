//! Locating each client's user-scope config file.
//!
//! Paths depend on environment overrides (`XDG_CONFIG_HOME`,
//! `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HOME`/`USERPROFILE`) and, for opencode,
//! on the CLI itself, which is the only one that knows about custom installs.
//! GUI apps inherit a minimal `PATH`, so CLI probes get the user's shell `PATH`.

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use super::{CONFIG_JSON, CONFIG_JSONC};
use tapd_core::paths::expand_home;

const DEBUG_PATHS_TIMEOUT: Duration = Duration::from_secs(3);

/// Location of the opencode global config, if it can be discovered.
///
/// The CLI is asked first (`opencode debug paths`); the conventional
/// XDG/home locations are the fallback.
pub(super) fn opencode_config_path() -> Option<PathBuf> {
    config_path_from_cli().or_else(fallback_config_path)
}

/// Claude Code's user-scope config. `CLAUDE_CONFIG_DIR` replaces the directory
/// that holds `.claude.json` when set.
pub(super) fn claude_config_path() -> Option<PathBuf> {
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
pub(super) fn zcode_config_path() -> Option<PathBuf> {
    tapd_core::paths::home_dir()
        .ok()
        .map(|home| home.join(".zcode").join("cli").join("config.json"))
}

pub(super) fn cursor_config_path() -> Option<PathBuf> {
    tapd_core::paths::home_dir()
        .ok()
        .map(|home| home.join(".cursor").join("mcp.json"))
}

pub(super) fn codex_config_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(dir).join("config.toml"));
    }
    tapd_core::paths::home_dir()
        .ok()
        .map(|home| home.join(".codex").join("config.toml"))
}

/// GUI apps inherit a minimal `PATH` on macOS, so `claude` / `opencode` are
/// only found when the child gets the user's shell `PATH`.
pub(super) fn command_with_user_path(binary: &str) -> Command {
    let mut command = Command::new(binary);
    command.env("PATH", crate::shell_path::user_path());
    command
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
        .map(expand_home)
}

fn is_config_label(label: &str) -> bool {
    let normalized: String = label
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    normalized.starts_with("config")
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

#[cfg(test)]
mod tests {
    use super::{config_file_for_dir, parse_debug_paths};
    use crate::mcp_import::test_support::{cleanup, temp_dir};
    use std::path::PathBuf;

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
    fn prefers_jsonc_in_config_directory() {
        let dir = temp_dir("jsonc-preference");
        let jsonc = dir.join(super::CONFIG_JSONC);
        std::fs::write(&jsonc, "{}").unwrap();

        assert_eq!(config_file_for_dir(&dir), jsonc);

        cleanup(&dir);
    }
}
