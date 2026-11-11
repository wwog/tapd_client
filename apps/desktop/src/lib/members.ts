import { useEffect } from "react";

import { api, type WorkspaceMember } from "./api";
import { cacheApi } from "./cache";
import { createExternalStore } from "./store";
import { showToast } from "./toast";

/** People directory refresh window; matches the two-hour update check. */
export const MEMBERS_TTL_MS = 2 * 60 * 60 * 1000;

export type MembersSnapshot = {
  /** Workspace people directory, keyed by workspace id. */
  byWorkspace: Record<string, WorkspaceMember[]>;
  loading: Record<string, boolean>;
};

export const membersStore = createExternalStore<MembersSnapshot>({
  byWorkspace: {},
  loading: {},
});

/** When each workspace directory was last fetched (milliseconds). */
let membersFetchedAt: Record<string, number> = {};
/** Concurrent callers share one request per workspace. */
let membersInFlight: Record<string, Promise<WorkspaceMember[]> | undefined> = {};

const storeMembers = (
  targetWorkspaceId: string,
  members: WorkspaceMember[],
  fetchedAtMs: number,
): void => {
  membersFetchedAt = { ...membersFetchedAt, [targetWorkspaceId]: fetchedAtMs };
  membersStore.set((current) => ({
    byWorkspace: { ...current.byWorkspace, [targetWorkspaceId]: members },
    loading: current.loading,
  }));
};

const setMembersLoading = (targetWorkspaceId: string, loading: boolean): void => {
  membersStore.set((current) => {
    const next = { ...current.loading };
    if (loading) next[targetWorkspaceId] = true;
    else delete next[targetWorkspaceId];
    return { byWorkspace: current.byWorkspace, loading: next };
  });
};

/**
 * Returns a workspace's people directory, cache-first.
 *
 * Cached members are reused for two hours; `force` refreshes them in place
 * (also used by the background two-hour timer). Concurrent callers share one
 * request so opening several bugs does not fan out into duplicate calls.
 */
export async function ensureMembers(
  targetWorkspaceId: string,
  force = false,
): Promise<WorkspaceMember[]> {
  const workspaceId = targetWorkspaceId.trim();
  if (!workspaceId) return [];

  const inFlight = membersInFlight[workspaceId];
  if (inFlight) return inFlight;

  const known = membersStore.get().byWorkspace[workspaceId] ?? [];
  const knownAt = membersFetchedAt[workspaceId] ?? 0;
  if (!force && known.length > 0 && Date.now() - knownAt < MEMBERS_TTL_MS) {
    return known;
  }

  if (!force && known.length === 0) {
    try {
      const cached = await cacheApi.workspaceMembers(workspaceId);
      if (cached.data?.length) {
        const fetchedAtMs = (cached.fetchedAt ?? 0) * 1000;
        storeMembers(workspaceId, cached.data, fetchedAtMs);
        if (Date.now() - fetchedAtMs < MEMBERS_TTL_MS) return cached.data;
      }
    } catch {
      // A cache miss is not an error; the live request decides.
    }
  }

  setMembersLoading(workspaceId, true);
  const request = api
    .workspaceMembers(workspaceId)
    .then((members) => {
      storeMembers(workspaceId, members, Date.now());
      return members;
    })
    .finally(() => {
      delete membersInFlight[workspaceId];
      setMembersLoading(workspaceId, false);
    });
  membersInFlight[workspaceId] = request;

  try {
    return await request;
  } catch (error) {
    if (!membersStore.get().byWorkspace[workspaceId]?.length) {
      showToast("error", `处理人列表加载失败：${String(error)}`);
    }
    return membersStore.get().byWorkspace[workspaceId] ?? [];
  }
}

/** Live people directories, shared by every pane that shows members. */
export function useMembers(): MembersSnapshot {
  return membersStore.use();
}

/**
 * Wires the directory lifecycle for the signed-in session: load the active
 * project, keep every cached directory fresh on the two-hour cadence, and drop
 * the cache when the session ends.
 */
export function useMembersDirectory(
  loggedIn: boolean,
  workspaceId: string,
): MembersSnapshot {
  const snapshot = membersStore.use();

  // Load the current project's people as soon as it becomes active.
  useEffect(() => {
    if (!loggedIn || !workspaceId) return;
    void ensureMembers(workspaceId);
  }, [loggedIn, workspaceId]);

  // Keep cached directories fresh on the same two-hour cadence as updates.
  useEffect(() => {
    if (!loggedIn) return;
    const timer = window.setInterval(() => {
      const ids = new Set(
        [...Object.keys(membersStore.get().byWorkspace), workspaceId].filter(
          Boolean,
        ),
      );
      for (const id of ids) void ensureMembers(id, true);
    }, MEMBERS_TTL_MS);
    return () => window.clearInterval(timer);
  }, [loggedIn, workspaceId]);

  // Signing out drops the directory: it belongs to the ended session.
  useEffect(() => {
    if (loggedIn) return;
    membersFetchedAt = {};
    membersInFlight = {};
    membersStore.set({ byWorkspace: {}, loading: {} });
  }, [loggedIn]);

  return snapshot;
}
