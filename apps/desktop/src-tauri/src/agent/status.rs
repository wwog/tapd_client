//! 把各客户端原生 hook 的 payload 归一成 UI 可展示的运行时状态。
//!
//! 事件名来自不同 CLI：`Stop` / `stop` / `AfterAgent` / `agent_end` 都表示
//! 回合结束；`PreToolUse` / `preToolUse` / `BeforeTool` 都表示工具开始。
//! 这里只做名称归一和字段提取，不依赖具体客户端。

use serde_json::Value;

use super::{truncate_text, AgentRuntimePhase, AgentRuntimeStatus};

/// 一个 hook 事件归一化后的结果。
pub(super) struct HookActivity {
    /// 供 UI 展示的最新状态；未知事件为 None。
    pub(super) status: Option<AgentRuntimeStatus>,
    /// 本轮结束（Stop / AfterAgent / agent_end）。
    pub(super) complete: bool,
    /// 错误结束原因；有值时任务按失败收尾。
    pub(super) error: Option<String>,
}

pub(super) fn normalize(
    previous: Option<&AgentRuntimeStatus>,
    event: &str,
    payload: Option<&Value>,
    session_id: Option<&str>,
    now: &str,
    will_continue: bool,
    awaiting_async_work: bool,
) -> HookActivity {
    let key: String = event
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();

    let tool = tool_name(payload);
    let detail = tool_input(payload);
    let message = message_text(payload);
    let model = field_text(payload, &["model", "model_id", "modelID", "modelName"], 80);
    let subagents = previous.map(|status| status.subagents).unwrap_or(0);

    let mut activity = HookActivity {
        status: None,
        complete: false,
        error: None,
    };

    match key.as_str() {
        "sessionstart" | "sessioncreated" => {
            activity.status = Some(base(
                previous,
                AgentRuntimePhase::Idle,
                "会话已启动",
                session_id,
                model,
                now,
            ));
        }
        "agentstart" => {
            activity.status = Some(base(
                previous,
                AgentRuntimePhase::Working,
                "正在处理",
                session_id,
                model,
                now,
            ));
        }
        "beforeagent" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                "开始处理",
                session_id,
                model,
                now,
            );
            status.message = message;
            activity.status = Some(status);
        }
        "userpromptsubmit" | "promptadmitted" | "sessionnextpromptadmitted" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                "正在处理",
                session_id,
                model,
                now,
            );
            status.message = message.or_else(|| field_text(payload, &["prompt"], 200));
            activity.status = Some(status);
        }
        "pretooluse" | "beforetool" | "toolstart" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                tool_label(tool.as_deref()),
                session_id,
                model,
                now,
            );
            status.tool = tool;
            status.detail = detail;
            activity.status = Some(status);
        }
        "posttooluse" | "aftertool" | "toolend" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                "正在处理",
                session_id,
                model,
                now,
            );
            status.tool = tool.or_else(|| previous.and_then(|status| status.tool.clone()));
            status.detail = Some("工具已完成".to_string());
            activity.status = Some(status);
        }
        "posttoolusefailure" | "toolfailure" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                "工具执行失败",
                session_id,
                model,
                now,
            );
            status.tool = tool.or_else(|| previous.and_then(|status| status.tool.clone()));
            status.detail = message.or(detail);
            activity.status = Some(status);
        }
        "permissionrequest" | "permissionasked" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::WaitingPermission,
                "等待权限确认",
                session_id,
                model,
                now,
            );
            status.tool = tool;
            status.detail = detail;
            status.message = message;
            activity.status = Some(status);
        }
        "questionasked" | "notification" => {
            let waiting_permission =
                field_text(payload, &["notification_type", "notificationType"], 80)
                    .is_some_and(|kind| kind.contains("permission"));
            let mut status = base(
                previous,
                if waiting_permission {
                    AgentRuntimePhase::WaitingPermission
                } else {
                    AgentRuntimePhase::WaitingQuestion
                },
                if waiting_permission {
                    "等待权限确认"
                } else {
                    "等待用户回答"
                },
                session_id,
                model,
                now,
            );
            status.tool = tool;
            status.message = message;
            activity.status = Some(status);
        }
        "permissionreplied" | "permissionresolved" | "questionreplied" | "questionrejected"
        | "questionresolved" => {
            activity.status = Some(base(
                previous,
                AgentRuntimePhase::Working,
                "继续处理",
                session_id,
                model,
                now,
            ));
        }
        "subagentstart" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                "子 Agent 启动",
                session_id,
                model,
                now,
            );
            status.subagents = subagents.saturating_add(1);
            status.message = message
                .or_else(|| field_text(payload, &["subagent_type", "agent_type", "agentType"], 80));
            activity.status = Some(status);
        }
        "subagentstop" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                "子 Agent 结束",
                session_id,
                model,
                now,
            );
            status.subagents = subagents.saturating_sub(1);
            activity.status = Some(status);
        }
        "postcompact"
        | "precompact"
        | "turnstart"
        | "turnend"
        | "progress"
        | "sessionnextstepstarted" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                "正在处理",
                session_id,
                model,
                now,
            );
            status.message = message;
            activity.status = Some(status);
        }
        "agentturnend" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                "正在收尾",
                session_id,
                model,
                now,
            );
            status.message = message;
            activity.status = Some(status);
        }
        "afteragentresponse" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                "收到回复",
                session_id,
                model,
                now,
            );
            status.message = message;
            activity.status = Some(status);
        }
        "stop" | "afteragent" | "agentend" => {
            if will_continue || awaiting_async_work {
                let mut status = base(
                    previous,
                    AgentRuntimePhase::Working,
                    if will_continue {
                        "继续处理"
                    } else {
                        "等待后台任务"
                    },
                    session_id,
                    model,
                    now,
                );
                status.message = message;
                activity.status = Some(status);
            } else {
                let mut status = base(
                    previous,
                    AgentRuntimePhase::Idle,
                    "回合结束",
                    session_id,
                    model,
                    now,
                );
                status.message = message;
                activity.status = Some(status);
                activity.complete = true;
            }
        }
        "stopfailure" => {
            let error = message
                .clone()
                .unwrap_or_else(|| "Agent 回合失败".to_string());
            let mut status = base(
                previous,
                AgentRuntimePhase::Error,
                "回合失败",
                session_id,
                model,
                now,
            );
            status.message = Some(error.clone());
            activity.status = Some(status);
            activity.complete = true;
            activity.error = Some(error);
        }
        "sessionerror" | "error" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Error,
                "执行出错",
                session_id,
                model,
                now,
            );
            status.message = message;
            activity.status = Some(status);
        }
        "sessionend" => {
            activity.status = Some(base(
                previous,
                AgentRuntimePhase::Idle,
                "会话结束",
                session_id,
                model,
                now,
            ));
        }
        "interrupt" => {
            activity.status = Some(base(
                previous,
                AgentRuntimePhase::Idle,
                "已中断",
                session_id,
                model,
                now,
            ));
        }
        _ => {}
    }

    activity
}

