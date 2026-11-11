//! AI / MCP notification cards.
//!
//! Parses the `tapd_notify_user` argument schema into the generic `ai` payload,
//! keeps the transient in-memory card store and implements the long-polling
//! decision wait used by the MCP tools. Cards are never persisted.

use std::collections::BTreeSet;
use std::time::Duration;

use chrono::Local;
use serde_json::{json, Value};

use super::{
    model::{
        AiAction, AiBlock, AiField, AiPayload, AiResolution, AiTone, NotificationItem,
        NotificationKind, NotificationSource, NotificationState,
    },
    rules::format_tapd_time,
    service, NotificationService, DEFAULT_NOTIFY_WAIT_SECS, MAX_AI_ACTIONS, MAX_AI_BLOCKS,
    MAX_AI_CODE_CHARS, MAX_AI_ITEMS, MAX_AI_TAG_CHARS, MAX_AI_TEXT_CHARS, MAX_AI_TITLE_CHARS,
    MAX_NOTIFY_WAIT_SECS, NOT_FOUND,
};

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max.saturating_sub(1)).collect();
    truncated.push('…');
    truncated
}

fn required_text(value: Option<&Value>, path: &str, max: usize) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| truncate_chars(text, max))
        .ok_or_else(|| format!("{path} 不能为空"))
}

fn parse_ai_fields(value: &Value, path: &str) -> Result<Vec<AiField>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| format!("{path} 必须是数组"))?;
    if items.len() > 8 {
        return Err(format!("{path} 最多 8 项"));
    }
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let label = required_text(item.get("label"), &format!("{path}[{index}].label"), 24)?;
            let value = item
                .get("value")
                .and_then(Value::as_str)
                .map(str::trim)
                .map(|text| truncate_chars(text, 120))
                .unwrap_or_default();
            Ok(AiField { label, value })
        })
        .collect()
}

fn parse_ai_progress(value: &Value, path: &str) -> Result<AiBlock, String> {
    let percent = value.get("percent").and_then(Value::as_f64).map(|percent| {
        if percent.is_finite() {
            percent.clamp(0.0, 100.0)
        } else {
            0.0
        }
    });
    let label = value
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(|label| truncate_chars(label, 80));
    if percent.is_none() && label.is_none() {
        return Err(format!("{path} 需要 percent 或 label"));
    }
    Ok(AiBlock::Progress { percent, label })
}

fn parse_ai_block(block: &Value, index: usize) -> Result<AiBlock, String> {
    let path = format!("blocks[{index}]");
    let kind = block
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|kind| !kind.is_empty())
        .ok_or_else(|| format!("{path}.type 不能为空"))?;

    match kind {
        "text" => Ok(AiBlock::Text {
            text: required_text(
                block.get("text"),
                &format!("{path}.text"),
                MAX_AI_TEXT_CHARS,
            )?,
        }),
        "code" => Ok(AiBlock::Code {
            text: block
                .get("text")
                .and_then(Value::as_str)
                .map(|text| truncate_chars(text, MAX_AI_CODE_CHARS))
                .unwrap_or_default(),
            language: block
                .get("language")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|language| !language.is_empty())
                .map(|language| truncate_chars(language, 24)),
        }),
        "fields" => {
            let fields = parse_ai_fields(
                block.get("fields").unwrap_or(&Value::Null),
                &format!("{path}.fields"),
            )?;
            Ok(AiBlock::Fields { fields })
        }
        "progress" => parse_ai_progress(block, &path),
        "divider" => Ok(AiBlock::Divider),
        other => Err(format!(
            "{path}.type 不支持「{other}」，可用 text / code / fields / progress / divider"
        )),
    }
}

