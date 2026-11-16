//! Terminal WebSocket: `GET /companion/api/terminal/ws?ticket=<ticket>&id=<session>`.
//!
//! One socket mirrors one desktop session. Attaching never creates or kills a
//! session: the phone can come and go while the desktop tab keeps running, and
//! closing the socket only detaches.
//!
//! The phone first redeems a single-use ticket via
//! `feature("terminal_ticket", { id })` (60s TTL, bound to that session), then
//! attaches with `ticket` + `id`. The ticket wins over the legacy `t` session
//! token, which stays accepted for phone builds that predate tickets. Both
//! arrive in the query because a browser WebSocket cannot set an
//! `Authorization` header.
//!
//! A bad ticket (unknown, expired, mismatched session or no `id` at all) is
//! rejected *before* the upgrade with a plain 401: the phone cannot read the
//! handshake status, so it just fetches a new ticket and retries.
//!
//! The desktop keeps driving the same session through `terminal_*` commands
//! (`feature_router`), so both surfaces see one process and one replay ring.

use std::{sync::Arc, time::Duration};

use std::sync::atomic::{AtomicU64, Ordering};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::Response,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tapd_i18n::tr;
use tauri::Manager;
use tokio::sync::broadcast::{error::RecvError, Receiver};

use crate::terminal::{Session, TerminalChunk, TerminalCore};

use super::{err_data, pairing::authorize_token, CompanionCtx};

/// A phone that sleeps through a ping (backgrounded tab) must be noticed
/// before the OS keeps a half-dead socket around.
const PING_INTERVAL: Duration = Duration::from_secs(20);

#[derive(Deserialize)]
pub(super) struct TerminalQuery {
    /// Single-use attach ticket from `feature("terminal_ticket", { id })`.
    ticket: Option<String>,
    /// Legacy session token, kept while older phone builds still send it.
    t: Option<String>,
    id: Option<String>,
}

/// The credential the socket presented, already reduced to the one the handler
/// should trust. Separated from the HTTP layer so the precedence rule is
/// unit-testable without an `AppHandle`.
#[derive(Debug, PartialEq, Eq)]
enum WsCredential<'a> {
    /// A ticket identifies no session by itself, so `id` is mandatory and is
    /// checked against the ticket's binding on consumption.
    Ticket { ticket: &'a str, session: &'a str },
    /// Legacy path: long-lived session token carried as `t`.
    Token(Option<&'a str>),
}

/// A ticket takes precedence over a leftover `t`; a ticket without `id` is
/// rejected outright rather than silently falling back to the token, so a
/// broken new client cannot mask itself as a valid old one.
fn credential(query: &TerminalQuery) -> Result<WsCredential<'_>, &'static str> {
    let Some(ticket) = query.ticket.as_deref() else {
        return Ok(WsCredential::Token(query.t.as_deref()));
    };
    let session = query
        .id
        .as_deref()
        .ok_or("terminal ticket requires a session id")?;
    Ok(WsCredential::Ticket { ticket, session })
}

/// Auth is checked before the upgrade (the phone sees a plain HTTP 401). A
/// vanished session is reported *after* it: a browser WebSocket cannot read
/// the HTTP status of a failed handshake, so a pre-upgrade 404 would look like
/// a network drop and keep the phone retrying a session that no longer exists.
pub(super) async fn ws_terminal(
    ws: WebSocketUpgrade,
    Query(query): Query<TerminalQuery>,
    State(ctx): State<CompanionCtx>,
) -> Response {
    let Ok(presented) = credential(&query) else {
        return ticket_rejection();
    };
    if let Some(rejection) = authorize_ws(&ctx, presented) {
        return rejection;
    }
    let session = ctx
        .app
        .try_state::<Arc<TerminalCore>>()
        .and_then(|core| query.id.as_deref().and_then(|id| core.session(id)));
    let Some(session) = session else {
        return ws.on_upgrade(|mut socket| async move {
            let _ = send_json(
                &mut socket,
                json!({
                    "type": "error",
                    "code": "not_found",
                    "message": tr("terminal.notFound"),
                }),
            )
            .await;
            let _ = socket.send(Message::Close(None)).await;
        });
    };
    // HTTP auth only happens before the upgrade. Keep the revocation counter
    // so the socket can notice an unpair / server stop on its next tick.
    let (revoked, generation, seen) = {
        let runtime = ctx.state.companion.lock().expect("companion lock");
        (
            runtime.revoked.clone(),
            runtime.revoked_generation.clone(),
            runtime.revoked_generation.load(Ordering::SeqCst),
        )
    };
    ws.on_upgrade(move |socket| relay(socket, session, revoked, generation, seen))
}

/// Resolves a credential to pass/reject. Burning the ticket and checking its
/// session binding happen in one `consume_ticket` call, so two concurrent
/// attaches with the same ticket cannot both win.
fn authorize_ws(ctx: &CompanionCtx, credential: WsCredential<'_>) -> Option<Response> {
    match credential {
        WsCredential::Ticket { ticket, session } => {
            let accepted = ctx
                .app
                .try_state::<Arc<TerminalCore>>()
                .is_some_and(|core| core.consume_ticket(ticket, session));
            (!accepted).then(ticket_rejection)
        }
        WsCredential::Token(token) => authorize_token(&ctx.state, token.map(str::to_owned)),
    }
}

/// One generic answer for unknown, expired, mismatched or id-less tickets: a
/// prober learns nothing about which check failed.
fn ticket_rejection() -> Response {
    err_data(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        tr("terminal.ticketInvalid"),
    )
}

