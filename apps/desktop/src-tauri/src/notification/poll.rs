//! Background poll runtime.
//!
//! Resolves the signed-in user plus accessible projects, fetches bug pages
//! with bounded paging and overlap, and turns the observed changes into
//! notification cards. The first round per workspace is a silent baseline.

use std::collections::BTreeMap;
use std::sync::{atomic::Ordering, Arc};
use std::time::Duration;

use chrono::{Duration as ChronoDuration, Local, NaiveDateTime};
use tauri::Emitter;
use tapd_core::{
    config::AppConfig,
    tapd::{
        api::{bug_list_url, parse_bug_list, parse_workspaces, user_workspace_url, BugQuery},
        Workspace,
    },
};

use crate::{
    commands::auth::session_request_json,
    notification_db::{self, PollWrite},
};

use super::{
    fetch_bug,
    model::{
        bug_key, scope_allows, trim_oldest_items, NotificationItem, NotificationKind,
        NotificationScope, NotificationSettings, NotificationSource, NotificationState, SeenBug,
    },
    rules::{
        already_notified, classify_bug, current_user_nick, format_tapd_time, is_recent,
        parse_tapd_time, prune_seen, round_is_silent, workspace_from_session_url,
    },
    NotificationService, MAX_BASELINE_PAGES, MAX_DETAIL_LOOKUPS, MAX_ITEMS, MAX_POLL_PAGES,
    OVERLAP_MINUTES, POLL_PAGE_DELAY, POLL_PAGE_SIZE, SESSION_SEQ,
};

/// Result of one poll round. A round can partially succeed (some projects
/// polled, others failed), so "did poll" and the error are tracked separately.
#[derive(Debug, Default)]
pub(super) struct PollReport {
    pub(super) polled: bool,
    /// At least one notification item was created this round.
    pub(super) notified: bool,
    pub(super) error: Option<String>,
}

impl NotificationService {
    pub(super) async fn poll_once(self: &Arc<Self>) {
        let result = self.poll_inner().await;
        let mut notify_list = false;

        match result {
            Ok(report) => {
                notify_list = report.notified;
                *self.last_error.lock().expect("last error lock") = report.error;
                // Update the stamp if any project was polled: a single broken
                // project must not make an otherwise successful round look
                // like it never ran. A skipped round (logged out / no projects
                // / notifications off) still leaves the stamp untouched.
                if report.polled {
                    *self.last_poll_at.lock().expect("last poll lock") =
                        Some(Local::now().to_rfc3339());
                }
            }
            Err(error) => {
                // Pollution of the error slot is intentional: the settings page
                // shows it, but we never raise dialogs from the poll loop.
                *self.last_error.lock().expect("last error lock") = Some(error.clone());
                tracing::debug!(%error, "notification poll failed");
            }
        }

        // New bugs found by the background poll: let the main window refresh its
        // (offline-first) lists so cached data does not silently go stale. This
        // is based on emitted items, not the net item count: trimming at the
        // cap could otherwise hide a round that did produce notifications.
        if notify_list {
            let _ = self.app.emit("data://refresh", ());
        }

        self.refresh_window();
    }

    async fn poll_inner(&self) -> Result<PollReport, String> {
        let settings = self.settings();
        if !settings.enabled {
            return Ok(PollReport::default());
        }

        let config = self.state.config_snapshot();
        if !config.logged_in {
            return Ok(PollReport::default());
        }

        let (me, workspaces) = self.ensure_identity("0").await?;
        let Some(me) = me else {
            return Ok(PollReport::default());
        };
        if me.trim().is_empty() || workspaces.is_empty() {
            return Ok(PollReport::default());
        }

        // "Mine" polls every accessible project. "Project" keeps the previous
        // single-project behaviour, otherwise one busy project floods the queue.
        let workspace_ids: Vec<String> = if settings.scope == NotificationScope::Mine {
            workspaces
                .iter()
                .map(|workspace| workspace.id.clone())
                .collect()
        } else {
            current_workspace_id(&config, &workspaces)
                .into_iter()
                .collect()
        };
        if workspace_ids.is_empty() {
            return Ok(PollReport::default());
        }

        let now = Local::now().naive_local();
        let session = SESSION_SEQ.load(Ordering::SeqCst);
        let mut report = PollReport::default();
        for workspace_id in workspace_ids {
            match self
                .poll_workspace(&workspace_id, &me, &settings, now, session)
                .await
            {
                Ok(notified) => {
                    report.polled = true;
                    report.notified |= notified;
                }
                Err(error) => {
                    tracing::warn!(%workspace_id, %error, "notification poll failed");
                    if report.error.is_none() {
                        report.error = Some(error);
                    }
                }
            }
        }

        // Keep the seen table bounded (time + row cap). Runs once per round,
        // outside the per-workspace loops.
        let removed = {
            let mut store = self.store.lock().expect("notification store lock");
            prune_seen(&mut store, now)
        };
        notification_db::delete_seen_and_ignored(&self.state.cache, &removed);

        Ok(report)
    }

