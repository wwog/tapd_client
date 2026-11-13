//! cloudflared Quick Tunnel supervision for the companion server.
//!
//! The app never bundles or auto-installs cloudflared. It detects an existing
//! install, spawns a quick tunnel against the local companion port and keeps
//! that process alive until the user stops it, the companion is disabled or
//! the app exits. Scanning a QR code never tears the tunnel down: the phone
//! keeps using the same public URL for the whole desktop session.
//!
//! State transitions are published on [`TUNNEL_EVENT`]; every write is guarded
//! by a generation number so a reader thread from a stopped run can never
//! overwrite the snapshot of a newer one.

use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, ChildStderr, Command, Stdio},
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::{shell_path, state::SharedState};

pub(super) const TUNNEL_EVENT: &str = "companion://tunnel";
/// A quick tunnel normally resolves in a few seconds; past this it is treated
/// as failed so the dialog can offer a retry instead of spinning forever.
const START_TIMEOUT: Duration = Duration::from_secs(30);
const TRYCLOUDFLARE_SUFFIX: &str = ".trycloudflare.com";

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Whether `cloudflared` is installed and, if so, which binary/version.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudflaredInfo {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

/// Detects the binary fresh. The settings dialog calls this after the user
/// says they installed it; the cached copy lives in `CompanionRuntime`.
pub fn detect() -> CloudflaredInfo {
    let Some(path) = find_binary() else {
        return CloudflaredInfo::default();
    };
    let version = Command::new(&path)
        .arg("--version")
        .env("PATH", shell_path::user_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()
        .and_then(|output| {
            let bytes = if output.stdout.is_empty() {
                output.stderr
            } else {
                output.stdout
            };
            let text = String::from_utf8_lossy(&bytes);
            text.lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_string)
        });
    CloudflaredInfo {
        installed: true,
        path: Some(path.display().to_string()),
        version,
    }
}

/// PATH first (the GUI process inherits a minimal one, see `shell_path`), then
/// the usual Homebrew/system locations as a fallback.
fn find_binary() -> Option<PathBuf> {
    for dir in std::env::split_paths(shell_path::user_path()) {
        let candidate = dir.join("cloudflared");
        if shell_path::is_executable(&candidate) {
            return Some(candidate);
        }
    }
    [
        "/opt/homebrew/bin/cloudflared",
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| shell_path::is_executable(path))
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelState {
    #[default]
    Stopped,
    Starting,
    Running,
    Failed,
}

/// What the dialog renders. `url` is only present while running.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSnapshot {
    pub state: TunnelState,
    pub url: Option<String>,
    pub error: Option<String>,
    pub started_at: Option<String>,
}

/// The tunnel process and its last known state, stored under the companion
/// runtime lock.
#[derive(Default)]
pub struct TunnelRuntime {
    pub snapshot: TunnelSnapshot,
    child: Option<Child>,
    generation: u64,
}

impl TunnelRuntime {
    /// Invalidates older reader threads and kills the current child.
    fn reset(&mut self) -> TunnelSnapshot {
        self.generation = self.generation.wrapping_add(1);
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.snapshot = TunnelSnapshot::default();
        self.snapshot.clone()
    }
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

/// Starts a quick tunnel for the running companion port. Idempotent while a
/// tunnel is already starting/running. Returns the snapshot immediately; the
/// public URL arrives later on [`TUNNEL_EVENT`].
pub(super) fn start(app: &AppHandle, state: &SharedState) -> Result<TunnelSnapshot, String> {
    let (port, cached) = {
        let runtime = state.companion.lock().expect("companion lock");
        (runtime.port, runtime.cloudflared.clone())
    };
    let port = port.ok_or_else(|| "伴侣服务未运行".to_string())?;
    let cloudflared = cached.unwrap_or_else(detect);

    {
        let mut runtime = state.companion.lock().expect("companion lock");
        runtime.cloudflared = Some(cloudflared.clone());
        if matches!(
            runtime.tunnel.snapshot.state,
            TunnelState::Starting | TunnelState::Running
        ) {
            return Ok(runtime.tunnel.snapshot.clone());
        }
    }

    if !cloudflared.installed {
        let snapshot = failed(
            state,
            app,
            "未检测到 cloudflared，请先安装后再建立隧道",
        );
        return Err(snapshot
            .error
            .clone()
            .unwrap_or_else(|| "未检测到 cloudflared".to_string()));
    }

    let binary = cloudflared
        .path
        .as_deref()
        .ok_or_else(|| "cloudflared 路径无效".to_string())?;
    let local_url = format!("http://127.0.0.1:{port}");
    let mut child = Command::new(binary)
        .arg("tunnel")
        .arg("--url")
        .arg(&local_url)
        .arg("--protocol")
        .arg("http2")
        .arg("--no-autoupdate")
        .env("PATH", shell_path::user_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 cloudflared：{error}"))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 cloudflared 输出".to_string())?;

    let (generation, snapshot) = {
        let mut runtime = state.companion.lock().expect("companion lock");
        let generation = runtime.tunnel.generation.wrapping_add(1);
        runtime.tunnel.generation = generation;
        runtime.tunnel.child = Some(child);
        runtime.tunnel.snapshot = TunnelSnapshot {
            state: TunnelState::Starting,
            url: None,
            error: None,
            started_at: Some(chrono::Utc::now().to_rfc3339()),
        };
        (generation, runtime.tunnel.snapshot.clone())
    };
    emit(app, &snapshot);

    spawn_reader(app.clone(), state.clone(), generation, stderr);
    spawn_watchdog(app.clone(), state.clone(), generation);
    Ok(snapshot)
}

/// Stops the tunnel (if any) and publishes the stopped snapshot.
pub(super) fn stop(state: &SharedState, app: &AppHandle) -> TunnelSnapshot {
    let snapshot = {
        let mut runtime = state.companion.lock().expect("companion lock");
        runtime.tunnel.reset()
    };
    emit(app, &snapshot);
    snapshot
}

fn failed(state: &SharedState, app: &AppHandle, error: &str) -> TunnelSnapshot {
    let snapshot = {
        let mut runtime = state.companion.lock().expect("companion lock");
        runtime.tunnel.snapshot = TunnelSnapshot {
            state: TunnelState::Failed,
            url: None,
            error: Some(error.to_string()),
            started_at: runtime.tunnel.snapshot.started_at.clone(),
        };
        runtime.tunnel.snapshot.clone()
    };
    emit(app, &snapshot);
    snapshot
}

// ---------------------------------------------------------------------------
// Background readers
// ---------------------------------------------------------------------------

/// Reads cloudflared's stderr: the public URL is printed there once the quick
/// tunnel is live, and EOF tells us the process died.
fn spawn_reader(
    app: AppHandle,
    state: SharedState,
    generation: u64,
    stderr: ChildStderr,
) {
    std::thread::spawn(move || {
        let mut last_error: Option<String> = None;
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { continue };
            let Some(url) = parse_tunnel_url(&line) else {
                if let Some(message) = error_line(&line) {
                    last_error = Some(message);
                }
                continue;
            };
            let mut runtime = state.companion.lock().expect("companion lock");
            if runtime.tunnel.generation != generation {
                return;
            }
            if runtime.tunnel.snapshot.state != TunnelState::Starting {
                continue;
            }
            runtime.tunnel.snapshot = TunnelSnapshot {
                state: TunnelState::Running,
                url: Some(url),
                error: None,
                started_at: runtime.tunnel.snapshot.started_at.clone(),
            };
            let snapshot = runtime.tunnel.snapshot.clone();
            drop(runtime);
            emit(&app, &snapshot);
        }

        let mut runtime = state.companion.lock().expect("companion lock");
        if runtime.tunnel.generation != generation {
            return;
        }
        runtime.tunnel.child = None;
        if matches!(
            runtime.tunnel.snapshot.state,
            TunnelState::Starting | TunnelState::Running
        ) {
            runtime.tunnel.snapshot = TunnelSnapshot {
                state: TunnelState::Failed,
                url: None,
                // A quick tunnel that Cloudflare rejects (429, no network)
                // prints the reason; surfacing it beats a generic message.
                error: Some(
                    last_error.unwrap_or_else(|| "隧道进程已退出，请重新建立".to_string()),
                ),
                started_at: runtime.tunnel.snapshot.started_at.clone(),
            };
            let snapshot = runtime.tunnel.snapshot.clone();
            drop(runtime);
            emit(&app, &snapshot);
        }
    });
}

/// Fails a start that never produced a URL within [`START_TIMEOUT`].
fn spawn_watchdog(app: AppHandle, state: SharedState, generation: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(START_TIMEOUT);
        let mut runtime = state.companion.lock().expect("companion lock");
        if runtime.tunnel.generation != generation
            || runtime.tunnel.snapshot.state != TunnelState::Starting
        {
            return;
        }
        if let Some(mut child) = runtime.tunnel.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        runtime.tunnel.snapshot = TunnelSnapshot {
            state: TunnelState::Failed,
            url: None,
            error: Some("建立外网隧道超时（30 秒）".to_string()),
            started_at: runtime.tunnel.snapshot.started_at.clone(),
        };
        let snapshot = runtime.tunnel.snapshot.clone();
        drop(runtime);
        emit(&app, &snapshot);
    });
}

