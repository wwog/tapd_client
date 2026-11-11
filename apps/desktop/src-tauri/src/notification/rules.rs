//! Pure notification business rules.
//!
//! Classification, TAPD timestamp handling, quiet hours, seen-row pruning and
//! de-duplication keys. Everything here is deterministic and side-effect free,
//! so the rules stay unit-testable without a TAPD session or a database.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{Duration as ChronoDuration, NaiveDateTime, NaiveTime};
use serde_json::Value;

use super::{
    model::{NotificationKind, NotificationStore, QuietHours, SeenBug},
    FRESH_WINDOW_MINUTES, MAX_SEEN_ENTRIES, SEEN_RETENTION_DAYS, SELF_CLAIM_TTL_SECS,
};

pub fn parse_tapd_time(raw: &str) -> Option<NaiveDateTime> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M"))
        .ok()
}

pub fn format_tapd_time(time: NaiveDateTime) -> String {
    time.format("%Y-%m-%d %H:%M:%S").to_string()
}

pub(super) fn is_recent(raw: &str, now: NaiveDateTime, minutes: i64) -> bool {
    let Some(time) = parse_tapd_time(raw) else {
        return false;
    };
    let delta = now - time;
    delta.num_minutes() <= minutes && delta.num_minutes() >= -1
}

fn assigned_recently(created: &str, assigned_time: &str, now: NaiveDateTime) -> bool {
    let Some(assigned) = parse_tapd_time(assigned_time) else {
        return false;
    };
    // "Assigned at creation time" means the bug was created for me, not transferred.
    if let Some(created) = parse_tapd_time(created) {
        if (assigned - created).num_seconds().abs() <= 60 {
            return false;
        }
    }
    let delta = now - assigned;
    delta.num_minutes() <= 10 && delta.num_minutes() >= -1
}

/// Classifies a bug into a notification kind.
///
/// `open` is handled exactly like `new` (both are non-reopened starting
/// statuses), so it is still split into `new` vs `transferred` by creation and
/// assignment time.
///
/// `previous` is the last observed state for this bug (`None` = first sighting
/// after the baseline). `trust_recent_assignment` is true for `scope=mine`,
/// where a newly visible bug owned by me can be assumed to have just been
/// assigned even if `assigned_time` is unavailable. For `scope=project` the
/// caller looks up the detail first; without `assigned_time` we stay silent to
/// avoid notifying on every comment.
pub fn classify_bug(
    status: &str,
    owner: &str,
    created: &str,
    assigned_time: &str,
    previous: Option<&SeenBug>,
    me: &str,
    now: NaiveDateTime,
    trust_recent_assignment: bool,
) -> Option<NotificationKind> {
    let me = me.trim();
    if me.is_empty() {
        return None;
    }
    let status = status.trim();
    let owner = owner.trim();

    if let Some(previous) = previous {
        if status == "reopened" && previous.status.trim() != "reopened" {
            return Some(NotificationKind::Reopened);
        }
        if owner == me && previous.owner.trim() != me {
            return Some(NotificationKind::Transferred);
        }
        // scope=mine never observes the bug while it is assigned to someone
        // else, so a transfer back looks like "owner unchanged". A new
        // assigned_time is the only evidence TAPD gives us; comparing it with
        // the last observed value yields one notification per assignment
        // instead of one forever (the old lifetime de-dupe).
        if owner == me
            && previous.owner.trim() == me
            && previous.assigned_time.trim() != assigned_time.trim()
            && assigned_recently(created, assigned_time, now)
        {
            return Some(NotificationKind::Transferred);
        }
        return None;
    }

    if status == "reopened" {
        return Some(NotificationKind::Reopened);
    }
    // `open` deliberately goes through the same new/transferred split as `new`.
    if is_recent(created, now, FRESH_WINDOW_MINUTES) {
        return Some(NotificationKind::New);
    }
    let recently_assigned = assigned_recently(created, assigned_time, now);
    let assumption = trust_recent_assignment && owner == me && assigned_time.trim().is_empty();
    if owner == me && (recently_assigned || assumption) {
        return Some(NotificationKind::Transferred);
    }

    None
}

fn parse_hhmm(raw: &str) -> Option<NaiveTime> {
    let (hour, minute) = raw.trim().split_once(':')?;
    let hour: u32 = hour.trim().parse().ok()?;
    let minute: u32 = minute.trim().parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    NaiveTime::from_hms_opt(hour, minute, 0)
}

pub fn is_hhmm(raw: &str) -> bool {
    parse_hhmm(raw).is_some()
}

