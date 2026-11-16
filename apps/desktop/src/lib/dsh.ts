/**
 * Built-in DeepSeek Harness runtime: commands, event payloads and the agent
 * settings extension that carries the model API.
 *
 * The contract (commands, phases, stream revision rules) is documented in
 * `docs/DSH.md` §3. Entries are committed history; streams are token-level
 * deltas the UI overlays on top of them until the entry arrives.
 */
import { invoke } from "@tauri-apps/api/core";

import {
  agentSettingsApi,
  type AgentConfig,
  type DshModelConfig,
  type DshModelProtocol,
} from "./agentSettings";

export type DshPhase = "stopped" | "starting" | "ready" | "failed";

export type DshStatus = {
  phase: DshPhase;
  payloadVersion?: string;
  nodeVersion?: string;
  nodePath?: string;
  provider?: string;
  model?: string;
  /** Stable machine code (`node_missing`, `model_missing`, …). */
  errorCode?: string;
  error?: string;
};

export type PayloadReport = {
  version: string;
  /** `env` | `dev` | `bundled`. */
  source: string;
  extracted: boolean;
  archive: string;
  runtimeDir: string;
  archiveBytes: number;
  unpackedBytes: number;
  files: number;
};

export type DshSessionStatus = "idle" | "running" | "failed";

export type DshSession = {
  id: string;
  /** First user line; the backend owns the wording. */
  title: string;
  updatedAt: string;
  status: DshSessionStatus;
  messageCount: number;
};

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
      status: "running" | "ok" | "error";
      /** Raw result. The contract documents a string; the host forwards the
       *  JSON value it received, so the view normalizes either shape. */
      result?: unknown;
    }
  | { kind: "turn"; seq: number; at: string; state: "start" | "end"; reason?: string };

export type DshStreamDelta =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; callId?: string; name?: string; arguments?: string };

export type DshStream = {
  sessionId: string;
  attemptId: string;
  /** Monotonic per attempt; a change replaces the accumulated text. */
  revision: number;
  index: number;
  delta: DshStreamDelta;
};

export type DshApprovalRequest = {
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
};

export type DshQuestionOption = {
  label: string;
  description?: string;
};

export type DshQuestion = {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: DshQuestionOption[];
  multiSelect?: boolean;
  /** Presentation hint (`plan-review`, `approval`); kept untyped upstream. */
  intent?: unknown;
};

export type DshQuestionRequest = {
  requestId: string;
  sessionId: string;
  questions: DshQuestion[];
};

export type DshAnswer = {
  id: string;
  selected: string[];
  custom?: string;
};

export type DshApprovalOutcome = "allowed-once" | "rejected" | "cancelled";

export type { DshModelConfig, DshModelProtocol };

/** The settings shape the runtime reads; the model block is part of it. */
export type DshAgentConfig = AgentConfig;

export const dshSettingsApi = {
  get: () => agentSettingsApi.get(),
  save: (config: DshAgentConfig) => agentSettingsApi.set(config) as Promise<DshAgentConfig>,
};

export const dshApi = {
  status: () => invoke<DshStatus>("dsh_status"),
  prepare: () => invoke<PayloadReport>("dsh_prepare"),
  start: () => invoke<DshStatus>("dsh_start"),
  stop: () => invoke<DshStatus>("dsh_stop"),
  newSession: () => invoke<{ sessionId: string }>("dsh_new_session"),
  sessions: () => invoke<{ sessions: DshSession[] }>("dsh_sessions"),
  pending: () => invoke<{ requests: DshPendingRequest[] }>("dsh_pending"),
  sessionEntries: (sessionId: string) =>
    invoke<{ sessionId: string; known: boolean; entries: DshEntry[] }>(
      "dsh_session_entries",
      { sessionId },
    ),
  prompt: (sessionId: string, text: string) =>
    invoke<{ receipt: unknown }>("dsh_prompt", { sessionId, text }),
  approvalAnswer: (rpcId: number, outcome: DshApprovalOutcome) =>
    invoke<void>("dsh_approval_answer", { rpcId, outcome }),
  questionAnswer: (rpcId: number, answers: DshAnswer[] | null) =>
    invoke<void>("dsh_question_answer", { rpcId, answers }),
};

/** Event payloads, kept next to the command types they mirror. */
export type DshEntryEvent = { sessionId: string; entry: DshEntry };
export type DshSessionEvent = { sessionId: string; stream: DshStream };
export type DshApprovalEvent = { rpcId: number; request: DshApprovalRequest };
export type DshQuestionEvent = { rpcId: number; request: DshQuestionRequest };
export type DshErrorEvent = { code: string; message: string };

/** A request the runtime is still blocked on (snapshot after a page reload). */
export type DshPendingRequest =
  | { rpcId: number; sessionId: string; kind: "approval"; request: DshApprovalRequest }
  | { rpcId: number; sessionId: string; kind: "question"; request: DshQuestionRequest };
