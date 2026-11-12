//! Pairing and session auth for the companion server.
//!
//! The pair route exchanges a one-time code (or nothing, while test-phase
//! direct pairing is on) for a long-lived session token; every other route
//! authenticates with `Authorization: Bearer <token>` whose SHA-256 must
//! match a paired device. Rate limiting is one sliding per-IP window
//! implementation shared by the pair route (10/min) and the feature proxy
//! (60/min, see `feature`).

use std::{
    collections::{HashMap, VecDeque},
    net::IpAddr,
    time::{Duration, Instant},
};

use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::json;
use tapd_core::config::CompanionDevice;

use crate::{server::opaque_token, state::SharedState};

use super::{err_data, ok_data, CompanionCtx};

/// Pairing rate limit: more than 10 attempts per IP per minute are rejected.
const PAIR_MAX_ATTEMPTS: usize = 10;
const PAIR_WINDOW: Duration = Duration::from_secs(60);
/// Fallback device name when the phone sends none.
const DEFAULT_DEVICE_NAME: &str = "移动设备";
/// Device names are display text; keep them short.
const MAX_DEVICE_NAME_CHARS: usize = 24;

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/// Sliding-window attempt budget per client IP. One implementation, two
/// budgets: pairing uses `default()` (10/min), the feature proxy builds its
/// own wider one via `new`.
pub(super) struct RateLimiter {
    max_attempts: usize,
    window: Duration,
    attempts: HashMap<IpAddr, VecDeque<Instant>>,
}

impl Default for RateLimiter {
    /// The pairing budget: 10 attempts per minute.
    fn default() -> Self {
        Self::new(PAIR_MAX_ATTEMPTS, PAIR_WINDOW)
    }
}

impl RateLimiter {
    pub(super) fn new(max_attempts: usize, window: Duration) -> Self {
        Self {
            max_attempts,
            window,
            attempts: HashMap::new(),
        }
    }

    /// Records an attempt and reports whether it is within the limit.
    pub(super) fn allows(&mut self, ip: IpAddr, now: Instant) -> bool {
        let attempts = self.attempts.entry(ip).or_default();
        while attempts
            .front()
            .is_some_and(|at| now.duration_since(*at) >= self.window)
        {
            attempts.pop_front();
        }
        if attempts.len() >= self.max_attempts {
            if attempts.is_empty() {
                self.attempts.remove(&ip);
            }
            return false;
        }
        attempts.push_back(now);
        true
    }
}

// ---------------------------------------------------------------------------
// Session auth
// ---------------------------------------------------------------------------

/// Session auth: `Authorization: Bearer <token>` whose SHA-256 matches a
/// paired device. Unpairing deletes the entry, so the phone's next request
/// fails here. `Some(response)` is the rejection to return early — including
/// a missing/malformed header.
pub(super) fn authorize(state: &SharedState, headers: &HeaderMap) -> Option<Response> {
    authorize_token(state, bearer_token(headers))
}

/// Same check, for callers whose token arrives outside a header. `<img>` /
/// `<video>` requests cannot set `Authorization`, so media accepts the session
/// token via a `t` query parameter instead.
pub(super) fn authorize_token(state: &SharedState, token: Option<String>) -> Option<Response> {
    let unauthorized = || {
        err_data(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "会话已失效，请重新配对",
        )
    };
    let paired = token.is_some_and(|token| {
        token_is_paired(
            &state.config.lock().expect("config lock").companion.devices,
            &token,
        )
    });
    (!paired).then(unauthorized)
}

/// Whether the presented session token matches a paired device's stored hash.
fn token_is_paired(devices: &[CompanionDevice], token: &str) -> bool {
    let token_hash = sha256_hex(token);
    devices
        .iter()
        .any(|device| device.token_hash == token_hash)
}

/// Business endpoints answer `not_logged_in` while the desktop has no TAPD
/// session; the phone renders its offline state from this code.
pub(super) fn require_logged_in(state: &SharedState) -> Option<Response> {
    let logged_in = state.config.lock().expect("config lock").logged_in;
    (!logged_in).then(|| {
        err_data(
            StatusCode::FORBIDDEN,
            "not_logged_in",
            "桌面端尚未登录 TAPD",
        )
    })
}

