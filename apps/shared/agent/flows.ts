import {
  describeTool,
  failedVerb,
  isWaitingTool,
  pendingVerb,
  reasoningPreview,
  runningVerb,
  toolGroup,
  waitingDetail,
  type ToolAction,
} from "./actions";
import { agentLabel } from "./labels";
import { duration } from "./format";
import type { AgentEntry, AgentLocale, AgentTurnBlock } from "./types";

export type AssistantEntry = Extract<AgentEntry, { kind: "assistant" }>;
export type ToolEntry = Extract<AgentEntry, { kind: "tool" }>;

/** One live tool call from the streaming overlay (arguments may be partial). */
export type FlowLiveTool = { callId?: string; name: string; args: string };

/** The token-level overlay of the turn currently running. */
export type FlowLive = {
  text: string;
  reasoning: string;
  tools: FlowLiveTool[];
};

/**
 * Sort anchors for items that have no committed seq yet. A live-only flow
 * stays after every committed flow; a live subagent row stays after the flow
 * that is currently streaming.
 */
export const LIVE_FLOW_SEQ = Number.MAX_SAFE_INTEGER - 2000;
export const LIVE_SUBAGENT_SEQ = Number.MAX_SAFE_INTEGER - 1000;

/** One thinking block: committed or the single live one. */
export type AgentThinking = {
  key: string;
  text: string;
  live: boolean;
  startedAtMs?: number;
  completedAtMs?: number;
};

/**
 * One step of a flow, in execution order. Grouping by kind would lose that
 * order (think → run → think → run), so the expansion is this flat list.
 */
export type AgentFlowStep =
  | { kind: "thinking"; key: string; thinking: AgentThinking }
  | { kind: "tool"; key: string; entry: ToolEntry }
  | { kind: "live"; key: string; tool: FlowLiveTool };

/**
 * The steps between two 说明. A flow is closed by its `note` (an assistant
 * text); the trailing flow of a running turn has none and is drawn from the
 * latest step instead of a summary.
 */
export type AgentFlow = {
  key: string;
  index: number;
  firstSeq: number;
  thinking: AgentThinking[];
  reads: ToolEntry[];
  commands: ToolEntry[];
  files: ToolEntry[];
  liveTools: FlowLiveTool[];
  /** Committed and live steps interleaved by execution order. */
  steps: AgentFlowStep[];
  note?: AssistantEntry;
  liveNote?: string;
};

export type StepPhase = "pending" | "waiting" | "running" | "ok" | "error";

/** The last step of a running flow, with the verb its own state dictates. */
export type LatestStep = {
  phase: StepPhase;
  kind: ToolAction["kind"] | "thinking";
  verb: string;
  target: string;
  added?: number;
  removed?: number;
  failed: boolean;
};

/** Group classification for a live call; `subagent` never reaches a flow. */
function groupOf(tool: FlowLiveTool) {
  return toolGroup(tool.name, tool.args);
}

/**
 * Cuts one turn into flows at every assistant text (说明). Reasoning joins the
 * flow before the text, tool calls after it start the next flow — exactly the
 * seq order of the committed rows. `subagent` calls and settle notices are
 * hoisted to the turn root and never enter a flow.
 */
