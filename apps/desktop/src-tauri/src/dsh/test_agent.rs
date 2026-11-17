//! i18n-exempt: scripted model replies for a debug-only fixture, not UI copy.
//!
//! A fake model provider, debug builds only.
//!
//! `TestAgent` is a local OpenAI-compatible endpoint served by the app's own
//! API server, so the runtime talks to it exactly like a real gateway: same
//! protocol, same tool loop, same streaming. The replies are scripted rather
//! than generated, which makes it the fixture for exercising the whole UI.
//!
//! Which script runs is chosen from the prompt:
//!
//! ```text
//! /test all        reasoning + text + file tools + bash + a user question (default)
//! /test text       text only
//! /test reasoning  reasoning then text
//! /test files      write → read → edit → read, all under <workspace>/tmp/test-agent
//! /test tools      every safe built-in tool once
//! /test ask        only the user question
//! /test error      a tool that fails, to see the error path
//! /test long       a long reply, for scrolling and performance
//! /test ping       the TAPD bridge tool
//! ```
//!
//! A second turn (the request ends with tool results) always answers with a
//! short text and no tool calls, so the loop terminates.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use axum::{
    body::{Body, Bytes},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::agent_settings::{
    AgentConfig, DshModelEntry, DshProvider, ReasoningEffort,
};

/// Provider key in the rendered profile (`providers.test-agent`).
pub const PROVIDER_ID: &str = "test-agent";
/// The one model this provider serves.
pub const MODEL_ID: &str = "TestAgent";
/// Where the file scripts work, relative to the session's working directory.
/// Relative on purpose: the session sandbox only allows writes inside it.
const TEST_DIR: &str = "tmp/test-agent";
/// Pause between streamed chunks, so the UI's incremental rendering is visible.
const CHUNK_DELAY: Duration = Duration::from_millis(25);
/// Characters per streamed text chunk.
const CHUNK_CHARS: usize = 6;

/// Local API port, learned when the server binds. The provider entry needs it
/// before settings are loaded (the profile is rendered from those settings).
static PORT: AtomicU16 = AtomicU16::new(0);

/// Records the port the fake endpoint is reachable on.
pub fn set_port(port: u16) {
    PORT.store(port, Ordering::Relaxed);
}

/// The port, once the local API server is listening.
pub fn port() -> Option<u16> {
    match PORT.load(Ordering::Relaxed) {
        0 => None,
        port => Some(port),
    }
}

/// Adds (or refreshes) the provider in the settings the runtime is about to
/// render. The port moves on every launch, so the base URL is always rewritten.
pub fn inject(config: &mut AgentConfig, port: u16) {
    config.dsh_models.providers.retain(|item| item.id != PROVIDER_ID);
    config.dsh_models.providers.push(DshProvider {
        id: PROVIDER_ID.to_string(),
        name: "TestAgent".to_string(),
        base_url: format!("http://127.0.0.1:{port}/test-agent/v1"),
        protocol: "openai-completions".to_string(),
        api_key: "test-agent".to_string(),
        enabled: true,
        models: vec![DshModelEntry {
            id: MODEL_ID.to_string(),
            context_window: 128_000,
            max_tokens: Some(8_192),
            input: vec!["text".to_string()],
            reasoning: vec![ReasoningEffort {
                level: "low".to_string(),
                wire: "low".to_string(),
            }],
            enabled: true,
        }],
    });
}

// ---------------------------------------------------------------------------
// HTTP surface (OpenAI chat completions)
// ---------------------------------------------------------------------------

/// `POST /test-agent/v1/chat/completions`.
pub async fn completions(Json(request): Json<Value>) -> Response {
    // A request that already carries tool results is the second turn: answer in
    // words, or the runtime would call the same tools forever.
    let second_turn = matches!(
        request["messages"].as_array().and_then(|list| list.last()),
        Some(last) if last["role"] == "tool"
    );
    let scenario = scenario_for(&request);
    let events = if second_turn {
        vec![Event::Text(summary(scenario))]
    } else {
        script(scenario, &request)
    };

    let streaming = request["stream"].as_bool().unwrap_or(false);
    if !streaming {
        return Json(json!({
            "id": "test-agent",
            "object": "chat.completion",
            "model": MODEL_ID,
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": plain_text(&events) },
                "finish_reason": "stop",
            }],
        }))
        .into_response();
    }

    let body = sse_body(&events);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// One scripted piece of a reply.
enum Event {
    Reasoning(String),
    Text(String),
    Tool { name: String, args: Value },
}

/// Replays the script as OpenAI streaming chunks, one word-ish piece at a time.
fn sse_body(
    events: &[Event],
) -> impl futures_util::Stream<Item = Result<Bytes, std::convert::Infallible>> + Send + 'static {
    let chunks = sse_chunks(events);
    futures_util::stream::unfold(chunks.into_iter(), |mut rest| async move {
        let next = rest.next()?;
        tokio::time::sleep(CHUNK_DELAY).await;
        Some((Ok::<_, std::convert::Infallible>(Bytes::from(next)), rest))
    })
}

