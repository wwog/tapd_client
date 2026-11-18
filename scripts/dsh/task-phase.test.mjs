// Regression tests for the task-flow phase rules.
//
// The host owns the phase, but two plugin-side decisions are load-bearing and
// cheap to get wrong: which tool is visible in a phase, and how a mirrored
// phase frame is applied. Both live in import-free modules so these tests run
// without the dsh payload.
//
//   node --test scripts/dsh/task-phase.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  TASK_PHASES,
  replacePhaseEntries,
  readPhaseEntry,
  phaseOfEntry,
  setPhaseEntry,
} from "../../dsh/plugins/tapd-bridge/task-phases.js";
import {
  EXECUTE_PROMPT,
  WRITEBACK_PROMPT,
  commentText,
  completeText,
  isExecuteTask,
  isWritebackTask,
  promptFor,
  showsExecutePrompt,
  statusText,
  submitText,
  transitionsText,
} from "../../dsh/plugins/tapd-tools/task.js";

// ---------------------------------------------------------------------------
// Bridge mirror
// ---------------------------------------------------------------------------

test("a phase frame updates one session and keeps its kind", () => {
  const map = new Map();

  assert.equal(setPhaseEntry(map, "s1", "execute", "bug"), true);
  assert.deepEqual(readPhaseEntry(map, "s1"), { phase: "execute", kind: "bug" });

  // A second frame without a kind must not silently become `chat`.
  assert.equal(setPhaseEntry(map, "s1", "writeback"), true);
  assert.deepEqual(readPhaseEntry(map, "s1"), { phase: "writeback", kind: "bug" });
  assert.equal(phaseOfEntry(map, "s1"), "writeback");
});

test("an unknown phase or empty session is rejected, not guessed", () => {
  const map = new Map();

  assert.equal(setPhaseEntry(map, "s1", "running", "bug"), false);
  assert.equal(setPhaseEntry(map, "", "execute", "bug"), false);
  assert.equal(setPhaseEntry(map, undefined, "execute", "bug"), false);
  assert.equal(map.size, 0);
  assert.equal(readPhaseEntry(map, "s1"), null);
  assert.equal(phaseOfEntry(map, "s1"), undefined);

  for (const phase of TASK_PHASES) {
    assert.equal(setPhaseEntry(map, "s1", phase, "chat"), true, phase);
  }
});

test("a snapshot replaces the whole map", () => {
  const map = new Map();
  setPhaseEntry(map, "gone", "execute", "bug");
  setPhaseEntry(map, "kept", "review", "bug");

  const count = replacePhaseEntries(map, [
    { sessionId: "kept", phase: "writeback", kind: "bug" },
    { sessionId: "new", phase: "execute", kind: "local_item" },
    { sessionId: "bad", phase: "nonsense", kind: "bug" },
    null,
    { phase: "execute" },
  ]);

  assert.equal(count, 2);
  assert.equal(map.size, 2, "the stale execute entry is dropped");
  assert.equal(phaseOfEntry(map, "gone"), undefined);
  assert.deepEqual(readPhaseEntry(map, "new"), { phase: "execute", kind: "local_item" });

  // A malformed snapshot clears rather than preserving a lie.
  assert.equal(replacePhaseEntries(map, undefined), 0);
  assert.equal(map.size, 0);
});

// ---------------------------------------------------------------------------
// Tool visibility
// ---------------------------------------------------------------------------

test("task_submit belongs to execute for bug/local tasks only", () => {
  assert.equal(isExecuteTask({ phase: "execute", kind: "bug" }), true);
  assert.equal(isExecuteTask({ phase: "execute", kind: "local_item" }), true);
  assert.equal(isExecuteTask({ phase: "execute", kind: "chat" }), false);
  assert.equal(isExecuteTask({ phase: "review", kind: "bug" }), false);
  assert.equal(isExecuteTask({ phase: "writeback", kind: "bug" }), false);
  assert.equal(isExecuteTask(null), false);
});

test("TAPD writeback tools belong to writeback on a bug only", () => {
  assert.equal(isWritebackTask({ phase: "writeback", kind: "bug" }), true);
  assert.equal(isWritebackTask({ phase: "writeback", kind: "local_item" }), false);
  assert.equal(isWritebackTask({ phase: "writeback", kind: "chat" }), false);
  assert.equal(isWritebackTask({ phase: "execute", kind: "bug" }), false);
  assert.equal(isWritebackTask(null), false);
});

test("execute and writeback never show each other's prompt", () => {
  for (const task of [
    { phase: "chat", kind: "chat" },
    { phase: "review", kind: "bug" },
    { phase: "none", kind: "bug" },
    { phase: "none", kind: "chat" },
  ]) {
    assert.equal(promptFor(task), "", `${task.phase}/${task.kind}`);
    assert.equal(showsExecutePrompt(task), false);
  }

  assert.equal(promptFor({ phase: "execute", kind: "bug" }), EXECUTE_PROMPT);
  assert.equal(promptFor({ phase: "execute", kind: "local_item" }), EXECUTE_PROMPT);
  assert.equal(promptFor({ phase: "writeback", kind: "bug" }), WRITEBACK_PROMPT);
  // The section for execute covers every non-chat kind; the tool does not.
  assert.equal(promptFor({ phase: "execute", kind: "chat" }), "");
  assert.equal(promptFor({ phase: "execute", kind: "future_kind" }), EXECUTE_PROMPT);
  assert.equal(showsExecutePrompt({ phase: "execute", kind: "future_kind" }), true);

  assert.match(EXECUTE_PROMPT, /task_submit/);
  assert.match(EXECUTE_PROMPT, /不要 git commit/);
  assert.match(WRITEBACK_PROMPT, /tapd_update_status/);
  assert.match(WRITEBACK_PROMPT, /task_complete/);
});

// ---------------------------------------------------------------------------
// Host reply rendering
// ---------------------------------------------------------------------------

test("task_submit renders each outcome", () => {
  assert.match(submitText({ outcome: "review", phase: "review" }), /等待人工审核/);
  assert.match(submitText({ outcome: "review", phase: "review" }), /review/);
  assert.match(submitText({ outcome: "done" }), /没有代码改动/);
  assert.match(submitText({ outcome: "already" }), /未重复提交/);
  assert.equal(typeof submitText({}), "string");
  assert.equal(submitText({}).length > 0, true);
});

test("transitions render the current state and every legal target", () => {
  const text = transitionsText({
    current: "new",
    alias: "新",
    transitions: [
      { key: "resolved", label: "已解决" },
      { key: "rejected", label: "已拒绝" },
    ],
  });
  assert.match(text, /当前状态：new（新）/);
  assert.match(text, /- resolved（已解决）/);
  assert.match(text, /- rejected（已拒绝）/);

  assert.match(transitionsText({ current: "resolved", transitions: [] }), /没有可用/);
  assert.match(transitionsText({}), /未知/);
  // String entries and duplicate labels are tolerated.
  const loose = transitionsText({ current: "new", alias: "new", transitions: ["resolved", { key: "rejected" }] });
  assert.match(loose, /- resolved/);
  assert.match(loose, /- rejected/);
  assert.doesNotMatch(loose, /（new）/);
});

test("writeback results read as one short line", () => {
  assert.match(commentText({}), /评论已写入/);
  assert.match(commentText({ duplicate: true }), /未重复写入/);
  assert.match(statusText({ from: "new", to: "resolved" }), /new 变更为 resolved/);
  assert.match(completeText(), /done/);
});
