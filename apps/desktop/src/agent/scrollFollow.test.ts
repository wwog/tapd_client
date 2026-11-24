// Run with: node --test apps/desktop/src/agent/scrollFollow.test.ts
//
// The tail-follow rule decides whether one scroll event keeps the transcript
// pinned to the bottom; the small-nudge case is the one that regressed.
import assert from "node:assert/strict";
import test from "node:test";

import { sticksAfterScroll } from "../../../shared/agent/scrollFollow.ts";

const STICK = 48;
/** A reader sitting exactly at the bottom of a 1000px-tall transcript. */
const AT_TAIL = { top: 600, height: 1000 };
const VIEWPORT = 400;

test("a small nudge up leaves the tail instead of being re-pinned", () => {
  // 20px up: still inside the 48px threshold, but the reader asked to leave.
  assert.equal(
    sticksAfterScroll(AT_TAIL, { top: 580, height: 1000 }, VIEWPORT, STICK),
    false,
  );
});

test("scrolling back down to the end follows again", () => {
  assert.equal(
    sticksAfterScroll({ top: 580, height: 1000 }, AT_TAIL, VIEWPORT, STICK),
    true,
  );
  // 30px above the end is still "at the tail".
  assert.equal(
    sticksAfterScroll({ top: 400, height: 1000 }, { top: 570, height: 1000 }, VIEWPORT, STICK),
    true,
  );
  // Landing far from the end does not silently resume.
  assert.equal(
    sticksAfterScroll({ top: 100, height: 1000 }, { top: 300, height: 1000 }, VIEWPORT, STICK),
    false,
  );
});

test("a clamp after the content shrank is not a reader move", () => {
  // The fold closed under the tail: offset fell exactly with the height.
  assert.equal(
    sticksAfterScroll({ top: 600, height: 1000 }, { top: 520, height: 920 }, VIEWPORT, STICK),
    true,
  );
  // Even with a couple of pixels of rounding the tail is kept.
  assert.equal(
    sticksAfterScroll({ top: 600, height: 1000 }, { top: 519, height: 918 }, VIEWPORT, STICK),
    true,
  );
});

test("a real move up during a shrink still leaves", () => {
  // The content lost 40px but the offset fell 55px: the reader scrolled too,
  // even though the tail is still within the threshold.
  assert.equal(
    sticksAfterScroll({ top: 600, height: 1000 }, { top: 545, height: 960 }, VIEWPORT, STICK),
    false,
  );
});

test("one pixel of jitter keeps following", () => {
  assert.equal(
    sticksAfterScroll(AT_TAIL, { top: 599, height: 1000 }, VIEWPORT, STICK),
    true,
  );
});

test("an explicit release survives a jitter-sized rise", () => {
  // The wheel-up already detached the tail; the 1px the wheel actually moved
  // must not re-attach it on the scroll event that follows.
  assert.equal(
    sticksAfterScroll(AT_TAIL, { top: 599, height: 1000 }, VIEWPORT, STICK, true),
    false,
  );
  // A clamp while released (fold closing under the tail) is not motion: the
  // reader ends at the bottom, so following resumes.
  assert.equal(
    sticksAfterScroll(AT_TAIL, { top: 520, height: 920 }, VIEWPORT, STICK, true),
    true,
  );
  // Coming back down to the end re-attaches.
  assert.equal(
    sticksAfterScroll({ top: 400, height: 1000 }, AT_TAIL, VIEWPORT, STICK, true),
    true,
  );
});
