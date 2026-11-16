//! 运行时模型列表探测。
//!
//! 能机器读取的优先跑 CLI 的列表命令，读不到时由调用方回退到静态建议：
//! - OpenCode / OpenCode2 / ZCode: `models`，逐行 id
//! - Claude / OpenClaude: `list_models` control_request（stream-json）
//! - Codex: app-server 的 `model/list`
//! - OMP: `models --json`

use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
use tapd_i18n::{tr, tr_args};

use crate::shell_path;

/// CLI 探测的最长等待时间；超过后杀掉子进程并回退静态建议。
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_MODELS: usize = 300;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentModelOption {
    pub(super) id: String,
    pub(super) label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
}

/// 该运行时是否支持 CLI 模型探测；其余运行时直接用目录里的静态建议。
pub(super) fn supported(runtime_id: &str) -> bool {
    matches!(
        runtime_id,
        "opencode" | "opencode2" | "zcode" | "claude" | "openclaude" | "codex" | "omp"
    )
}

pub(super) fn discover(runtime_id: &str, binary: &Path) -> Result<Vec<AgentModelOption>, String> {
    match runtime_id {
        "opencode" | "opencode2" | "zcode" => read_line_models(binary),
        "claude" | "openclaude" => read_claude_models(binary),
        "codex" => read_codex_models(binary),
        "omp" => read_omp_models(binary),
        _ => Ok(Vec::new()),
    }
}

/// 模型 id → 展示名：`provider/model` 和 `-` 分段，首字母大写；
/// `claude-opus-5[1m]` 这类上下文后缀转成 `(1M context)`。
pub(super) fn model_label(id: &str) -> String {
    let (base, context) = match id.rfind('[') {
        Some(index) if id.ends_with(']') => {
            let suffix = &id[index + 1..id.len() - 1];
            if !suffix.is_empty() && suffix.chars().all(|ch| ch.is_ascii_alphanumeric()) {
                (&id[..index], Some(suffix.to_ascii_uppercase()))
            } else {
                (id, None)
            }
        }
        _ => (id, None),
    };
    let mut label = base
        .split(|ch: char| ch == '/' || ch == '-')
        .filter(|part| !part.is_empty())
        .map(|part| {
            if part.eq_ignore_ascii_case("gpt") {
                return "GPT".to_string();
            }
            if part.len() <= 3 && part.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
                return part.to_ascii_uppercase();
            }
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if let Some(context) = context {
        label.push_str(&format!(" ({context} context)"));
    }
    label
}

// -- OpenCode ---------------------------------------------------------------

fn read_line_models(binary: &Path) -> Result<Vec<AgentModelOption>, String> {
    let output = run_to_completion(binary, &["models"], None)?;
    let models = parse_line_models(&output);
    if models.is_empty() {
        Err(tr_args("agent.models.list.empty", &[&binary.display()]))
    } else {
        Ok(models)
    }
}

fn parse_line_models(output: &str) -> Vec<AgentModelOption> {
    let mut seen = HashSet::new();
    output
        .lines()
        .map(str::trim)
        // 只保留形如 `provider/model` 的 id；CLI 的提示行通常带空格。
        .filter(|line| {
            !line.is_empty() && !line.starts_with('#') && !line.chars().any(char::is_whitespace)
        })
        .filter(|line| seen.insert((*line).to_string()))
        .take(MAX_MODELS)
        .map(|id| AgentModelOption {
            id: id.to_string(),
            label: model_label(id),
            description: None,
        })
        .collect()
}

// -- Claude / OpenClaude ----------------------------------------------------

const CLAUDE_LIST_MODELS_STDIN: &str = r#"{"type":"control_request","request_id":"tapd-model-discovery","request":{"subtype":"list_models"}}"#;

fn read_claude_models(binary: &Path) -> Result<Vec<AgentModelOption>, String> {
    let display = binary.display();
    let mut child = Command::new(binary)
        .env("PATH", shell_path::user_path())
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--strict-mcp-config",
            "--settings",
            r#"{"disableAllHooks":true}"#,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| tr_args("agent.scan.start.failed", &[&display, &error]))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| tr_args("agent.models.stdin.unavailable", &[&display]))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| tr_args("agent.models.stdout.unavailable", &[&display]))?;
    let _ = writeln!(stdin, "{CLAUDE_LIST_MODELS_STDIN}");
    let _ = stdin.flush();

    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + PROBE_TIMEOUT;
    let mut models = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(tr_args("agent.models.timeout", &[&display]));
        }
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                if let Some(listed) = parse_claude_line(&line) {
                    models = listed;
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(tr_args("agent.models.timeout", &[&display]));
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // Claude 的 -p 会话不会自己退出；拿到响应后直接结束进程。
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    if models.is_empty() {
        Err(tr_args("agent.models.list.missing", &[&display]))
    } else {
        Ok(models)
    }
}

fn parse_claude_line(line: &str) -> Option<Vec<AgentModelOption>> {
    if !line.contains("control_response") {
        return None;
    }
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("control_response") {
        return None;
    }
    let response = value.get("response")?;
    if response.get("subtype").and_then(Value::as_str) != Some("success") {
        return None;
    }
    let mut rows: Vec<&Value> = response
        .get("response")
        .and_then(|response| response.get("models"))
        .and_then(Value::as_array)
        .map(|rows| rows.iter().collect())
        .unwrap_or_default();
    // 先处理具体模型行，再处理 default 行：两者可能指向同一个 resolvedModel，
    // 保留 picker 别名对应的那个 id。
    rows.sort_by_key(|row| row.get("value").and_then(Value::as_str) == Some("default"));
    let mut models: Vec<AgentModelOption> = Vec::new();
    {
        for row in rows {
            if row.get("disabled").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let alias = row
                .get("value")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty());
            let resolved = row
                .get("resolvedModel")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty());
            let Some(id) = resolved.or(alias) else {
                continue;
            };
            if id == "default" || models.iter().any(|model| model.id.eq_ignore_ascii_case(id)) {
                continue;
            }
            // resolvedModel 与 picker 的别名不同时，用解析后的模型名做标签，
            // 避免代理账号把 displayName 改成别的名字。
            let label = match (resolved, alias) {
                (Some(resolved), alias) if alias != Some(resolved) => model_label(resolved),
                _ => row
                    .get("displayName")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|label| !label.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| model_label(id)),
            };
            let description = row
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_string);
            models.push(AgentModelOption {
                id: id.to_string(),
                label,
                description,
            });
        }
    }
    Some(models)
}