export function buildFlows(
  block: AgentTurnBlock,
  live: FlowLive | undefined,
  running: boolean,
): AgentFlow[] {
  const flows: AgentFlow[] = [];
  let current: AgentFlow | null = null;
  let index = 0;

  const start = (seq: number): AgentFlow => {
    const flow: AgentFlow = {
      key: `${block.key}:flow:${index}`,
      index,
      firstSeq: seq,
      thinking: [],
      reads: [],
      commands: [],
      files: [],
      liveTools: [],
      steps: [],
    };
    index += 1;
    flows.push(flow);
    current = flow;
    return flow;
  };

  const ensure = (): AgentFlow => current ?? start(LIVE_FLOW_SEQ);

  for (const entry of block.entries) {
    if (entry.kind === "user" || entry.kind === "turn" || entry.kind === "notice") {
      continue;
    }
    if (entry.kind === "tool" && entry.name === "subagent") continue;
    if (entry.kind === "assistant") {
      const reasoning = entry.reasoning?.trim() ?? "";
      if (reasoning) {
        const flow = current ?? start(entry.seq);
        const block: AgentThinking = {
          key: `think:${entry.seq}`,
          text: entry.reasoning ?? "",
          live: false,
          startedAtMs: entry.startedAtMs,
          completedAtMs: entry.completedAtMs,
        };
        flow.thinking.push(block);
        flow.steps.push({ kind: "thinking", key: block.key, thinking: block });
      }
      if (entry.text.trim()) {
        const flow = current ?? start(entry.seq);
        flow.note = entry;
        current = null;
      }
      continue;
    }
    if (entry.kind === "tool") {
      const flow = current ?? start(entry.seq);
      const kind = toolGroup(entry.name, entry.args);
      switch (kind) {
        case "reads":
          flow.reads.push(entry);
          break;
        case "files":
          flow.files.push(entry);
          break;
        case "commands":
          flow.commands.push(entry);
          break;
      }
      flow.steps.push({
        kind: "tool",
        key: `tool:${entry.callId || entry.seq}`,
        entry,
      });
    }
  }

  // Live overlay: the reasoning of the in-flight message closes with its text,
  // and the same message's tool calls start the next flow. That is the same
  // order the committed rows arrive in.
  if (running && live) {
    const liveReasoning = live.reasoning.trim();
    if (liveReasoning) {
      const flow = ensure();
      const block: AgentThinking = {
        key: "think:live",
        text: live.reasoning,
        live: true,
      };
      flow.thinking.push(block);
      flow.steps.push({ kind: "thinking", key: block.key, thinking: block });
    }
    if (live.text.trim()) {
      const flow = ensure();
      flow.liveNote = live.text;
      current = null;
    }
    for (const [offset, tool] of live.tools.entries()) {
      if (tool.name === "subagent") continue;
      const flow = ensure();
      flow.liveTools.push(tool);
      flow.steps.push({
        kind: "live",
        key: `live:${tool.callId || offset}`,
        tool,
      });
    }
  }

  return flows.filter(
    (flow) =>
      flow.thinking.length > 0 ||
      flow.reads.length > 0 ||
      flow.commands.length > 0 ||
      flow.files.length > 0 ||
      flow.liveTools.length > 0 ||
      flow.note !== undefined ||
      flow.liveNote !== undefined,
  );
}

/** Whether the flow is closed by a 说明 (committed or still streaming). */
export function isClosed(flow: AgentFlow): boolean {
  return flow.note !== undefined || flow.liveNote !== undefined;
}

/** Unique edited files; live calls included when asked. */
export function editedFiles(
  flow: AgentFlow,
  locale: AgentLocale,
  includeLive = false,
): number {
  const files = new Set<string>();
  for (const entry of flow.files) {
    files.add(describeTool(entry.name, entry.args, locale).target);
  }
  if (includeLive) {
    for (const tool of flow.liveTools) {
      if (groupOf(tool) !== "files") continue;
      files.add(describeTool(tool.name, tool.args, locale).target);
    }
  }
  return files.size;
}

/** Sum of the model-call spans of this flow's thinking blocks. */
export function thinkingDuration(flow: AgentFlow): number | null {
  let total = 0;
  let any = false;
  for (const block of flow.thinking) {
    const start = block.startedAtMs;
    const end = block.completedAtMs;
    if (start === undefined || end === undefined || end <= start) continue;
    total += end - start;
    any = true;
  }
  return any ? total : null;
}

/**
 * The flow's summary: the non-zero read/command/file counts, or the thinking
 * span for a flow that only thought. `null` means "no summary line at all"
 * (a note-only flow).
 */
export function summaryLabel(flow: AgentFlow, locale: AgentLocale): string | null {
  const parts: string[] = [];
  if (flow.reads.length > 0) {
    parts.push(agentLabel("flow.reads", locale, { count: flow.reads.length }));
  }
  if (flow.commands.length > 0) {
    parts.push(agentLabel("flow.commands", locale, { count: flow.commands.length }));
  }
  const files = editedFiles(flow, locale, true);
  if (files > 0) {
    parts.push(agentLabel("flow.files", locale, { count: files }));
  }
  if (parts.length > 0) {
    return parts.join(agentLabel("flow.sep", locale));
  }
  if (flow.thinking.length > 0) {
    const span = thinkingDuration(flow);
    return span === null
      ? agentLabel("flow.thinkingPlain", locale)
      : agentLabel("flow.thinking", locale, { duration: duration(span, locale) });
  }
  return null;
}