    /// Polls one workspace. Returns whether the round created notifications.
    async fn poll_workspace(
        &self,
        workspace_id: &str,
        me: &str,
        settings: &NotificationSettings,
        now: NaiveDateTime,
        session: u64,
    ) -> Result<bool, String> {
        let (baseline, cursor, primed) = {
            let store = self.store.lock().expect("notification store lock");
            (
                // No cursor = this workspace has never been polled for this
                // account/session. The round records state but stays silent.
                !store.cursors.contains_key(workspace_id),
                store.cursors.get(workspace_id).cloned(),
                self.primed
                    .lock()
                    .expect("notification primed lock")
                    .contains(workspace_id),
            )
        };
        // The first completed round after launch/login only primes the state;
        // notifications start from the next round. A truncated round does not
        // prime, so the unread tail is absorbed silently on the retry.
        let silent = round_is_silent(baseline, primed);

        let modified_after = if baseline {
            None
        } else {
            let base = cursor
                .as_deref()
                .and_then(parse_tapd_time)
                .unwrap_or_else(|| now - ChronoDuration::minutes(10));
            Some(format_tapd_time(
                base - ChronoDuration::minutes(OVERLAP_MINUTES),
            ))
        };

        let mut query = BugQuery::new(workspace_id);
        query.perpage = POLL_PAGE_SIZE;
        query.modified_after = modified_after;
        if settings.scope == NotificationScope::Mine {
            query.owner = Some(me.to_string());
        }

        let max_pages = if baseline {
            MAX_BASELINE_PAGES
        } else {
            MAX_POLL_PAGES
        };
        let (bugs, complete) = self.fetch_bug_pages(&mut query, max_pages).await?;
        if !complete {
            tracing::warn!(
                %workspace_id,
                pages = max_pages,
                "notification poll hit the page cap; cursor stays put for a retry"
            );
        }

        // For project scope a first-seen bug owned by me may just be an old bug
        // touched by a comment. Ask the detail once for `assigned_time`.
        let mut assigned_overrides: BTreeMap<String, String> = BTreeMap::new();
        if !silent && settings.scope == NotificationScope::Project {
            let seen = self
                .store
                .lock()
                .expect("notification store lock")
                .seen
                .clone();
            let mut budget = MAX_DETAIL_LOOKUPS;
            for bug in &bugs {
                if budget == 0 {
                    break;
                }
                if bug.workspace_id.trim().is_empty() {
                    continue;
                }
                let key = bug_key(&bug.workspace_id, &bug.id);
                if seen.contains_key(&key)
                    || bug.status.trim() == "reopened"
                    || bug.owner.trim() != me
                    || !bug.assigned_time.trim().is_empty()
                    || is_recent(&bug.created, now, super::FRESH_WINDOW_MINUTES)
                {
                    continue;
                }
                budget -= 1;
                if let Ok(detail) = fetch_bug(&self.app, &bug.workspace_id, &bug.id).await {
                    if !detail.summary.assigned_time.trim().is_empty() {
                        assigned_overrides.insert(key, detail.summary.assigned_time);
                    }
                }
            }
        }

        // A login/logout during the fetch invalidates this round: writing it
        // would leak the previous account's state into the new session.
        if SESSION_SEQ.load(Ordering::SeqCst) != session {
            return Ok(false);
        }

        let names = self
            .workspace_names
            .lock()
            .expect("workspace names lock")
            .clone();
        let seen_at = format_tapd_time(now);

        // Collect mutations under the store lock, then mirror only those rows to
        // SQLite in one transaction. Nothing here rewrites the whole store.
        let (seen_updates, new_items, ignore_lifted, cursor, trim_items) = {
            let mut store = self.store.lock().expect("notification store lock");
            let mut seen_updates: Vec<(String, SeenBug)> = Vec::new();
            let mut new_items: Vec<NotificationItem> = Vec::new();
            let mut ignore_lifted: Vec<String> = Vec::new();

            for bug in &bugs {
                if bug.workspace_id.trim().is_empty() || bug.id.trim().is_empty() {
                    continue;
                }
                let key = bug_key(&bug.workspace_id, &bug.id);
                let previous = store.seen.get(&key).cloned();
                let assigned_time = assigned_overrides
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| bug.assigned_time.clone());
                let mut kinds = previous
                    .as_ref()
                    .map(|previous| previous.kinds.clone())
                    .unwrap_or_default();

                if baseline {
                    let seen = SeenBug {
                        status: bug.status.clone(),
                        owner: bug.owner.clone(),
                        created: bug.created.clone(),
                        assigned_time,
                        kinds,
                        last_seen: seen_at.clone(),
                    };
                    store.seen.insert(key.clone(), seen.clone());
                    seen_updates.push((key, seen));
                    continue;
                }

                let ignored = store.ignored.iter().any(|ignored| ignored == &key);
                let in_scope = scope_allows(settings.scope, &bug.owner, &me);
                let kind = if in_scope {
                    classify_bug(
                        &bug.status,
                        &bug.owner,
                        &bug.created,
                        &assigned_time,
                        previous.as_ref(),
                        &me,
                        now,
                        settings.scope == NotificationScope::Mine,
                    )
                } else {
                    None
                };
                // A first sighting / transfer caused by our own "认领" write is
                // not news. Reopen is left alone: it can only come from
                // someone else. The seen row below still advances, so the
                // suppressed state never fires later.
                let kind = if matches!(
                    kind,
                    Some(NotificationKind::New | NotificationKind::Transferred)
                ) && self.take_self_claim(&key)
                {
                    None
                } else {
                    kind
                };

                if matches!(kind, Some(NotificationKind::Reopened)) {
                    // Reopening lifts an ignore.
                    let before = store.ignored.len();
                    store.ignored.retain(|ignored| ignored != &key);
                    if store.ignored.len() != before {
                        ignore_lifted.push(key.clone());
                    }
                }

                let notify = if silent {
                    None
                } else {
                    match kind {
                        Some(kind) if settings.allows(kind) => {
                            let is_ignored_and_blocked =
                                ignored && kind != NotificationKind::Reopened;
                            // Reopen and transfer are transition-based (their
                            // previous state comparison already prevents
                            // repeats). "New" keys off `created`, which survives
                            // a seen-row prune, so it keeps a lifetime guard.
                            let already_sent =
                                kind == NotificationKind::New && already_notified(&kinds, kind);
                            if !is_ignored_and_blocked && !already_sent {
                                Some(kind)
                            } else {
                                None
                            }
                        }
                        _ => None,
                    }
                };

                if let Some(kind) = notify {
                    kinds.push(kind.as_str().to_string());
                    let item = NotificationItem {
                        id: uuid::Uuid::new_v4().to_string(),
                        workspace_id: bug.workspace_id.to_string(),
                        workspace_name: names
                            .get(&bug.workspace_id)
                            .cloned()
                            .unwrap_or_else(|| bug.workspace_id.to_string()),
                        bug_id: bug.id.clone(),
                        title: bug.title.clone(),
                        kind,
                        owner: bug.owner.clone(),
                        creator: bug.creator.clone(),
                        severity: bug.severity_label.clone(),
                        priority: bug.priority_label.clone(),
                        created: bug.created.clone(),
                        detected_at: Local::now().to_rfc3339(),
                        state: NotificationState::Pending,
                        source: NotificationSource::Tapd,
                        ai: None,
                    };
                    store.items.push(item.clone());
                    new_items.push(item);
                }

                let seen = SeenBug {
                    status: bug.status.clone(),
                    owner: bug.owner.clone(),
                    created: bug.created.clone(),
                    assigned_time,
                    kinds,
                    last_seen: seen_at.clone(),
                };
                store.seen.insert(key.clone(), seen.clone());
                seen_updates.push((key, seen));
            }

            // A complete round advances the cursor. An incomplete incremental
            // round keeps it so the unread tail is retried next poll; a
            // baseline always advances to avoid re-baselining every 30s.
            let cursor = if baseline || complete {
                store
                    .cursors
                    .insert(workspace_id.to_string(), seen_at.clone());
                Some(seen_at.clone())
            } else {
                None
            };
            let trim_items = trim_oldest_items(&mut store.items, MAX_ITEMS);
            (seen_updates, new_items, ignore_lifted, cursor, trim_items)
        };

