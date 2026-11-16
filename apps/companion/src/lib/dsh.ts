/**
 * Typed adapter for the built-in dsh runtime (desktop DeepSeek Harness).
 *
 * Every command goes through the companion feature proxy (`POST
 * /companion/api/feature`); the desktop executes it and returns the same serde
 * shapes its own windows consume. The phone renders transcripts and sends
 * prompts — it never talks to the runtime directly.
 *
 * Types are the contract of `dsh_*` commands (see docs/DSH.md). Everything is
 * funnelled through `dshApi`, so one transport/shape change is made in one
 * place.
 */
import { feature } from "./api";

export type DshPhase = "stopped" | "starting" | "ready" | "failed";

export type DshStatus = {
  phase: DshPhase;
  payloadVersion?: string;
  nodeVersion?: string;
  provider?: string;
  model?: string;
  /** Stable machine code, e.g. `node_missing` / `model_missing`. */
  errorCode?: string;
  error?: string;
};

export type DshSessionStatus = "idle" | "running" | "failed";

export type DshSession = {
  id: string;
  title: string;
  updatedAt: string;
  status: DshSessionStatus;
  messageCount: number;
};

export type DshToolStatus = "running" | "ok" | "error";

/** One rendered transcript row; `seq` is unique and monotonic per session. */
export type DshEntry =
  | { kind: "user"; seq: number; at: string; text: string }
  | { kind: "assistant"; seq: number; at: string; text: string; reasoning?: string }
  | {
      kind: "tool";
      seq: number;
      at: string;
      callId: string;
      name: string;
      args: string;
      status: DshToolStatus;
      result?: string;
    }
  | { kind: "turn"; seq: number; at: string; state: "start" | "end"; reason?: string };

/** Only `allowed-once` grants a tool call; the rest deny or cancel it. */
export type DshApprovalOutcome = "allowed-once" | "rejected" | "cancelled";

export type DshAnswer = { id: string; selected: string[]; custom?: string };

/** A request the runtime is still blocked on; the phone only renders it. */
export type DshPendingRequest =
  | { rpcId: number; sessionId: string; kind: "approval"; request: { sessionId: string; toolName: string; reason?: string } }
  | { rpcId: number; sessionId: string; kind: "question"; request: { sessionId: string; questions: unknown[] } };

export const dshApi = {
  status: () => feature<DshStatus>("dsh_status"),
  /** Extracts the payload and starts + initializes the runtime. */
  start: () => feature<DshStatus>("dsh_start"),
  stop: () => feature<DshStatus>("dsh_stop"),

  sessions: () => feature<{ sessions: DshSession[] }>("dsh_sessions"),
  entries: (sessionId: string) =>
    feature<{ sessionId: string; known: boolean; entries: DshEntry[] }>(
      "dsh_session_entries",
      { sessionId },
    ),
  pending: () => feature<{ requests: DshPendingRequest[] }>("dsh_pending"),

  /** Allocates a session id; the runtime creates the session at first prompt. */
  newSession: () => feature<{ sessionId: string }>("dsh_new_session"),
  prompt: (sessionId: string, text: string) =>
    feature<{ receipt: unknown }>("dsh_prompt", { sessionId, text }),

  /** Answers are desktop-only for now; typed so the contract stays in one place. */
  approvalAnswer: (rpcId: number, outcome: DshApprovalOutcome) =>
    feature<unknown>("dsh_approval_answer", { rpcId, outcome }),
  questionAnswer: (rpcId: number, answers: DshAnswer[] | null) =>
    feature<unknown>("dsh_question_answer", { rpcId, answers }),
};