fn parse_ai_actions(value: Option<&Value>) -> Result<Vec<AiAction>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let items = value
        .as_array()
        .ok_or_else(|| "actions 必须是数组".to_string())?;
    if items.len() > MAX_AI_ACTIONS {
        return Err(format!("actions 最多 {MAX_AI_ACTIONS} 个"));
    }

    let mut seen = BTreeSet::new();
    let mut actions = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let path = format!("actions[{index}]");
        let id = required_text(item.get("id"), &format!("{path}.id"), 48)?;
        if !seen.insert(id.clone()) {
            return Err(format!("{path}.id「{id}」重复"));
        }
        let label = required_text(item.get("label"), &format!("{path}.label"), 24)?;
        let style = match item.get("style").and_then(Value::as_str) {
            None | Some("") => "secondary".to_string(),
            Some(style @ ("primary" | "secondary" | "danger")) => style.to_string(),
            Some(_) => {
                return Err(format!("{path}.style 必须是 primary / secondary / danger"));
            }
        };
        actions.push(AiAction { id, label, style });
    }
    Ok(actions)
}

/// Parses the MCP arguments into a title plus the generic AI payload.
///
/// Supports both the shorthand (`body` / `fields` / `progress`) and the
/// explicit `blocks` array. Text is truncated so a runaway message cannot
/// break the fixed-height capsule card.
pub fn ai_payload_from_arguments(
    arguments: &Value,
    client: &str,
) -> Result<(String, AiPayload), String> {
    let title = required_text(arguments.get("title"), "title", MAX_AI_TITLE_CHARS)?;
    let tone = match arguments.get("tone").and_then(Value::as_str) {
        None => AiTone::Info,
        Some(raw) => AiTone::parse(raw)
            .ok_or_else(|| "tone 必须是 info / success / warning / error / progress".to_string())?,
    };

    let blocks = match arguments.get("blocks") {
        None => Vec::new(),
        Some(Value::Array(items)) if items.is_empty() => Vec::new(),
        Some(Value::Array(items)) => {
            if items.len() > MAX_AI_BLOCKS {
                return Err(format!("blocks 最多 {MAX_AI_BLOCKS} 个"));
            }
            items
                .iter()
                .enumerate()
                .map(|(index, block)| parse_ai_block(block, index))
                .collect::<Result<Vec<_>, _>>()?
        }
        Some(_) => return Err("blocks 必须是数组".to_string()),
    };

    let mut blocks = blocks;
    if blocks.is_empty() {
        if let Some(body) = arguments
            .get("body")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|body| !body.is_empty())
        {
            blocks.push(AiBlock::Text {
                text: truncate_chars(body, MAX_AI_TEXT_CHARS),
            });
        }
        if let Some(fields) = arguments.get("fields").filter(|fields| !fields.is_null()) {
            let fields = parse_ai_fields(fields, "fields")?;
            if !fields.is_empty() {
                blocks.push(AiBlock::Fields { fields });
            }
        }
        if let Some(progress) = arguments
            .get("progress")
            .filter(|progress| !progress.is_null())
        {
            blocks.push(parse_ai_progress(progress, "progress")?);
        }
    }

    let actions = parse_ai_actions(arguments.get("actions"))?;
    let tag = arguments
        .get("tag")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(|tag| truncate_chars(tag, MAX_AI_TAG_CHARS));

    let client = if client.trim().is_empty() {
        "AI".to_string()
    } else {
        truncate_chars(client.trim(), 40)
    };

    Ok((
        title,
        AiPayload {
            tone,
            client,
            blocks,
            actions,
            tag,
            resolution: None,
        },
    ))
}