        notification_db::write_poll(
            &self.state.cache,
            workspace_id,
            PollWrite {
                seen: &seen_updates,
                items: &new_items,
                ignore_lifted: &ignore_lifted,
                cursor: cursor.as_deref(),
                trim_items,
                max_items: MAX_ITEMS,
            },
        );

        if baseline || complete {
            self.primed
                .lock()
                .expect("notification primed lock")
                .insert(workspace_id.to_string());
        }

        Ok(!new_items.is_empty())
    }

    /// Fetches every page of a poll query up to `max_pages`.
    ///
    /// Returns `(bugs, complete)`. `complete == false` means the page cap was
    /// hit with a full page, so the tail is still unread.
    async fn fetch_bug_pages(
        &self,
        query: &mut BugQuery,
        max_pages: u32,
    ) -> Result<(Vec<tapd_core::tapd::BugSummary>, bool), String> {
        let mut all = Vec::new();
        let mut page_no = 1;
        loop {
            query.page = page_no;
            let root = session_request_json(
                &self.app,
                "POST",
                &bug_list_url(),
                Some(query.body()),
                Duration::from_secs(60),
            )
            .await?;
            let page = parse_bug_list(&root)?;
            let fetched = page.bugs.len();
            let total = page.total as usize;
            all.extend(page.bugs);

            let short_page = fetched < POLL_PAGE_SIZE as usize;
            // `total` is unreliable (it falls back to the page length when the
            // response omits it), so a full page alone keeps the loop going.
            let reached_total = total > 0 && all.len() >= total;
            let complete = short_page || reached_total;
            if complete || page_no >= max_pages {
                return Ok((all, complete));
            }
            // A baseline can sweep many pages; pace them instead of firing a
            // burst that TAPD may throttle.
            tokio::time::sleep(POLL_PAGE_DELAY).await;
            page_no += 1;
        }
    }

    /// Resolves the signed-in user plus the accessible workspaces in one call.
    async fn ensure_identity(
        &self,
        workspace_id: &str,
    ) -> Result<(Option<String>, Vec<Workspace>), String> {
        let cached = self
            .state
            .config_snapshot()
            .me
            .map(|me| me.trim().to_string())
            .filter(|me| !me.is_empty());

        let root = session_request_json(
            &self.app,
            "GET",
            &user_workspace_url(workspace_id),
            None,
            Duration::from_secs(30),
        )
        .await?;

        // Propagate a failed aggregation response instead of treating it as an
        // empty project list: swallowing it made an API/auth error look like a
        // successful poll (`lastPollAt` advanced, no `lastError`).
        let workspaces = parse_workspaces(&root)?;
        {
            let mut names = self.workspace_names.lock().expect("workspace names lock");
            for workspace in &workspaces {
                names.insert(workspace.id.clone(), workspace.name.clone());
            }
        }

        let nick = current_user_nick(&root);

        if !nick.is_empty() && cached.as_deref() != Some(nick.as_str()) {
            let persisted = self
                .state
                .update_config(|config| config.me = Some(nick.clone()));
            if let Err(error) = persisted {
                tracing::warn!(%error, "failed to persist current user");
            }
        }

        let resolved = if nick.is_empty() { cached } else { Some(nick) };
        Ok((resolved, workspaces))
    }
}

/// The project used for `project`-scope polling: last selected, then the URL.
fn current_workspace_id(config: &AppConfig, workspaces: &[Workspace]) -> Option<String> {
    let known = |id: &str| workspaces.iter().any(|workspace| workspace.id == id);

    if let Some(id) = config.last_workspace_id.as_deref().map(str::trim) {
        if !id.is_empty() && known(id) {
            return Some(id.to_string());
        }
    }
    if let Some(id) = config
        .last_session_url
        .as_deref()
        .and_then(workspace_from_session_url)
    {
        if known(&id) {
            return Some(id);
        }
    }

    workspaces.first().map(|workspace| workspace.id.clone())
}
