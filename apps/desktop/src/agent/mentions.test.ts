// Run with: node --test apps/desktop/src/agent/mentions.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import { activeMention, applyMention, mentionText } from "./mentions.ts";

test("a token opens at a word boundary and carries the query", () => {
  assert.deepEqual(activeMention("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(activeMention("see @src/ma", 11), {
    start: 4,
    end: 11,
    query: "src/ma",
  });
  assert.deepEqual(activeMention("[@abc", 5), {
    start: 1,
    end: 5,
    query: "abc",
  });
});

test("emails, spaces and a second @ never open a search", () => {
  assert.equal(activeMention("mail a@b.com", 12), undefined);
  assert.equal(activeMention("@src main", 9), undefined);
  assert.equal(activeMention("@a@b", 4), undefined);
});

test("a quoted token stays open until its closing quote", () => {
  assert.deepEqual(activeMention('@"docs/a b', 10), {
    start: 0,
    end: 10,
    query: "docs/a b",
  });
  assert.equal(activeMention('@"docs/a b"', 11), undefined);
});

test("only the token at the caret counts", () => {
  // The caret sits before the mention, so nothing is being completed.
  assert.equal(activeMention("text @src/main.ts", 0), undefined);
});

test("picking replaces the token and leaves a trailing space", () => {
  const text = "look @src/ma and";
  const token = activeMention(text, 12);
  assert.ok(token);
  const next = applyMention(text, token, "src/main.ts");
  assert.equal(next.text, "look @src/main.ts  and");
  assert.equal(next.caret, "look @src/main.ts ".length);
});

test("paths with spaces are quoted", () => {
  assert.equal(mentionText("docs/a b.md"), '@"docs/a b.md"');
  assert.equal(mentionText("src/main.ts"), "@src/main.ts");
});