pub fn quiet_hours_active(quiet: &QuietHours, now: NaiveTime) -> bool {
    if !quiet.enabled {
        return false;
    }
    let (Some(start), Some(end)) = (parse_hhmm(&quiet.start), parse_hhmm(&quiet.end)) else {
        return false;
    };
    if start == end {
        return false;
    }
    if start < end {
        now >= start && now < end
    } else {
        // Window crosses midnight, e.g. 22:00 -> 09:00.
        now >= start || now < end
    }
}

/// Extracts the workspace id from `https://www.tapd.cn/tapd_fe/<id>/...`.
pub fn workspace_from_session_url(raw: &str) -> Option<String> {
    let (_, rest) = raw.split_once("tapd_fe/")?;
    let segment = rest.split(['/', '?', '#']).next()?.trim();
    if !segment.is_empty() && segment.chars().all(|character| character.is_ascii_digit()) {
        Some(segment.to_string())
    } else {
        None
    }
}

/// The first completed round after a session starts is silent: it only records
/// state, so entering the app never replays a backlog. `baseline` (no cursor)
/// is always silent; a truncated incremental round stays unprimed and is silent
/// again until it consumes the whole window.
pub(super) fn round_is_silent(baseline: bool, primed: bool) -> bool {
    baseline || !primed
}

/// Drops seen entries untouched for `SEEN_RETENTION_DAYS`, then keeps at most
/// `MAX_SEEN_ENTRIES` newest rows. Returns the removed keys for the DB mirror.
pub(super) fn prune_seen(store: &mut NotificationStore, now: NaiveDateTime) -> Vec<String> {
    let cutoff = now - ChronoDuration::days(SEEN_RETENTION_DAYS);
    let mut remove: BTreeSet<String> = store
        .seen
        .iter()
        .filter(|(_, seen)| parse_tapd_time(&seen.last_seen).is_some_and(|last| last < cutoff))
        .map(|(key, _)| key.clone())
        .collect();

    if store.seen.len().saturating_sub(remove.len()) > MAX_SEEN_ENTRIES {
        let mut keep: Vec<(String, NaiveDateTime)> = store
            .seen
            .iter()
            .filter(|(key, _)| !remove.contains(key.as_str()))
            .map(|(key, seen)| (key.clone(), parse_tapd_time(&seen.last_seen).unwrap_or(now)))
            .collect();
        keep.sort_by(|left, right| right.1.cmp(&left.1));
        remove.extend(keep.into_iter().skip(MAX_SEEN_ENTRIES).map(|(key, _)| key));
    }

    for key in &remove {
        store.seen.remove(key);
    }
    // An ignored key only matters while its bug is still tracked; drop it with
    // the seen row so `notification_ignored` cannot grow forever.
    store.ignored.retain(|key| !remove.contains(key));
    remove.into_iter().collect()
}

/// Whether this `(workspace, bug, kind)` de-dup key was already emitted.
pub(super) fn already_notified(kinds: &[String], kind: NotificationKind) -> bool {
    kinds
        .iter()
        .filter_map(|sent| NotificationKind::parse(sent))
        .any(|sent| sent == kind)
}

/// Removes `key` from the pending self-claims, dropping expired entries first.
/// Returns whether the claim was still fresh (i.e. should be suppressed).
pub(super) fn take_claim_entry(claims: &mut BTreeMap<String, i64>, key: &str, now: i64) -> bool {
    claims.retain(|_, at| now - *at <= SELF_CLAIM_TTL_SECS && *at <= now + 60);
    claims.remove(key).is_some()
}