fn notify_wait_seconds(arguments: &Value) -> u64 {
    arguments
        .get("waitSeconds")
        .or_else(|| arguments.get("wait_seconds"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_NOTIFY_WAIT_SECS)
        .min(MAX_NOTIFY_WAIT_SECS)
}

impl NotificationService {
    pub(super) fn find_ai_item(&self, id: &str) -> Result<NotificationItem, String> {
        self.ai_items
            .lock()
            .expect("ai notification lock")
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| NOT_FOUND.to_string())
    }

    /// Creates an AI notification. `bypass_enabled` is used by the settings
    /// debug panel so a test card still appears while AI notifications are off.
    pub(super) fn raise_ai(
        &self,
        title: String,
        payload: AiPayload,
        bypass_enabled: bool,
    ) -> Result<NotificationItem, String> {
        if !bypass_enabled && !self.settings().ai_enabled {
            return Err("AI 通知已在「设置 → 通知」中关闭".to_string());
        }

        let now = Local::now();
        let tag = payload.tag.clone();
        let item = NotificationItem {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: "ai".to_string(),
            workspace_name: payload.client.clone(),
            bug_id: String::new(),
            title,
            kind: NotificationKind::Ai,
            owner: String::new(),
            creator: payload.client.clone(),
            severity: String::new(),
            priority: String::new(),
            created: format_tapd_time(now.naive_local()),
            detected_at: now.to_rfc3339(),
            state: NotificationState::Pending,
            source: NotificationSource::Ai,
            ai: Some(payload),
        };

        {
            let mut items = self.ai_items.lock().expect("ai notification lock");
            // `tag` replaces an outstanding card in place, so rapid progress
            // updates do not collapse and re-expand the island. The replaced
            // waiter observes `replaced` on its next poll.
            if let Some(tag) = tag.as_deref() {
                for existing in items.iter_mut() {
                    if existing.state != NotificationState::Pending
                        || existing.ai.as_ref().and_then(|ai| ai.tag.as_deref()) != Some(tag)
                    {
                        continue;
                    }
                    if let Some(ai) = existing.ai.as_mut() {
                        ai.resolution = Some(AiResolution {
                            kind: "replaced".to_string(),
                            action_id: None,
                            action_label: None,
                            at: now.to_rfc3339(),
                        });
                    }
                    existing.state = NotificationState::Ignored;
                }
            }

            items.push_back(item.clone());
            while items.len() > MAX_AI_ITEMS {
                items.pop_front();
            }
        }
        self.refresh_window();
        Ok(item)
    }

    /// Stores the user's decision on an AI card. `kind` is `action`,
    /// `dismissed` or `replaced`; `action_id` is required for `action`.
    pub(super) fn finish_ai(
        &self,
        id: &str,
        kind: &str,
        action_id: Option<&str>,
    ) -> Result<NotificationItem, String> {
        let item = {
            let mut items = self.ai_items.lock().expect("ai notification lock");
            let item = items
                .iter_mut()
                .find(|item| item.id == id)
                .ok_or_else(|| NOT_FOUND.to_string())?;
            if let Some(ai) = item.ai.as_mut() {
                if ai.resolution.is_some() {
                    return Ok(item.clone());
                }
                let action = match action_id {
                    Some(action_id) => Some(
                        ai.actions
                            .iter()
                            .find(|action| action.id == action_id)
                            .cloned()
                            .ok_or_else(|| format!("未知操作「{action_id}」"))?,
                    ),
                    None => None,
                };
                ai.resolution = Some(AiResolution {
                    kind: kind.to_string(),
                    action_id: action.as_ref().map(|action| action.id.clone()),
                    action_label: action.as_ref().map(|action| action.label.clone()),
                    at: Local::now().to_rfc3339(),
                });
            }
            item.state = if kind == "action" {
                NotificationState::Handled
            } else {
                NotificationState::Ignored
            };
            item.clone()
        };
        self.refresh_window();
        Ok(item)
    }

    fn ai_state(&self, id: &str) -> (bool, Option<AiResolution>) {
        let items = self.ai_items.lock().expect("ai notification lock");
        match items.iter().find(|item| item.id == id) {
            Some(item) => (true, item.ai.as_ref().and_then(|ai| ai.resolution.clone())),
            None => (false, None),
        }
    }

    /// Waits for a user decision. Returns the stored resolution when the user
    /// already acted, `Pending` on timeout, `Gone` when the card was dropped.
    ///
    /// Uses a short poll instead of a notifier so a resolution that lands
    /// between the state check and the wait cannot be missed.
    async fn wait_ai(&self, id: &str, timeout: Duration) -> AiWait {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let (exists, resolution) = self.ai_state(id);
            if let Some(resolution) = resolution {
                return AiWait::Resolved(resolution);
            }
            if !exists {
                return AiWait::Gone;
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return AiWait::Pending;
            }
            tokio::time::sleep((deadline - now).min(Duration::from_millis(200))).await;
        }
    }
}

