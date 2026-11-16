//! Newline-delimited JSON-RPC 2.0 framing, as spoken by the SDK server.
//!
//! One JSON object per `\n`-terminated line. A frame with both `id` and
//! `method` is a request, `id` alone is a response, `method` alone is a
//! notification. Malformed lines are reported to the caller, which logs and
//! keeps reading: a single bad frame must never kill the runtime.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// Client → server methods.
pub const METHOD_INITIALIZE: &str = "initialize";
pub const METHOD_SESSION_QUERY: &str = "session/query";
pub const METHOD_SESSION_WAIT: &str = "session/wait";
pub const METHOD_SESSION_RESUME: &str = "session/resume";
pub const METHOD_SESSION_WORKING_DIRECTORY_SET: &str = "session/working-directory/set";
pub const METHOD_SHUTDOWN: &str = "shutdown";

// Server → client requests and notifications.
pub const METHOD_APPROVAL_REQUEST: &str = "approval/request";
pub const METHOD_USER_QUESTION: &str = "user-question/ask";
pub const METHOD_USER_QUESTION_CANCELLED: &str = "user-question.cancelled";
pub const METHOD_SESSION_EVENT: &str = "session.event";
pub const METHOD_SESSION_STATUS: &str = "session.status";
pub const METHOD_SESSION_QUERY_COMPLETED: &str = "session.query.completed";

/// Outbound request identity. Monotonic within one runtime process.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RpcId(pub u64);

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Incoming {
    Response {
        id: RpcId,
        result: Result<Value, RpcError>,
    },
    Request {
        id: RpcId,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("frame is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("frame has neither id nor method")]
    Empty,
}

/// Decodes one line. `None` means "nothing to do" (blank line).
pub fn decode(line: &str) -> Result<Option<Incoming>, DecodeError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let frame: Value = serde_json::from_str(trimmed)?;
    let id = frame.get("id").and_then(Value::as_u64).map(RpcId);
    let method = frame
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string);
    let params = frame.get("params").cloned().unwrap_or(Value::Null);

    match (id, method) {
        (Some(id), Some(method)) => Ok(Some(Incoming::Request { id, method, params })),
        (Some(id), None) => {
            if let Some(error) = frame.get("error") {
                let error: RpcError = serde_json::from_value(error.clone())?;
                Ok(Some(Incoming::Response {
                    id,
                    result: Err(error),
                }))
            } else {
                Ok(Some(Incoming::Response {
                    id,
                    result: Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
                }))
            }
        }
        (None, Some(method)) => Ok(Some(Incoming::Notification { method, params })),
        (None, None) => Err(DecodeError::Empty),
    }
}

pub fn encode_request(id: RpcId, method: &str, params: Value) -> String {
    let frame = json!({ "jsonrpc": "2.0", "id": id.0, "method": method, "params": params });
    format!("{frame}\n")
}

pub fn encode_success(id: RpcId, result: Value) -> String {
    let frame = json!({ "jsonrpc": "2.0", "id": id.0, "result": result });
    format!("{frame}\n")
}

pub fn encode_error(id: RpcId, code: i64, message: &str) -> String {
    let frame = json!({
        "jsonrpc": "2.0",
        "id": id.0,
        "error": { "code": code, "message": message }
    });
    format!("{frame}\n")
}

/// Allocates outbound request ids. Wraps to 1 instead of 0 after `u64::MAX`
/// (never reached in practice) so ids stay distinct from the JSON-RPC default.
#[derive(Debug, Default)]
pub struct RequestIds {
    next: u64,
}

impl RequestIds {
    pub fn alloc(&mut self) -> RpcId {
        self.next = self.next.wrapping_add(1);
        RpcId(self.next.max(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_response() {
        let line = r#"{"jsonrpc":"2.0","id":3,"result":{"serverInfo":{"name":"dsh"}}}"#;
        match decode(line).expect("decode").expect("frame") {
            Incoming::Response { id, result } => {
                assert_eq!(id, RpcId(3));
                assert_eq!(result.expect("ok")["serverInfo"]["name"], "dsh");
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn decodes_an_error_response() {
        let line = r#"{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"boom"}}"#;
        match decode(line).expect("decode").expect("frame") {
            Incoming::Response { id, result } => {
                assert_eq!(id, RpcId(7));
                let error = result.expect_err("error frame");
                assert_eq!(error.code, -32603);
                assert_eq!(error.message, "boom");
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn decodes_requests_and_notifications() {
        let request = r#"{"jsonrpc":"2.0","id":9,"method":"approval/request","params":{"sessionId":"s"}}"#;
        match decode(request).expect("decode").expect("frame") {
            Incoming::Request { id, method, params } => {
                assert_eq!(id, RpcId(9));
                assert_eq!(method, METHOD_APPROVAL_REQUEST);
                assert_eq!(params["sessionId"], "s");
            }
            other => panic!("unexpected frame: {other:?}"),
        }

        let notification = r#"{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"s"}}"#;
        match decode(notification).expect("decode").expect("frame") {
            Incoming::Notification { method, params } => {
                assert_eq!(method, METHOD_SESSION_EVENT);
                assert_eq!(params["sessionId"], "s");
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn tolerates_blank_lines_and_rejects_garbage() {
        assert!(decode("  \n").expect("blank").is_none());
        assert!(decode("not json").is_err());
        assert!(decode(r#"{"jsonrpc":"2.0"}"#).is_err());
    }

    #[test]
    fn encodes_one_line_per_frame() {
        let line = encode_request(
            RpcId(1),
            METHOD_SESSION_QUERY,
            json!({ "sessionId": "s", "contentBlocks": [] }),
        );
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let value: Value = serde_json::from_str(line.trim()).expect("json");
        assert_eq!(value["method"], METHOD_SESSION_QUERY);
        assert_eq!(value["id"], 1);
    }

    #[test]
    fn ids_start_at_one_and_increase() {
        let mut ids = RequestIds::default();
        assert_eq!(ids.alloc(), RpcId(1));
        assert_eq!(ids.alloc(), RpcId(2));
    }
}