fn base(
    previous: Option<&AgentRuntimeStatus>,
    phase: AgentRuntimePhase,
    label: &str,
    session_id: Option<&str>,
    model: Option<String>,
    now: &str,
) -> AgentRuntimeStatus {
    AgentRuntimeStatus {
        phase,
        label: label.to_string(),
        tool: None,
        detail: None,
        message: None,
        model: model.or_else(|| previous.and_then(|status| status.model.clone())),
        session_id: session_id
            .map(str::to_string)
            .or_else(|| previous.and_then(|status| status.session_id.clone())),
        subagents: previous.map(|status| status.subagents).unwrap_or(0),
        updated_at: now.to_string(),
    }
}

fn tool_label(tool: Option<&str>) -> &'static str {
    match tool {
        Some(_) => "正在执行工具",
        None => "正在处理",
    }
}

fn tool_name(payload: Option<&Value>) -> Option<String> {
    if let Some(value) = field(payload, &["tool_name", "toolName"]) {
        return value_text(value, 80);
    }
    if let Some(value) = field(payload, &["tool"]) {
        if let Some(name) = value.as_str() {
            return Some(truncate_text(name.trim(), 80)).filter(|name| !name.is_empty());
        }
        if let Some(name) = value.get("name").and_then(Value::as_str) {
            return Some(truncate_text(name.trim(), 80)).filter(|name| !name.is_empty());
        }
    }
    None
}

fn tool_input(payload: Option<&Value>) -> Option<String> {
    field(
        payload,
        &["tool_input", "toolInput", "input", "arguments", "args"],
    )
    .and_then(|value| value_text(value, 160))
}

fn message_text(payload: Option<&Value>) -> Option<String> {
    field(
        payload,
        &[
            "message",
            "text",
            "prompt",
            "question",
            "error",
            "last_assistant_message",
            "prompt_response",
            "summary",
            "notification",
        ],
    )
    .and_then(|value| value_text(value, 220))
}

fn field_text(payload: Option<&Value>, keys: &[&str], limit: usize) -> Option<String> {
    field(payload, keys).and_then(|value| value_text(value, limit))
}