pub(super) fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .trim();
    value
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

/// Lowercase hex SHA-256. The config stores only the hash; the raw token
/// lives on the phone.
fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(input.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

// ---------------------------------------------------------------------------
// Pair route
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(super) struct PairRequest {
    /// Absent when pairing codes are switched off (direct pairing).
    token: Option<String>,
    name: Option<String>,
}

/// Exchanges a one-time pairing code for a long-lived session token.
/// Deliberately unauthenticated: the code is the secret.
pub(super) async fn pair(
    State(ctx): State<CompanionCtx>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    Json(request): Json<PairRequest>,
) -> Response {
    let allowed = ctx
        .pair_limiter
        .lock()
        .expect("pair rate limiter lock")
        .allows(peer.ip(), Instant::now());
    if !allowed {
        return err_data(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "配对请求过于频繁，请稍后再试",
        );
    }

    // Off = test-phase direct pairing: knowing the address is the only gate.
    if ctx.state.config_snapshot().companion.require_pairing_code {
        let matched = {
            let mut runtime = ctx.state.companion.lock().expect("companion lock");
            runtime.consume_pairing_code(
                request.token.as_deref().unwrap_or("").trim(),
                chrono::Utc::now(),
            )
        };
        if !matched {
            return err_data(
                StatusCode::UNAUTHORIZED,
                "pairing_invalid",
                "配对码无效或已过期",
            );
        }
    }

    let token = opaque_token();
    let device = CompanionDevice {
        id: uuid::Uuid::new_v4().to_string(),
        name: normalize_device_name(request.name.as_deref()),
        token_hash: sha256_hex(&token),
        paired_at: chrono::Utc::now().to_rfc3339(),
    };
    // Replace-by-name: one phone keeps one slot, re-pairing rotates its token.
    let saved = ctx.state.update_config(|config| {
        upsert_device_by_name(&mut config.companion.devices, device)
    });
    match saved {
        Ok(()) => ok_data(json!({ "sessionToken": token })),
        Err(error) => {
            tracing::error!(%error, "failed to persist paired companion device");
            err_data(
                StatusCode::INTERNAL_SERVER_ERROR,
                "save_failed",
                "配对信息保存失败",
            )
        }
    }
}

/// Display name from the phone: trimmed, capped at 24 characters, blank names
/// fall back to a default so every device entry stays readable in settings.
fn normalize_device_name(raw: Option<&str>) -> String {
    let trimmed = raw.unwrap_or_default().trim();
    if trimmed.is_empty() {
        return DEFAULT_DEVICE_NAME.to_string();
    }
    trimmed.chars().take(MAX_DEVICE_NAME_CHARS).collect()
}

/// Registers a device by name: re-pairing with the same name overwrites the
/// previous entry (token + time), a new name appends.
fn upsert_device_by_name(devices: &mut Vec<CompanionDevice>, device: CompanionDevice) {
    match devices.iter_mut().find(|existing| existing.name == device.name) {
        Some(existing) => *existing = device,
        None => devices.push(device),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::{CompanionRuntime, PairingCode};
    use std::net::Ipv4Addr;
    use tapd_core::config::CompanionConfig;

    fn device(name: &str, token_hash: &str) -> CompanionDevice {
        CompanionDevice {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            token_hash: token_hash.to_string(),
            paired_at: "2026-11-13T00:00:00+00:00".to_string(),
        }
    }

    fn runtime_with_code(expires_in_secs: i64) -> CompanionRuntime {
        CompanionRuntime {
            pairing: Some(PairingCode {
                code: "pair-code".to_string(),
                expires_at: chrono::Utc::now() + chrono::Duration::seconds(expires_in_secs),
            }),
            ..CompanionRuntime::default()
        }
    }

    #[test]
    fn valid_pairing_code_is_consumed_exactly_once() {
        let mut runtime = runtime_with_code(60);
        let now = chrono::Utc::now();

        assert!(runtime.consume_pairing_code("pair-code", now));
        // 第二次提交同一个码：已作废，必须拒绝。
        assert!(!runtime.consume_pairing_code("pair-code", now));
    }

    #[test]
    fn expired_pairing_code_is_rejected() {
        let mut runtime = runtime_with_code(-1);
        assert!(!runtime.consume_pairing_code("pair-code", chrono::Utc::now()));
    }

    #[test]
    fn unknown_pairing_code_is_rejected() {
        let mut runtime = runtime_with_code(60);
        assert!(!runtime.consume_pairing_code("something-else", chrono::Utc::now()));
    }

    #[test]
    fn paired_session_token_authorizes() {
        let token = opaque_token();
        let devices = vec![device("手机", &sha256_hex(&token))];
        assert!(token_is_paired(&devices, &token));
    }

    #[test]
    fn unpaired_session_token_is_rejected() {
        let devices = vec![device("手机", &sha256_hex("phone-A-token"))];
        assert!(!token_is_paired(&devices, "phone-B-token"));
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn pairing_flood_within_a_minute_is_rate_limited() {
        let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let mut limiter = RateLimiter::default();
        let now = Instant::now();

        for _ in 0..10 {
            assert!(limiter.allows(ip, now));
        }
        // 第 11 次/分钟：拒绝。
        assert!(!limiter.allows(ip, now));
    }

    #[test]
    fn pairing_attempts_are_forgotten_after_a_minute() {
        let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let mut limiter = RateLimiter::default();
        let start = Instant::now();

        for _ in 0..10 {
            assert!(limiter.allows(ip, start));
        }
        assert!(!limiter.allows(ip, start + PAIR_WINDOW - Duration::from_secs(1)));
        // 窗口滑出后恢复放行。
        assert!(limiter.allows(ip, start + PAIR_WINDOW + Duration::from_secs(1)));
    }

    #[test]
    fn rate_limit_is_counted_per_ip() {
        let mut limiter = RateLimiter::default();
        let now = Instant::now();
        let phone = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 2));
        let laptop = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 3));

        for _ in 0..10 {
            assert!(limiter.allows(phone, now));
        }
        // 另一个 IP 不受影响。
        assert!(limiter.allows(laptop, now));
        assert!(!limiter.allows(phone, now));
    }

    #[test]
    fn companion_config_roundtrips_camel_case() {
        let config = CompanionConfig {
            enabled: true,
            require_pairing_code: true,
            devices: vec![device("iPhone 15", &sha256_hex("token"))],
        };

        let raw = serde_json::to_string(&config).expect("serialize companion config");
        assert!(raw.contains("\"tokenHash\""), "wire key must be camelCase: {raw}");
        assert!(raw.contains("\"pairedAt\""), "wire key must be camelCase: {raw}");

        let parsed: CompanionConfig =
            serde_json::from_str(&raw).expect("deserialize companion config");
        assert_eq!(parsed, config);
    }

    #[test]
    fn companion_config_defaults_to_disabled_and_empty() {
        let parsed: CompanionConfig = serde_json::from_str("{}").expect("parse empty object");
        assert!(!parsed.enabled);
        assert!(parsed.require_pairing_code, "code gate must default on");
        assert!(parsed.devices.is_empty());
    }

    #[test]
    fn re_pairing_same_name_replaces_token_not_row() {
        let mut devices = vec![device("iPhone", "old-hash")];
        let replacement = device("iPhone", "new-hash");

        upsert_device_by_name(&mut devices, replacement);

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].token_hash, "new-hash");
    }

    #[test]
    fn pairing_with_new_name_appends_device() {
        let mut devices = vec![device("iPhone", "hash-a")];

        upsert_device_by_name(&mut devices, device("iPad", "hash-b"));

        assert_eq!(devices.len(), 2);
        let names: Vec<&str> = devices.iter().map(|device| device.name.as_str()).collect();
        assert_eq!(names, vec!["iPhone", "iPad"]);
    }

    #[test]
    fn blank_device_name_falls_back_to_default() {
        assert_eq!(normalize_device_name(None), DEFAULT_DEVICE_NAME);
        assert_eq!(normalize_device_name(Some("   ")), DEFAULT_DEVICE_NAME);
    }

    #[test]
    fn device_name_is_trimmed_and_capped_at_24_chars() {
        assert_eq!(normalize_device_name(Some("  手机 ")), "手机");
        let long = "零一二三四五六七八九十零一二三四五六七八九十零一二三四五";
        assert_eq!(normalize_device_name(Some(long)).chars().count(), 24);
    }
}
