/**
 * Workspace member directory backing the filter sheet's 处理人/创建人 options:
 * one fetch per workspace per TTL window, held in memory and mirrored to
 * sessionStorage (`companion.members.<wsId>`) so a reload stays cheap. The
 * companion server caches members for 2h, so a client hit never reaches TAPD.
 */
import { api, asApiError, type WorkspaceMember } from "./api";

const TTL_MS = 30 * 60_000;
const SESSION_PREFIX = "companion.members.";

type Entry = { at: number; members: WorkspaceMember[] };

const memory = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const inFlight = new Map<string, Promise<WorkspaceMember[]>>();

function readSession(workspaceId: string): Entry | null {
  try {
    const raw = sessionStorage.getItem(SESSION_PREFIX + workspaceId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Entry>;
    if (!Array.isArray(parsed.members)) return null;
    return { at: Number(parsed.at) || 0, members: parsed.members as WorkspaceMember[] };
  } catch {
    return null;
  }
}

function writeSession(workspaceId: string, members: WorkspaceMember[]): void {
  try {
    sessionStorage.setItem(
      SESSION_PREFIX + workspaceId,
      JSON.stringify({ at: Date.now(), members }),
    );
  } catch {
    // Private browsing: the directory stays memory-only.
  }
}

const emit = (workspaceId: string): void => {
  for (const listener of listeners.get(workspaceId) ?? []) listener();
};

/** Subscribers re-run `loadMembers` when a background refresh lands. */
export function subscribeMembers(workspaceId: string, listener: () => void): () => void {
  let set = listeners.get(workspaceId);
  if (!set) {
    set = new Set();
    listeners.set(workspaceId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(workspaceId);
  };
}

function fetchMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const pending = inFlight.get(workspaceId);
  if (pending) return pending;
  const load = api
    .members(workspaceId)
    .then((members) => {
      const entry = { at: Date.now(), members };
      memory.set(workspaceId, entry);
      writeSession(workspaceId, members);
      inFlight.delete(workspaceId);
      emit(workspaceId);
      return members;
    })
    .catch((err) => {
      inFlight.delete(workspaceId);
      throw asApiError(err);
    });
  inFlight.set(workspaceId, load);
  return load;
}

/**
 * Cached members. A fresh (or stale-but-present) directory resolves from
 * cache; past the TTL one background refresh runs per workspace, and
 * subscribers are notified when it lands. Errors propagate only when there is
 * nothing cached at all.
 */
export async function loadMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  let entry = memory.get(workspaceId) ?? null;
  if (!entry) {
    const stored = readSession(workspaceId);
    if (stored) {
      memory.set(workspaceId, stored);
      entry = stored;
    }
  }
  if (entry) {
    if (Date.now() - entry.at >= TTL_MS) void fetchMembers(workspaceId).catch(() => {});
    return entry.members;
  }
  return fetchMembers(workspaceId);
}
