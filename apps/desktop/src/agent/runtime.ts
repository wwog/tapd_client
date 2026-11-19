/**
 * One answer to "can the composer send right now", shared by the notice above
 * the composer and the configuration tab's runtime section.
 */
import { modelsReady } from "../lib/agentSettings";
import { t } from "../lib/i18n";
import type { AgentState } from "./store";

export type RuntimeBlock =
  | "checking"
  | "stopped"
  | "starting"
  | "node"
  | "model"
  | "payload"
  | "failed"
  | "status";

/** `null` means the runtime is ready and the composer may send. */
export function runtimeBlock(state: AgentState): RuntimeBlock | null {
  if (!state.status) return state.statusError ? "status" : "checking";
  if (state.starting || state.preparingSince !== null) return "starting";
  if (state.status.phase === "ready") return null;
  // The process itself reports `starting` while it boots; treating that as
  // "stopped" showed a dead end during every launch and payload extraction.
  if (state.status.phase === "starting") return "starting";
  if (state.status.phase === "failed") {
    switch (state.status.errorCode) {
      case "node_missing":
        return "node";
      case "model_missing":
        return "model";
      case "payload_missing":
        return "payload";
      default:
        return "failed";
    }
  }
  if (state.config && !modelsReady(state.config.dshModels)) {
    return "model";
  }
  return "stopped";
}

/** Short state name; also the composer's disabled explanation. */
export function runtimeLabel(block: RuntimeBlock): string {
  switch (block) {
    case "checking":
      return t("common.loading");
    case "stopped":
      return t("agent.runtime.stopped");
    case "starting":
      return t("agent.runtime.starting");
    case "node":
      return t("agent.runtime.nodeMissing");
    case "model":
      return t("agent.runtime.modelMissing");
    case "payload":
      return t("agent.runtime.payloadMissing");
    case "failed":
      return t("agent.runtime.failed");
    case "status":
      return t("agent.runtime.stateFailed");
  }
}

/** Why the state exists, when it has a fixed explanation. */
export function runtimeHint(block: RuntimeBlock, state: AgentState): string | undefined {
  switch (block) {
    case "node":
      return t("agent.runtime.nodeMissingHint");
    case "model":
      return t("agent.runtime.modelMissingHint");
    case "payload":
      return t("agent.runtime.payloadMissingHint");
    case "failed":
      return state.status?.error || undefined;
    case "status":
      return state.statusError ?? undefined;
    case "checking":
    case "stopped":
    case "starting":
      return undefined;
  }
}
