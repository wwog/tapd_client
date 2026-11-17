/**
 * Structural contracts for the shared agent chat view.
 *
 * This module belongs to neither app: desktop and companion both feed their
 * own runtime shapes in, so every type here must stay structurally
 * compatible with `apps/desktop/src/lib/dsh.ts` (the serde contract is owned
 * by `crates/dsh-host/src/transcript.rs`). Field names are the camelCase wire
 * names the Rust side serializes.
 */

export type AgentLocale = "zh" | "en";

/** One entry of the session todo list (`todo/write`, whole-list replacement). */
export type AgentTodo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

/** One normalized, committed transcript row. Mirrors `DshEntry` in dsh.ts. */
export type AgentEntry =
  | { kind: "user"; seq: number; at: string; turn: number; step: number; text: string }
  | {
      kind: "assistant";
      seq: number;
      at: string;
      turn: number;
      step: number;
      text: string;
      reasoning?: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        totalTokens: number;
      };
      provider?: string;
      model?: string;
      startedAtMs?: number;
      firstTokenAtMs?: number;
      completedAtMs?: number;
    }
  | {
      kind: "tool";
      seq: number;
      at: string;
      turn: number;
      step: number;
      callId: string;
      name: string;
      args: string;
      status: "running" | "ok" | "error";
      result?: unknown;
      startedAtMs?: number;
      endedAtMs?: number;
    }
  | {
      kind: "turn";
      seq: number;
      at: string;
      turn: number;
      state: "start" | "end";
      reason?: string;
      error?: string;
    }
  | {
      /** `subagent-settled` completion notice — part of the sub-agent group. */
      kind: "notice";
      seq: number;
      at: string;
      turn: number;
      step: number;
      text: string;
      summary: string;
      stopReason?: string;
      senderSessionId: string;
    };

/** Per-reply token accounting, as the assistant entry carries it. */
export type AgentUsage = NonNullable<
  Extract<AgentEntry, { kind: "assistant" }>["usage"]
>;

/** The `subagent-settled` row, when a caller needs just this variant. */
export type AgentNotice = Extract<AgentEntry, { kind: "notice" }>;

/** One user-visible turn: everything committed between the turn markers. */
export type AgentTurnBlock = {
  key: string;
  start?: { seq: number; at: string; turn: number };
  end?: { seq: number; at: string; turn: number; reason?: string; error?: string };
  entries: AgentEntry[];
};