fn emit(app: &AppHandle, snapshot: &TunnelSnapshot) {
    let _ = app.emit(TUNNEL_EVENT, snapshot.clone());
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

/// Extracts the first `https://*.trycloudflare.com` URL from a log line.
/// cloudflared prints it inside a box (`| https://… |`), sometimes with ANSI
/// colour codes around it.
fn parse_tunnel_url(line: &str) -> Option<String> {
    let cleaned = strip_ansi(line);
    let start = cleaned.find("https://")?;
    let rest = &cleaned[start..];
    let end = rest
        .find(|c: char| {
            c.is_whitespace() || matches!(c, '"' | '\'' | '|' | ')' | ']' | '>' | ',')
        })
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches('/');
    let host = url.strip_prefix("https://")?;
    (host.len() > TRYCLOUDFLARE_SUFFIX.len() && host.ends_with(TRYCLOUDFLARE_SUFFIX))
        .then(|| url.to_string())
}

/// Picks a short human-readable failure line out of cloudflared's log. The
/// dialog shows it instead of a generic "process exited" message.
fn error_line(line: &str) -> Option<String> {
    let cleaned = strip_ansi(line).trim().to_string();
    let lower = cleaned.to_ascii_lowercase();
    if lower.contains(" err ") || lower.contains("error") || lower.contains("failed") {
        Some(cleaned.chars().take(180).collect())
    } else {
        None
    }
}

/// Drops SGR escape sequences (`ESC [ … m`) so URLs split by colour codes
/// still parse.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for next in chars.by_ref() {
                if next == 'm' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_trycloudflare_url_from_boxed_log_line() {
        let line =
            "2026-11-13T10:00:00Z INF |  https://quiet-forest-1234.trycloudflare.com  |";
        assert_eq!(
            parse_tunnel_url(line).as_deref(),
            Some("https://quiet-forest-1234.trycloudflare.com")
        );
    }

    #[test]
    fn parses_url_with_ansi_colours() {
        let line = "\u{1b}[32mhttps://calm-river-99.trycloudflare.com\u{1b}[0m";
        assert_eq!(
            parse_tunnel_url(line).as_deref(),
            Some("https://calm-river-99.trycloudflare.com")
        );
    }

    #[test]
    fn ignores_non_tunnel_urls() {
        assert!(parse_tunnel_url("https://example.com").is_none());
        assert!(parse_tunnel_url("no url here").is_none());
        assert!(parse_tunnel_url("https://.trycloudflare.com").is_none());
    }

    #[test]
    fn picks_a_failure_line_from_the_log() {
        let line = "2026-11-13T03:16:13Z ERR quick tunnel provisioning failed with status 429";
        assert_eq!(
            error_line(line).as_deref(),
            Some("2026-11-13T03:16:13Z ERR quick tunnel provisioning failed with status 429")
        );
        assert!(error_line("INF Requesting new quick Tunnel").is_none());
    }

    #[test]
    fn default_snapshot_is_stopped() {
        let snapshot = TunnelSnapshot::default();
        assert_eq!(snapshot.state, TunnelState::Stopped);
        assert!(snapshot.url.is_none());
        assert!(snapshot.error.is_none());
    }

    #[test]
    fn reset_invalidates_the_generation() {
        let mut runtime = TunnelRuntime::default();
        let before = runtime.generation;
        let snapshot = runtime.reset();
        assert_eq!(runtime.generation, before.wrapping_add(1));
        assert_eq!(snapshot.state, TunnelState::Stopped);
    }
}
