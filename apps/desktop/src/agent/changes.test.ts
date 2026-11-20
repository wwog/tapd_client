// Run with: node --test apps/desktop/src/agent/changes.test.ts
//
// The change card's projection is pure, so it is tested directly: one turn's
// file-tool calls in, per-file counts out.
import assert from "node:assert/strict";
import test from "node:test";

import { turnChanges } from "../../../shared/agent/changes.ts";
import type { AgentTurnBlock } from "../../../shared/agent/types.ts";

function block(entries: AgentTurnBlock["entries"]): AgentTurnBlock {
  return { key: "turn:1", entries };
}

function tool(name: string, args: unknown, status: "ok" | "error" = "ok") {
  return {
    kind: "tool" as const,
    seq: 1,
    at: "2026-11-20T00:00:00.000Z",
    turn: 1,
    step: 1,
    callId: `c-${name}`,
    name,
    args: JSON.stringify(args),
    status,
  };
}

test("write and edit on one file are summed, in first-seen order", () => {
  const changes = turnChanges(
    block([
      tool("write", { file_path: "src/a.ts", content: "one\ntwo\nthree" }),
      tool("edit", {
        file_path: "src/a.ts",
        old_string: "two",
        new_string: "TWO\nEXTRA",
      }),
      tool("write", { file_path: "docs/b.md", content: "x" }),
    ]),
  );
  assert.deepEqual(
    changes.files.map((file) => file.path),
    ["src/a.ts", "docs/b.md"],
  );
  const a = changes.files[0];
  // The write added three lines; the edit replaced one line with two.
  assert.equal(a.added, 3 + 2);
  assert.equal(a.removed, 1);
  assert.equal(changes.added, 3 + 2 + 1);
  assert.equal(changes.removed, 1);
});

test("apply_patch counts every file block", () => {
  const input = [
    "*** Begin Patch",
    "*** Add File: src/new.ts",
    "+one",
    "+two",
    "*** Update File: src/old.ts",
    "@@ context",
    " keep",
    "-gone",
    "+added",
    "*** Delete File: src/dead.ts",
    "*** End Patch",
  ].join("\n");
  const changes = turnChanges(block([tool("apply_patch", { input })]));
  assert.deepEqual(
    changes.files.map((file) => [file.path, file.added, file.removed]),
    [
      ["src/new.ts", 2, 0],
      ["src/old.ts", 1, 1],
      ["src/dead.ts", 0, 0],
    ],
  );
});

test("failed calls, reads and shell commands never count", () => {
  const changes = turnChanges(
    block([
      tool("write", { file_path: "src/a.ts", content: "x" }, "error"),
      tool("read", { file_path: "src/a.ts" }),
      tool("bash", { command: "echo hi > src/a.ts" }),
    ]),
  );
  assert.deepEqual(changes, { files: [], added: 0, removed: 0 });
});

test("str_replace_editor create counts its own lines", () => {
  const changes = turnChanges(
    block([
      tool("str_replace_editor", {
        command: "create",
        path: "lib/x.ts",
        file_text: "a\nb",
      }),
    ]),
  );
  assert.deepEqual(changes.files, [{ path: "lib/x.ts", added: 2, removed: 0 }]);
});
