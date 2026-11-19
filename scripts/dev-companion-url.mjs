#!/usr/bin/env node
// Companion external-URL helper for dev.
//
// Ensures the debug app is running (starts `pnpm dev` detached when it is
// not), ensures the Quick Tunnel is up, then returns the tunnel pairing URL
// the phone opens: `<trycloudflare>/#/pair?t=<code>`. The debug app publishes
// a loopback API (runtime.json) whose webview can invoke the app's own Tauri
// commands (`/dev/ui/call`), so nothing here clicks through the UI.
//
//   node scripts/dev-companion-url.mjs                 # ensure everything, print JSON
//   node scripts/dev-companion-url.mjs --no-start      # fail instead of starting the app
//   node scripts/dev-companion-url.mjs --timeout 300   # app-start budget in seconds
//   node scripts/dev-companion-url.mjs --lan           # LAN URL instead of the tunnel
//
// Output (stdout) is a single JSON object:
//   { ok, url, code?, tunnel?, lan?, appStarted, requirePairingCode? }
// `url` is always the link to open on the phone; the query code is inert
// while pairing codes are switched off.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const REPO_ROOT = join(import.meta.dirname, "..");
const RUNTIME_FILE = join(
  homedir(),
  "Library/Application Support/com.tapdclient.desktop_dev/runtime.json",
);
const DEV_LOG = join(tmpdir(), "tapd-client-dev.log");
const VITE_PORT = 1420;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const numberArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) || fallback : fallback;
};
const NO_START = flag("--no-start");
const USE_LAN = flag("--lan");
const START_TIMEOUT_S = numberArg("--timeout", 240);
const TUNNEL_TIMEOUT_S = numberArg("--tunnel-timeout", 40);

function readRuntime() {
  try {
    return JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function probeLoopback(port, token, timeoutMs = 2_500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/dev/ui/eval`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expression: "1", withConsole: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload.ok === true && payload.value === 1;
  } catch {
    return false;
  }
}

/** Invokes one of the app's own Tauri commands inside the debug webview. */
async function invoke(command, argsJson = {}) {
  const runtime = readRuntime();
  const response = await fetch(`http://127.0.0.1:${runtime.port}/dev/ui/call`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      expression:
        `(async () => { const { invoke } = window.__TAURI_INTERNALS__; ` +
        `return await invoke(${JSON.stringify(command)}, ${JSON.stringify(argsJson)}); })()`,
      withConsole: false,
      timeoutSecs: 20,
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`invoke ${command}: ${payload.error ?? "loopback error"}`);
  }
  return payload.value;
}

/** Frees the Vite port: a leftover watcher from a previous dev run keeps
 *  `tauri dev` from binding and the start would silently never finish. */
function freeVitePort() {
  try {
    const pids = execSync(`lsof -ti tcp:${VITE_PORT}`, { encoding: "utf8" }).trim();
    if (!pids) return;
    for (const pid of pids.split("\n").filter(Boolean)) {
      spawnSync("kill", ["-9", pid]);
      console.error(`killed orphan listener on :${VITE_PORT} (pid ${pid})`);
    }
  } catch {
    // Nothing on the port — fine.
  }
}

function startDevApp() {
  freeVitePort();
  const log = spawnSync("bash", ["-c", `: > ${JSON.stringify(DEV_LOG)}`]);
  if (log.error) throw log.error;
  const child = spawn("pnpm", ["dev"], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  console.error(`started pnpm dev (pid ${child.pid}); log: ${DEV_LOG}`);
}

async function waitForApp(timeoutS) {
  const deadline = Date.now() + timeoutS * 1_000;
  while (Date.now() < deadline) {
    const runtime = readRuntime();
    if (runtime && (await probeLoopback(runtime.port, runtime.token))) return runtime;
    await delay(2_000);
  }
  throw new Error(
    `dev app did not come up within ${timeoutS}s — see ${DEV_LOG}`,
  );
}

async function waitForTunnel(timeoutS) {
  const deadline = Date.now() + timeoutS * 1_000;
  let last = null;
  while (Date.now() < deadline) {
    const status = await invoke("companion_status");
    last = status.tunnel;
    if (status.tunnel.state === "running" && status.tunnel.url) return status;
    if (status.tunnel.state === "failed") {
      throw new Error(`tunnel failed: ${status.tunnel.error ?? "unknown error"}`);
    }
    await delay(1_500);
  }
  throw new Error(
    `tunnel did not report a URL within ${timeoutS}s (state: ${last?.state ?? "?"})`,
  );
}

const out = (payload) => {
  console.log(JSON.stringify(payload, null, 2));
};

try {
  let runtime = readRuntime();
  let appRunning = runtime ? await probeLoopback(runtime.port, runtime.token) : false;
  let appStarted = false;

  if (!appRunning) {
    if (NO_START) {
      throw new Error("dev app is not running (and --no-start was given)");
    }
    if (!existsSync(join(REPO_ROOT, "node_modules"))) {
      throw new Error("node_modules missing — run pnpm install first");
    }
    startDevApp();
    appStarted = true;
  }

  if (appStarted) {
    await waitForApp(START_TIMEOUT_S);
  } else {
    runtime = readRuntime();
  }
  if (!runtime) throw new Error("runtime.json vanished unexpectedly");

  const status = await invoke("companion_status");
  if (!status.enabled) throw new Error("companion is disabled in settings");
  if (!status.running) throw new Error("companion server is not running");

  let tunnel = status.tunnel;
  if (!USE_LAN && tunnel.state !== "running") {
    await invoke("companion_tunnel_start");
    tunnel = (await waitForTunnel(TUNNEL_TIMEOUT_S)).tunnel;
  }

  const pairing = await invoke("companion_pairing_code", {
    mode: USE_LAN ? "lan" : "tunnel",
  });

  out({
    ok: true,
    url: pairing.url,
    code: pairing.code,
    tunnel: tunnel.url ?? undefined,
    appStarted,
    requirePairingCode: status.require_pairing_code,
  });
} catch (error) {
  out({ ok: false, error: error.message ?? String(error) });
  process.exit(1);
}
