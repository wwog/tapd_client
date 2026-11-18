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
    }
  | {
      /** The rendered system prompt (`system/message`). Trajectory only: the
       *  conversation view treats it as request context, not a bubble. */
      kind: "system";
      seq: number;
      at: string;
      turn: number;
      step: number;
      text: string;
      /** The prompt replaced an earlier one (phase change / normalization). */
      update?: boolean;
    }
  | {
      /** Injected request context (a non-human `user/message` source, or a
       *  `developer/message`). Trajectory only. */
      kind: "context";
      seq: number;
      at: string;
      turn: number;
      step: number;
      text: string;
      /** Display label for the producer (paths / skill name / source kind). */
      producer?: string;
      /** `source.form` (instructions / notice / …) when carried. */
      form?: string;
    }
  | {
      /** The full request header (`request/header`): route + tool names. */
      kind: "request";
      seq: number;
      at: string;
      turn: number;
      step: number;
      /** initial / resume / change / series. */
      reason: string;
      provider?: string;
      model?: string;
      effort?: string;
      maxTokens?: number;
      tools: string[];
    }
  | {
      /** One provider-routed retry wait (`llm/retry`). */
      kind: "retry";
      seq: number;
      at: string;
      turn: number;
      step: number;
      provider: string;
      retry: number;
      maxRetries?: number;
      delayMs: number;
      message: string;
      code: string;
      status?: number;
    }
  | {
      /** A request attempt that committed no message (`assistant/attempt`). */
      kind: "attempt";
      seq: number;
      at: string;
      turn: number;
      step: number;
      startedAtMs?: number;
      endedAtMs?: number;
    }
  | {
      /** One compaction cycle, merged in place (start → summary → end). */
      kind: "compaction";
      seq: number;
      at: string;
      turn: number;
      step: number;
      status: "running" | "ok" | "error";
      summary?: string;
      shadowedTokens?: number;
      error?: string;
    }
  | {
      /** A PTC sub-call nested in a parent tool call (`tool/ptc-dispatch*`). */
      kind: "subcall";
      seq: number;
      at: string;
      turn: number;
      step: number;
      callId: string;
      parentCallId: string;
      name: string;
      args: string;
      status: "running" | "ok" | "error";
      result?: string;
      startedAtMs?: number;
      endedAtMs?: number;
    }
  | {
      /** The inherited-history boundary (`session/end-seed`). */
      kind: "seed";
      seq: number;
      at: string;
      inherited?: boolean;
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
