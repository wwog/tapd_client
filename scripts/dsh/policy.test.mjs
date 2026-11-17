// Regression tests for the permission gate's dynamic mode.
//
// The old gate captured TAPD_DSH_PERMISSION_MODE once at activation, so a mode
// change only applied after restarting the runtime. These tests drive the real
// plugin with a fake Cordis context and assert that a session override, the
// runtime default and the engine's plan mode all change the decision on the
// very next tool call.
//
//   node --test scripts/dsh/policy.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { apply } from "../../dsh/plugins/tapd-policy/index.js";

const ROOT = { id: "root", header: { id: "root", cwd: "/repo" } };
const SOFT = { command: "git push origin main" };

function harness({ defaultMode = "auto", plan = false } = {}) {
  const listeners = new Map();
  const services = new Map();
  const notices = [];
  let policy;
  if (plan) {
    services.set("planMode", { selectedActive: () => true });
  }
  services.set("tapdBridge", { notice: (notice) => notices.push(notice) });

  const ctx = {
    logger: { warn() {}, info() {} },
    on(name, handler) {
      listeners.set(name, handler);
    },
    get(name) {
      return services.get(name);
    },
    provide(name, value) {
      if (name === "tapdPolicy") policy = value;
      services.set(name, value);
    },
  };

  const previous = process.env.TAPD_DSH_PERMISSION_MODE;
  process.env.TAPD_DSH_PERMISSION_MODE = defaultMode;
  try {
    apply(ctx);
  } finally {
    if (previous === undefined) delete process.env.TAPD_DSH_PERMISSION_MODE;
    else process.env.TAPD_DSH_PERMISSION_MODE = previous;
  }

  const execute = listeners.get("tools/pre-execute");
  const run = (session, tool, args) =>
    execute(
      { name: tool, arguments: args, agent: { session } },
      async () => ({ kind: "allow" }),
    );

  return { policy, run, listeners, notices };
}

test("a session override takes effect on the next call", async () => {
  const { policy, run, notices } = harness({ defaultMode: "auto" });

  // `git push` is a soft risk: auto asks, full and notify let it run.
  assert.equal((await run(ROOT, "bash", SOFT)).kind, "ask");

  policy.setMode("root", "full");
  assert.equal((await run(ROOT, "bash", SOFT)).kind, "allow");
  assert.equal(notices.length, 0);

  policy.setMode("root", "notify");
  assert.equal((await run(ROOT, "bash", SOFT)).kind, "allow");
  assert.equal(notices.length, 1, "notify announces the call");
});

test("the default only covers sessions without an override", async () => {
  const { policy, run, notices } = harness({ defaultMode: "auto" });
  const quiet = { id: "quiet", header: { id: "quiet", cwd: "/repo" } };
  const other = { id: "other", header: { id: "other", cwd: "/repo" } };

  policy.setMode("quiet", "full");
  policy.setDefault("notify");

  assert.equal((await run(other, "bash", SOFT)).kind, "allow");
  assert.equal(notices.length, 1, "the unset session follows the new default");
  assert.equal((await run(quiet, "bash", SOFT)).kind, "allow");
  assert.equal(notices.length, 1, "the overridden session keeps its own mode");
});

test("a subagent inherits its parent session mode", async () => {
  const { policy, run, listeners } = harness({ defaultMode: "auto" });
  const child = {
    id: "child",
    header: { id: "child", cwd: "/repo", origin: "subagent", parentSession: "root" },
  };
  listeners.get("session/created")(child);
  policy.setMode("root", "full");

  assert.equal((await run(child, "bash", SOFT)).kind, "allow");
});

test("plan mode denies file edits but not commands", async () => {
  const { run } = harness({ plan: true });

  const denied = await run(ROOT, "write", {
    file_path: "/repo/a.txt",
    content: "x",
  });
  assert.equal(denied.kind, "deny");
  assert.match(denied.reason, /exit_plan_mode/);

  // Commands are not blocked by the plan gate; the permission mode still is.
  assert.equal((await run(ROOT, "bash", SOFT)).kind, "ask");
});

test("file edits pass when plan mode is off", async () => {
  const { run } = harness();
  const allowed = await run(ROOT, "write", {
    file_path: "/repo/a.txt",
    content: "x",
  });
  assert.equal(allowed.kind, "allow");
});