/// Nickname of the signed-in user in a `user_workspace` response.
pub(super) fn current_user_nick(root: &Value) -> String {
    root.pointer("/data/get_current_user_ret/data/user_nick")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// Tests — pure business rules only (no TAPD calls).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    use crate::notification::{
        model::{
            bug_key, scope_allows, NotificationKind, NotificationScope, NotificationSettings,
            NotificationStore, QuietHours, SeenBug,
        },
        DEFAULT_POLL_INTERVAL_SECS, SELF_CLAIM_TTL_SECS,
    };

    fn at(hour: u32, minute: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, 10)
            .expect("date")
            .and_hms_opt(hour, minute, 0)
            .expect("time")
    }

    fn seen(status: &str, owner: &str, kinds: &[&str]) -> SeenBug {
        SeenBug {
            status: status.to_string(),
            owner: owner.to_string(),
            created: "2026-11-09 09:00:00".to_string(),
            assigned_time: String::new(),
            kinds: kinds.iter().map(|kind| kind.to_string()).collect(),
            last_seen: String::new(),
        }
    }

    #[test]
    fn fresh_created_bug_is_new() {
        let kind = classify_bug(
            "new",
            "何帅",
            "2026-11-10 11:58:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::New));
    }

    #[test]
    fn old_bug_first_seen_for_me_is_transferred() {
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Transferred));
    }

    #[test]
    fn list_observation_silences_the_next_poll() {
        // A list refresh writes the same seen row a poll would. Once the user
        // has the bug on screen, neither a fresh creation nor a first-sighting
        // assignment may arrive later as a card.
        let previous = seen("in_progress", "何帅", &[]);
        for (status, created) in [
            ("in_progress", "2026-11-01 09:00:00"),
            ("new", "2026-11-10 11:58:00"),
        ] {
            let kind = classify_bug(
                status,
                "何帅",
                created,
                "",
                Some(&previous),
                "何帅",
                at(12, 0),
                true,
            );
            assert_eq!(
                kind, None,
                "{status} seen in the list must not notify on the next poll"
            );
        }
    }

    #[test]
    fn recent_assignment_wins_over_creation_time() {
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "2026-11-10 11:57:00",
            None,
            "何帅",
            at(12, 0),
            false,
        );
        assert_eq!(kind, Some(NotificationKind::Transferred));
    }

    #[test]
    fn project_scope_needs_evidence_for_transfer() {
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            false,
        );
        assert_eq!(kind, None);
    }

    #[test]
    fn owner_change_on_known_bug_is_transferred() {
        let previous = seen("in_progress", "郭俊宏", &["new"]);
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-09 09:00:00",
            "",
            Some(&previous),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Transferred));
    }

    #[test]
    fn comment_only_change_is_not_a_notification() {
        let previous = seen("in_progress", "何帅", &["new"]);
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-09 09:00:00",
            "",
            Some(&previous),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, None);
    }

    #[test]
    fn reopened_status_wins_over_everything() {
        let previous = seen("resolved", "何帅", &["new"]);
        let kind = classify_bug(
            "reopened",
            "何帅",
            "2026-11-01 09:00:00",
            "",
            Some(&previous),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Reopened));
    }

    #[test]
    fn first_sighting_of_reopened_bug_is_reopened() {
        let kind = classify_bug(
            "reopened",
            "郭俊宏",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Reopened));
    }

    #[test]
    fn open_is_classified_like_new() {
        // A fresh `open` bug is a new notification.
        let fresh = classify_bug(
            "open",
            "何帅",
            "2026-11-10 11:58:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(fresh, Some(NotificationKind::New));

        // An old `open` bug that just appeared for me is a transfer.
        let transferred = classify_bug(
            "open",
            "何帅",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(transferred, Some(NotificationKind::Transferred));

        // Someone else's old `open` bug is not mine to notify in mine scope.
        let not_mine = classify_bug(
            "open",
            "郭俊宏",
            "2026-11-01 09:00:00",
            "",
            None,
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(not_mine, None);
    }

    #[test]
    fn missing_me_disables_classification() {
        let kind = classify_bug(
            "new",
            "",
            "2026-11-10 11:59:00",
            "",
            None,
            "  ",
            at(12, 0),
            true,
        );
        assert_eq!(kind, None);
    }

    #[test]
    fn scope_filter_matches_owner() {
        assert!(scope_allows(NotificationScope::Mine, "何帅", "何帅"));
        assert!(!scope_allows(NotificationScope::Mine, "郭俊宏", "何帅"));
        assert!(scope_allows(NotificationScope::Project, "郭俊宏", "何帅"));
    }

    #[test]
    fn kinds_dedupe_by_kind() {
        let sent = vec!["new".to_string()];
        assert!(already_notified(&sent, NotificationKind::New));
        assert!(!already_notified(&sent, NotificationKind::Reopened));
        assert_eq!(bug_key(" 45336192 ", " 1 "), "45336192:1");
    }

    #[test]
    fn quiet_hours_cross_midnight() {
        let quiet = QuietHours {
            enabled: true,
            start: "22:00".to_string(),
            end: "09:00".to_string(),
        };
        assert!(quiet_hours_active(
            &quiet,
            NaiveTime::from_hms_opt(23, 0, 0).unwrap()
        ));
        assert!(quiet_hours_active(
            &quiet,
            NaiveTime::from_hms_opt(8, 59, 0).unwrap()
        ));
        assert!(!quiet_hours_active(
            &quiet,
            NaiveTime::from_hms_opt(9, 0, 0).unwrap()
        ));
        assert!(!quiet_hours_active(
            &quiet,
            NaiveTime::from_hms_opt(12, 0, 0).unwrap()
        ));
    }

    #[test]
    fn quiet_hours_within_day_and_disabled() {
        let quiet = QuietHours {
            enabled: true,
            start: "12:00".to_string(),
            end: "13:30".to_string(),
        };
        assert!(quiet_hours_active(
            &quiet,
            NaiveTime::from_hms_opt(13, 0, 0).unwrap()
        ));
        assert!(!quiet_hours_active(
            &quiet,
            NaiveTime::from_hms_opt(13, 30, 0).unwrap()
        ));

        let disabled = QuietHours {
            enabled: false,
            ..quiet
        };
        assert!(!quiet_hours_active(
            &disabled,
            NaiveTime::from_hms_opt(13, 0, 0).unwrap()
        ));
    }

    #[test]
    fn settings_are_clamped() {
        let settings = NotificationSettings {
            poll_interval_secs: 5,
            max_visible: 42,
            ..NotificationSettings::default()
        }
        .normalized();
        assert_eq!(settings.poll_interval_secs, 20);
        assert_eq!(settings.max_visible, 5);

        let settings = NotificationSettings {
            poll_interval_secs: 5000,
            max_visible: 0,
            ..NotificationSettings::default()
        }
        .normalized();
        assert_eq!(settings.poll_interval_secs, 600);
        assert_eq!(settings.max_visible, 1);
    }

    #[test]
    fn default_poll_interval_is_30s() {
        assert_eq!(
            NotificationSettings::default().poll_interval_secs,
            DEFAULT_POLL_INTERVAL_SECS
        );
        assert_eq!(DEFAULT_POLL_INTERVAL_SECS, 30);
    }

    #[test]
    fn the_first_round_of_a_session_is_silent() {
        assert!(round_is_silent(true, false));
        assert!(round_is_silent(false, false));
        assert!(round_is_silent(true, true));
        assert!(!round_is_silent(false, true));
    }

    #[test]
    fn transfer_back_is_detected_from_a_new_assigned_time() {
        let mut previous = seen("in_progress", "何帅", &["new"]);
        previous.assigned_time = "2026-11-01 09:00:00".to_string();

        // "Mine" never saw the bug while it was assigned to someone else, so
        // the new assigned_time is the only transfer evidence.
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "2026-11-10 11:58:00",
            Some(&previous),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, Some(NotificationKind::Transferred));

        // The same assignment observed again on the next round stays silent.
        let mut observed = previous.clone();
        observed.assigned_time = "2026-11-10 11:58:00".to_string();
        let kind = classify_bug(
            "in_progress",
            "何帅",
            "2026-11-01 09:00:00",
            "2026-11-10 11:58:00",
            Some(&observed),
            "何帅",
            at(12, 0),
            true,
        );
        assert_eq!(kind, None);
    }

    #[test]
    fn prune_seen_drops_stale_rows() {
        let now = at(12, 0);
        let mut store = NotificationStore::default();
        store.seen.insert(
            "1:1".to_string(),
            SeenBug {
                last_seen: "2026-11-10 11:00:00".to_string(),
                ..SeenBug::default()
            },
        );
        store.seen.insert(
            "1:2".to_string(),
            SeenBug {
                last_seen: "2025-01-01 00:00:00".to_string(),
                ..SeenBug::default()
            },
        );

        let removed = prune_seen(&mut store, now);
        assert_eq!(removed, vec!["1:2".to_string()]);
        assert!(store.seen.contains_key("1:1"));
    }

    #[test]
    fn extracts_workspace_from_session_url() {
        assert_eq!(
            workspace_from_session_url("https://www.tapd.cn/tapd_fe/45336192/bug/list"),
            Some("45336192".to_string())
        );
        assert_eq!(
            workspace_from_session_url("https://www.tapd.cn/tapd_fe/123/my/work?x=1"),
            Some("123".to_string())
        );
        assert_eq!(
            workspace_from_session_url("https://www.tapd.cn/login"),
            None
        );
        assert_eq!(
            workspace_from_session_url("https://www.tapd.cn/tapd_fe/my/work"),
            None
        );
    }

    #[test]
    fn self_claim_is_consumed_once_and_expires() {
        let key = bug_key("1", "2");
        let mut claims = BTreeMap::new();
        claims.insert(key.clone(), 1_000);
        assert!(take_claim_entry(&mut claims, &key, 1_120));
        // One claim explains one observation only.
        assert!(!take_claim_entry(&mut claims, &key, 1_120));

        claims.insert(key.clone(), 1_000);
        assert!(!take_claim_entry(
            &mut claims,
            &key,
            1_000 + SELF_CLAIM_TTL_SECS + 1
        ));
        assert!(claims.is_empty(), "expired entries are pruned");
    }

    #[test]
    fn timestamps_round_trip() {
        let time = at(12, 34);
        assert_eq!(format_tapd_time(time), "2026-11-10 12:34:00");
        assert_eq!(parse_tapd_time("2026-11-10 12:34:00"), Some(time));
        assert_eq!(parse_tapd_time(""), None);
    }
}
