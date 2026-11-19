/**
 * The task-phase mirror (docs/AGENT_TASK_FLOW.md §4.1 / §5.1).
 *
 * The host owns phases; this module is only the bookkeeping half — validate one
 * frame, mirror it into a `Map`, replace the whole map from a reconnect
 * snapshot. Kept free of plugin imports so the rules are unit-testable.
 *
 * A session's entry is `{ phase, kind }`. `kind` is remembered when a later
 * frame omits it: the host sends the kind with every phase change, but a local
 * update from a tool reply reuses the known kind rather than inventing `chat`.
 */

/** The only phases the host may assign. */
export const TASK_PHASES = new Set(['chat', 'execute', 'review', 'writeback', 'none'])

/** Known task kinds. Others are accepted (forward compatible) but not validated. */
export const TASK_KINDS = new Set(['chat', 'bug', 'local_item'])

const isId = (value) => typeof value === 'string' && value.length > 0

/**
 * Records one session's phase.
 *
 * @param map - sessionId → `{ phase, kind }`.
 * @param sessionId - root session id; anything else is ignored.
 * @param phase - one of {@link TASK_PHASES}; unknown values are rejected.
 * @param kind - task kind; omitted keeps the previous kind (or `chat`).
 * @returns whether the entry was written.
 */
export function setPhaseEntry(map, sessionId, phase, kind) {
  if (!isId(sessionId)) return false
  if (!TASK_PHASES.has(phase)) return false
  const previous = map.get(sessionId)
  const nextKind = isId(kind) ? kind : (previous?.kind ?? 'chat')
  map.set(sessionId, { phase, kind: nextKind })
  return true
}

/**
 * Replaces the whole map from a `task-phases` snapshot. Omitted sessions are
 * dropped: after a reconnect the host is authoritative, and a stale `execute`
 * would otherwise resurrect tools for a task that already finished.
 *
 * @param map - sessionId → `{ phase, kind }`, mutated in place.
 * @param phases - the frame's array of `{ sessionId, phase, kind }`.
 * @returns the number of entries written.
 */
export function replacePhaseEntries(map, phases) {
  map.clear()
  if (!Array.isArray(phases)) return 0
  let written = 0
  for (const entry of phases) {
    if (!entry || typeof entry !== 'object') continue
    if (setPhaseEntry(map, entry.sessionId, entry.phase, entry.kind)) written += 1
  }
  return written
}

/** A detached copy of one entry, or null when the session is untracked. */
export function readPhaseEntry(map, sessionId) {
  if (!isId(sessionId)) return null
  const entry = map.get(sessionId)
  return entry ? { phase: entry.phase, kind: entry.kind } : null
}

/** The mirrored phase, or undefined when the session is untracked. */
export function phaseOfEntry(map, sessionId) {
  if (!isId(sessionId)) return undefined
  return map.get(sessionId)?.phase
}