// -- Codex ------------------------------------------------------------------

fn read_codex_models(binary: &Path) -> Result<Vec<AgentModelOption>, String> {
    let display = binary.display();
    let mut child = Command::new(binary)
        .env("PATH", shell_path::user_path())
        .args([
            "-c",
            "approval_policy=never",
            "-c",
            "features.plugins=false",
            "-s",
            "read-only",
            "-a",
            "never",
            "app-server",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| tr_args("agent.scan.start.failed", &[&display, &error]))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| tr_args("agent.models.stdin.unavailable", &[&display]))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| tr_args("agent.models.stdout.unavailable", &[&display]))?;
    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + PROBE_TIMEOUT;
    let mut next_id = 1_u64;
    codex_request(
        &mut child,
        &mut stdin,
        &rx,
        deadline,
        &mut next_id,
        "initialize",
        Some(json!({
            "clientInfo": {
                "name": "tapd_client",
                "title": "TAPD Client",
                "version": env!("CARGO_PKG_VERSION"),
            }
        })),
    )?;
    let _ = writeln!(stdin, "{}", json!({ "method": "initialized" }));
    let _ = stdin.flush();

    let mut models: Vec<AgentModelOption> = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..20 {
        let params = match &cursor {
            Some(cursor) => json!({ "limit": 100, "includeHidden": false, "cursor": cursor }),
            None => json!({ "limit": 100, "includeHidden": false }),
        };
        let result = codex_request(
            &mut child,
            &mut stdin,
            &rx,
            deadline,
            &mut next_id,
            "model/list",
            Some(params),
        )?;
        if let Some(rows) = result.get("data").and_then(Value::as_array) {
            for row in rows {
                parse_codex_model(row, &mut models);
            }
        }
        cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        if cursor.is_none() {
            break;
        }
    }

    // app-server 会一直等 stdin；读完列表后主动结束。
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    if models.is_empty() {
        Err(tr_args("agent.models.list.missing", &[&display]))
    } else {
        Ok(models)
    }
}

fn codex_request(
    child: &mut Child,
    stdin: &mut ChildStdin,
    rx: &Receiver<String>,
    deadline: Instant,
    next_id: &mut u64,
    method: &str,
    params: Option<Value>,
) -> Result<Value, String> {
    let id = *next_id;
    *next_id += 1;
    let payload = match params {
        Some(params) => json!({ "method": method, "id": id, "params": params }),
        None => json!({ "method": method, "id": id }),
    };
    writeln!(stdin, "{payload}")
        .map_err(|error| tr_args("agent.models.codex.write.failed", &[&error]))?;
    stdin
        .flush()
        .map_err(|error| tr_args("agent.models.codex.write.failed", &[&error]))?;

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = child.kill();
            return Err(tr("agent.models.codex.timeout").to_string());
        }
        match rx.recv_timeout(remaining) {
            Ok(line) => {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let reply_id = value.get("id").and_then(|id| {
                    id.as_u64()
                        .or_else(|| id.as_str().and_then(|id| id.parse::<u64>().ok()))
                });
                if reply_id != Some(id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    let message = tr_args("agent.models.codex.request.failed", &[&method, &error]);
                    return Err(message);
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
            Err(RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                return Err(tr("agent.models.codex.timeout").to_string());
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(tr("agent.models.codex.exited").to_string());
            }
        }
    }
}

