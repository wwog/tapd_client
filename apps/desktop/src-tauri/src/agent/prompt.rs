//! 权限确认 / AskUserQuestion 的归一化与按键映射。
//!
//! hook payload 的形状随客户端变化：Claude 系把问题放在
//! `tool_input.questions`，Codex 用 `arguments.questions[].title`，OpenCode
//! 只上报题干文本。这里统一成 [`AgentPendingPrompt`]，并只对确认过的运行时
//! 开放按键回执；其余情况让用户回终端处理。

use std::borrow::Cow;

use serde_json::Value;

use super::{AgentPendingPrompt, AgentPromptOption};

/// 已确认可以安全回执的运行时族。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyFamily {
    /// Claude Code / OpenClaude：允许 = 1，拒绝 = Esc。
    Claude,
    /// Codex / Grok：允许 = y，拒绝 = n。
    Codex,
    /// OpenCode 系：允许 = Enter，拒绝 = Esc。
    OpenCode,
}

fn family(runtime_id: &str) -> Option<KeyFamily> {
    match runtime_id.trim().to_ascii_lowercase().as_str() {
        "claude" | "openclaude" => Some(KeyFamily::Claude),
        "codex" | "grok" => Some(KeyFamily::Codex),
        "opencode" | "opencode2" | "zcode" => Some(KeyFamily::OpenCode),
        _ => None,
    }
}

/// 工具名归一化后是否属于 AskUserQuestion 家族。
pub(super) fn is_question_tool(name: &str) -> bool {
    matches!(
        tool_key(name).as_str(),
        "askuserquestion"
            | "askuserquestions"
            | "ask"
            | "requestuserinput"
            | "requestuserinputasync"
    )
}

