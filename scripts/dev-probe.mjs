#!/usr/bin/env node
// Dev probe client for the running debug app.
//
// Talks to the loopback API published in runtime.json and drives the app's own
// UI window (`/dev/ui/*`), so verifying the interface does not need OS-level
// automation. Debug builds only.
//
//   node scripts/dev-probe.mjs eval 'document.title'
//   node scripts/dev-probe.mjs call '(async () => { ... })()'
//   node scripts/dev-probe.mjs console
//   node scripts/dev-probe.mjs shot [maxWidth]
//   node scripts/dev-probe.mjs /dev/feature '{"name":"cache_workspace_context"}'
//
// Expressions may also be piped on stdin ("-").

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const runtimeFile = join(
  homedir(),
  "Library/Application Support/com.tapdclient.desktop_dev/runtime.json",
);

function readRuntime() {
  try {
    return JSON.parse(readFileSync(runtimeFile, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read ${runtimeFile}: ${error.message}\nIs the debug app running (pnpm dev)?`,
    );
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function request(path, { method = "POST", body, query } = {}) {
  const runtime = readRuntime();
  const url = new URL(`http://127.0.0.1:${runtime.port}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${runtime.token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: response.ok, raw: text };
  }
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

const [command, ...rest] = process.argv.slice(2);

async function expressionArg() {
  const raw = rest.join(" ").trim();
  if (!raw || raw === "-") return (await readStdin()).trim();
  return raw;
}

switch (command) {
  case "eval":
  case "call": {
    const expression = await expressionArg();
    const result = await request(`/dev/ui/${command}`, {
      body: { expression, withConsole: true },
    });
    print(result);
    const consoleEntries = result.console ?? [];
    if (consoleEntries.length > 0) {
      console.log("--- console ---");
      for (const entry of consoleEntries) {
        console.log(`[${entry.level}] ${entry.text}`);
      }
    }
    process.exit(result.ok ? 0 : 1);
    break;
  }
  case "console":
    print(await request("/dev/ui/console", { method: "GET" }));
    break;
  case "shot": {
    const maxWidth = Number(rest[0] ?? 0) || undefined;
    print(await request("/dev/ui/snapshot", { body: { maxWidth } }));
    break;
  }
  default: {
    if (!command) {
      console.error(
        "usage: dev-probe.mjs eval|call|console|shot [args]\n" +
          "       dev-probe.mjs <path> '<json body>'   # any other loopback route",
      );
      process.exit(2);
    }
    const body = rest.length > 0 ? JSON.parse(await expressionArg()) : undefined;
    print(await request(command, { body }));
  }
}
