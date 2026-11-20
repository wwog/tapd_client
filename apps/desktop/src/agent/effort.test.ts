// Run with: node --test apps/desktop/src/agent/effort.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultSelection,
  hasReasoning,
  rememberedEffort,
  type DshModelEntry,
  type DshModelsConfig,
} from "../lib/agentSettings.ts";

const effort = (level: string, wire = level) => ({ level, wire }) as DshModelEntry["reasoning"][number];

const model = (overrides: Partial<DshModelEntry> = {}): DshModelEntry => ({
  id: "m",
  contextWindow: 128_000,
  maxTokens: null,
  input: ["text"],
  reasoning: [],
  enabled: true,
  ...overrides,
});

const reasoningModel = model({
  reasoning: [effort("off", ""), effort("low"), effort("high")],
});

const configWith = (
  models: DshModelEntry[],
  modelEfforts: Record<string, string> = {},
): DshModelsConfig => ({
  providers: [{ id: "p", name: "P", baseUrl: "https://x", protocol: "openai-completions", apiKey: "", enabled: true, models }],
  activeProviderId: "p",
  activeModelId: models[0].id,
  modelEfforts,
});

test("hasReasoning only counts levels beyond off", () => {
  assert.equal(hasReasoning(model()), false);
  assert.equal(hasReasoning(model({ reasoning: [effort("off", "")] })), false);
  assert.equal(hasReasoning(reasoningModel), true);
});

test("a model with no ladder omits the effort everywhere", () => {
  const config = configWith([model()], { "p/m": "off" });
  assert.equal(rememberedEffort(config, "p", "m"), undefined);
  const selection = defaultSelection(config);
  assert.ok(selection);
  assert.equal("reasoningEffort" in selection, false);
});

test("a reasoning model defaults to off and honors a declared remembered level", () => {
  assert.equal(rememberedEffort(configWith([reasoningModel]), "p", "m"), "off");
  assert.equal(
    rememberedEffort(configWith([reasoningModel], { "p/m": "high" }), "p", "m"),
    "high",
  );
  // A remembered level the ladder does not declare falls back to off.
  assert.equal(
    rememberedEffort(configWith([reasoningModel], { "p/m": "max" }), "p", "m"),
    "off",
  );
});

test("defaultSelection carries the effort for a reasoning model", () => {
  const selection = defaultSelection(configWith([reasoningModel], { "p/m": "low" }));
  assert.ok(selection);
  assert.equal(selection.reasoningEffort, "low");
});
