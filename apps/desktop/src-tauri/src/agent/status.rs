//! 把各客户端原生 hook 的 payload 归一成 UI 可展示的运行时状态。
//!
//! 事件名来自不同 CLI：`Stop` / `stop` / `AfterAgent` / `agent_end` 都表示
//! 回合结束；`PreToolUse` / `preToolUse` / `BeforeTool` 都表示工具开始。
//! 这里只做名称归一和字段提取，不依赖具体客户端。

use serde_json::Value;
use tapd_i18n::tr;

use super::{prompt, truncate_text, AgentPendingPrompt, AgentRuntimePhase, AgentRuntimeStatus};

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
                tr("agent.status.session.started"),
                session_id,
                model,
                now,
            ));
        }
        "agentstart" => {
            activity.status = Some(base(
                previous,
                AgentRuntimePhase::Working,
                tr("agent.status.working"),
                session_id,
                model,
                now,
            ));
        }
        "beforeagent" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                tr("agent.status.starting"),
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
                tr("agent.status.working"),
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
            // AskUserQuestion 走 PreToolUse：把问题解析成可回答的卡片。
            let question_prompt = tool
                .as_deref()
                .filter(|name| prompt::is_question_tool(name))
                .and_then(|_| prompt::question(payload, tool.clone(), now));
            status.tool = tool;
            status.detail = detail;
            // 工具切换视为新的工作段，Working 条从 0 开始计时。
            status.started_at = Some(now.to_string());
            status.prompt = question_prompt;
            activity.status = Some(status);
        }
        "posttooluse" | "aftertool" | "toolend" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                tr("agent.status.working"),
                session_id,
                model,
                now,
            );
            status.tool = tool.or_else(|| previous.and_then(|status| status.tool.clone()));
            status.detail = Some(tr("agent.status.tool.done").to_string());
            activity.status = Some(status);
        }
        "posttoolusefailure" | "toolfailure" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                tr("agent.status.tool.failed"),
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
                tr("agent.status.waiting.permission"),
                session_id,
                model,
                now,
            );
            status.tool = tool.clone();
            status.detail = detail.clone();
            status.message = message.clone();
            status.prompt = Some(prompt::approval(tool, detail.or(message), now));
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
                    tr("agent.status.waiting.permission")
                } else {
                    tr("agent.status.waiting.answer")
                },
                session_id,
                model,
                now,
            );
            status.tool = tool.clone();
            status.message = message.clone();
            // 只有真正的提问事件才占用输入区；普通 Notification（例如
            // “等待输入”）不能把 Composer 藏起来。
            status.prompt = if waiting_permission {
                Some(prompt::approval(tool, message, now))
            } else if key == "questionasked" {
                prompt::question(payload, tool, now).or_else(|| {
                    message.map(|text| AgentPendingPrompt {
                        prompt_id: now.to_string(),
                        kind: "question".to_string(),
                        tool: None,
                        summary: None,
                        question: Some(text),
                        header: None,
                        options: Vec::new(),
                        can_answer: false,
                        answer_hint: None,
                    })
                })
            } else {
                prompt::question(payload, tool, now)
            };
            activity.status = Some(status);
        }
        "permissionreplied" | "permissionresolved" | "questionreplied" | "questionrejected"
        | "questionresolved" => {
            activity.status = Some(base(
                previous,
                AgentRuntimePhase::Working,
                tr("agent.status.resuming"),
                session_id,
                model,
                now,
            ));
        }
        "subagentstart" => {
            let mut status = base(
                previous,
                AgentRuntimePhase::Working,
                tr("agent.status.subagent.started"),
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
                tr("agent.status.subagent.stopped"),
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
                tr("agent.status.working"),
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
                tr("agent.status.wrapping.up"),
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
                tr("agent.status.reply.received"),
                session_id,
                model,
                now,
            );
            status.last_message = message.clone();
            status.message = message;
            activity.status = Some(status);
        }
        "stop" | "afteragent" | "agentend" => {
            if will_continue || awaiting_async_work {
                let mut status = base(
                    previous,
                    AgentRuntimePhase::Working,
                    if will_continue {
                        tr("agent.status.resuming")
                    } else {
                        tr("agent.status.waiting.background")
                    },
                    session_id,
                    model,
                    now,
                );
                status.last_message = message.clone();
                status.message = message;
                activity.status = Some(status);
            } else {
                let mut status = base(
                    previous,
                    AgentRuntimePhase::Idle,
                    tr("agent.status.turn.ended"),
                    session_id,
                    model,
                    now,
                );
                status.last_message = message.clone();
                status.message = message;
                activity.status = Some(status);
                activity.complete = true;
            }
        }
        "stopfailure" => {
            let error = message
                .clone()
                .unwrap_or_else(|| tr("agent.status.turn.failed.detail").to_string());
            let mut status = base(
                previous,
                AgentRuntimePhase::Error,
                tr("agent.status.turn.failed"),
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
                tr("agent.status.error"),
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
                tr("agent.status.session.ended"),
                session_id,
                model,
                now,
            ));
        }
        "interrupt" => {
            activity.status = Some(base(
                previous,
                AgentRuntimePhase::Idle,
                tr("agent.status.interrupted"),
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
        // phase 不变时沿用起点；切换 phase 时从现在重新计时。
        started_at: match previous {
            Some(status) if status.phase == phase => status.started_at.clone(),
            _ => Some(now.to_string()),
        },
        last_message: previous.and_then(|status| status.last_message.clone()),
        prompt: None,
        updated_at: now.to_string(),
    }
}

fn tool_label(tool: Option<&str>) -> &'static str {
    match tool {
        Some(_) => tr("agent.status.tool.running"),
        None => tr("agent.status.working"),
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
        let status = waiting.status.expect("known event");
        assert_eq!(status.phase, AgentRuntimePhase::WaitingPermission);
        let prompt = status.prompt.expect("approval prompt");
        assert_eq!(prompt.kind, "approval");
        assert_eq!(prompt.options.len(), 2);
        assert!(!waiting.complete);

        let stopped = run("AfterAgent", json!({ "last_assistant_message": "done" }));
        assert!(stopped.complete);
        let status = stopped.status.expect("known event");
        assert_eq!(status.phase, AgentRuntimePhase::Idle);
        assert!(status.prompt.is_none());
        assert_eq!(status.last_message.as_deref(), Some("done"));
    }

    #[test]
    fn ask_user_question_tool_becomes_a_prompt_card() {
        let activity = run(
            "PreToolUse",
            json!({
                "tool_name": "AskUserQuestion",
                "tool_input": { "questions": [{
                    "question": "继续吗",
                    "options": ["继续", "停止"]
                }]}
            }),
        );
        let prompt = activity
            .status
            .expect("known event")
            .prompt
            .expect("question prompt");
        assert_eq!(prompt.kind, "question");
        assert_eq!(prompt.options.len(), 2);
        assert!(prompt.can_answer, "single-select question is answerable");
    }

    #[test]
    fn plain_notification_does_not_block_the_composer() {
        let activity = run(
            "Notification",
            json!({ "notification_type": "waiting_for_input", "message": "等待输入" }),
        );
        let status = activity.status.expect("known event");
        assert!(status.prompt.is_none());
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