fn parse_codex_model(row: &Value, out: &mut Vec<AgentModelOption>) {
    if row.get("hidden").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let id = row
        .get("model")
        .and_then(Value::as_str)
        .or_else(|| row.get("id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let Some(id) = id else {
        return;
    };
    if out.iter().any(|model| model.id == id) {
        return;
    }
    let label = row
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| model_label(id));
    let description = row
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    out.push(AgentModelOption {
        id: id.to_string(),
        label,
        description,
    });
}

// -- OMP --------------------------------------------------------------------

fn read_omp_models(binary: &Path) -> Result<Vec<AgentModelOption>, String> {
    let display = binary.display();
    let mut child = Command::new(binary)
        .env("PATH", shell_path::user_path())
        .args(["models", "--json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| tr_args("agent.scan.start.failed", &[&display, &error]))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| tr_args("agent.models.stdout.unavailable", &[&display]))?;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if tx.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let deadline = Instant::now() + PROBE_TIMEOUT;
    let mut output = String::new();
    let mut parsed: Option<Vec<AgentModelOption>> = None;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match rx.recv_timeout(remaining) {
            Ok(chunk) => {
                output.push_str(&String::from_utf8_lossy(&chunk));
                // OMP 打印完列表后进程可能不退出；看到完整 JSON 就收工。
                if output.trim_end().ends_with('}') {
                    if let Ok(models) = parse_omp_models(&output) {
                        parsed = Some(models);
                        break;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => break,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();

    let models = match parsed {
        Some(models) => models,
        None => parse_omp_models(&output).unwrap_or_default(),
    };
    if models.is_empty() {
        Err(tr_args("agent.models.list.missing", &[&display]))
    } else {
        Ok(models)
    }
}

fn parse_omp_models(output: &str) -> Result<Vec<AgentModelOption>, String> {
    let trimmed = output.trim();
    let (start, end) = match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(start), Some(end)) if end > start => (start, end),
        _ => return Err(tr("agent.models.omp.notJson").to_string()),
    };
    let value: Value = serde_json::from_str(&trimmed[start..=end])
        .map_err(|error| tr_args("agent.models.omp.parse.failed", &[&error]))?;
    let rows = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| tr("agent.models.omp.invalid").to_string())?;
    let mut models: Vec<AgentModelOption> = Vec::new();
    for row in rows {
        let provider = row
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let bare = row.get("id").and_then(Value::as_str).unwrap_or("").trim();
        let selector = row
            .get("selector")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let id = if !selector.is_empty() {
            selector.to_string()
        } else if !provider.is_empty() && !bare.is_empty() {
            format!("{provider}/{bare}")
        } else {
            bare.to_string()
        };
        if id.is_empty() || models.iter().any(|model| model.id == id) {
            continue;
        }
        let label = row
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| model_label(&id));
        let description = if provider.is_empty() {
            None
        } else {
            Some(provider.to_string())
        };
        models.push(AgentModelOption {
            id,
            label,
            description,
        });
    }
    Ok(models)
}

// -- Process helpers --------------------------------------------------------

/// 跑一个会自己退出的列表命令；超时后杀掉子进程。
fn run_to_completion(
    binary: &Path,
    args: &[&str],
    stdin_payload: Option<&str>,
) -> Result<String, String> {
    let display = binary.display();
    let mut child = Command::new(binary)
        .env("PATH", shell_path::user_path())
        .args(args)
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| tr_args("agent.scan.start.failed", &[&display, &error]))?;
    if let Some(payload) = stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(payload.as_bytes());
            let _ = stdin.flush();
        }
    }

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() >= PROBE_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(tr_args("agent.models.timeout", &[&display]));
                }
                thread::sleep(Duration::from_millis(80));
            }
            Err(error) => return Err(tr_args("agent.models.wait.failed", &[&display, &error])),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|error| tr_args("agent.models.read.output.failed", &[&display, &error]))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("");
        return Err(if detail.is_empty() {
            tr_args("agent.models.noOutput", &[&display])
        } else {
            tr_args("agent.models.noOutput.detail", &[&display, &detail])
        });
    }
    Ok(stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_split_provider_and_model() {
        assert_eq!(
            model_label("opencode-go/deepseek-v4.1-flash"),
            "Opencode Go Deepseek V4.1 Flash"
        );
        assert_eq!(model_label("gpt-5"), "GPT 5");
        assert_eq!(
            model_label("claude-opus-5[1m]"),
            "Claude Opus 5 (1M context)"
        );
    }

    #[test]
    fn parses_opencode_lines() {
        let models = parse_line_models("provider/a\nprovider/a\n\n# note\nprovider/b\n");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "provider/a");
        assert_eq!(models[0].label, "Provider A");
        assert_eq!(models[1].id, "provider/b");
    }

    #[test]
    fn parses_claude_listing() {
        let line = r#"{"type":"control_response","response":{"subtype":"success","response":{"models":[{"value":"default","resolvedModel":"claude-opus-5-5"},{"value":"sonnet","displayName":"Sonnet 5","description":"平衡"},{"value":"opus","disabled":true}]}}}"#;
        let models = parse_claude_line(line).expect("listing");
        assert_eq!(models.len(), 2);
        // 具体模型行排在 default 行之前，避免两者指向同一个 resolvedModel 时
        // 丢掉 picker 别名对应的 id。
        assert_eq!(models[0].id, "sonnet");
        assert_eq!(models[0].label, "Sonnet 5");
        assert_eq!(models[0].description.as_deref(), Some("平衡"));
        assert_eq!(models[1].id, "claude-opus-5-5");
    }

    #[test]
    fn parses_codex_rows() {
        let row = json!({
            "model": "gpt-5.6-terra",
            "displayName": "GPT-5.6 Terra",
            "description": "frontier",
            "hidden": false,
        });
        let mut out = Vec::new();
        parse_codex_model(&row, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "gpt-5.6-terra");
        assert_eq!(out[0].label, "GPT-5.6 Terra");
        assert_eq!(out[0].description.as_deref(), Some("frontier"));
    }

    #[test]
    fn parses_omp_listing_with_preamble() {
        let output = "update available\n{\"models\":[{\"provider\":\"anthropic\",\"id\":\"claude-x\",\"name\":\"Claude X\"},{\"selector\":\"openai/gpt-y\"}]}";
        let models = parse_omp_models(output).expect("listing");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "anthropic/claude-x");
        assert_eq!(models[0].label, "Claude X");
        assert_eq!(models[0].description.as_deref(), Some("anthropic"));
        assert_eq!(models[1].id, "openai/gpt-y");
    }

    /// 在临时目录写一个可执行的假 CLI，用于验证进程 / stdin / NDJSON 路径。
    #[cfg(unix)]
    fn fake_binary(name: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let dir =
            std::env::temp_dir().join(format!("tapd-models-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write script");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    #[cfg(unix)]
    fn cleanup(path: &Path) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }

    #[cfg(unix)]
    #[test]
    fn runs_opencode_style_listing() {
        let path = fake_binary("fake-opencode", "#!/bin/sh\nprintf 'p/a\\np/b\\n'\n");
        let models = read_line_models(&path).expect("models");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "p/a");
        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn runs_claude_listing_without_waiting_for_exit() {
        let path = fake_binary(
            "fake-claude",
            "#!/bin/sh\nread line\nprintf '%s\\n' '{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"response\":{\"models\":[{\"value\":\"sonnet\",\"displayName\":\"Sonnet Mock\"}]}}}'\nsleep 5\n",
        );
        let models = read_claude_models(&path).expect("models");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "sonnet");
        assert_eq!(models[0].label, "Sonnet Mock");
        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn runs_codex_app_server_protocol() {
        let path = fake_binary(
            "fake-codex",
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
    *'"method":"model/list"'*) printf '%s\n' '{"id":2,"result":{"data":[{"model":"gpt-mock","displayName":"GPT Mock"}],"nextCursor":null}}' ;;
  esac
done
"#,
        );
        let models = read_codex_models(&path).expect("models");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-mock");
        assert_eq!(models[0].label, "GPT Mock");
        cleanup(&path);
    }

    #[cfg(unix)]
    #[test]
    fn runs_omp_listing_without_waiting_for_exit() {
        let path = fake_binary(
            "fake-omp",
            "#!/bin/sh\nprintf '%s\\n' '{\"models\":[{\"provider\":\"p\",\"id\":\"m\",\"name\":\"Mock Model\"}]}'\nsleep 5\n",
        );
        let models = read_omp_models(&path).expect("models");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "p/m");
        assert_eq!(models[0].label, "Mock Model");
        cleanup(&path);
    }
}