/** Which glyph leads the summary line. */
export type SummaryKind = "reads" | "commands" | "files" | "thinking";

export function summaryKind(flow: AgentFlow): SummaryKind {
  if (flow.reads.length > 0) return "reads";
  if (flow.commands.length > 0) return "commands";
  if (flow.files.length > 0) return "files";
  return "thinking";
}

/**
 * The last step of the flow with the verb its state dictates. Only the open
 * flow of a running turn uses this: a finished call keeps its past-tense line
 * until the next step starts, and a blocked call reads as waiting.
 */
export function latestStep(
  flow: AgentFlow,
  live: FlowLive | undefined,
  locale: AgentLocale,
): LatestStep | null {
  // While the 说明 itself streams, it is the latest activity; the step line
  // would only repeat the flow behind it.
  if (live?.text.trim()) return null;

  const liveReasoning = live?.reasoning.trim() ?? "";
  if (liveReasoning) {
    return {
      phase: "running",
      kind: "thinking",
      verb: agentLabel("action.thinking", locale),
      target: reasoningPreview(liveReasoning),
      failed: false,
    };
  }

  const liveTool = [...(live?.tools ?? [])]
    .reverse()
    .find((tool) => tool.name !== "subagent");
  if (liveTool) {
    const action = describeTool(liveTool.name, liveTool.args, locale);
    return {
      phase: "pending",
      kind: action.kind,
      verb: pendingVerb(liveTool.name, action.kind, locale),
      target: action.target,
      added: action.added,
      removed: action.removed,
      failed: false,
    };
  }

  const tools = [...flow.reads, ...flow.commands, ...flow.files].sort(
    (left, right) => left.seq - right.seq,
  );
  const last = tools[tools.length - 1];
  if (!last) return null;
  const action = describeTool(last.name, last.args, locale);

  if (last.status === "running") {
    if (isWaitingTool(last.name, last.args)) {
      const waiting = waitingDetail(last.name, last.args, locale);
      return {
        phase: "waiting",
        kind: action.kind,
        verb: waiting?.verb ?? runningVerb(action.kind, locale),
        target: waiting?.target || action.target,
        failed: false,
      };
    }
    return {
      phase: "running",
      kind: action.kind,
      verb: runningVerb(action.kind, locale),
      target: action.target,
      added: action.added,
      removed: action.removed,
      failed: false,
    };
  }
  if (last.status === "error") {
    const special = failedDetail(last, locale);
    return {
      phase: "error",
      kind: action.kind,
      verb: special?.verb ?? failedVerb(action.kind, locale),
      target: special?.target || action.target,
      added: action.added,
      removed: action.removed,
      failed: true,
    };
  }
  const special = completedDetail(last, locale);
  return {
    phase: "ok",
    kind: action.kind,
    verb: special?.verb ?? action.verb,
    target: special?.target || action.target,
    added: action.added,
    removed: action.removed,
    failed: false,
  };
}

/** Semantic completion verbs for the blocked-on-external-event tools. */
function completedDetail(
  tool: ToolEntry,
  locale: AgentLocale,
): { verb: string; target: string } | null {
  if (tool.name === "ask_user_question") {
    return {
      verb: agentLabel("step.answered", locale),
      target: waitingDetail(tool.name, tool.args, locale)?.target ?? "",
    };
  }
  if (tool.name === "job_output") {
    return {
      verb: agentLabel("step.jobReturned", locale),
      target: waitingDetail(tool.name, tool.args, locale)?.target ?? "",
    };
  }
  if (tool.name === "wait_agent") {
    return { verb: agentLabel("step.agentReturned", locale), target: "" };
  }
  return null;
}

/** Failure verbs for the same tools. */
function failedDetail(
  tool: ToolEntry,
  locale: AgentLocale,
): { verb: string; target: string } | null {
  if (tool.name === "ask_user_question") {
    return {
      verb: agentLabel("step.askFailed", locale),
      target: waitingDetail(tool.name, tool.args, locale)?.target ?? "",
    };
  }
  if (tool.name === "job_output") {
    return {
      verb: agentLabel("step.jobFailed", locale),
      target: waitingDetail(tool.name, tool.args, locale)?.target ?? "",
    };
  }
  if (tool.name === "wait_agent") {
    return { verb: agentLabel("step.agentFailed", locale), target: "" };
  }
  return null;
}