/// System notice for local queue events (external AI takeover, rejected claim).
/// This is not an AI request, so it bypasses the "allow AI notifications"
/// toggle: losing a queued task must always be visible. A `tag` replaces an
/// outstanding card in place, so a client that keeps retrying cannot spam the
/// island.
pub fn raise_system_note(
    title: &str,
    tone: AiTone,
    body: &str,
    tag: Option<&str>,
) -> Result<(), String> {
    let service = service()?;
    let payload = AiPayload {
        tone,
        client: "TAPD Client".to_string(),
        blocks: vec![AiBlock::Text {
            text: body.trim().to_string(),
        }],
        actions: Vec::new(),
        tag: tag.map(str::to_string),
        resolution: None,
    };
    service.raise_ai(title.trim().to_string(), payload, true)?;
    Ok(())
}

enum AiWait {
    Resolved(AiResolution),
    /// The user did not act before the wait deadline; the card stays visible.
    Pending,
    /// The card was dropped (cap / restart) before a decision.
    Gone,
}

fn ai_outcome_json(id: &str, outcome: AiWait, waited: Duration, waited_for: bool) -> Value {
    let (status, resolution) = match outcome {
        AiWait::Resolved(resolution) => {
            // Only these three are produced by `finish_ai`; a future kind still
            // gets a stable fallback instead of leaking an internal string.
            let status = match resolution.kind.as_str() {
                "action" => "acted",
                "dismissed" => "dismissed",
                "replaced" => "replaced",
                _ => "resolved",
            };
            (status, Some(resolution))
        }
        AiWait::Pending => (if waited_for { "timeout" } else { "pending" }, None),
        AiWait::Gone => ("expired", None),
    };

    let mut result = json!({
        "id": id,
        "status": status,
        "waitedMs": waited.as_millis() as u64,
    });
    if let Some(resolution) = resolution {
        result["resolvedAt"] = Value::from(resolution.at);
        if let Some(action_id) = resolution.action_id {
            result["actionId"] = Value::from(action_id);
        }
        if let Some(action_label) = resolution.action_label {
            result["actionLabel"] = Value::from(action_label);
        }
    }
    result
}

/// MCP `tapd_notify_user`: raises the capsule and optionally waits for the
/// user's decision so the calling AI receives it in the same tool call.
pub async fn mcp_notify(arguments: &Value, client: &str) -> Result<Value, String> {
    let service = service()?;
    let (title, payload) = ai_payload_from_arguments(arguments, client)?;
    let wait_secs = notify_wait_seconds(arguments);
    let started = std::time::Instant::now();
    let item = service.raise_ai(title, payload, false)?;

    let outcome = if wait_secs == 0 {
        AiWait::Pending
    } else {
        service
            .wait_ai(&item.id, Duration::from_secs(wait_secs))
            .await
    };
    Ok(ai_outcome_json(
        &item.id,
        outcome,
        started.elapsed(),
        wait_secs > 0,
    ))
}

