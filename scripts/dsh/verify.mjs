#!/usr/bin/env node
/**
 * Contract smoke test for the built-in agent payload.
 *
 * Unpacks the payload into a temporary directory, composes the same profile the
 * app boots (dsh-base + dsh-sdk-app + our plugins + a probe provider), then
 * drives the SDK JSON-RPC handshake with the system Node:
 *
 *   initialize      → { serverInfo }
 *   session/query   → { kind: "prompt", messageId }
 *   shutdown        → process exits
 *
 * Run after every payload build and after every dsh version bump:
 *   node scripts/dsh/prepare.mjs --verify
 *   node scripts/dsh/verify.mjs [path/to/payload.tar.zst]
 */

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Provider id used only by the smoke test; it never reaches a real endpoint. */
const PROBE_PROVIDER = "tapd-probe-gateway";

function log(message) {
  process.stdout.write(`[dsh-verify] ${message}\n`);
}

function unpack(archivePath, targetDir) {
  const tarPath = join(targetDir, "payload.tar");
  return pipeline(
    createReadStream(archivePath),
    zlib.createZstdDecompress(),
    createWriteStream(tarPath),
  ).then(() => {
    const result = spawnSync("tar", ["-xf", tarPath, "-C", targetDir], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: "inherit",
    });
    if (result.status !== 0) throw new Error(`tar exited with ${result.status}`);
    rmSync(tarPath, { force: true });
    return targetDir;
  });
}

function pluginNames(modulesDir) {
  const scope = join(modulesDir, "@tapd");
  if (!existsSync(scope)) return [];
  return readdirSync(scope)
    .filter((name) => existsSync(join(scope, name, "package.json")))
    .map((name) => ({ name: `@tapd/${name}`, entry: join(scope, name, "index.js") }));
}

function writeProfile(homeDir, modulesDir, plugins) {
  const profileDir = join(homeDir, "profiles/tapd");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, "package.json"),
    JSON.stringify(
      {
        name: "dsh-profile-tapd",
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"] } },
      },
      null,
      2,
    ) + "\n",
  );
  const rows = plugins
    .map((plugin) => `    - id: ${plugin.name.replace("@tapd/", "")}\n      name: ${plugin.entry}`)
    .join("\n");
  writeFileSync(
    join(profileDir, "cordis.patch.yml"),
    [
      "- insert:",
      rows,
      "",
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
      `      ${PROBE_PROVIDER}:`,
      "        displayName: Probe Gateway",
      "        api: openai-completions",
      "        baseURL: http://127.0.0.1:9/v1",
      "        models:",
      "          - id: probe-model",
      "            name: Probe Model",
      "            contextWindow: 8192",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(profileDir, "pnpm-workspace.yaml"),
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
  );
  return profileDir;
}

function drive(entry, homeDir, timeoutMs) {
  return new Promise((resolveDrive, rejectDrive) => {
    const child = spawn(process.execPath, [entry, "--profile", "tapd"], {
      env: { ...process.env, DSH_HOME: homeDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map();
    let nextId = 1;
    const call = (method, params) =>
      new Promise((resolveCall, rejectCall) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveCall, reject: rejectCall });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectDrive(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 && pending.size > 0) {
        rejectDrive(new Error(`runtime exited with ${code}\n${stderr}`));
      }
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(`non-protocol stdout: ${line.slice(0, 120)}`);
      }
      // Server → client requests: fail closed, the smoke test never approves.
      if (message.id && message.method) {
        const result =
          message.method === "approval/request"
            ? { outcome: "rejected" }
            : { cancelled: true };
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
        return;
      }
      if (!message.id) return;
      const slot = pending.get(message.id);
      if (!slot) return;
      pending.delete(message.id);
      if (message.error) slot.reject(new Error(JSON.stringify(message.error)));
      else slot.resolve(message.result);
    });

    (async () => {
      try {
        const init = await call("initialize", {
          cwd: homeDir,
          provider: PROBE_PROVIDER,
          model: "probe-model",
          approvalRequests: true,
          capabilities: { userQuestions: true },
        });
        if (init?.serverInfo?.name !== "deepseek-harness-sdk-runtime") {
          throw new Error(`unexpected serverInfo: ${JSON.stringify(init)}`);
        }
        const sessionId = `tapd-smoke-${Date.now().toString(36)}`;
        const receipt = await call("session/query", {
          sessionId,
          contentBlocks: [{ type: "text", text: "smoke test" }],
        });
        if (receipt?.kind !== "prompt" || !receipt.messageId) {
          throw new Error(`unexpected session/query receipt: ${JSON.stringify(receipt)}`);
        }
        // The launcher logs a failed plugin import and keeps booting, so a
        // green handshake alone does not prove the composition is healthy.
        const broken = stderr
          .split("\n")
          .filter((line) => /failed to import:|JsonSchemaError|failed to load/i.test(line));
        if (broken.length > 0) {
          throw new Error(`runtime reported broken plugins:\n${broken.slice(0, 8).join("\n")}`);
        }
        await call("shutdown", undefined).catch(() => undefined);
        child.stdin.end();
        // Wait for the runtime to flush SQLite and close its log handles before
        // the caller removes the extraction directory.
        const exited = new Promise((resolveExit) => {
          if (child.exitCode !== null) return resolveExit();
          child.once("exit", () => resolveExit());
          setTimeout(() => {
            child.kill("SIGKILL");
            resolveExit();
          }, 5000);
        });
        await exited;
        clearTimeout(timer);
        resolveDrive({ init, receipt });
      } catch (error) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        rejectDrive(error);
      }
    })();
  });
}

export async function verifyPayload({ archivePath, version }) {
  const workDir = mkdtempSync(join(tmpdir(), "dsh-verify-"));
  const homeDir = join(workDir, "home");
  mkdirSync(homeDir, { recursive: true });
  try {
    log(`unpacking ${archivePath}`);
    await unpack(archivePath, workDir);
    const modulesDir = join(workDir, "node_modules");
    const entry = join(modulesDir, "@deepseek-ai/dsh/lib/bin.js");
    if (!existsSync(entry)) throw new Error(`payload has no launcher at ${entry}`);
    const plugins = pluginNames(modulesDir);
    writeProfile(homeDir, modulesDir, plugins);
    log(`booting payload ${version ?? ""} with ${plugins.length} plugin(s)`);
    const started = Date.now();
    const { init } = await drive(entry, homeDir, 120_000);
    log(`ok: ${init.serverInfo.name} in ${Date.now() - started} ms`);
    return true;
  } finally {
    // A just-exited runtime can still hold a SQLite file for a few milliseconds.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(workDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 9) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = join(root, "apps/desktop/src-tauri/resources/dsh");
  const manifestPath = join(outDir, "manifest.json");
  const arg = process.argv[2];
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : null;
  const archivePath = arg
    ? resolve(arg)
    : manifest
      ? join(outDir, manifest.file)
      : null;
  if (!archivePath || !existsSync(archivePath)) {
    process.stderr.write("[dsh-verify] no payload found; run scripts/dsh/prepare.mjs first\n");
    process.exit(1);
  }
  verifyPayload({ archivePath, version: manifest?.version })
    .then(() => process.exit(0))
    .catch((error) => {
      process.stderr.write(`[dsh-verify] failed: ${error.stack ?? error}\n`);
      process.exit(1);
    });
}
