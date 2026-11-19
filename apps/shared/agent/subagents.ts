/**
 * Pure assembly of one session's sub-agent data, shared by desktop and
 * companion (the host layer of the contract: `TurnBlock` only renders what it
 * is given).
 *
 * Sources, per session:
 *  1. committed `subagent` / `subagent_fork` tool calls paired with settle
 *     notices — the notice's `senderSessionId` is the child session id, its
 *     text the closing message. `subagent/catalog` gives the call the same id
 *     right after it starts, so a running child already has a row;
 *  2. uncommitted live calls — running placeholders with no transcript (the
 *     child session id is simply unknown until the catalog event).
 *
 * Pairing runs across the WHOLE transcript, not per turn block: a background
 * child settles after the dispatching turn has ended, so its notice lands in a
 * later block than the call that started it. A call with a child id pairs with
 * the notice carrying the same `senderSessionId`; only logs without the catalog
 * fall back to k-th call ↔ k-th notice in log order. Calls whose notice has not
 * landed yet stay running, and a paired notice is consumed by the fold in its
 * call's block instead of rendering as an orphan in its own.
 *
 * Nothing here touches a store: per-child facts (status, title, preset,
 * transcript, loading flag) arrive through the `childInfo` lookup.
 */
import { groupTurns } from "./turns";
import { LIVE_SUBAGENT_SEQ } from "./flows";
import { isSubagentTool } from "./actions";
import type { AgentEntry, AgentNotice, AgentTurnBlock } from "./types";

type SubagentCall = Extract<AgentEntry, { kind: "tool" }>;

/**
 * One root-level sub-agent row. A row is its own fold domain: expanding it
 * renders the child session's transcript with the same turn view. It never
 * joins a flow's groups or summary line.
 */
export type AgentSubagentRow = {
  /** Model-facing child name: `agent-1`, or `reviewer/checker` when nested. */
  name: string;
  /** The call's own description, the row's single-line title. */
  description: string;
  /** Agent preset the child ran under, when known. */
  preset?: string;
  /** The child's own session id — the fold's data source. */
  sessionId: string;
  /** The `subagent` call id, when the runtime carried one. */
  callId?: string;
  /** Root ordering anchor: the call's seq, or a tail anchor for live calls. */
  callSeq: number;
  /** True while the child's session is still running a turn. */
  running: boolean;
  /** Child transcript grouped with the shared `groupTurns`; empty until loaded. */
  turns: AgentTurnBlock[];
  /** True while the host is fetching the child transcript for the first time. */
  loading?: boolean;
  /** The fetch failed; the row shows this instead of retrying silently. */
  error?: string;
  /** The settled notice, once the runtime has delivered one. */
  settled?: { at: string; summary: string; stopReason?: string; text: string };
};

/** Placeholder id for a child whose session id is not known yet. */
const PENDING_PREFIX = "pending:";

/** Stable empty transcript so the WeakMap cache key does not churn. */
const EMPTY_ENTRIES: readonly AgentEntry[] = [];

/**
 * `groupTurns` per transcript identity. Assembly reruns on every store tick
 * while the parent streams (token deltas land in `live`, but the entries
 * bucket identity also changes); re-grouping a settled child transcript with
 * thousands of rows each time is the expensive part, and the child bucket
 * arrays keep their identity between polls.
 */
const turnsCache = new WeakMap<object, ReturnType<typeof groupTurns>>();

function groupedTurns(entries: readonly AgentEntry[] | undefined) {
  const source = entries ?? EMPTY_ENTRIES;
  const cached = turnsCache.get(source);
  if (cached) return cached;
  // Copy satisfies `groupTurns`'s mutable signature; the cache is keyed on the
  // caller's array identity, which is what stays stable between polls.
  const turns = groupTurns([...source]);
  turnsCache.set(source, turns);
  return turns;
}

/** Model-facing child name from the call's arguments (`{ name: … }`). */
function argsName(args: string): string {
  try {
    const parsed = JSON.parse(args) as { name?: unknown };
    if (typeof parsed.name === "string" && parsed.name.trim() !== "") {
      return parsed.name.trim();
    }
  } catch {
    // Arguments may be partial while the call is still streaming.
  }
  return "";
}

/** Child name from the activation result (`started subagent <name>`). */
function resultName(result: unknown): string {
  if (typeof result !== "string") return "";
  return result.match(/started subagent (\S+)/)?.[1] ?? "";
}

/** The call's own one-line description, the root row's title. */
function argsDescription(args: string): string {
  try {
    const parsed = JSON.parse(args) as { description?: unknown };
    if (typeof parsed.description === "string") {
      return parsed.description.split("\n")[0]?.trim() ?? "";
    }
  } catch {
    // Arguments may be partial while the call is still streaming.
  }
  return "";
}

/**
 * Per-child-session facts the host resolves for the assembler. Everything is
 * plain data so both ends can build it from their own store shapes: desktop
 * reads its session rows / entry buckets, companion its session list and
 * transcript accessor.
 */
export type ChildSessionInfo = {
  /** The child's own session is running a turn right now. */
  running?: boolean;
  /** Child session title — a name fallback when the call carries none. */
  title?: string;
  /** Agent preset the child ran under, when the session row reports one. */
  preset?: string;
  /** Committed child transcript rows (oldest first). */
  entries?: readonly AgentEntry[];
  /** True while the host is fetching this child's transcript. */
  loading?: boolean;
};

export type TurnSubagents = {
  children: AgentSubagentRow[];
  /** Settled notices that matched no `subagent` call (old logs, orphans). */
  orphans: AgentNotice[];
};

