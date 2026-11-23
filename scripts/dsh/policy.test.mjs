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

const ROOT = session("root", "/repo");
const SOFT = { command: "git push origin main" };

/** A session stub that records the `sandbox/mode` events the gate writes. */
function session(id, cwd, header = {}) {
  return {
    id,
    header: { id, cwd, ...header },
    appended: [],
    append(type, data) {
      this.appended.push({ type, data });
    },
    lastSandbox() {
      return this.appended.filter((event) => event.type === "sandbox/mode").at(-1)?.data.mode;
    },
  };
}

function harness({ defaultMode = "auto", plan = false } = {}) {
  const listeners = new Map();
  const services = new Map();
  const notices = [];
  const sessions = new Map([[ROOT.id, ROOT]]);
  let policy;
  if (plan) {
    services.set("planMode", { selectedActive: () => true });
  }
  services.set("tapdBridge", { notice: (notice) => notices.push(notice) });
  const agents = {
    get: (id) => (sessions.has(id) ? { session: sessions.get(id) } : undefined),
    list: () => [...sessions.values()].map((item) => ({ session: item })),
  };
  services.set("agents", agents);

  const ctx = {
    logger: { warn() {}, info() {} },
    // Cordis exposes injected services as properties; the fake mirrors that.
    agents,
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
  const run = (target, tool, args) =>
    execute(
      { name: tool, arguments: args, agent: { session: target } },
      async () => ({ kind: "allow" }),
    );

  return { policy, run, listeners, notices, sessions };
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
  const quiet = session("quiet", "/repo");
  const other = session("other", "/repo");

  policy.setMode("quiet", "full");
  policy.setDefault("notify");

  assert.equal((await run(other, "bash", SOFT)).kind, "allow");
  assert.equal(notices.length, 1, "the unset session follows the new default");
  assert.equal((await run(quiet, "bash", SOFT)).kind, "allow");
  assert.equal(notices.length, 1, "the overridden session keeps its own mode");
});

test("a subagent inherits its parent session mode", async () => {
  const { policy, run, listeners } = harness({ defaultMode: "auto" });
  const child = session("child", "/repo", { origin: "subagent", parentSession: "root" });
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

test("reading a path or redirecting stderr is not a write", async () => {
  const { run } = harness({ defaultMode: "auto" });

  // These are the three shapes that asked for approval in a real session:
  // a stderr redirect made the whole line "a write" and every absolute token
  // on it a write target.
  for (const command of [
    'find . -maxdepth 2 -type d -name "chat-engine" 2>/dev/null; ls skills',
    "ls -la /Users/me/projects/chat-engine 2>/dev/null | head",
    "ls /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg 2>/dev/null; echo done",
    "cat ../chat-engine/Cargo.toml",
    "git -C /Users/me/projects/chat-engine status",
    "echo done > /dev/null",
    "rm -rf build",
  ]) {
    assert.equal(
      (await run(ROOT, "bash", { command })).kind,
      "allow",
      command,
    );
  }
});

test("auto leaves path writes to the engine sandbox", async () => {
  const { run } = harness({ defaultMode: "auto" });

  // The sandbox runs in `workspace-write` here, so it denies or escalates an
  // outside write itself. Asking here as well would be two cards for one call.
  for (const command of [
    "cp /repo/a.txt /tmp/b.txt",
    "echo x > /tmp/x",
    "mkdir -p /Users/me/elsewhere",
    'echo key > "$HOME/.ssh/authorized_keys"',
  ]) {
    assert.equal(
      (await run(ROOT, "bash", { command })).kind,
      "allow",
      command,
    );
  }
});

test("full still asks for a credential write", async () => {
  const { policy, run } = harness({ defaultMode: "auto" });
  policy.setMode("root", "full");
  const decision = await run(ROOT, "bash", {
    command: 'echo key > "$HOME/.ssh/authorized_keys"',
  });
  assert.equal(decision.kind, "ask");
  assert.match(decision.reason, /^hard:protected_path/);
});

test("the permission mode owns the engine sandbox", async () => {
  const { policy, run } = harness({ defaultMode: "auto" });

  // The desktop re-pushes the mode before every prompt; the first push writes
  // the event, a repeat writes nothing.
  policy.setMode("root", "auto");
  assert.equal(ROOT.lastSandbox(), "workspace-write");
  const writes = ROOT.appended.length;
  policy.setMode("root", "auto");
  assert.equal(ROOT.appended.length, writes, "an unchanged mode appends nothing");

  // The two "let it run" modes must not leave the engine asking for the very
  // writes they allow.
  policy.setMode("root", "full");
  assert.equal(ROOT.lastSandbox(), "danger-full-access");
  policy.setMode("root", "notify");
  assert.equal(ROOT.lastSandbox(), "danger-full-access");

  // A runtime-wide default reaches sessions that never picked one, and leaves
  // an explicit pick alone.
  policy.setMode("root", "auto");
  policy.setDefault("full");
  assert.equal(ROOT.lastSandbox(), "workspace-write", "the override wins");
  assert.equal((await run(ROOT, "bash", SOFT)).kind, "ask", "and it stays auto");
});

test("notify announces ordinary in-workspace file changes", async () => {
  const { policy, run, notices } = harness({ defaultMode: "auto" });
  policy.setMode("root", "notify");

  // No risk rule fires for an edit inside the session directory, but notify
  // mode promises a notice before every change.
  assert.equal(
    (await run(ROOT, "write", { file_path: "/repo/a.txt", content: "x" }))
      .kind,
    "allow",
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0].tool, "write");
  assert.match(notices[0].target, /a\.txt$/);

  // Shell writes count too, including the implicit-target editors.
  assert.equal(
    (await run(ROOT, "bash", { command: "echo x > /repo/b.txt" })).kind,
    "allow",
  );
  assert.equal(notices.length, 2);
  assert.equal(
    (await run(ROOT, "bash", { command: "sed -i '' s/a/b/ /repo/a.txt" }))
      .kind,
    "allow",
  );
  assert.equal(notices.length, 3);

  // Reads stay silent.
  assert.equal(
    (await run(ROOT, "bash", { command: "cat /repo/a.txt" })).kind,
    "allow",
  );
  assert.equal(
    (await run(ROOT, "read", { file_path: "/repo/a.txt" })).kind,
    "allow",
  );
  assert.equal(notices.length, 3);
});

test("notify leaves non-mutating tools alone", async () => {
  const { policy, run, notices } = harness({ defaultMode: "auto" });
  policy.setMode("root", "notify");

  assert.equal((await run(ROOT, "glob", { pattern: "*.txt" })).kind, "allow");
  assert.equal(
    (await run(ROOT, "bash", { command: "git status" })).kind,
    "allow",
  );
  assert.equal(notices.length, 0);
});

test("a new default reaches a session without its own pick", async () => {
  const { policy, sessions } = harness({ defaultMode: "auto" });
  const other = session("other", "/repo");
  sessions.set("other", other);

  policy.setDefault("full");
  assert.equal(other.lastSandbox(), "danger-full-access");
  assert.equal(ROOT.lastSandbox(), "danger-full-access");
});
