//! `tapd-mcp` — MCP stdio server that proxies tool calls to the desktop app.
//!
//! The desktop app owns the TAPD session, caching and policy. This process only
//! speaks JSON-RPC over stdio and forwards each call to the app's loopback API,
//! launching the app first if necessary.

use std::time::Duration;

use serde_json::{json, Map, Value};
use tapd_core::{mcp, paths::AppPaths, runtime::RuntimeInfo};
use tapd_i18n::tr;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdout};

const PROTOCOL_VERSION: &str = "2024-11-05";
const APP_BUNDLE_ID: &str = "com.tapdclient.desktop";

#[tokio::main]
async fn main() {
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("tapd-mcp {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let paths = match AppPaths::resolve() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("tapd-mcp: cannot resolve application paths: {error}");
            std::process::exit(1);
        }
    };

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(240))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            eprintln!("tapd-mcp: cannot build HTTP client: {error}");
            std::process::exit(1);
        }
    };

    // Parse every schema up front so a malformed manifest literal fails before
    // the server starts serving `tools/list`.
    let tool_definitions = match tool_definitions() {
        Ok(definitions) => definitions,
        Err(error) => {
            eprintln!("tapd-mcp: invalid tool manifest: {error}");
            std::process::exit(1);
        }
    };

    // Clients spawn the sidecar inside the project they are working on; forward
    // that directory so the app can match a TAPD project by repo path.
    let cwd = std::env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string());

    let mut client_name = "unknown".to_string();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();

    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let message: Value = match serde_json::from_str(line) {
            Ok(message) => message,
            Err(error) => {
                send(
                    &mut stdout,
                    json!({
                        "jsonrpc": "2.0",
                        "id": Value::Null,
                        "error": {"code": -32700, "message": format!("parse error: {error}")}
                    }),
                )
                .await;
                continue;
            }
        };

        let id = message.get("id").cloned().filter(|id| !id.is_null());
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");

        match method {
            "initialize" => {
                if let Some(name) = message
                    .pointer("/params/clientInfo/name")
                    .and_then(Value::as_str)
                {
                    client_name = name.to_string();
                }
                tracing::info!(client = %client_name, "mcp initialize");
                respond(
                    &mut stdout,
                    id,
                    json!({
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {"tools": {"listChanged": false}},
                        "serverInfo": {
                            "name": "tapd-mcp",
                            "version": env!("CARGO_PKG_VERSION")
                        }
                    }),
                )
                .await;
            }
            "notifications/initialized" => {}
            "ping" => respond(&mut stdout, id, json!({})).await,
            "tools/list" => {
                respond(
                    &mut stdout,
                    id,
                    json!({ "tools": tool_definitions.clone() }),
                )
                .await;
            }
            "tools/call" => {
                let name = message
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let arguments = inject_root(
                    message.pointer("/params/arguments").unwrap_or(&Value::Null),
                    cwd.as_deref(),
                );

                match call_tool(&paths, &client, &client_name, &name, &arguments).await {
                    Ok(data) => {
                        respond(
                            &mut stdout,
                            id,
                            json!({
                                "content": [{"type": "text", "text": pretty(&data)}],
                                "isError": false
                            }),
                        )
                        .await;
                    }
                    Err(error) => {
                        tracing::warn!(tool = %name, %error, "tool call failed");
                        respond(
                            &mut stdout,
                            id,
                            json!({
                                "content": [{"type": "text", "text": error}],
                                "isError": true
                            }),
                        )
                        .await;
                    }
                }
            }
            other => {
                if id.is_some() {
                    send(
                        &mut stdout,
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {"code": -32601, "message": format!("method not found: {other}")}
                        }),
                    )
                    .await;
                }
            }
        }
    }
}

async fn call_tool(
    paths: &AppPaths,
    client: &reqwest::Client,
    client_name: &str,
    tool: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let runtime = ensure_app(paths, client).await?;
    let body = json!({
        "tool": tool,
        "arguments": arguments,
        "client": client_name,
    });

    let mut response = post_tool(client, &runtime, &body).await?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        // The app restarted and rotated its token; retry once with a fresh read.
        let runtime = ensure_app(paths, client).await?;
        response = post_tool(client, &runtime, &body).await?;
    }

    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("invalid response from TAPD Client: {error}"))?;

    if payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        Ok(payload.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("TAPD Client returned an error")
            .to_string())
    }
}

async fn post_tool(
    client: &reqwest::Client,
    runtime: &RuntimeInfo,
    body: &Value,
) -> Result<reqwest::Response, String> {
    client
        .post(format!("http://127.0.0.1:{}/mcp/call", runtime.port))
        .bearer_auth(&runtime.token)
        .json(body)
        .send()
        .await
        .map_err(|error| format!("cannot reach TAPD Client: {error}"))
}

async fn ensure_app(paths: &AppPaths, client: &reqwest::Client) -> Result<RuntimeInfo, String> {
    if let Some(runtime) = read_runtime(paths) {
        if healthy(client, &runtime).await {
            return Ok(runtime);
        }
    }

    launch_app();

    for _ in 0..24 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(runtime) = read_runtime(paths) {
            if healthy(client, &runtime).await {
                return Ok(runtime);
            }
        }
    }

    Err(tr("mcp.cli.appnotrunning").to_string())
}

