// Run with: node --test apps/desktop/src/agent/diff.test.ts
//
// The review diff is projected from raw `git diff` text, so the parser is the
// only thing between the backend's string and two line-number gutters.
import assert from "node:assert/strict";
import test from "node:test";

import { diffRows } from "../../../shared/agent/diff.ts";

test("numbers old and new sides through a hunk", () => {
  const rows = diffRows(
    [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -3,4 +3,5 @@",
      " three",
      "-four",
      "+FOUR",
      "+five",
      " six",
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    rows.map((row) => [row.kind, row.oldNo, row.newNo, row.text]),
    [
      ["hunk", undefined, undefined, "@@ -3,4 +3,5 @@"],
      ["context", 3, 3, "three"],
      ["del", 4, undefined, "four"],
      ["add", undefined, 4, "FOUR"],
      ["add", undefined, 5, "five"],
      ["context", 5, 6, "six"],
    ],
  );
});

test("content that looks like a file header stays content inside a hunk", () => {
  const rows = diffRows(
    ["@@ -1,2 +1,2 @@", "--- a comment", "+++ a comment", " keep"].join("\n"),
  );

  assert.deepEqual(
    rows.map((row) => [row.kind, row.oldNo, row.newNo, row.text]),
    [
      ["hunk", undefined, undefined, "@@ -1,2 +1,2 @@"],
      ["del", 1, undefined, "-- a comment"],
      ["add", undefined, 1, "++ a comment"],
      ["context", 2, 2, "keep"],
    ],
  );
});

test("file headers are dropped, notes keep, no-newline marker skipped", () => {
  const rows = diffRows(
    [
      "diff --git a/logo.png b/logo.png",
      "index 3333333..4444444 100644",
      "--- a/logo.png",
      "+++ b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "diff --git a/notes.txt b/notes.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
    ].join("\n"),
  );

  assert.deepEqual(
    rows.map((row) => [row.kind, row.text]),
    [
      ["note", "Binary files a/logo.png and b/logo.png differ"],
      ["hunk", "@@ -1 +1 @@"],
      ["del", "old"],
      ["add", "new"],
    ],
  );
});

test("CRLF input and a truncated tail still project", () => {
  const rows = diffRows("@@ -8,2 +8,2 @@\r\n-eight\r\n+eight\r\n");

  assert.deepEqual(
    rows.map((row) => [row.kind, row.oldNo, row.newNo, row.text]),
    [
      ["hunk", undefined, undefined, "@@ -8,2 +8,2 @@"],
      ["del", 8, undefined, "eight"],
      ["add", undefined, 8, "eight"],
    ],
  );
  assert.deepEqual(diffRows("not a diff at all").map((row) => row.kind), ["note"]);
});

test("a diff without hunks keeps its header lines as notes", () => {
  // A chmod-only change emits no hunk; dropping the headers would leave the
  // review panel claiming the modified file has no changes.
  const rows = diffRows(
    ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"].join("\n"),
  );
  assert.deepEqual(
    rows.map((row) => [row.kind, row.text]),
    [
      ["note", "diff --git a/run.sh b/run.sh"],
      ["note", "old mode 100644"],
      ["note", "new mode 100755"],
    ],
  );
  assert.deepEqual(diffRows("").map((row) => row.kind), []);
});
