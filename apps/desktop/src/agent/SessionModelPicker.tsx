/**
 * Composer model chip: resolves the session's route (its own pick, the draft
 * before a session exists, or the configured default) and hands it to the
 * shared `ModelPicker`. A pick is session-local; `agentActions.selectModel`
 * also records it as the default for the sessions that start next.
 */
import {
  resolveActiveModel,
  type ModelSelection,
} from "../lib/agentSettings";
import { agentActions, agentStore } from "./store";
import { ModelPicker } from "./ModelPicker";

export function SessionModelPicker({ openSignal = 0 }: { openSignal?: number } = {}) {
  const state = agentStore.use();
  const models = state.config?.dshModels ?? null;
  const row = state.selectedId ? state.sessions[state.selectedId] : undefined;

  const active = resolveActiveModel(models);
  const configured: ModelSelection | null = active
    ? { provider: active.provider.id, model: active.model.id }
    : null;
  // The session's own choice wins; an old session without one still knows the
  // route of its last request. A chat that has not been allocated yet uses the
  // composer draft, then the configured default. A pick made before the first
  // reply has no transcript row behind it, hence the override.
  const chosen: ModelSelection | null =
    row?.selection ??
    (state.selectedId ? state.selectionOverrides[state.selectedId] : null) ??
    (row?.usage.provider && row.usage.model
      ? { provider: row.usage.provider, model: row.usage.model }
      : null) ??
    (!state.selectedId ? state.draftSelection : null) ??
    configured;

  return (
    <ModelPicker
      models={models}
      value={chosen}
      defaultModel={configured}
      onChange={(selection) => void agentActions.selectModel(state.selectedId, selection)}
      onManage={() => agentActions.openConfig("models")}
      openSignal={openSignal}
    />
  );
}
