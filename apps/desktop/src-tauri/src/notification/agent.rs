//! Capsule adapter for the built-in agent's blocking requests (P3).
//!
//! Contract: docs/DSH.md §9.4. The runtime emits `dsh://approval` and
//! `dsh://question` for requests it is blocked on; the Agent page renders the
//! full sheets, and the capsule is the always-visible second surface. Both go
//! back through the same `dsh_approval_answer` / `dsh_question_answer`, so the
//! first answer wins: the request leaves `RuntimeState.pending`, and the other
//! surface drops its card on its next look.
//!
//! The card logic lives here rather than in `dsh/policy.rs` because the card
//! store is private to this module tree; this file is the facade over
//! `raise_ai` / `finish_ai` that keeps `dsh/` out of `pub(super)` internals.
//!
//! Rules that must not drift:
//! - dismissing an approval never grants it;
//! - a request settled elsewhere is never answered twice;
//! - one card per request id.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use dsh_host::protocol::{AnswerItem, Question, UserQuestionRequest};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tapd_i18n::{tr, tr_args};

use super::{
    model::{AiAction, AiBlock, AiField, AiPayload, AiTone},
    service, truncate_chars, MAX_AI_ACTION_DESC_CHARS,
};
use crate::dsh::{EVENT_APPROVAL, EVENT_QUESTION};

/// How often a live card re-checks the runtime. Fast enough to feel immediate
/// when the Agent page answers, slow enough to cost nothing.
const ANSWER_POLL: Duration = Duration::from_millis(250);
/// More options than this and the capsule turns into the "go handle it" card.
const MAX_OPTION_ACTIONS: usize = 3;
/// Stable tag: one live notify-mode card replaces the previous one.
const NOTICE_TAG: &str = "dsh-policy-notice";

/// Cards raised for runtime requests.
#[derive(Default)]
struct Cards {
    /// rpcId → card id.
    by_rpc: HashMap<u64, String>,
    /// requestId → rpcId, so `user-question.cancelled` finds the card.
    by_request: HashMap<String, u64>,
    /// Requests the runtime already gave up on; their cards must not answer.
    settled: HashSet<u64>,
}

fn cards() -> &'static Mutex<Cards> {
    static CARDS: OnceLock<Mutex<Cards>> = OnceLock::new();
    CARDS.get_or_init(|| Mutex::new(Cards::default()))
}

/// Subscribes the capsule to the runtime's blocking requests. Called once, from
/// `notification::init`.
pub fn mount(app: &AppHandle) {
    listen_json(app, EVENT_APPROVAL, approval);
    listen_json(app, EVENT_QUESTION, question);
    // `user-question.cancelled` arrives on the generic notification channel.
    listen_json(app, "dsh://notification", cancelled);
}