fn read_runtime(paths: &AppPaths) -> Option<RuntimeInfo> {
    let runtime = RuntimeInfo::read(&paths.runtime_file).ok()?;
    runtime.pid_alive().then_some(runtime)
}

async fn healthy(client: &reqwest::Client, runtime: &RuntimeInfo) -> bool {
    client
        .get(format!("http://127.0.0.1:{}/healthz", runtime.port))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

/// Debug builds (`pnpm dev`) relaunch the sibling dev binary instead of asking
/// LaunchServices for the bundle id: that would open an installed release app,
/// which runs against a different data directory and takes over the session.
#[cfg(debug_assertions)]
fn launch_dev_sibling() -> bool {
    let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
    else {
        return false;
    };
    #[cfg(target_os = "windows")]
    let binary = dir.join("tapd-client.exe");
    #[cfg(not(target_os = "windows"))]
    let binary = dir.join("tapd-client");
    if !binary.is_file() {
        return false;
    }
    std::process::Command::new(&binary)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
}

fn launch_app() {
    #[cfg(debug_assertions)]
    if launch_dev_sibling() {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/open")
            .args(["-b", APP_BUNDLE_ID])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        let _ = std::process::Command::new("/usr/bin/open")
            .args(["-a", "TAPD Client"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", "tapd-client"])
            .status();
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = std::process::Command::new("tapd-client").status();
    }
}

/// Adds the sidecar's working directory as a soft `root` hint. Explicit
/// arguments always win, and `rootSource` tells the app the hint came from the
/// process cwd (so an unmatched cwd falls back instead of failing).
fn inject_root(arguments: &Value, cwd: Option<&str>) -> Value {
    let Some(cwd) = cwd else {
        return arguments.clone();
    };
    let mut map: Map<String, Value> = match arguments {
        Value::Object(map) => map.clone(),
        Value::Null => Map::new(),
        _ => return arguments.clone(),
    };

    const ROOT_KEYS: [&str; 4] = ["root", "cwd", "repo_path", "repoPath"];
    if ROOT_KEYS
        .iter()
        .any(|key| map.get(*key).is_some_and(|value| !value.is_null()))
    {
        return Value::Object(map);
    }

    map.insert("root".to_string(), Value::String(cwd.to_string()));
    map.insert("rootSource".to_string(), Value::String("cwd".to_string()));
    Value::Object(map)
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

async fn respond(stdout: &mut Stdout, id: Option<Value>, result: Value) {
    if id.is_none() {
        return;
    }
    send(
        stdout,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        }),
    )
    .await;
}

async fn send(stdout: &mut Stdout, value: Value) {
    let mut line = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
    line.push('\n');
    let _ = stdout.write_all(line.as_bytes()).await;
    let _ = stdout.flush().await;
}

fn tool_definitions() -> Result<Value, String> {
    let tools = mcp::tools()
        .iter()
        .map(|spec| {
            let schema: Value = serde_json::from_str(spec.schema)
                .map_err(|error| format!("{}: invalid inputSchema: {error}", spec.name))?;
            Ok(json!({
                "name": spec.name,
                "description": spec.description,
                "inputSchema": schema,
            }))
        })
        .collect::<Result<Vec<Value>, String>>()?;
    Ok(Value::Array(tools))
}

#[cfg(test)]
mod root_tests {
    use super::inject_root;
    use serde_json::json;

    #[test]
    fn injects_cwd_as_soft_root() {
        let arguments = json!({ "bug_id": "1" });
        let injected = inject_root(&arguments, Some("/repo/app"));
        assert_eq!(injected["root"], "/repo/app");
        assert_eq!(injected["rootSource"], "cwd");
        assert_eq!(injected["bug_id"], "1");
    }

    #[test]
    fn explicit_root_wins() {
        let arguments = json!({ "root": "/other/repo" });
        let injected = inject_root(&arguments, Some("/repo/app"));
        assert_eq!(injected["root"], "/other/repo");
        assert!(injected.get("rootSource").is_none());
    }

    #[test]
    fn empty_arguments_become_a_root_hint() {
        let injected = inject_root(&serde_json::Value::Null, Some("/repo/app"));
        assert_eq!(injected["root"], "/repo/app");
    }

    #[test]
    fn missing_cwd_or_scalar_arguments_are_untouched() {
        let arguments = json!({ "bug_id": "1" });
        assert_eq!(inject_root(&arguments, None), arguments);
        let scalar = json!("bad");
        assert_eq!(inject_root(&scalar, Some("/repo")), scalar);
    }
}

#[cfg(test)]
mod manifest_tests {
    use super::tool_definitions;
    use tapd_core::mcp;

    #[test]
    fn tools_list_is_rendered_from_the_shared_manifest() {
        let definitions = tool_definitions().expect("manifest schemas must parse");
        let tools = definitions.as_array().expect("tools/list returns an array");

        assert_eq!(tools.len(), mcp::tools().len());
        for (definition, spec) in tools.iter().zip(mcp::tools()) {
            assert_eq!(definition["name"], spec.name);
            assert_eq!(definition["description"], spec.description);
            assert_eq!(definition["inputSchema"]["type"], "object");
            assert_eq!(
                definition["inputSchema"],
                serde_json::from_str::<serde_json::Value>(spec.schema).unwrap()
            );
        }
    }
}