/// MCP `tapd_wait_notification`: waits again for a card raised earlier.
pub async fn mcp_wait(arguments: &Value) -> Result<Value, String> {
    let service = service()?;
    let id = arguments
        .get("id")
        .or_else(|| arguments.get("notificationId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "缺少参数 id".to_string())?
        .to_string();
    let wait_secs = notify_wait_seconds(arguments);
    let started = std::time::Instant::now();
    let outcome = if wait_secs == 0 {
        match service.ai_state(&id) {
            (false, _) => AiWait::Gone,
            (true, Some(resolution)) => AiWait::Resolved(resolution),
            (true, None) => AiWait::Pending,
        }
    } else {
        service.wait_ai(&id, Duration::from_secs(wait_secs)).await
    };
    Ok(ai_outcome_json(
        &id,
        outcome,
        started.elapsed(),
        wait_secs > 0,
    ))
}

#[cfg(test)]
mod ai_notification_tests {
    use super::*;
    use serde_json::json;

    use crate::notification::{
        model::{AiBlock, AiTone},
        DEFAULT_NOTIFY_WAIT_SECS, MAX_AI_TEXT_CHARS, MAX_NOTIFY_WAIT_SECS,
    };

    #[test]
    fn builds_blocks_from_shorthand() {
        let (title, payload) = ai_payload_from_arguments(
            &json!({
                "title": "  构建完成 ",
                "tone": "success",
                "body": "3 个任务完成",
                "fields": [{"label": "耗时", "value": "42s"}],
                "actions": [{"id": "open", "label": "打开", "style": "primary"}]
            }),
            "Claude Code",
        )
        .expect("payload");

        assert_eq!(title, "构建完成");
        assert_eq!(payload.tone, AiTone::Success);
        assert_eq!(payload.client, "Claude Code");
        assert_eq!(
            payload.blocks[0],
            AiBlock::Text {
                text: "3 个任务完成".to_string()
            }
        );
        assert!(matches!(payload.blocks[1], AiBlock::Fields { .. }));
        assert_eq!(payload.actions[0].id, "open");
        assert_eq!(payload.actions[0].style, "primary");
    }

    #[test]
    fn explicit_blocks_override_shorthand() {
        let (_, payload) = ai_payload_from_arguments(
            &json!({
                "title": "进度",
                "tone": "progress",
                "body": "ignored",
                "blocks": [
                    {"type": "progress", "percent": 120, "label": "安装"},
                    {"type": "divider"},
                    {"type": "code", "text": "cargo build", "language": "sh"}
                ]
            }),
            "Codex",
        )
        .expect("payload");

        assert_eq!(payload.blocks.len(), 3);
        assert_eq!(
            payload.blocks[0],
            AiBlock::Progress {
                percent: Some(100.0),
                label: Some("安装".to_string())
            }
        );
        assert_eq!(payload.blocks[1], AiBlock::Divider);
        assert!(matches!(&payload.blocks[2], AiBlock::Code { text, .. } if text == "cargo build"));
    }

    #[test]
    fn rejects_unknown_types_and_duplicate_actions() {
        let unknown = ai_payload_from_arguments(
            &json!({"title": "x", "blocks": [{"type": "video"}]}),
            "client",
        );
        assert!(unknown.is_err());

        let duplicate = ai_payload_from_arguments(
            &json!({
                "title": "x",
                "actions": [
                    {"id": "a", "label": "A"},
                    {"id": "a", "label": "B"}
                ]
            }),
            "client",
        );
        assert!(duplicate.is_err());

        let bad_style = ai_payload_from_arguments(
            &json!({"title": "x", "actions": [{"id": "a", "label": "A", "style": "loud"}]}),
            "client",
        );
        assert!(bad_style.is_err());
    }

    #[test]
    fn truncates_long_body_and_clamps_wait() {
        let body = "x".repeat(MAX_AI_TEXT_CHARS + 10);
        let (_, payload) =
            ai_payload_from_arguments(&json!({"title": "x", "body": body}), "client")
                .expect("payload");
        match &payload.blocks[0] {
            AiBlock::Text { text } => {
                assert_eq!(text.chars().count(), MAX_AI_TEXT_CHARS);
                assert!(text.ends_with('…'));
            }
            other => panic!("unexpected block: {other:?}"),
        }

        assert_eq!(
            notify_wait_seconds(&json!({"waitSeconds": 999})),
            MAX_NOTIFY_WAIT_SECS
        );
        assert_eq!(notify_wait_seconds(&json!({})), DEFAULT_NOTIFY_WAIT_SECS);
        assert_eq!(notify_wait_seconds(&json!({"waitSeconds": 0})), 0);
    }
}