fn field<'a>(payload: Option<&'a Value>, keys: &[&str]) -> Option<&'a Value> {
    let object = payload?.as_object()?;
    keys.iter().find_map(|key| object.get(*key))
}

fn value_text(value: &Value, limit: usize) -> Option<String> {
    if let Value::String(text) = value {
        let text: String = text.chars().take(limit).collect();
        let text = text.replace(['\n', '\r', '\t'], " ").trim().to_string();
        return if text.is_empty() {
            None
        } else {
            Some(truncate_text(&text, limit))
        };
    }
    if value.is_null() {
        return None;
    }

    // 工具参数可能是很大的对象；限长写入，避免为了展示复制整份内容。
    let mut writer = LimitedWriter {
        buf: String::new(),
        limit,
    };
    let _ = serde_json::to_writer(&mut writer, value);
    let text = writer
        .buf
        .replace(['\n', '\r', '\t'], " ")
        .trim()
        .to_string();
    if text.is_empty() {
        None
    } else {
        Some(truncate_text(&text, limit))
    }
}

struct LimitedWriter {
    buf: String,
    limit: usize,
}

impl std::io::Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.buf.len() >= self.limit {
            // 到达展示上限后直接中止序列化，避免为了截断遍历整个大对象。
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "display limit reached",
            ));
        }
        let remaining = self.limit - self.buf.len();
        let take = bytes.len().min(remaining);
        self.buf.push_str(&String::from_utf8_lossy(&bytes[..take]));
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::normalize;
    use crate::agent::AgentRuntimePhase;
    use serde_json::json;

    fn run(event: &str, payload: serde_json::Value) -> super::HookActivity {
        normalize(
            None,
            event,
            Some(&payload),
            Some("s-1"),
            "2026-01-01T00:00:00Z",
            false,
            false,
        )
    }

    #[test]
    fn pre_tool_reports_the_running_tool() {
        let activity = run(
            "PreToolUse",
            json!({ "tool_name": "Bash", "tool_input": { "command": "cargo test" } }),
        );
        let status = activity.status.expect("known event");
        assert_eq!(status.phase, AgentRuntimePhase::Working);
        assert_eq!(status.tool.as_deref(), Some("Bash"));
        assert!(status.detail.unwrap().contains("cargo test"));
        assert!(!activity.complete);
    }

    #[test]
    fn permission_request_waits_and_stop_completes() {
        let waiting = run("permission.asked", json!({ "tool_name": "Write" }));
        assert_eq!(
            waiting.status.expect("known event").phase,
            AgentRuntimePhase::WaitingPermission
        );

        let stopped = run("AfterAgent", json!({ "last_assistant_message": "done" }));
        assert!(stopped.complete);
        assert_eq!(
            stopped.status.expect("known event").phase,
            AgentRuntimePhase::Idle
        );
    }

    #[test]
    fn stop_failure_finishes_with_an_error() {
        let activity = run("StopFailure", json!({ "error": "rate limited" }));
        assert!(activity.complete);
        assert_eq!(activity.error.as_deref(), Some("rate limited"));
        assert_eq!(
            activity.status.expect("known event").phase,
            AgentRuntimePhase::Error
        );
    }

    #[test]
    fn subagent_events_change_the_child_count() {
        let started = run("SubagentStart", json!({ "subagent_type": "Explore" }));
        let previous = started.status.expect("known event");
        assert_eq!(previous.subagents, 1);

        let stopped = normalize(
            Some(&previous),
            "SubagentStop",
            None,
            Some("s-1"),
            "2026-01-01T00:00:01Z",
            false,
            false,
        );
        assert_eq!(stopped.status.expect("known event").subagents, 0);
    }

    #[test]
    fn notification_type_maps_to_permission_waiting() {
        let activity = run(
            "Notification",
            json!({ "notification_type": "permission_prompt", "message": "approve Write" }),
        );
        assert_eq!(
            activity.status.expect("known event").phase,
            AgentRuntimePhase::WaitingPermission
        );
    }

    #[test]
    fn omp_agent_turn_end_waits_for_settled() {
        let turn_end = run("AgentTurnEnd", json!({ "message": "still working" }));
        assert!(!turn_end.complete);
        assert_eq!(
            turn_end.status.expect("known event").phase,
            AgentRuntimePhase::Working
        );

        let settled = run("agent_end", json!({ "message": "done" }));
        assert!(settled.complete);
        assert_eq!(
            settled.status.expect("known event").phase,
            AgentRuntimePhase::Idle
        );
    }
}
