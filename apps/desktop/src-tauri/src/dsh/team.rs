//! Agent Teams board for one root session (P5).
//!
//! Contract: docs/DSH.md §9.5. The runtime composes `dsh-agent-team`, so the
//! board is a projection `/agentTeam` over the root session's committed log;
//! the bridge plugin forwards it, [`BridgeState`] keeps the last value, and
//! this module exposes it in the app's stable shape and toggles Team mode.
//!
//! Team mode is durable in dsh (`team/mode`), so nothing here is persisted:
//! a started runtime replays the saved selection and the plugin re-publishes
//! the board on connect. A session the runtime has never seen simply answers
//! with an empty board instead of an error.
//!
//! Enabling appends one guidance message naming the enabled coworkers, so the
//! lead splits work into board tasks and hands parts to matching coworkers
//! ([`crate::coworker`]). It is sent once per session per app run.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::bridge::BridgeState;
use super::runtime::RuntimeState;
use crate::agent_settings;
use crate::coworker;
use tapd_i18n::{tr, tr_args};

/// Emitted on every inbound team frame. Payload: `{ sessionId, team }`.
pub const EVENT_TEAM: &str = "dsh://team";

/// How long `dsh_team_set` waits for the plugin to echo the new mode. The
/// toggle itself is already queued; a slow runtime must not hang the UI.
const MODE_TIMEOUT: Duration = Duration::from_secs(3);
const MODE_POLL: Duration = Duration::from_millis(50);

// ---------------------------------------------------------------------------
// Model (docs/DSH.md §9.5)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamTaskStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshTeamTask {
    pub id: String,
    pub subject: String,
    pub description: String,
    pub status: TeamTaskStatus,
    /// Absent until a member claims the task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    /// Immutable agent path captured at assignment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_name: Option<String>,
    pub blocked_by: Vec<String>,
    pub write_scopes: Vec<String>,
    /// Every blocker is completed.
    pub ready: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshTeam {
    pub session_id: String,
    pub enabled: bool,
    pub tasks: Vec<DshTeamTask>,
    /// The projection rejected a persisted record; tasks then hold the last
    /// valid state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

impl DshTeam {
    /// The board of a session the runtime has not reported yet.
    fn empty(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            enabled: false,
            tasks: Vec::new(),
            failure: None,
        }
    }
}

