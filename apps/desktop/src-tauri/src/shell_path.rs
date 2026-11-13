//! A `PATH` that works from a Finder-launched app.
//!
//! A macOS app started from Finder/Dock/LaunchServices inherits a minimal
//! `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one from the user's shell.
//! Anything installed by Homebrew, npm, bun or a version manager (including the
//! default `opencode`) is therefore invisible to `Command::new("opencode")`
//! and to our own `PATH` lookups.
//!
//! Everything that launches an agent binary goes through [`user_path`] instead
//! of inheriting `PATH`:
//! - [`probe_login_shell`] asks the user's shell once and caches the result;
//! - a list of well-known install locations is appended as a fallback for
//!   shells that only set `PATH` in an interactive rc file or that probe too
//!   slowly;
//! - the inherited `PATH` is kept last so dev runs behave as before.

use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    time::{Duration, Instant},
};

/// The login shell gets a short budget: a heavy rc file must not delay the
/// first task of the session.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// `PATH` used for every child process the app starts.
pub fn user_path() -> &'static OsStr {
    static PATH: OnceLock<OsString> = OnceLock::new();
    PATH.get_or_init(build_user_path).as_os_str()
}

/// True when `path` is a regular file with an executable bit.
pub fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    true
}

fn build_user_path() -> OsString {
    let mut entries: Vec<PathBuf> = Vec::new();

    if let Some(shell_path) = probe_login_shell() {
        entries.extend(std::env::split_paths(&shell_path));
    }

    if let Ok(home) = tapd_core::paths::home_dir() {
        for dir in [
            ".local/bin",
            ".npm-global/bin",
            ".npm-packages/bin",
            ".bun/bin",
            ".opencode/bin",
            ".cargo/bin",
            ".volta/bin",
            ".nvm/current/bin",
        ] {
            entries.push(home.join(dir));
        }
    }
    // nvm keeps node behind `~/.nvm/versions/node/<version>/bin`; the newest
    // version is the closest thing to "what the shell would use".
    if let Ok(home) = tapd_core::paths::home_dir() {
        entries.extend(newest_nvm_bins(&home));
    }

    #[cfg(target_os = "macos")]
    {
        entries.push(PathBuf::from("/opt/homebrew/bin"));
        entries.push(PathBuf::from("/opt/homebrew/sbin"));
        entries.push(PathBuf::from("/usr/local/bin"));
        entries.push(PathBuf::from("/usr/local/sbin"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        entries.push(PathBuf::from(appdata).join("npm"));
    }

    if let Some(current) = std::env::var_os("PATH") {
        entries.extend(std::env::split_paths(&current));
    }

    let mut unique: Vec<PathBuf> = Vec::with_capacity(entries.len());
    for entry in entries {
        if entry.as_os_str().is_empty() || unique.contains(&entry) {
            continue;
        }
        unique.push(entry);
    }
    std::env::join_paths(unique).unwrap_or_default()
}

fn newest_nvm_bins(home: &Path) -> Vec<PathBuf> {
    let versions = home.join(".nvm").join("versions").join("node");
    let Ok(read_dir) = std::fs::read_dir(&versions) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read_dir
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    // Version directories sort naturally enough for `v24.x` style names.
    names.sort();
    names
        .pop()
        .map(|name| vec![versions.join(name).join("bin")])
        .unwrap_or_default()
}

/// Runs `$SHELL -ilc 'printf %s "$PATH"'` and returns its output.
///
/// `-i` is what makes zsh read `~/.zshrc` (where nvm and friends usually live),
/// which can emit prompt noise on stdout; the last non-empty line that looks
/// like a `PATH` wins.
fn probe_login_shell() -> Option<OsString> {
    let shell = std::env::var_os("SHELL")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_shell);

    let mut child = Command::new(&shell)
        .arg("-ilc")
        .arg(r#"printf %s "$PATH""#)
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
                if started.elapsed() >= PROBE_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }

    let output = child.wait_with_output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.contains('/') && !line.contains(' '))?;
    Some(OsString::from(line))
}

/// The platform shell used when `$SHELL` is missing or unusable. Shared with
/// user-facing terminals so both spawn paths agree.
pub(crate) fn default_shell() -> OsString {
    #[cfg(target_os = "macos")]
    {
        OsString::from("/bin/zsh")
    }
    #[cfg(not(target_os = "macos"))]
    {
        OsString::from("/bin/sh")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_path_is_never_empty() {
        assert!(!user_path().is_empty());
    }

    #[test]
    fn inherited_entries_survive_deduplication() {
        let Some(current) = std::env::var_os("PATH") else {
            return;
        };
        let resolved = std::env::split_paths(user_path())
            .map(|entry| entry.to_path_buf())
            .collect::<Vec<_>>();
        for entry in std::env::split_paths(&current) {
            assert!(resolved.contains(&entry), "missing {}", entry.display());
        }
    }
}
