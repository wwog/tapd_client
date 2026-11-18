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
//! /test e2e        the whole product flow across several turns (see below)
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
//!
//! `/test e2e` is the one-prompt tour of every UI surface. It stretches over
//! several turns: plan + todo list, the file lifecycle plus a failing command,
//! two dispatched subagents (whose settlement notices start the next turns on
//! their own), a final todo check-off and a user question. The stage is read
//! from the conversation history, so the same command keeps driving the flow
//! no matter how many turns it takes.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
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

/// Monotonic call id suffix. Real providers never reuse a call id, and the
/// client store keys tool rows by it; a scripted reply must not collide with
/// the previous step's ids either.
static CALL_SEQ: AtomicU64 = AtomicU64::new(0);

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
    // The e2e flow owns its whole conversation, tool results included: its
    // stage machine reads the history instead of the one shortcut below.
    let events = if scenario == Scenario::E2e {
        e2e_script(&request)
    } else if second_turn {
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
                let call_seq = CALL_SEQ.fetch_add(1, Ordering::Relaxed);
                let call = json!([{
                    "index": tool_index,
                    "id": format!("call_test_{call_seq}_{tool_index}"),
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
    /// One prompt, several turns: todo plan → file lifecycle with a failing
    /// command → two subagents whose settlement notices start the next turns
    /// → final check-off and a user question.
    E2e,
    Text,
    Reasoning,
    Files,
    Tools,
    Ask,
    Error,
    Long,
    Ping,
    /// Spawns three subagents, each with a different job.
    Agents,
    // Child scripts. A child never spawns further agents, so the tree stops.
    ChildFiles,
    ChildCurl,
    ChildGrep,
}

/// Only an explicit `/test <name>` picks a script.
///
/// Runtime-injected context also arrives as a `user` message — it mentions
/// "Ask the user to clarify…" and "Current working directory", so any keyword
/// matching would fire on it and the choice would never reach the model. The
/// newest command in the conversation wins.
///
/// `/test e2e` additionally latches: its later turns are started by settlement
/// notices (no new command), so the whole history is scanned for it after the
/// newest-command window. Any `/test` in the newest window still wins.
fn scenario_for(request: &Value) -> Scenario {
    for text in user_texts(request, 4) {
        // A delegated prompt carries its own job tag; it never has `/test`.
        if let Some(child) = child_marker(&text) {
            return child;
        }
        let tokens: Vec<&str> = text.split_whitespace().collect();
        if let Some(position) = tokens.iter().position(|token| *token == "/test") {
            if let Some(scenario) = tokens.get(position + 1).and_then(|token| parse(token)) {
                return scenario;
            }
        }
    }
    if user_texts(request, 200)
        .iter()
        .any(|text| text.contains("/test e2e"))
    {
        return Scenario::E2e;
    }
    Scenario::All
}

/// The job tag a delegated prompt carries, e.g. `[test-child:curl]`.
fn child_marker(text: &str) -> Option<Scenario> {
    let lower = text.to_lowercase();
    if lower.contains("[test-child:files]") {
        return Some(Scenario::ChildFiles);
    }
    if lower.contains("[test-child:curl]") {
        return Some(Scenario::ChildCurl);
    }
    if lower.contains("[test-child:grep]") {
        return Some(Scenario::ChildGrep);
    }
    None
}

fn parse(token: &str) -> Option<Scenario> {
    Some(match token.trim_matches(|c: char| !c.is_ascii_alphanumeric()) {
        "all" => Scenario::All,
        "e2e" | "flow" => Scenario::E2e,
        "text" => Scenario::Text,
        "reasoning" => Scenario::Reasoning,
        "files" | "file" => Scenario::Files,
        "tools" | "tool" => Scenario::Tools,
        "ask" | "choose" | "question" => Scenario::Ask,
        "error" => Scenario::Error,
        "long" => Scenario::Long,
        "ping" => Scenario::Ping,
        "agents" | "agent" | "subagent" => Scenario::Agents,
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
可用指令：`/test all | e2e | text | reasoning | files | tools | ask | agents | error | long | ping`。\n\
`e2e` 是全流程演示：一条指令跑多轮（todo 计划 → 文件与失败命令 → 派子 agent → 汇总与提问）。\n\
`agents` 会派三个子 agent，分别做文件查找、curl 请求与内容检索。\n\
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
            events.push(Event::Text("调用任务提交工具。".to_string()));
            push_tool(
                &mut events,
                &available,
                "task_submit",
                json!({
                    "summary": "测试模型提交了一个任务",
                    "verification": "无",
                    "risks": "无"
                }),
            );
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
        Scenario::Agents => {
            events.push(Event::Reasoning(
                "用户要测子 agent。先落一个文件给它们用，然后派三个各做一件事：文件查找、curl 请求、内容检索；最后等它们回来。"
                    .to_string(),
            ));
            events.push(Event::Text(
                "派三个子 agent：一个找文件、一个发 curl 请求、一个做内容检索。它们的回复在任务轨迹里能看到。\n"
                    .to_string(),
            ));
            push_tool(
                &mut events,
                &available,
                "write",
                json!({ "file_path": format!("{TEST_DIR}/hello.txt"), "content": "hello from TestAgent\nsecond line\n" }),
            );
            for (description, prompt) in child_jobs() {
                push_tool(
                    &mut events,
                    &available,
                    "subagent",
                    json!({ "description": description, "prompt": prompt }),
                );
            }
            push_tool(
                &mut events,
                &available,
                "wait_agent",
                json!({ "timeout_ms": 90_000 }),
            );
        }
        // Children do one focused job and report; they never delegate again.
        Scenario::ChildFiles => {
            events.push(Event::Text(
                "子 agent A：在测试目录里找文件，读第一个并汇报。".to_string(),
            ));
            push_tool(
                &mut events,
                &available,
                "glob",
                json!({ "pattern": format!("{TEST_DIR}/*") }),
            );
            push_tool(
                &mut events,
                &available,
                "read",
                json!({ "file_path": format!("{TEST_DIR}/hello.txt") }),
            );
        }
        Scenario::ChildCurl => {
            events.push(Event::Text(
                "子 agent B：用 curl 请求本机接口，把响应前 200 字节汇报。".to_string(),
            ));
            // The mock's own port: a deterministic target that needs no network.
            let port = port().unwrap_or(0);
            push_tool(
                &mut events,
                &available,
                "bash",
                json!({
                    "description": "curl 本机接口",
                    "command": format!("curl -s -m 5 http://127.0.0.1:{port}/healthz | head -c 200"),
                }),
            );
        }
        Scenario::ChildGrep => {
            events.push(Event::Text(
                "子 agent C：在测试目录里检索 TestAgent 并汇报匹配行。".to_string(),
            ));
            push_tool(
                &mut events,
                &available,
                "grep",
                json!({ "pattern": "TestAgent", "path": TEST_DIR }),
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
        // The e2e flow never enters this dispatcher: `completions` routes it to
        // the stage machine (`e2e_script`) before any per-script match runs.
        Scenario::E2e => unreachable!("e2e is routed to e2e_script in completions"),
    }
    events
}

/// The three delegated jobs, each with a distinct skill. The tag is what makes
/// the child pick its own script.
fn child_jobs() -> Vec<(&'static str, String)> {
    let dir = TEST_DIR;
    vec![
        (
            "查找测试文件",
            format!(
                "[test-child:files] 用 glob 在 {dir} 下找出所有文件，读第一个，用两行汇报文件名与第一行内容。"
            ),
        ),
        (
            "curl 本机接口",
            format!(
                "[test-child:curl] 用 bash 执行 curl 请求本机健康检查接口，把响应前 200 字节原样汇报。目录 {dir} 与本任务无关。"
            ),
        ),
        (
            "检索关键词",
            format!(
                "[test-child:grep] 用 grep 在 {dir} 里搜索 TestAgent，把匹配到的行汇报；没有匹配也要说明。"
            ),
        ),
    ]
}

// ---------------------------------------------------------------------------
// The e2e flow: one command, several turns
// ---------------------------------------------------------------------------

/// The settlement notice dsh injects when a background child finishes. The
/// leading words come from the runtime itself (`continuation-messages.ts`), so
/// matching the prefix is stable across stop reasons.
const NOTICE_MARKER: &str = "Background subagent";

/// The deliberately failing command of turn two, recognizable in history by
/// its own description (the args are what the model produced, so the
/// description travels with the call).
const FAIL_MARKER: &str = "故意失败";

/// Text of the settle turns (a child notice arrived). Tool-free on purpose:
/// every tool call re-enters the loop, and the stage machine has nothing left
/// to do until the next notice.
const SETTLE_TEXT: &str = "收到一个子 agent 的完成通知（notice 已并进上方「子 agent」折叠组）。等其余子 agent 回来后我会汇总收尾。";

/// Closing text after the dispatch results came back: the turn ends here and
/// the children's settlement notices start the following turns on their own.
const DISPATCHED_TEXT: &str = "两个子 agent 已派出（tool 行里能看到 started）。本轮到此结束——它们完成时会各自动开启新轮次，无需你再发消息。";

/// Closing text once the final question was answered (or the user speaks up
/// afterwards): the tour is over.
const FLOW_DONE_TEXT: &str = "全流程演示结束：todo 计划与勾选、文件生命周期、成功与失败的命令、子 agent 派发与完成通知、提问与回答都已覆盖。想单独看某一类可再试 `/test text`、`/test agents`、`/test error`。";

/// The stage machine behind `/test e2e`. Every branch is chosen from the
/// conversation history alone, so the flow survives restarts of neither state
/// nor order: it simply reads what already happened.
fn e2e_script(request: &Value) -> Vec<Event> {
    let available = available_tools(request);
    let mut events = Vec::new();

    let messages = request["messages"].as_array();
    let notices = messages
        .map(|list| {
            list.iter()
                .filter(|message| message["role"] == "user")
                .filter(|message| message_text(message).contains(NOTICE_MARKER))
                .count()
        })
        .unwrap_or(0);
    let last_is_tool = matches!(messages.and_then(|list| list.last()), Some(last) if last["role"] == "tool");
    let dispatched = has_tool_call(request, |name, _| name == "subagent");
    let failed_ran = has_tool_call(request, |name, args| name == "bash" && args.contains(FAIL_MARKER));
    // The final turn announces itself in prose (todo_write/ask_user_question
    // are shared with other scripts, so tool names cannot mark the stage).
    let finalized = messages
        .map(|list| {
            list.iter().any(|message| {
                message["role"] == "assistant"
                    && message_text(message).contains("最后把 todo 勾完")
            })
        })
        .unwrap_or(false);

    if notices >= 2 {
        // All children settled. The question's result arriving (or the final
        // turn already spoken, or any later human input) closes the tour;
        // anything else is the final turn: check the list off and ask.
        if last_is_tool || finalized {
            events.push(Event::Text(FLOW_DONE_TEXT.to_string()));
        } else {
            events.push(Event::Text(
                "两个子 agent 都回来了，全部范畴已覆盖。最后把 todo 勾完，并发起一次提问收尾。".to_string(),
            ));
            push_tool(
                &mut events,
                &available,
                "todo_write",
                json!({ "todos": [
                    { "content": "梳理测试范畴并写计划", "status": "completed" },
                    { "content": "文件生命周期四连", "status": "completed" },
                    { "content": "成功与失败的命令", "status": "completed" },
                    { "content": "派发两个子 agent", "status": "completed" },
                    { "content": "汇总收尾与提问", "status": "completed" },
                ]}),
            );
            push_question(&mut events, &available);
        }
        return events;
    }

    if notices == 1 {
        events.push(Event::Text(SETTLE_TEXT.to_string()));
        return events;
    }

    if dispatched {
        // The dispatch results ("started subagent …") came back: end the turn.
        events.push(Event::Text(DISPATCHED_TEXT.to_string()));
        return events;
    }

    if failed_ran && last_is_tool {
        // The file lifecycle and both commands already ran: dispatch children
        // next. No wait_agent here — the settlement notices must open the
        // following turns for the fold to be visible.
        events.push(Event::Text(
            "文件与命令都执行完了（含一条故意失败的命令）。现在派两个子 agent：一个找文件、一个 curl 本机接口。".to_string(),
        ));
        push_tool(
            &mut events,
            &available,
            "todo_write",
            json!({ "todos": [
                { "content": "梳理测试范畴并写计划", "status": "completed" },
                { "content": "文件生命周期四连", "status": "completed" },
                { "content": "成功与失败的命令", "status": "completed" },
                { "content": "派发两个子 agent", "status": "in_progress" },
                { "content": "汇总收尾与提问", "status": "pending" },
            ]}),
        );
        for (description, prompt) in child_jobs().into_iter().take(2) {
            push_tool(
                &mut events,
                &available,
                "subagent",
                json!({ "description": description, "prompt": prompt }),
            );
        }
        return events;
    }

    if last_is_tool {
        // The plan's todo_write came back: run the file lifecycle plus one
        // succeeding and one deliberately failing command.
        events.push(Event::Text(
            "继续：文件生命周期四连，外加一条成功命令与一条故意失败的命令。".to_string(),
        ));
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
            "bash",
            json!({ "description": FAIL_MARKER, "command": "echo boom >&2; exit 3" }),
        );
        return events;
    }

    // A fresh prompt: reason, explain, and write the plan. The todo_write
    // result re-enters the machine above.
    events.push(Event::Reasoning(
        "全流程演示。分几轮走：先落 todo 计划；然后文件生命周期和两条命令（一条故意失败）；再派两个子 agent 并结束本轮，让它们的完成通知自动开启后续轮次；最后勾完 todo 并提问。"
            .to_string(),
    ));
    events.push(Event::Text(
        "全流程演示开始（/test e2e）：我会分几轮覆盖 todo、文件、命令、子 agent 和提问。先落计划。".to_string(),
    ));
    push_tool(
        &mut events,
        &available,
        "todo_write",
        json!({ "todos": [
            { "content": "梳理测试范畴并写计划", "status": "completed" },
            { "content": "文件生命周期四连", "status": "in_progress" },
            { "content": "成功与失败的命令", "status": "pending" },
            { "content": "派发两个子 agent", "status": "pending" },
            { "content": "汇总收尾与提问", "status": "pending" },
        ]}),
    );
    events
}

/// One assistant tool call in the history matching `pred`. Tool calls travel
/// as `function.name` + `function.arguments` (a JSON *string*).
fn has_tool_call(request: &Value, mut pred: impl FnMut(&str, &str) -> bool) -> bool {
    request["messages"]
        .as_array()
        .map(|list| {
            list.iter().any(|message| {
                message["role"] == "assistant"
                    && message["tool_calls"].as_array().is_some_and(|calls| {
                        calls.iter().any(|call| {
                            let name = call
                                .pointer("/function/name")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            let args = call
                                .pointer("/function/arguments")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            pred(name, args)
                        })
                    })
            })
        })
        .unwrap_or(false)
}

/// The text of one wire message, whether the provider sent a string or the
/// content-parts array.
fn message_text(message: &Value) -> String {
    match &message["content"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
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
        Scenario::Ping => "任务提交工具调用完了。",
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
                { "type": "function", "function": { "name": "glob" } },
                { "type": "function", "function": { "name": "grep" } },
                { "type": "function", "function": { "name": "todo_write" } },
                { "type": "function", "function": { "name": "subagent" } },
                { "type": "function", "function": { "name": "wait_agent" } },
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

    fn tools_of(events: &[Event]) -> Vec<(String, Value)> {
        events
            .iter()
            .filter_map(|event| match event {
                Event::Tool { name, args } => Some((name.clone(), args.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_agents_script_delegates_three_distinct_jobs() {
        let events = script(Scenario::Agents, &request("/test agents"));
        let calls = tools_of(&events);
        let prompts: Vec<&str> = calls
            .iter()
            .filter(|(name, _)| name == "subagent")
            .map(|(_, args)| args["prompt"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(prompts.len(), 3);
        assert!(prompts[0].contains("[test-child:files]"));
        assert!(prompts[1].contains("[test-child:curl]"));
        assert!(prompts[2].contains("[test-child:grep]"));
        // The parent waits for them instead of ending the turn blind.
        assert!(calls.iter().any(|(name, _)| name == "wait_agent"));
    }

    #[test]
    fn a_delegated_prompt_picks_its_own_job_and_never_delegates_again() {
        assert!(scenario_for(&request("[test-child:files] 找文件")) == Scenario::ChildFiles);
        assert!(scenario_for(&request("[test-child:curl] 请求")) == Scenario::ChildCurl);
        assert!(scenario_for(&request("[test-child:grep] 检索")) == Scenario::ChildGrep);
        for scenario in [Scenario::ChildFiles, Scenario::ChildCurl, Scenario::ChildGrep] {
            let calls = tools_of(&script(scenario, &request("child")));
            assert!(
                calls.iter().all(|(name, _)| name != "subagent"),
                "a child must not spawn agents"
            );
            assert!(!calls.is_empty());
        }
    }

    #[test]
    fn the_curl_child_targets_the_local_endpoint() {
        set_port(1234);
        let calls = tools_of(&script(Scenario::ChildCurl, &request("curl")));
        let command = calls[0].1["command"].as_str().unwrap_or_default();
        assert!(command.contains("127.0.0.1:1234/healthz"), "{command}");
    }

    // -- e2e stage machine --------------------------------------------------

    /// The standard tool surface, detached from any prompt.
    fn body_tools() -> Value {
        request("")["tools"].clone()
    }

    fn user_msg(text: &str) -> Value {
        json!({ "role": "user", "content": text })
    }

    fn assistant_tools(calls: Vec<(&str, Value)>) -> Value {
        json!({
            "role": "assistant",
            "content": "",
            "tool_calls": calls
                .into_iter()
                .enumerate()
                .map(|(index, (name, args))| json!({
                    "id": format!("call_{index}"),
                    "type": "function",
                    "function": { "name": name, "arguments": args.to_string() },
                }))
                .collect::<Vec<_>>(),
        })
    }

    fn tool_result() -> Value {
        json!({ "role": "tool", "content": "ok" })
    }

    fn notice(name: &str) -> Value {
        user_msg(&format!(
            "Background subagent {name} finished and will do no further work unless you send it more.\nIts closing message: done."
        ))
    }

    /// The full tour: plan → files+commands → dispatch → dispatch close →
    /// settle → final check-off + question → close. Every later request
    /// carries the whole history, exactly like the runtime sends it.
    #[test]
    fn the_e2e_flow_walks_every_stage() {
        let todo_plan = json!({ "todos": [{ "content": "梳理测试范畴并写计划", "status": "completed" }] });
        let mut messages = vec![user_msg("/test e2e 走一遍全流程")];

        // Turn 1a: reason + plan.
        let request = json!({ "stream": true, "messages": messages, "tools": body_tools() });
        let events = e2e_script(&request);
        assert!(events.iter().any(|event| matches!(event, Event::Reasoning(_))));
        let tools = tools_of(&events);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].0, "todo_write");
        assert!(tools[0].1["todos"].as_array().is_some());

        // Turn 1b: files + succeeding + failing command, no agents yet.
        messages.push(assistant_tools(vec![("todo_write", todo_plan.clone())]));
        messages.push(tool_result());
        let request = json!({ "stream": true, "messages": messages, "tools": body_tools() });
        let events = e2e_script(&request);
        let tools = tools_of(&events);
        let names: Vec<&str> = tools.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["write", "read", "edit", "read", "bash", "bash"]);
        assert!(tools[5].1["command"].as_str().unwrap_or_default().contains("echo boom"));

        // Turn 1c: progress todo + two tagged children, never wait_agent.
        messages.push(assistant_tools(vec![
            ("write", json!({ "file_path": "tmp/test-agent/hello.txt" })),
            ("bash", json!({ "description": "故意失败", "command": "echo boom >&2; exit 3" })),
        ]));
        messages.push(tool_result());
        let request = json!({ "stream": true, "messages": messages, "tools": body_tools() });
        let events = e2e_script(&request);
        let tools = tools_of(&events);
        let names: Vec<&str> = tools.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["todo_write", "subagent", "subagent"]);
        let prompts = tools
            .iter()
            .filter(|(name, _)| name == "subagent")
            .map(|(_, args)| args["prompt"].as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>();
        assert!(prompts[0].contains("[test-child:files]"));
        assert!(prompts[1].contains("[test-child:curl]"));
        assert!(!names.contains(&"wait_agent"));

        // Dispatch results came back: the turn ends in words only.
        messages.push(assistant_tools(vec![
            ("subagent", json!({ "description": "查找测试文件", "prompt": prompts[0].clone() })),
            ("subagent", json!({ "description": "curl 本机接口", "prompt": prompts[1].clone() })),
        ]));
        messages.push(tool_result());
        let request = json!({ "stream": true, "messages": messages, "tools": body_tools() });
        let events = e2e_script(&request);
        assert!(tools_of(&events).is_empty());
        assert!(events.iter().any(|event| matches!(event, Event::Text(text) if text.contains("本轮到此结束"))));

        // First settlement notice: a new turn, still tool-free.
        messages.push(notice("agent-1"));
        let request = json!({ "stream": true, "messages": messages, "tools": body_tools() });
        let events = e2e_script(&request);
        assert!(tools_of(&events).is_empty());

        // Second notice: check the list off and ask the closing question.
        messages.push(notice("agent-2"));
        let request = json!({ "stream": true, "messages": messages, "tools": body_tools() });
        let events = e2e_script(&request);
        let tools = tools_of(&events);
        let names: Vec<&str> = tools.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["todo_write", "ask_user_question"]);
        assert!(tools[0].1["todos"].as_array().is_some_and(|todos| todos
            .iter()
            .all(|todo| todo["status"] == "completed")));

        // The question was answered: the tour closes in words only.
        messages.push(assistant_tools(vec![("ask_user_question", json!({}))]));
        messages.push(tool_result());
        let request = json!({ "stream": true, "messages": messages, "tools": body_tools() });
        let events = e2e_script(&request);
        assert!(tools_of(&events).is_empty());
        assert!(events.iter().any(|event| matches!(event, Event::Text(text) if text.contains("全流程演示结束"))));
    }

    /// `/test e2e` survives settlement turns (no new command) but never
    /// outlives a newer `/test`.
    #[test]
    fn e2e_latches_from_history_until_a_newer_command() {
        let mut messages = vec![user_msg("/test e2e 开始"), user_msg("背景说明一"), user_msg("背景说明二"), user_msg("背景说明三"), user_msg("背景说明四"), user_msg("背景说明五")];
        let request = json!({ "stream": true, "messages": messages, "tools": body_tools() });
        assert!(scenario_for(&request) == Scenario::E2e);

        messages.push(user_msg("换个 /test text 看看"));
        let request = json!({ "stream": true, "messages": messages, "tools": body_tools() });
        assert!(scenario_for(&request) == Scenario::Text);
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