/// Replays the tail, then forwards live output. Ends with an exit frame and a
/// close; the session itself is untouched.
async fn relay(
    mut socket: WebSocket,
    session: Arc<Session>,
    revoked: Arc<tokio::sync::Notify>,
    generation: Arc<AtomicU64>,
    seen: u64,
) {
    let (tail, _seq, mut output) = session.snapshot_and_subscribe();
    if send_json(&mut socket, json!({ "type": "replay", "data": tail }))
        .await
        .is_err()
    {
        return;
    }

    // Subscribing before reading the flag is what makes an already-finished
    // session observable: a change after this point wakes `changed()`.
    let mut closed = session.closed();
    if *closed.borrow() {
        let _ = flush_exit(&mut socket, &session, &mut output).await;
        return;
    }

    let mut ping = tokio::time::interval(PING_INTERVAL);
    // The first tick fires immediately; the socket was just established.
    ping.tick().await;

    let revoked_since_seen = || generation.load(Ordering::SeqCst) != seen;

    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => handle_client(&session, text.as_str()),
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                // Binary frames and pongs carry nothing this protocol defines.
                _ => {}
            },
            chunk = output.recv() => match chunk {
                Ok(chunk) => {
                    if send_data(&mut socket, &chunk).await.is_err() {
                        break;
                    }
                }
                // The phone fell behind the frame stream. A fresh replay lets
                // it reset the screen instead of rendering a hole.
                Err(RecvError::Lagged(_)) => {
                    let (tail, _) = session.snapshot();
                    if send_json(&mut socket, json!({ "type": "replay", "data": tail }))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(RecvError::Closed) => break,
            },
            _ = closed.changed() => {
                let _ = flush_exit(&mut socket, &session, &mut output).await;
                break;
            }
            // Unpair / disable bump the generation: stop relaying at once.
            _ = revoked.notified() => {
                if revoked_since_seen() {
                    let _ = send_json(
                        &mut socket,
                        json!({
                            "type": "error",
                            "code": "unauthorized",
                            "message": tr("terminal.ticketInvalid"),
                        }),
                    )
                    .await;
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
            }
            _ = ping.tick() => {
                // `notify_waiters` only wakes sockets already waiting, so the
                // generation is also checked on every keepalive tick.
                if revoked_since_seen() {
                    let _ = send_json(
                        &mut socket,
                        json!({
                            "type": "error",
                            "code": "unauthorized",
                            "message": tr("terminal.ticketInvalid"),
                        }),
                    )
                    .await;
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }
}

/// Client frames are `{"type":"input"|"resize", …}`. Unknown types are ignored
/// so a newer phone build cannot break an older desktop.
fn handle_client(session: &Arc<Session>, text: &str) {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        return;
    };
    match message.get("type").and_then(Value::as_str) {
        Some("input") => {
            let data = message
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // Queue only: the session's writer thread owns the blocking PTY IO,
            // so this frame handler never stalls the socket loop.
            let _ = session.write(data);
        }
        Some("resize") => {
            let cols = dimension(&message, "cols");
            let rows = dimension(&message, "rows");
            session.resize(cols, rows);
        }
        _ => {}
    }
}

fn dimension(message: &Value, key: &str) -> u16 {
    message
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(0)
}

/// Queued frames must reach the phone before `exit`, or the last prompt is
/// lost. Lagged frames are dropped: the session is over anyway.
async fn flush_exit(
    socket: &mut WebSocket,
    session: &Session,
    output: &mut Receiver<TerminalChunk>,
) -> Result<(), ()> {
    while let Ok(chunk) = output.try_recv() {
        send_data(socket, &chunk).await?;
    }
    send_json(
        socket,
        json!({ "type": "exit", "code": session.exit_code() }),
    )
    .await?;
    // Say goodbye explicitly instead of relying on the drop closing the frame.
    let _ = socket.send(Message::Close(None)).await;
    Ok(())
}

async fn send_data(socket: &mut WebSocket, chunk: &TerminalChunk) -> Result<(), ()> {
    send_json(socket, json!({ "type": "data", "data": chunk.data })).await
}

async fn send_json(socket: &mut WebSocket, value: Value) -> Result<(), ()> {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .map_err(|_| ())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn query(ticket: Option<&str>, t: Option<&str>, id: Option<&str>) -> TerminalQuery {
        TerminalQuery {
            ticket: ticket.map(str::to_owned),
            t: t.map(str::to_owned),
            id: id.map(str::to_owned),
        }
    }

    #[test]
    fn ticket_and_session_id_form_the_ticket_credential() {
        assert_eq!(
            credential(&query(Some("tk"), None, Some("s1"))),
            Ok(WsCredential::Ticket {
                ticket: "tk",
                session: "s1"
            })
        );
    }

    #[test]
    fn ticket_without_session_id_is_rejected() {
        assert!(credential(&query(Some("tk"), None, None)).is_err());
        // 即便同时带了旧 token 也不回退：新客户端必须带上 id。
        assert!(credential(&query(Some("tk"), Some("tok"), None)).is_err());
    }

    #[test]
    fn bare_token_keeps_the_legacy_credential() {
        assert_eq!(
            credential(&query(None, Some("tok"), Some("s1"))),
            Ok(WsCredential::Token(Some("tok")))
        );
    }

    #[test]
    fn ticket_wins_over_a_leftover_token() {
        assert_eq!(
            credential(&query(Some("tk"), Some("tok"), Some("s1"))),
            Ok(WsCredential::Ticket {
                ticket: "tk",
                session: "s1"
            })
        );
    }

    #[test]
    fn no_credential_yields_an_empty_token() {
        // 沿用旧路径：由 `authorize_token` 统一拒绝。
        assert_eq!(
            credential(&query(None, None, Some("s1"))),
            Ok(WsCredential::Token(None))
        );
    }
}