/// The exact bytes dsh streams through: one `data:` frame per delta.
fn sse_chunks(events: &[Event]) -> Vec<String> {
    let mut chunks: Vec<String> = vec![chunk(json!({ "role": "assistant", "content": "" }), None)];
    let mut finish = "stop";
    let mut tool_index = 0;

    for event in events {
        match event {
            Event::Reasoning(text) => {
                for piece in split(text) {
                    chunks.push(chunk(json!({ "reasoning_content": piece }), None));
                }
            }
            Event::Text(text) => {
                for piece in split(text) {
                    chunks.push(chunk(json!({ "content": piece }), None));
                }
            }
            Event::Tool { name, args } => {
                finish = "tool_calls";
                let call = json!([{
                    "index": tool_index,
                    "id": format!("call_test_{tool_index}"),
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": args.to_string(),
                    },
                }]);
                tool_index += 1;
                chunks.push(chunk(json!({ "tool_calls": call }), None));
            }
        }
    }

    chunks.push(chunk(json!({}), Some(finish)));
    chunks.push(format!(
        "data: {}\n\n",
        json!({
            "id": "test-agent",
            "object": "chat.completion.chunk",
            "model": MODEL_ID,
            "choices": [],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 },
        })
    ));
    chunks.push("data: [DONE]\n\n".to_string());
    chunks
}

fn chunk(delta: Value, finish: Option<&str>) -> String {
    format!(
        "data: {}\n\n",
        json!({
            "id": "test-agent",
            "object": "chat.completion.chunk",
            "model": MODEL_ID,
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
        })
    )
}

/// Splits on character boundaries so multi-byte text is never cut mid-glyph.
fn split(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    chars
        .chunks(CHUNK_CHARS)
        .map(|piece| piece.iter().collect())
        .collect()
}

