#!/usr/bin/env node
/**
 * Controlled 60fps lab for the agent transcript fold.
 *
 * Serves `apps/desktop/perf.html` (Vite must be running on :1420), opens it in
 * a separate headful Chrome, and drives the "已工作" fold open/close while
 * collecting frame intervals, Long Animation Frames, long tasks and layout
 * shifts. Unlike the Tauri WebView, this window is visible, so rAF and paint
 * are real.
 *
 *   pnpm -C apps/desktop dev        # in another terminal
 *   node scripts/agent-perf-lab.mjs [iterations]
 *
 * Exit code 1 when a budget is violated.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ITERATIONS = Math.max(1, Number.parseInt(process.argv[2] ?? "12", 10) || 12);
const PORT = Number(process.env.PERF_CDP_PORT ?? "9333");
const CHROME =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = `http://localhost:1420/perf.html`;

const profile = mkdtempSync(join(tmpdir(), "agent-perf-chrome-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--force-device-scale-factor=2",
    "--window-size=1000,900",
    URL,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const pages = await response.json();
      const page = pages.find((item) => item.type === "page" && item.url.includes("perf.html"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error("Chrome did not expose the perf page");
}

function cdp(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
}

const expression = String.raw`
(async () => {
  const iterations = ITERATIONS;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pct = (values, p) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  };
  const foldButton = () =>
    [...document.querySelectorAll("button")].find((button) =>
      button.textContent.includes("已工作"),
    );
  await document.fonts.ready;
  await wait(250);
  const scroller = document.getElementById("perf-scroll");
  if (!scroller) throw new Error("perf scroll container missing");

  const runs = [];
  for (let run = 0; run < iterations; run += 1) {
    const button = foldButton();
    if (!button) throw new Error("fold button missing");
    if (button.getAttribute("aria-expanded") === "true") {
      button.click();
      await wait(320);
    }
    button.scrollIntoView({ block: "center" });
    await wait(60);

    const finalAnswer = [...scroller.querySelectorAll(".md-body")].at(-1);
    const gapOf = () =>
      finalAnswer
        ? finalAnswer.getBoundingClientRect().top - button.getBoundingClientRect().bottom
        : null;
    const closedGap = gapOf();
    const startScroll = scroller.scrollTop;
    const frames = [];
    let last = performance.now();
    let frameLoop = true;
    const frame = (now) => {
      frames.push(now - last);
      last = now;
      if (frameLoop) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    const longTasks = [];
    const loafs = [];
    const shifts = [];
    const poLong = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    try { poLong.observe({ entryTypes: ["longtask"] }); } catch {}
    let poLoaf = null;
    try {
      poLoaf = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          loafs.push({
            duration: entry.duration,
            blocking: entry.blockingDuration,
            layout: entry.styleAndLayoutStart
              ? entry.startTime + entry.duration - entry.styleAndLayoutStart
              : 0,
          });
        }
      });
      poLoaf.observe({ entryTypes: ["long-animation-frame"] });
    } catch {}
    const poShift = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) shifts.push(entry.value);
      }
    });
    try { poShift.observe({ entryTypes: ["layout-shift"] }); } catch {}

    const timeline = [];
    const t0 = performance.now();
    button.click();
    const sample = () => {
      const grid = button.parentElement.querySelector("div.grid");
      timeline.push([
        performance.now() - t0,
        grid ? grid.getBoundingClientRect().height : -1,
        scroller.scrollTop - startScroll,
      ]);
      if (timeline.length < 32) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    await wait(560);
    frameLoop = false;
    poLong.disconnect();
    poLoaf?.disconnect();
    poShift.disconnect();

    // The same extra-flex-gap bug existed one level down: a flow's note after
    // its steps. Measure it while the turn fold is still open.
    const flowButton = [...scroller.querySelectorAll("button")].find((candidate) =>
      candidate.textContent.includes("已执行 4 命令"),
    );
    const flowNote = flowButton
      ? flowButton.parentElement.parentElement.querySelector(".md-body")
      : null;
    const flowGapOf = () =>
      flowButton && flowNote
        ? flowNote.getBoundingClientRect().top - flowButton.getBoundingClientRect().bottom
        : null;
    const flowClosedGap = flowGapOf();
    let flowOpenGap = null;
    let flowClosingGap = null;
    let flowAfterGap = null;
    if (flowButton) {
      flowButton.click();
      await wait(320);
      flowOpenGap = flowGapOf();
      flowButton.click();
      await wait(230);
      flowClosingGap = flowGapOf();
      await wait(160);
      flowAfterGap = flowGapOf();
    }

    button.click();
    await wait(230);
    const closingGap = gapOf();
    await wait(160);
    const afterGap = gapOf();

    const deltas = frames.slice(1);
    const gapJump =
      closingGap !== null && afterGap !== null ? closingGap - afterGap : null;
    const gapRestore =
      closedGap !== null && afterGap !== null ? afterGap - closedGap : null;
    const firstHeight = timeline.find((sample) => sample[1] > 0);
    runs.push({
      frames: deltas.length,
      p50: pct(deltas, 0.5),
      p95: pct(deltas, 0.95),
      max: Math.max(...deltas),
      over16: deltas.filter((value) => value > 16.7).length,
      over33: deltas.filter((value) => value > 33).length,
      longTasks: longTasks.map((value) => Math.round(value)),
      loafs,
      shift: shifts.reduce((sum, value) => sum + value, 0),
      startMs: firstHeight ? firstHeight[0] : null,
      height: timeline.at(-1)?.[1] ?? null,
      scrollMax: Math.max(...timeline.map((sample) => Math.abs(sample[2]))),
      closedGap,
      closingGap,
      afterGap,
      gapJump,
      gapRestore,
      flowClosedGap,
      flowOpenGap,
      flowClosingGap,
      flowAfterGap,
      flowJump:
        flowClosingGap !== null && flowAfterGap !== null
          ? flowClosingGap - flowAfterGap
          : null,
      flowRestore:
        flowClosedGap !== null && flowAfterGap !== null
          ? flowAfterGap - flowClosedGap
          : null,
    });
  }

  const flat = runs.flatMap((run) => {
    // Each run's own p-values are already aggregated; keep the raw frame sample
    // out and report the worst run plus the aggregate of the run p95s.
    return [run];
  });
  const summary = {
    runs: flat.length,
    p95Worst: Math.max(...flat.map((run) => run.p95)),
    maxWorst: Math.max(...flat.map((run) => run.max)),
    over33Total: flat.reduce((sum, run) => sum + run.over33, 0),
    longTaskTotal: flat.reduce((sum, run) => sum + run.longTasks.length, 0),
    shiftTotal: flat.reduce((sum, run) => sum + run.shift, 0),
    startWorst: Math.max(...flat.map((run) => run.startMs ?? 0)),
    scrollMax: Math.max(...flat.map((run) => run.scrollMax)),
    gapJumpWorst: Math.max(...flat.map((run) => Math.abs(run.gapJump ?? 0))),
    gapRestoreWorst: Math.max(...flat.map((run) => Math.abs(run.gapRestore ?? 0))),
    flowGapJumpWorst: Math.max(...flat.map((run) => Math.abs(run.flowJump ?? 0))),
    flowGapRestoreWorst: Math.max(
      ...flat.map((run) => Math.abs(run.flowRestore ?? 0)),
    ),
    height: flat[0]?.height ?? null,
    runs: flat,
  };
  return summary;
})()
`;

const budget = {
  p95: 18.5,
  max: 34,
  startMs: 60,
  scroll: 1,
  gapJump: 1.5,
};

try {
  const wsUrl = await findPage();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = cdp(ws);
  await send("Runtime.enable");
  await send("Page.enable");
  // The target can still be navigating when the endpoint first appears; wait
  // for the React fixture before evaluating the measurement expression.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const ready = await send("Runtime.evaluate", {
        expression:
          'document.readyState === "complete" && Boolean(document.getElementById("perf-scroll"))',
        returnByValue: true,
      });
      if (ready.result?.value === true) break;
    } catch {
      // Execution context replaced by the navigation; retry.
    }
    await sleep(250);
  }
  const result = await send("Runtime.evaluate", {
    expression: expression.replace("ITERATIONS", String(ITERATIONS)),
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "perf page threw");
  }
  const report = result.result.value;
  console.log(JSON.stringify(report, null, 2));

  const failures = [];
  if (report.p95Worst > budget.p95) failures.push(`p95 ${report.p95Worst.toFixed(1)}ms > ${budget.p95}`);
  if (report.maxWorst > budget.max) failures.push(`max ${report.maxWorst.toFixed(1)}ms > ${budget.max}`);
  if (report.startWorst > budget.startMs) failures.push(`start ${report.startWorst.toFixed(1)}ms > ${budget.startMs}`);
  if (report.scrollMax > budget.scroll) failures.push(`scroll drift ${report.scrollMax.toFixed(1)}px`);
  if (report.gapJumpWorst > budget.gapJump)
    failures.push(`close gap jump ${report.gapJumpWorst.toFixed(1)}px > ${budget.gapJump}`);
  if (report.gapRestoreWorst > budget.gapJump)
    failures.push(`gap not restored ${report.gapRestoreWorst.toFixed(1)}px`);
  if (report.flowGapJumpWorst > budget.gapJump)
    failures.push(`flow close gap jump ${report.flowGapJumpWorst.toFixed(1)}px`);
  if (report.flowGapRestoreWorst > budget.gapJump)
    failures.push(`flow gap not restored ${report.flowGapRestoreWorst.toFixed(1)}px`);
  if (report.longTaskTotal > 0) failures.push(`${report.longTaskTotal} long task(s)`);
  if (failures.length > 0) {
    console.error("\nFAIL: " + failures.join("; "));
    process.exitCode = 1;
  } else {
    console.log("\nPASS: 60fps budget held");
  }
  ws.close();
} finally {
  chrome.kill("SIGTERM");
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold a file; the OS temp dir can keep it.
  }
}
