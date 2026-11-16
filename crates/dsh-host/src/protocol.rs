//! Typed SDK JSON-RPC messages.
//!
//! Only the control plane is typed here. Session event payloads travel as
//! `serde_json::Value` because their vocabulary belongs to `dsh-session` and is
//! rendered generically by the UI; the bridge plugin adds the live stream.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    /// Default working directory recorded on new sessions.
    pub cwd: String,
    /// Provider route id from the profile's `llm-pi-ai` config.
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    /// Ask the server to route approvals back to us instead of the in-process
    /// answerers.
    pub approval_requests: bool,
    pub capabilities: Capabilities,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Capabilities {
    #[serde(rename = "userQuestions")]
    pub user_questions: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionQueryParams {
    pub session_id: String,
    pub content_blocks: Vec<ContentBlock>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ContentBlock {
    Text { text: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorkingDirectoryParams {
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorkingDirectoryResult {
    pub cwd: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorkingDirectorySetParams {
    pub session_id: String,
    pub cwd: String,
}

// ---------------------------------------------------------------------------
// Server → client requests
// ---------------------------------------------------------------------------

/// One-shot approval decision; only `allowed-once` grants the operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalOutcome {
    AllowedOnce,
    Rejected,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestParams {
    pub session_id: String,
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ApprovalRequestResult {
    pub outcome: ApprovalOutcome,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserQuestionRequest {
    /// Correlates cancellation independent of the JSON-RPC id.
    pub request_id: String,
    pub session_id: String,
    pub questions: Vec<Question>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
    /// Presentation hint (`plan-review`, `approval`, …); kept untyped because a
    /// newer runtime may add shapes we must still be able to display.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerItem {
    pub id: String,
    /// Empty for a skipped question.
    pub selected: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserQuestionAnswer {
    pub answers: Vec<AnswerItem>,
}

/// Answers, or an explicit dismissal. Dismissal is never approval.
///
/// Wire shapes: `{ "answers": [...] }` and `{ "cancelled": true }`.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum UserQuestionResult {
    Answers { answers: Vec<AnswerItem> },
    Cancelled { cancelled: bool },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserQuestionCancelled {
    pub request_id: String,
    pub session_id: String,
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub server_info: ServerInfo,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

/// `session/query` receipt: ordinary input queued, or a command that settled.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SessionQueryResult {
    Prompt { message_id: String },
    Command { execution: Value },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_uses_the_wire_field_names() {
        let json = serde_json::to_value(InitializeParams {
            cwd: "/repo".into(),
            provider: "acme-gateway".into(),
            model: "acme-think".into(),
            reasoning_effort: None,
            max_tokens: Some(8192),
            approval_requests: true,
            capabilities: Capabilities {
                user_questions: true,
            },
        })
        .expect("serialize");
        assert_eq!(json["cwd"], "/repo");
        assert_eq!(json["provider"], "acme-gateway");
        assert_eq!(json["model"], "acme-think");
        assert_eq!(json["maxTokens"], 8192);
        assert_eq!(json["approvalRequests"], true);
        assert_eq!(json["capabilities"]["userQuestions"], true);
        assert!(json.get("reasoningEffort").is_none());
    }

    #[test]
    fn query_blocks_are_tagged_text() {
        let json = serde_json::to_value(SessionQueryParams {
            session_id: "s1".into(),
            content_blocks: vec![ContentBlock::Text {
                text: "hello".into(),
            }],
        })
        .expect("serialize");
        assert_eq!(json["sessionId"], "s1");
        assert_eq!(json["contentBlocks"][0]["type"], "text");
        assert_eq!(json["contentBlocks"][0]["text"], "hello");
    }

    #[test]
    fn approval_round_trip() {
        let params: ApprovalRequestParams = serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "toolName": "bash",
            "callId": "c1",
            "reason": "writes files"
        }))
        .expect("params");
        assert_eq!(params.tool_name, "bash");
        assert_eq!(params.call_id.as_deref(), Some("c1"));
        let result = serde_json::to_value(ApprovalRequestResult {
            outcome: ApprovalOutcome::AllowedOnce,
        })
        .expect("result");
        assert_eq!(result["outcome"], "allowed-once");
    }

    #[test]
    fn question_intent_is_forwarded_untyped() {
        let request: UserQuestionRequest = serde_json::from_value(serde_json::json!({
            "requestId": "q1",
            "sessionId": "s1",
            "questions": [{
                "id": "pick",
                "question": "Which one?",
                "multiSelect": true,
                "options": [{ "label": "A", "description": "first" }],
                "intent": { "kind": "approval" }
            }]
        }))
        .expect("request");
        assert!(request.questions[0].multi_select);
        assert_eq!(request.questions[0].options[0].label, "A");
        assert_eq!(request.questions[0].intent.as_ref().unwrap()["kind"], "approval");
    }

    #[test]
    fn dismissal_serializes_as_cancelled() {
        let json =
            serde_json::to_value(UserQuestionResult::Cancelled { cancelled: true }).expect("serialize");
        assert_eq!(json["cancelled"], true);
        let answers = serde_json::to_value(UserQuestionResult::Answers {
            answers: vec![AnswerItem {
                id: "pick".into(),
                selected: vec!["A".into()],
                custom: None,
            }],
        })
        .expect("serialize");
        assert_eq!(answers["answers"][0]["selected"][0], "A");
        assert!(answers.get("cancelled").is_none());
    }

    #[test]
    fn query_result_distinguishes_prompt_and_command() {
        let prompt: SessionQueryResult = serde_json::from_value(serde_json::json!({
            "kind": "prompt", "messageId": "m1"
        }))
        .expect("prompt");
        assert!(matches!(prompt, SessionQueryResult::Prompt { .. }));
        let command: SessionQueryResult = serde_json::from_value(serde_json::json!({
            "kind": "command", "execution": { "id": "c1" }
        }))
        .expect("command");
        assert!(matches!(command, SessionQueryResult::Command { .. }));
    }
}