fn plain_text(events: &[Event]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            Event::Text(text) => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scenario {
    All,
    Text,
    Reasoning,
    Files,
    Tools,
    Ask,
    Error,
    Long,
    Ping,
}

/// Only an explicit `/test <name>` picks a script.
///
/// Runtime-injected context also arrives as a `user` message — it mentions
/// "Ask the user to clarify…" and "Current working directory", so any keyword
/// matching would fire on it and the choice would never reach the model. The
/// newest command in the conversation wins.
fn scenario_for(request: &Value) -> Scenario {
    for text in user_texts(request, 4) {
        let tokens: Vec<&str> = text.split_whitespace().collect();
        if let Some(position) = tokens.iter().position(|token| *token == "/test") {
            if let Some(scenario) = tokens.get(position + 1).and_then(|token| parse(token)) {
                return scenario;
            }
        }
    }
    Scenario::All
}

fn parse(token: &str) -> Option<Scenario> {
    Some(match token.trim_matches(|c: char| !c.is_ascii_alphanumeric()) {
        "all" => Scenario::All,
        "text" => Scenario::Text,
        "reasoning" => Scenario::Reasoning,
        "files" | "file" => Scenario::Files,
        "tools" | "tool" => Scenario::Tools,
        "ask" | "choose" | "question" => Scenario::Ask,
        "error" => Scenario::Error,
        "long" => Scenario::Long,
        "ping" => Scenario::Ping,
        _ => return None,
    })
}

/// The newest `limit` user messages, newest first. dsh appends its own
/// context as `user` messages, so callers must not assume the last one is human.
fn user_texts(request: &Value, limit: usize) -> Vec<String> {
    let Some(messages) = request["messages"].as_array() else {
        return Vec::new();
    };
    messages
        .iter()
        .rev()
        .filter(|message| message["role"] == "user")
        .take(limit)
        .map(|message| match &message["content"] {
            Value::String(text) => text.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        })
        .collect()
}

const INTRO: &str = "你好，我是 TestAgent——客户端内置的测试模型，回复是脚本化的。\n\n\
可用指令：`/test all | text | reasoning | files | tools | ask | error | long | ping`，\
直接说「文件」「提问」「工具」也能选中对应脚本。\n\
文件脚本只动工作目录下的 `tmp/test-agent/`。\n";

fn script(scenario: Scenario, request: &Value) -> Vec<Event> {
    let available = available_tools(request);
    let mut events = Vec::new();
    match scenario {
        Scenario::Text => events.push(Event::Text(INTRO.to_string())),
        Scenario::Reasoning => {
            events.push(Event::Reasoning(
                "用户在测推理块的渲染。先确认场景，再给出结论：只有推理和正文，没有工具调用。"
                    .to_string(),
            ));
            events.push(Event::Text(INTRO.to_string()));
        }
        Scenario::Long => {
            events.push(Event::Text(long_text()));
        }
        Scenario::Ask => {
            events.push(Event::Text("这次只发起一次提问，不调用其它工具。".to_string()));
            push_question(&mut events, &available);
        }
        Scenario::Ping => {
            events.push(Event::Text("调用 TAPD 桥接工具。".to_string()));
            push_tool(&mut events, &available, "tapd_ping", json!({}));
        }
        Scenario::Error => {
            events.push(Event::Text("下面这条命令会失败，用来看错误渲染。".to_string()));
            push_tool(
                &mut events,
                &available,
                "bash",
                json!({ "description": "故意失败", "command": "echo boom >&2; exit 3" }),
            );
        }
        Scenario::Files => {
            events.push(Event::Text(
                "走一遍文件生命周期：新建 → 读取 → 编辑 → 再读。".to_string(),
            ));
            push_files(&mut events, &available);
        }
        Scenario::Tools => {
            events.push(Event::Text("把安全的内置工具各调用一次。".to_string()));
            push_files(&mut events, &available);
            push_tool(
                &mut events,
                &available,
                "bash",
                json!({ "description": "查看测试目录", "command": "ls -la tmp/test-agent" }),
            );
            push_tool(
                &mut events,
                &available,
                "glob",
                json!({ "pattern": "tmp/test-agent/*" }),
            );
            push_tool(
                &mut events,
                &available,
                "grep",
                json!({ "pattern": "TestAgent", "path": "tmp/test-agent" }),
            );
            push_tool(
                &mut events,
                &available,
                "todo_write",
                json!({ "todos": [
                    { "content": "新建测试文件", "status": "completed" },
                    { "content": "读取并编辑测试文件", "status": "completed" },
                    { "content": "查看目录与内容检索", "status": "in_progress" },
                ]}),
            );
            push_tool(
                &mut events,
                &available,
                "working_directory",
                json!({}),
            );
        }
        Scenario::All => {
            events.push(Event::Reasoning(
                "用户没有指定脚本，走完整路径：先推理，再说明，然后文件四连、一条命令，最后问一个问题。"
                    .to_string(),
            ));
            events.push(Event::Text(INTRO.to_string()));
            push_files(&mut events, &available);
            push_tool(
                &mut events,
                &available,
                "bash",
                json!({ "description": "查看测试目录", "command": "ls -la tmp/test-agent" }),
            );
            push_question(&mut events, &available);
        }
    }
    events
}

/// `write → read → edit → read`, all inside [`TEST_DIR`].
fn push_files(events: &mut Vec<Event>, available: &HashSet<String>) {
    let file = format!("{TEST_DIR}/hello.txt");
    push_tool(
        events,
        available,
        "write",
        json!({ "file_path": file, "content": "hello from TestAgent\nsecond line\n" }),
    );
    push_tool(events, available, "read", json!({ "file_path": file }));
    push_tool(
        events,
        available,
        "edit",
        json!({ "file_path": file, "old_string": "hello from TestAgent", "new_string": "hello from TestAgent (edited)" }),
    );
    push_tool(events, available, "read", json!({ "file_path": file }));
}

fn push_question(events: &mut Vec<Event>, available: &HashSet<String>) {
    push_tool(
        events,
        available,
        "ask_user_question",
        json!({ "questions": [{
            "id": "test-agent-mode",
            "header": "测试选择",
            "question": "接下来用哪种方式继续？",
            "multiSelect": false,
            "options": [
                { "label": "再看一次文件示例", "description": "重新新建、读取、编辑 tmp/test-agent/hello.txt" },
                { "label": "只回文字", "description": "下一轮只输出正文" },
                { "label": "结束", "description": "不再执行任何工具" },
            ],
        }]}),
    );
}

/// Keeps a call only when this session actually offers that tool, so the same
/// script works with or without the TAPD bridge and team tools.
fn push_tool(events: &mut Vec<Event>, available: &HashSet<String>, name: &str, args: Value) {
    if available.contains(name) {
        events.push(Event::Tool {
            name: name.to_string(),
            args,
        });
    }
}

fn available_tools(request: &Value) -> HashSet<String> {
    request["tools"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|tool| {
                    tool.pointer("/function/name")
                        .or_else(|| tool.get("name"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn summary(scenario: Scenario) -> String {
    let hint = match scenario {
        Scenario::All => "文件与命令都执行完了。换个脚本可以看其它形态：`/test text`、`/test error`、`/test long`。",
        Scenario::Files => "文件四连执行完了，内容都在 `tmp/test-agent/hello.txt`。",
        Scenario::Tools => "内置工具调用完了，看工具行的折叠结果即可。",
        Scenario::Error => "上面那条命令按预期失败了。",
        Scenario::Ping => "桥接工具调用完了。",
        _ => "这一轮结束。",
    };
    format!("第二轮（工具结果回传后）的收尾回复：没有新的工具调用。{hint}")
}

fn long_text() -> String {
    let mut out = String::from("下面是长文本，用来看滚动与渲染性能：\n\n");
    for index in 1..=40 {
        out.push_str(&format!(
            "{index:02}. TestAgent 的第 {index} 段文本，包含中英文混排 and some ASCII, 以及一个很长的词 supercalifragilisticexpialidocious。\n"
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(prompt: &str) -> Value {
        json!({
            "stream": true,
            "messages": [{ "role": "user", "content": prompt }],
            "tools": [
                { "type": "function", "function": { "name": "write" } },
                { "type": "function", "function": { "name": "read" } },
                { "type": "function", "function": { "name": "edit" } },
                { "type": "function", "function": { "name": "bash" } },
                { "type": "function", "function": { "name": "ask_user_question" } },
            ],
        })
    }

    #[test]
    fn a_command_selects_the_script() {
        assert!(scenario_for(&request("/test files 开始")) == Scenario::Files);
        assert!(scenario_for(&request("请 /test ask 一下")) == Scenario::Ask);
        assert!(scenario_for(&request("随便说点什么")) == Scenario::All);
        assert!(scenario_for(&request("/test bogus")) == Scenario::All);
        // Words like 文件 only mean something after an explicit command.
        assert!(scenario_for(&request("帮我看看文件")) == Scenario::All);
    }

    #[test]
    fn injected_context_never_picks_the_script() {
        // dsh appends its own context as user messages, including "Ask the
        // user to clarify…"; scenario selection must ignore it.
        let mut with_context = request("/test files");
        with_context["messages"] = json!([
            { "role": "user", "content": "/test files" },
            { "role": "user", "content": "<system-reminder>Current working directory: /tmp</system-reminder>" },
            { "role": "user", "content": "Time sampled while preparing turn 1, step 1: 2026-11-17. Ask the user to clarify otherwise-unqualified dates." },
            { "role": "assistant", "content": "ok" },
            { "role": "tool", "content": "{}" },
        ]);
        assert!(scenario_for(&with_context) == Scenario::Files);
    }

    #[test]
    fn the_default_script_covers_every_reply_kind() {
        let events = script(Scenario::All, &request("hi"));
        assert!(events.iter().any(|event| matches!(event, Event::Reasoning(_))));
        assert!(events.iter().any(|event| matches!(event, Event::Text(_))));
        let tools: Vec<&str> = events
            .iter()
            .filter_map(|event| match event {
                Event::Tool { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(tools, ["write", "read", "edit", "read", "bash", "ask_user_question"]);
    }

    #[test]
    fn file_scripts_stay_inside_the_workspace_tmp_dir() {
        let events = script(Scenario::Files, &request("files"));
        for event in &events {
            if let Event::Tool { args, .. } = event {
                let path = args["file_path"].as_str().expect("file tools carry a path");
                assert!(path.starts_with(TEST_DIR), "unexpected path {path}");
            }
        }
    }

    #[test]
    fn tools_the_session_lacks_are_skipped() {
        let mut bare = request("ping");
        bare["tools"] = json!([]);
        // The prose still streams; only the call itself is dropped.
        assert!(!script(Scenario::Ping, &bare)
            .iter()
            .any(|event| matches!(event, Event::Tool { .. })));
        assert!(available_tools(&request("x")).contains("bash"));
    }

    #[test]
    fn the_default_script_streams_every_reply_kind() {
        let frames = sse_chunks(&script(Scenario::All, &request("hi")));
        let body = frames.join("");
        assert!(body.contains("\"reasoning_content\""));
        assert!(body.contains("\"content\""));
        // Six deltas, plus the `finish_reason` value (asserted below).
        assert_eq!(body.matches("\"tool_calls\":[").count(), 6);
        assert!(body.contains("\"finish_reason\":\"tool_calls\""));
        assert!(body.trim_end().ends_with("data: [DONE]"));
        // Tool arguments are sent as the JSON string the protocol expects.
        assert!(body.contains("tmp/test-agent/hello.txt"));
    }

    #[test]
    fn a_plain_reply_finishes_with_stop() {
        let body = sse_chunks(&script(Scenario::Text, &request("hi"))).join("");
        assert!(body.contains("\"finish_reason\":\"stop\""));
        assert!(!body.contains("tool_calls"));
    }

    #[test]
    fn text_streams_in_character_sized_pieces() {
        let pieces = split("你好世界");
        assert_eq!(pieces.len(), 1);
        assert_eq!(split("你好世界你好世界").len(), 2);
        // Multi-byte text is never cut mid-glyph.
        assert!(split("你好世界hello").iter().all(|piece| !piece.is_empty()));
    }
}