fn tool_key(name: &str) -> String {
    name.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// 构造权限确认卡片。`summary` 为空时卡片只显示工具名。
pub(super) fn approval(
    tool: Option<String>,
    summary: Option<String>,
    prompt_id: &str,
) -> AgentPendingPrompt {
    AgentPendingPrompt {
        prompt_id: prompt_id.to_string(),
        kind: "approval".to_string(),
        tool,
        summary,
        question: None,
        header: None,
        options: vec![
            AgentPromptOption {
                id: "allow_once".to_string(),
                label: "允许一次".to_string(),
                description: None,
            },
            AgentPromptOption {
                id: "reject".to_string(),
                label: "拒绝".to_string(),
                description: None,
            },
        ],
        can_answer: false,
        answer_hint: None,
    }
}

/// 从 hook payload 解析单选提问；多问题 / 多选 / 带 preview 时返回
/// `can_answer=false` 的卡片，由 UI 引导用户回终端。
pub(super) fn question(
    payload: Option<&Value>,
    tool: Option<String>,
    prompt_id: &str,
) -> Option<AgentPendingPrompt> {
    let input = tool_input(payload)?;
    let questions = input.get("questions")?.as_array()?;
    let first = questions.first()?;

    let text = first
        .get("question")
        .or_else(|| first.get("title"))
        .or_else(|| first.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)?;
    let header = first
        .get("header")
        .or_else(|| first.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);

    let mut options = Vec::new();
    let mut simple = true;
    if let Some(items) = first.get("options").and_then(Value::as_array) {
        for (index, item) in items.iter().enumerate() {
            match item {
                Value::String(label) => options.push(AgentPromptOption {
                    id: format!("option-{index}"),
                    label: label.clone(),
                    description: None,
                }),
                Value::Object(_) => {
                    let label = item
                        .get("label")
                        .or_else(|| item.get("title"))
                        .and_then(Value::as_str)?;
                    if item.get("preview").is_some() {
                        simple = false;
                    }
                    options.push(AgentPromptOption {
                        id: format!("option-{index}"),
                        label: label.to_string(),
                        description: item
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    });
                }
                _ => simple = false,
            }
        }
    } else {
        simple = false;
    }

    let multi_select = first
        .get("multiSelect")
        .or_else(|| first.get("multi_select"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let answerable = simple && !multi_select && questions.len() == 1 && !options.is_empty();

    Some(AgentPendingPrompt {
        prompt_id: prompt_id.to_string(),
        kind: "question".to_string(),
        tool,
        summary: None,
        question: Some(text),
        header,
        options,
        can_answer: answerable,
        answer_hint: None,
    })
}

/// 只有单问题、单选、选项为纯文本时才允许回执。
pub(super) fn can_answer(runtime_id: &str, prompt: &AgentPendingPrompt) -> bool {
    if family(runtime_id).is_none() || prompt.options.is_empty() {
        return false;
    }
    if prompt.kind == "question" {
        // 解析阶段已经排除了多选 / 多问题 / preview。
        prompt.can_answer
    } else {
        true
    }
}

/// 卡片下方的按键提示；不支持回执时明确要求回终端。
pub(super) fn answer_hint(runtime_id: &str, prompt: &AgentPendingPrompt) -> Option<String> {
    if !can_answer(runtime_id, prompt) {
        return Some("在 Agent 终端中回答".to_string());
    }
    let family = family(runtime_id)?;
    Some(match prompt.kind.as_str() {
        "approval" => match family {
            KeyFamily::Claude => "按 1 允许 · Esc 拒绝".to_string(),
            KeyFamily::Codex => "按 y 允许 · n 拒绝".to_string(),
            KeyFamily::OpenCode => "回车允许 · Esc 拒绝".to_string(),
        },
        _ => "按选项序号回答".to_string(),
    })
}

/// 把选项翻译成要写进 PTY 的按键。`None` 表示当前运行时无法回答。
pub(super) fn answer_keys(
    runtime_id: &str,
    kind: &str,
    option_id: &str,
) -> Option<Vec<&'static str>> {
    let family = family(runtime_id)?;
    match kind {
        "approval" => match (family, option_id) {
            (KeyFamily::Claude, "allow_once") => Some(vec!["1"]),
            (KeyFamily::Codex, "allow_once") => Some(vec!["y"]),
            (KeyFamily::OpenCode, "allow_once") => Some(vec!["\r"]),
            (_, "reject") => Some(vec!["\x1b"]),
            _ => None,
        },
        "question" => {
            let index = option_id.strip_prefix("option-")?.parse::<usize>().ok()?;
            // Claude / Codex / OpenCode 的问题编号从 1 开始，最多到 9。
            if index >= 9 {
                return None;
            }
            const DIGITS: [&str; 9] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
            Some(vec![DIGITS[index]])
        }
        _ => None,
    }
}

fn tool_input<'a>(payload: Option<&'a Value>) -> Option<Cow<'a, Value>> {
    let object = payload?.as_object()?;
    for key in ["tool_input", "toolInput", "input", "arguments", "args"] {
        if let Some(value) = object.get(key) {
            if value.is_object() {
                return Some(Cow::Borrowed(value));
            }
            // Codex 的 arguments 是 JSON 字符串；解析结果只在本次调用内使用。
            if let Some(text) = value.as_str() {
                if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                    if parsed.is_object() {
                        return Some(Cow::Owned(parsed));
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_question_options_become_numbered_buttons() {
        let payload = json!({
            "tool_name": "AskUserQuestion",
            "tool_input": { "questions": [{
                "question": "选择分支策略？",
                "header": "分支",
                "options": [
                    { "label": "直接提交", "description": "简单改动" },
                    { "label": "新建分支" }
                ]
            }]}
        });
        let prompt = question(Some(&payload), Some("AskUserQuestion".into()), "p1")
            .expect("question parses");
        assert_eq!(prompt.kind, "question");
        assert_eq!(prompt.options.len(), 2);
        assert!(can_answer("claude", &prompt));
        assert_eq!(
            answer_keys("claude", "question", "option-1"),
            Some(vec!["2"])
        );
    }

    #[test]
    fn multi_select_questions_fall_back_to_the_terminal() {
        let payload = json!({
            "tool_input": { "questions": [{
                "question": "选择多个",
                "multiSelect": true,
                "options": ["a", "b"]
            }]}
        });
        let prompt = question(Some(&payload), None, "p1").expect("question parses");
        assert!(!can_answer("claude", &prompt));
        assert!(!can_answer("codex", &prompt));
    }

    #[test]
    fn codex_arguments_json_string_parses() {
        let payload = json!({
            "tool_name": "request_user_input_async",
            "tool_input": "{\"questions\":[{\"title\":\"继续吗\",\"options\":[\"继续\",\"停止\"]}]}"
        });
        assert!(is_question_tool("request_user_input_async"));
        let prompt = question(Some(&payload), None, "p1").expect("question parses");
        assert!(can_answer("codex", &prompt));
        assert_eq!(prompt.question.as_deref(), Some("继续吗"));
    }

    #[test]
    fn approval_keys_follow_the_runtime() {
        assert_eq!(
            answer_keys("claude", "approval", "allow_once"),
            Some(vec!["1"])
        );
        assert_eq!(
            answer_keys("codex", "approval", "allow_once"),
            Some(vec!["y"])
        );
        assert_eq!(
            answer_keys("opencode", "approval", "allow_once"),
            Some(vec!["\r"])
        );
        assert_eq!(
            answer_keys("opencode2", "approval", "reject"),
            Some(vec!["\x1b"])
        );
        assert_eq!(answer_keys("omp", "approval", "allow_once"), None);
        assert_eq!(answer_keys("claude", "approval", "bogus"), None);
    }

    #[test]
    fn unsupported_runtimes_cannot_answer() {
        let prompt = approval(Some("Bash".into()), None, "p1");
        assert!(!can_answer("omp", &prompt));
        assert_eq!(
            answer_hint("omp", &prompt).as_deref(),
            Some("在 Agent 终端中回答")
        );
        assert!(can_answer("claude", &prompt));
    }
}