/** One `groupTurns` block: its key plus the entries that produced it. */
export type SubagentBlock = { key: string; entries: readonly AgentEntry[] };

/**
 * Builds the sub-agent data of every turn of ONE session. Child transcripts
 * are grouped with the shared `groupTurns` (cached per transcript identity);
 * `loading` passes through so the fold shows its spinner until the host's
 * fetch lands. Without a `childInfo` lookup every committed child renders with
 * unknown status and an empty transcript — useful for tests, and the degrade
 * hosts see for retired sessions.
 *
 * Live `subagent` calls become running placeholders in `liveBlockKey` only —
 * the live overlay is one in-flight step, not one per turn.
 */
export function assembleSessionSubagents(
  blocks: readonly SubagentBlock[],
  liveTools: ReadonlyArray<{ callId?: string; name: string; args: string }>,
  liveBlockKey: string | null,
  childInfo?: (sessionId: string) => ChildSessionInfo | undefined,
): Map<string, TurnSubagents> {
  const lookup = childInfo ?? (() => undefined);

  const calls: Array<{ blockKey: string; call: SubagentCall }> = [];
  const notices: Array<{ blockKey: string; notice: AgentNotice }> = [];
  for (const block of blocks) {
    for (const entry of block.entries) {
      if (entry.kind === "tool" && isSubagentTool(entry.name)) {
        calls.push({ blockKey: block.key, call: entry });
      } else if (entry.kind === "notice") {
        notices.push({ blockKey: block.key, notice: entry });
      }
    }
  }

  // Exact pairing first: `subagent/catalog` gives the call its child session id
  // before the child settles, so a notice with the same `senderSessionId`
  // belongs to that call even when several children settle out of order.
  const noticeOfCall = new Map<SubagentCall, AgentNotice>();
  const pairedNotices = new Set<AgentNotice>();
  const unpairedCalls: SubagentCall[] = [];
  for (const { call } of calls) {
    const childId = call.childSessionId;
    const match = childId
      ? notices.find(
          (candidate) =>
            !pairedNotices.has(candidate.notice) &&
            candidate.notice.senderSessionId === childId,
        )
      : undefined;
    if (match) {
      noticeOfCall.set(call, match.notice);
      pairedNotices.add(match.notice);
    } else {
      unpairedCalls.push(call);
    }
  }
  // Older logs (or a runtime that skipped the catalog) carry no child id:
  // fall back to k-th call ↔ k-th notice in log order, across turn boundaries.
  const unpairedNotices = notices.filter((item) => !pairedNotices.has(item.notice));
  const pairCount = Math.min(unpairedCalls.length, unpairedNotices.length);
  for (let index = 0; index < pairCount; index += 1) {
    const { notice } = unpairedNotices[index]!;
    noticeOfCall.set(unpairedCalls[index]!, notice);
    pairedNotices.add(notice);
  }

  const callsByBlock = new Map<string, SubagentCall[]>();
  for (const { blockKey, call } of calls) {
    const list = callsByBlock.get(blockKey);
    if (list) list.push(call);
    else callsByBlock.set(blockKey, [call]);
  }

  const groups = new Map<string, TurnSubagents>();
  for (const block of blocks) {
    const children: AgentSubagentRow[] = [];
    for (const call of callsByBlock.get(block.key) ?? []) {
      const notice = noticeOfCall.get(call);
      // A background child is known from `subagent/catalog` before it settles;
      // only a log without that event falls back to the pending placeholder.
      const sessionId = notice
        ? notice.senderSessionId
        : (call.childSessionId || `${PENDING_PREFIX}${call.callId || call.seq}`);
      const pending = sessionId.startsWith(PENDING_PREFIX);
      const info = pending ? undefined : lookup(sessionId);
      const name =
        argsName(call.args) || resultName(call.result) || (pending ? "" : (info?.title ?? ""));
      children.push({
        name,
        description: argsDescription(call.args),
        preset: info?.preset,
        sessionId,
        callId: call.callId,
        callSeq: call.seq,
        // Unsettled call = the child is still working, even when the host has
        // no session row for it yet.
        running: pending ? true : notice ? false : (info?.running ?? true),
        turns: pending ? [] : groupedTurns(info?.entries),
        loading: info?.loading ?? false,
        settled: notice
          ? {
              at: notice.at,
              summary: notice.summary,
              stopReason: notice.stopReason,
              text: notice.text,
            }
          : undefined,
      });
    }

    // Live calls that have not committed yet: running placeholders in the
    // block that owns the in-flight step. Expanding one shows the working
    // state only — there is no session id to read yet.
    if (block.key === liveBlockKey) {
      for (const [offset, tool] of liveTools.entries()) {
        if (!isSubagentTool(tool.name)) continue;
        children.push({
          name: argsName(tool.args),
          description: argsDescription(tool.args),
          sessionId: `${PENDING_PREFIX}${tool.callId || `live-${offset}`}`,
          callId: tool.callId,
          callSeq: LIVE_SUBAGENT_SEQ + offset,
          running: true,
          turns: [],
        });
      }
    }

    const orphans = block.entries.filter(
      (entry): entry is AgentNotice => entry.kind === "notice" && !pairedNotices.has(entry),
    );
    groups.set(block.key, { children, orphans });
  }
  return groups;
}

/** True for the transient ids given to children with no known session yet. */
export function isPendingChild(sessionId: string): boolean {
  return sessionId.startsWith(PENDING_PREFIX);
}