fn listen_json(app: &AppHandle, event: &str, handler: impl Fn(&AppHandle, &Value) + Send + 'static) {
    let handle = app.clone();
    app.listen(event, move |event| {
        match serde_json::from_str::<Value>(event.payload()) {
            Ok(payload) => handler(&handle, &payload),
            Err(error) => tracing::debug!(%error, "agent card: unreadable event payload"),
        }
    });
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

fn approval(app: &AppHandle, payload: &Value) {
    let Some(rpc_id) = payload.get("rpcId").and_then(Value::as_u64) else {
        return;
    };
    let request = payload.get("request").cloned().unwrap_or(Value::Null);
    let tool = text(&request, "toolName");
    let raw_reason = text(&request, "reason");
    let (risk, rule, target) = split_reason(&raw_reason);

    let mut fields = vec![AiField {
        label: tr("dsh.policy.field.tool").to_string(),
        value: tool.clone(),
    }];
    if !target.is_empty() {
        fields.push(AiField {
            label: tr("dsh.policy.field.target").to_string(),
            value: target.to_string(),
        });
    }
    if let Some(reason) = describe(risk, rule, &raw_reason) {
        fields.push(AiField {
            label: tr("dsh.policy.field.reason").to_string(),
            value: reason,
        });
    }

    let payload = AiPayload {
        // An approval is a decision, not a hint: warning reads correctly even
        // for a soft rule.
        tone: AiTone::Warning,
        client: tr("dsh.policy.client").to_string(),
        blocks: vec![AiBlock::Fields { fields }],
        actions: vec![
            AiAction {
                id: "allow".to_string(),
                label: tr("dsh.policy.approval.allow").to_string(),
                style: "primary".to_string(),
                description: None,
            },
            AiAction {
                id: "reject".to_string(),
                label: tr("dsh.policy.approval.reject").to_string(),
                style: "danger".to_string(),
                description: None,
            },
        ],
        stack_actions: false,
        allow_custom: false,
        tag: None,
        resolution: None,
    };

    let Some(card_id) = raise(rpc_id, tr_args("dsh.policy.approval.title", &[&tool]), payload) else {
        return;
    };
    spawn_settle(app.clone(), rpc_id, card_id, Answer::Approval);
}

/// Splits the policy plugin's audited reason line (`hard:rule_id: target`).
///
/// The SDK's `approval/request` has no target field, so the plugin encodes risk,
/// rule and target in the one string it can send. A reason from any other
/// producer is shown verbatim with no risk class.
fn split_reason(raw: &str) -> (Option<&str>, &str, &str) {
    let raw = raw.trim();
    if raw.is_empty() {
        return (None, "", "");
    }
    let mut parts = raw.splitn(3, ':');
    let risk = parts.next().unwrap_or("").trim();
    let rule = parts.next().unwrap_or("").trim();
    let target = parts.next().unwrap_or("").trim();
    if matches!(risk, "hard" | "soft") && !rule.is_empty() {
        (Some(risk), rule, target)
    } else {
        (None, "", raw)
    }
}

/// Localized reason text: the rule identifier is stable, the sentence is not.
fn describe(risk: Option<&str>, rule: &str, raw: &str) -> Option<String> {
    match risk {
        Some("hard") => Some(tr_args("dsh.policy.reason.hard", &[&rule])),
        Some("soft") => Some(tr_args("dsh.policy.reason.soft", &[&rule])),
        _ if !raw.is_empty() => Some(raw.to_string()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Question
// ---------------------------------------------------------------------------

fn question(app: &AppHandle, payload: &Value) {
    let Some(rpc_id) = payload.get("rpcId").and_then(Value::as_u64) else {
        return;
    };
    let Some(request) = payload.get("request") else {
        return;
    };
    let Ok(request) = serde_json::from_value::<UserQuestionRequest>(request.clone()) else {
        tracing::warn!("agent question: unreadable request payload");
        return;
    };

    let raised = match single_choice(&request) {
        // One short single-select question fits in the capsule: answer it here.
        Some(question) => raise(
            rpc_id,
            question_title(question),
            option_card(question),
        )
        .map(|card_id| {
            let answer = Answer::Single {
                question: question.clone(),
            };
            (card_id, answer)
        }),
        // Otherwise the capsule only points at the Agent page, which owns the
        // QuestionSheet.
        None => raise(
            rpc_id,
            tr("dsh.policy.question.title").to_string(),
            summary_card(request.questions.len()),
        )
        .map(|card_id| {
            let answer = Answer::Summary {
                session_id: request.session_id.clone(),
            };
            (card_id, answer)
        }),
    };

    let Some((card_id, answer)) = raised else {
        return;
    };
    cards()
        .lock()
        .expect("dsh agent cards lock")
        .by_request
        .insert(request.request_id.clone(), rpc_id);
    spawn_settle(app.clone(), rpc_id, card_id, answer);
}

fn single_choice(request: &UserQuestionRequest) -> Option<&Question> {
    let question = request.questions.first()?;
    if request.questions.len() != 1 || question.multi_select {
        return None;
    }
    if question.options.is_empty() || question.options.len() > MAX_OPTION_ACTIONS {
        return None;
    }
    Some(question)
}

fn question_title(question: &Question) -> String {
    let title = question
        .header
        .as_deref()
        .map(str::trim)
        .filter(|header| !header.is_empty())
        .unwrap_or(question.question.trim());
    truncate_chars(title, 140)
}

fn option_card(question: &Question) -> AiPayload {
    // The header makes a compact title; the question itself and its detail stay
    // visible in the body so nothing is lost when both exist.
    let mut blocks = Vec::new();
    let heading = question.header.as_deref().map(str::trim).unwrap_or("");
    let body = question.question.trim();
    let body = if heading.is_empty() || heading == body {
        ""
    } else {
        body
    };
    let detail = question.detail.as_deref().map(str::trim).unwrap_or("");
    let text = [body, detail]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if !text.is_empty() {
        blocks.push(AiBlock::Text {
            text: truncate_chars(&text, 400),
        });
    }
    AiPayload {
        tone: AiTone::Info,
        client: tr("dsh.policy.client").to_string(),
        blocks,
        // Option labels are the buttons; the index is the stable action id.
        // Several options are listed one per row (label over description),
        // because the card is too narrow for side-by-side buttons.
        actions: question
            .options
            .iter()
            .enumerate()
            .map(|(index, option)| AiAction {
                id: format!("option-{index}"),
                label: option.label.trim().to_string(),
                style: "secondary".to_string(),
                description: option
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .map(|text| truncate_chars(text, MAX_AI_ACTION_DESC_CHARS)),
            })
            .collect(),
        stack_actions: true,
        // "Other answer": the capsule can send free text back as a custom
        // answer instead of one of the listed options.
        allow_custom: true,
        tag: None,
        resolution: None,
    }
}

fn summary_card(count: usize) -> AiPayload {
    AiPayload {
        tone: AiTone::Info,
        client: tr("dsh.policy.client").to_string(),
        blocks: vec![AiBlock::Text {
            text: tr_args("dsh.policy.question.summary", &[&count]),
        }],
        actions: vec![AiAction {
            id: "open".to_string(),
            label: tr("dsh.policy.question.open").to_string(),
            style: "primary".to_string(),
            description: None,
        }],
        stack_actions: false,
        allow_custom: false,
        tag: None,
        resolution: None,
    }
}

// ---------------------------------------------------------------------------
// Notice (notify mode)
// ---------------------------------------------------------------------------

/// One `notice` from the policy plugin: the call is already allowed. The card
/// is informational, so the user's dismissal means nothing.
pub fn notice(tool: &str, target: &str, risk: &str) {
    let Ok(service) = service() else {
        return;
    };
    let target = target.trim();
    let payload = AiPayload {
        tone: if risk == "hard" {
            AiTone::Warning
        } else {
            AiTone::Info
        },
        client: tr("dsh.policy.client").to_string(),
        blocks: if target.is_empty() {
            Vec::new()
        } else {
            vec![AiBlock::Text {
                text: truncate_chars(target, 400),
            }]
        },
        actions: Vec::new(),
        stack_actions: false,
        allow_custom: false,
        tag: Some(NOTICE_TAG.to_string()),
        resolution: None,
    };
    if let Err(error) = service.raise_ai(tr_args("dsh.policy.notice.title", &[&tool]), payload, false) {
        tracing::debug!(%error, "agent notice card not raised");
    }
}

// ---------------------------------------------------------------------------
// Raising, waiting, answering
// ---------------------------------------------------------------------------

/// Which answer the card can produce.
enum Answer {
    /// Allow once / reject; closing cancels.
    Approval,
    /// One single-select question answered from the option buttons.
    Single { question: Question },
    /// A pointer card: only `open` acts, dismissal leaves the request alone.
    Summary { session_id: String },
}

enum Decision {
    Action(String),
    /// Text typed into the card's answer field ("other answer").
    Custom(String),
    /// The card was closed.
    Dismissed,
    /// The card store dropped it (cap / restart).
    Gone,
    /// Another surface answered, or the runtime stopped. Answer nothing.
    Settled,
}

/// Raises one card per request. Returns `None` when the card could not be
/// raised (notifications off) or this request already has one.
fn raise(rpc_id: u64, title: String, payload: AiPayload) -> Option<String> {
    let service = service().ok()?;
    // Check, raise and register under one lock: two copies of the same request
    // would otherwise race and the loser's answer would cancel the winner.
    let mut cards = cards().lock().expect("dsh agent cards lock");
    if cards.by_rpc.contains_key(&rpc_id) {
        return None;
    }
    match service.raise_ai(title, payload, false) {
        Ok(item) => {
            cards.by_rpc.insert(rpc_id, item.id.clone());
            Some(item.id)
        }
        Err(error) => {
            tracing::debug!(%error, "agent card not raised");
            None
        }
    }
}

fn spawn_settle(app: AppHandle, rpc_id: u64, card_id: String, answer: Answer) {
    tauri::async_runtime::spawn(async move {
        let decision = wait(&app, &card_id, rpc_id).await;
        answer_from(&app, rpc_id, &card_id, answer, decision).await;
        forget(rpc_id);
    });
}

/// Waits for a card decision, a settlement elsewhere, or the runtime leaving.
async fn wait(app: &AppHandle, card_id: &str, rpc_id: u64) -> Decision {
    loop {
        let settled = cards()
            .lock()
            .expect("dsh agent cards lock")
            .settled
            .contains(&rpc_id);
        if settled {
            return Decision::Settled;
        }
        let Some(service) = service().ok() else {
            return Decision::Gone;
        };
        let (exists, resolution) = service.ai_state(card_id);
        if let Some(resolution) = resolution {
            return match resolution.kind.as_str() {
                "action" => match (resolution.action_id, resolution.value) {
                    (Some(action_id), _) => Decision::Action(action_id),
                    // The answer field resolves the card with text, no action.
                    (None, Some(value)) => Decision::Custom(value),
                    (None, None) => Decision::Dismissed,
                },
                _ => Decision::Dismissed,
            };
        }
        if !exists {
            return Decision::Gone;
        }
        // The Agent page (or `dsh_stop`) removed the request: the card is stale.
        if !still_pending(app, rpc_id) {
            return Decision::Settled;
        }
        tokio::time::sleep(ANSWER_POLL).await;
    }
}

async fn answer_from(
    app: &AppHandle,
    rpc_id: u64,
    card_id: &str,
    answer: Answer,
    decision: Decision,
) {
    if matches!(decision, Decision::Settled) {
        // Answered elsewhere: take the card away, never answer twice.
        finish_dismissed(card_id);
        return;
    }

    match answer {
        Answer::Approval => {
            // Only an explicit allow grants the call.
            let outcome = match &decision {
                Decision::Action(action) if action == "allow" => "allowed-once",
                Decision::Action(_) | Decision::Custom(_) => "rejected",
                Decision::Dismissed | Decision::Gone => "cancelled",
                Decision::Settled => return,
            };
            if let Err(error) = crate::dsh::feature::approval_answer(app, rpc_id, outcome).await {
                tracing::warn!(%error, "agent approval answer failed");
            }
        }
        Answer::Single { question } => {
            let answers = match &decision {
                Decision::Action(action) => option_answers(action, &question),
                Decision::Custom(text) => Some(vec![AnswerItem {
                    id: question.id.clone(),
                    selected: Vec::new(),
                    custom: Some(text.clone()),
                }]),
                Decision::Dismissed | Decision::Gone => None,
                Decision::Settled => return,
            };
            if let Err(error) = crate::dsh::feature::question_answer(app, rpc_id, answers).await {
                tracing::warn!(%error, "agent question answer failed");
            }
        }
        Answer::Summary { session_id } => {
            // Dismissing the pointer must not cancel the live QuestionSheet;
            // only `open` acts.
            if let Decision::Action(action) = &decision {
                if action == "open" {
                    focus_session(app, &session_id);
                }
            }
        }
    }
}

/// Maps `option-<n>` back to the option label; anything else is a dismissal.
fn option_answers(action: &str, question: &Question) -> Option<Vec<AnswerItem>> {
    let index = action.strip_prefix("option-")?.parse::<usize>().ok()?;
    let option = question.options.get(index)?;
    Some(vec![AnswerItem {
        id: question.id.clone(),
        selected: vec![option.label.clone()],
        custom: None,
    }])
}

/// The request is gone from the runtime; drop its card without answering.
fn finish_dismissed(card_id: &str) {
    if let Ok(service) = service() {
        let _ = service.finish_ai(card_id, "dismissed", None, None);
    }
}

fn forget(rpc_id: u64) {
    let mut cards = cards().lock().expect("dsh agent cards lock");
    cards.by_rpc.remove(&rpc_id);
    cards.by_request.retain(|_, rpc| *rpc != rpc_id);
    cards.settled.remove(&rpc_id);
}

/// The runtime gave up on a question (`user-question.cancelled`): drop its card
/// and remember not to answer. Runs before the waiter's next look.
fn cancelled(_app: &AppHandle, payload: &Value) {
    if payload.get("method").and_then(Value::as_str) != Some("user-question.cancelled") {
        return;
    }
    let Some(request_id) = payload
        .pointer("/params/requestId")
        .and_then(Value::as_str)
    else {
        return;
    };
    let card_id = {
        let mut cards = cards().lock().expect("dsh agent cards lock");
        let Some(rpc_id) = cards.by_request.remove(request_id) else {
            return;
        };
        cards.settled.insert(rpc_id);
        cards.by_rpc.get(&rpc_id).cloned()
    };
    if let Some(card_id) = card_id {
        finish_dismissed(&card_id);
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn still_pending(app: &AppHandle, rpc_id: u64) -> bool {
    app.try_state::<std::sync::Arc<crate::dsh::runtime::RuntimeState>>()
        .map(|state| {
            state
                .pending()
                .iter()
                .any(|request| request.rpc_id == rpc_id)
        })
        .unwrap_or(false)
}

/// Brings the main window forward and asks it to select the session. The Agent
/// page owns the QuestionSheet; the event only moves the selection. Shared with
/// the review card and the "fix with agent" action (`notification/actions.rs`).
pub(super) fn focus_session(app: &AppHandle, session_id: &str) {
    // While an update owns the screen the main window is deliberately
    // unreachable (same rule as the notification handlers).
    if crate::update::is_updating() {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    let _ = app.emit("dsh://focus-session", json!({ "sessionId": session_id }));
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_reasons_split_into_risk_rule_and_target() {
        assert_eq!(
            split_reason("hard:rm_rf_root: rm -rf /"),
            (Some("hard"), "rm_rf_root", "rm -rf /")
        );
        assert_eq!(
            split_reason("soft:outside_cwd: /etc/passwd"),
            (Some("soft"), "outside_cwd", "/etc/passwd")
        );
        // A reason from any other producer stays readable.
        assert_eq!(
            split_reason("needs a human"),
            (None, "", "needs a human")
        );
        assert_eq!(split_reason("  "), (None, "", ""));
    }

    #[test]
    fn option_actions_map_back_to_the_label() {
        let question = Question {
            id: "q1".into(),
            question: "Pick one".into(),
            detail: None,
            header: None,
            options: vec![
                dsh_host::protocol::QuestionOption {
                    label: "yes".into(),
                    description: None,
                },
                dsh_host::protocol::QuestionOption {
                    label: "no".into(),
                    description: None,
                },
            ],
            multi_select: false,
            intent: None,
        };
        let answers = option_answers("option-1", &question).expect("answer");
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0].id, "q1");
        assert_eq!(answers[0].selected, vec!["no".to_string()]);
        assert!(option_answers("option-9", &question).is_none());
        assert!(option_answers("open", &question).is_none());
    }

    #[test]
    fn option_card_offers_a_custom_answer_row() {
        let question = Question {
            id: "q1".into(),
            question: "Pick one".into(),
            detail: None,
            header: Some("Header".into()),
            options: vec![
                dsh_host::protocol::QuestionOption {
                    label: "yes".into(),
                    description: Some("do it".into()),
                },
                dsh_host::protocol::QuestionOption {
                    label: "no".into(),
                    description: None,
                },
            ],
            multi_select: false,
            intent: None,
        };
        let card = option_card(&question);
        // Two options and the typed answer: three rows tall.
        assert!(card.allow_custom);
        assert_eq!(card.stacked_rows(), 3);
        assert_eq!(card.actions[0].description.as_deref(), Some("do it"));
        assert_eq!(card.actions[1].description, None);
    }

    #[test]
    fn only_short_single_select_questions_fit_the_capsule() {
        let base = UserQuestionRequest {
            request_id: "r1".into(),
            session_id: "s1".into(),
            questions: vec![Question {
                id: "q1".into(),
                question: "Pick one".into(),
                detail: None,
                header: None,
                options: (0..3)
                    .map(|index| dsh_host::protocol::QuestionOption {
                        label: format!("option {index}"),
                        description: None,
                    })
                    .collect(),
                multi_select: false,
                intent: None,
            }],
        };
        assert!(single_choice(&base).is_some());

        let multi_select = UserQuestionRequest {
            questions: vec![Question {
                multi_select: true,
                ..base.questions[0].clone()
            }],
            ..base.clone()
        };
        assert!(single_choice(&multi_select).is_none());

        let too_many = UserQuestionRequest {
            questions: vec![Question {
                options: (0..4)
                    .map(|index| dsh_host::protocol::QuestionOption {
                        label: format!("option {index}"),
                        description: None,
                    })
                    .collect(),
                ..base.questions[0].clone()
            }],
            ..base.clone()
        };
        assert!(single_choice(&too_many).is_none());

        let two_questions = UserQuestionRequest {
            questions: vec![base.questions[0].clone(), base.questions[0].clone()],
            ..base
        };
        assert!(single_choice(&two_questions).is_none());
    }
}