/// Maps one plugin `team` frame onto the UI contract. `deleted` tasks are
/// tombstones (the active board never shows them), and a task whose status
/// cannot be mapped is dropped rather than shown under a wrong status.
pub(super) fn normalize_team(session_id: &str, frame: &Value) -> DshTeam {
    let tasks = frame
        .get("tasks")
        .and_then(Value::as_array)
        .map(|tasks| tasks.iter().filter_map(normalize_task).collect())
        .unwrap_or_default();
    DshTeam {
        session_id: session_id.to_string(),
        enabled: frame
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        tasks,
        failure: frame
            .get("failure")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn normalize_task(task: &Value) -> Option<DshTeamTask> {
    let status = match task.get("status").and_then(Value::as_str) {
        Some("pending") => TeamTaskStatus::Pending,
        Some("in_progress") => TeamTaskStatus::InProgress,
        Some("completed") => TeamTaskStatus::Completed,
        // `deleted` is a tombstone; an unknown status has no mapping.
        _ => return None,
    };
    Some(DshTeamTask {
        id: text(task, "id"),
        subject: text(task, "subject"),
        description: text(task, "description"),
        status,
        owner_id: optional_text(task, "ownerId"),
        owner_name: optional_text(task, "ownerName"),
        blocked_by: text_list(task, "blockedBy"),
        write_scopes: text_list(task, "writeScopes"),
        ready: task.get("ready").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn optional_text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.is_empty())
}

fn text_list(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

/// Dispatches `dsh_team_get` / `dsh_team_set`.
pub async fn command(app: &AppHandle, name: &str, payload: Value) -> Result<Value, String> {
    match name {
        "dsh_team_get" => get(app, parse(payload, name)?),
        "dsh_team_set" => set(app, parse(payload, name)?).await,
        other => Err(format!("unknown dsh team command: {other}")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamGetRequest {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamSetRequest {
    session_id: String,
    enabled: bool,
}

fn parse<T: for<'de> Deserialize<'de>>(payload: Value, name: &str) -> Result<T, String> {
    serde_json::from_value(payload).map_err(|error| tr_args("dsh.args.invalid", &[&name, &error]))
}

fn get(app: &AppHandle, request: TeamGetRequest) -> Result<Value, String> {
    let team = bridge(app)
        .and_then(|bridge| bridge.team(&request.session_id))
        .unwrap_or_else(|| DshTeam::empty(&request.session_id));
    Ok(json!({ "team": team }))
}

async fn set(app: &AppHandle, request: TeamSetRequest) -> Result<Value, String> {
    let runtime = runtime(app)?;
    // The toggle is a runtime service call; without a runtime there is nothing
    // to switch and the plugin would not be listening either.
    runtime.ensure_ready(app).await?;
    let bridge = bridge(app).ok_or_else(|| tr("dsh.bridge.unavailable").to_string())?;
    bridge
        .set_team_mode(&request.session_id, request.enabled)
        .await?;

    let mut team = wait_for_mode(&bridge, &request.session_id, request.enabled)
        .await
        .unwrap_or_else(|| DshTeam::empty(&request.session_id));
    if request.enabled {
        // A session the runtime has not created yet only gets its live agent
        // when the roster prompt arrives; the toggle then applies on
        // `agent/created`, so wait once more for that frame.
        if announce_coworkers(app, &runtime, &request.session_id).await && !team.enabled {
            team = wait_for_mode(&bridge, &request.session_id, true)
                .await
                .unwrap_or(team);
        }
    }
    Ok(json!({ "team": team }))
}

/// Polls the registry until the plugin echoes the requested mode. A runtime
/// that never answers keeps the previous board; the timeout only bounds the
/// UI wait, it never invents a state.
async fn wait_for_mode(bridge: &BridgeState, session_id: &str, enabled: bool) -> Option<DshTeam> {
    let deadline = tokio::time::Instant::now() + MODE_TIMEOUT;
    loop {
        if let Some(team) = bridge.team(session_id) {
            if team.enabled == enabled {
                return Some(team);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return bridge.team(session_id);
        }
        tokio::time::sleep(MODE_POLL).await;
    }
}

// ---------------------------------------------------------------------------
// Coworker roster
// ---------------------------------------------------------------------------

/// Sessions whose roster message was already queued in this app run. The
/// message is guidance for the lead, so the guard only avoids spending a turn
/// twice; it is not persisted.
fn roster_sent() -> &'static Mutex<HashSet<String>> {
    static SENT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SENT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Queues the roster after Team mode was applied. Best effort: the toggle
/// already succeeded and must not be reported as failed because a prompt
/// could not be queued, so the error is logged. Returns whether the message
/// was queued now (i.e. not already sent in this run).
async fn announce_coworkers(app: &AppHandle, runtime: &RuntimeState, session_id: &str) -> bool {
    {
        let mut sent = roster_sent().lock().expect("dsh team roster lock");
        if !sent.insert(session_id.to_string()) {
            return false;
        }
    };

    let config = agent_settings::config_for(app);
    let section = coworker::prompt_section(app, &config.coworker_ids);
    let text = if section.trim().is_empty() {
        tr("dsh.team.roster.empty").to_string()
    } else {
        tr_args("dsh.team.roster", &[&section])
    };
    if let Err(error) = runtime.query(app, session_id, &text).await {
        // Let the next enable retry the guidance.
        roster_sent()
            .lock()
            .expect("dsh team roster lock")
            .remove(session_id);
        tracing::warn!(%error, session = session_id, "failed to queue the coworker roster");
        return false;
    }
    true
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

fn bridge(app: &AppHandle) -> Option<std::sync::Arc<BridgeState>> {
    app.try_state::<std::sync::Arc<BridgeState>>()
        .map(|state| state.inner().clone())
}

fn runtime(app: &AppHandle) -> Result<std::sync::Arc<RuntimeState>, String> {
    app.try_state::<std::sync::Arc<RuntimeState>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| tr("dsh.state.unavailable").to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleted_tasks_are_not_part_of_the_board() {
        let frame = json!({
            "enabled": true,
            "tasks": [
                { "id": "task-1", "subject": "改登录页", "description": "…",
                  "status": "pending", "blockedBy": [], "writeScopes": ["src/login"],
                  "ready": true },
                { "id": "task-2", "subject": "已删除", "description": "…",
                  "status": "deleted", "blockedBy": [], "writeScopes": [],
                  "ready": false }
            ]
        });
        let team = normalize_team("s1", &frame);
        assert_eq!(team.session_id, "s1");
        assert!(team.enabled);
        assert_eq!(team.tasks.len(), 1);
        assert_eq!(team.tasks[0].id, "task-1");
        assert_eq!(team.tasks[0].status, TeamTaskStatus::Pending);
        assert!(team.tasks[0].ready);
        assert_eq!(team.tasks[0].write_scopes, vec!["src/login".to_string()]);
        assert!(team.tasks[0].owner_id.is_none());
        assert!(team.tasks[0].owner_name.is_none());
        assert!(team.failure.is_none());
    }

    #[test]
    fn owners_and_status_keep_their_wire_names() {
        let frame = json!({
            "enabled": false,
            "tasks": [
                { "id": "task-1", "revision": 3, "subject": "s", "description": "d",
                  "status": "in_progress", "ownerId": "sub-1", "ownerName": "架构/author",
                  "blockedBy": ["task-0"], "writeScopes": [], "ready": false,
                  "writeScopeWarnings": ["w"] }
            ],
            "failure": "persisted task is invalid"
        });
        let team = normalize_team("s1", &frame);
        assert!(!team.enabled);
        let task = &team.tasks[0];
        assert_eq!(task.status, TeamTaskStatus::InProgress);
        assert_eq!(task.owner_id.as_deref(), Some("sub-1"));
        assert_eq!(task.owner_name.as_deref(), Some("架构/author"));
        assert_eq!(task.blocked_by, vec!["task-0".to_string()]);
        assert_eq!(team.failure.as_deref(), Some("persisted task is invalid"));

        let value = serde_json::to_value(task).unwrap();
        assert_eq!(value["status"], "in_progress");
        assert_eq!(value["ownerId"], "sub-1");
        assert_eq!(value["ownerName"], "架构/author");
        // `revision` / `writeScopeWarnings` are not part of §9.5.
        assert!(value.get("revision").is_none());
        assert!(value.get("writeScopeWarnings").is_none());
    }

    #[test]
    fn an_empty_or_partial_frame_still_yields_a_board() {
        let team = normalize_team("s1", &json!({}));
        assert!(!team.enabled);
        assert!(team.tasks.is_empty());
        assert!(team.failure.is_none());

        // A completed task with no owner reads as a finished, ownerless row.
        let frame = json!({
            "enabled": true,
            "tasks": [{ "id": "task-1", "subject": "s", "description": "d",
                        "status": "completed", "ready": true }]
        });
        let task = &normalize_team("s1", &frame).tasks[0];
        assert_eq!(task.status, TeamTaskStatus::Completed);
        assert!(task.owner_id.is_none());
        assert!(task.blocked_by.is_empty());
    }
}
