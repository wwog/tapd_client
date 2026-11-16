#!/usr/bin/env node
/**
 * Built-in agent payload builder.
 *
 * Produces the compressed DeepSeek Harness runtime that ships inside the app:
 *
 *   vendor/dsh/package.json         pinned `@deepseek-ai/dsh` version
 *   vendor/dsh/node_modules/        installed tree (gitignored, build artifact)
 *   dsh/plugins/<name>/             our Cordis plugins (source of truth, committed)
 *   apps/desktop/src-tauri/resources/dsh/
 *     payload-<version>-<platform>-<arch>.tar.zst
 *     manifest.json
 *
 * The app extracts the tarball into its data directory on first launch, so the
 * installer carries ~30 MB instead of a ~350 MB tree. Nothing here runs at
 * user runtime: no npm, no pnpm, no network.
 *
 * Usage:
 *   node scripts/dsh/prepare.mjs             # install (if needed), prune, pack
 *   node scripts/dsh/prepare.mjs --repack    # reuse the pruned tree, pack again
 *   node scripts/dsh/prepare.mjs --verify    # also boot the payload once
 *   node scripts/dsh/prepare.mjs --check     # fail fast when the payload is missing/stale
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";
import zlib from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const vendorDir = join(root, "vendor/dsh");
const modulesDir = join(vendorDir, "node_modules");
const pluginsDir = join(root, "dsh/plugins");
const outDir = join(root, "apps/desktop/src-tauri/resources/dsh");
const markerFile = join(vendorDir, ".prepared.json");

const repack = process.argv.includes("--repack");
const verify = process.argv.includes("--verify");
const checkOnly = process.argv.includes("--check");

const pinned = JSON.parse(readFileSync(join(vendorDir, "package.json"), "utf8"));
const version = pinned.dependencies["@deepseek-ai/dsh"];
const platform = process.platform;
const arch = process.arch;

/**
 * Packages the profile never mounts: web UI, Office/LibreOffice, voice, CUA,
 * experimental bundles and the extra app shells. Boot is verified afterwards,
 * so a wrong entry fails loudly instead of shipping a broken payload.
 */
const DROP_PREFIXES = [
  "@deepseek-ai/libreoffice-kit",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-web-frontend",
  "@deepseek-ai/dsh-client-ui-",
  "@deepseek-ai/dsh-experimental-",
  "@deepseek-ai/dsh-cua",
  "@deepseek-ai/dsh-acp",
  "@deepseek-ai/dsh-acp-app",
  "@deepseek-ai/dsh-sdk-minimal",
  "@deepseek-ai/dsh-headless",
  "@deepseek-ai/dsh-deepseek-chat-import",
  "sherpa-onnx",
];

/** Source/typing/debug leftovers: never imported at runtime. */
const STRIP_FILE_SUFFIXES = [".ts", ".mts", ".cts", ".map", ".pdb", ".md"];
const STRIP_DIRS = new Set(["docs", "src"]);

/** Prebuilds for other platforms cost disk and can never load here. */
const FOREIGN_PREBUILD = {
  darwin: /^(win32|linux)/,
  win32: /^(darwin|linux)/,
  linux: /^(win32|darwin)/,
};

function log(message) {
  process.stdout.write(`[dsh] ${message}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: options.cwd ?? vendorDir,
    env: { ...process.env, COPYFILE_DISABLE: "1", ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function installedVersion() {
  const file = join(modulesDir, "@deepseek-ai/dsh/package.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")).version;
}

function install() {
  log(`installing @deepseek-ai/dsh@${version} (npm ci)`);
  run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"]);
  // vendor/dsh/package.json carries a reviewed, pinned `allowScripts` list.
  // Re-run them explicitly: `npm ci` on some npm versions only records the
  // approval, and stripping `src/` before they run breaks native builds.
  const scripts = JSON.parse(readFileSync(join(vendorDir, "package.json"), "utf8")).allowScripts ?? {};
  const targets = Object.keys(scripts).map((spec) => spec.split("@").slice(0, -1).join("@") || spec);
  if (targets.length > 0) {
    log(`running approved install scripts: ${targets.join(", ")}`);
    run("npm", ["rebuild", ...targets, "--foreground-scripts"]);
  }
}

/** Copies `dsh/plugins/*` into the payload so imports resolve against its node_modules. */
function installPlugins() {
  if (!existsSync(pluginsDir)) return [];
  const installed = [];
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = join(pluginsDir, entry.name);
    const manifest = join(source, "package.json");
    if (!existsSync(manifest)) continue;
    const name = JSON.parse(readFileSync(manifest, "utf8")).name;
    const target = join(modulesDir, ...name.split("/"));
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
    installed.push({ name, dir: entry.name });
  }
  if (installed.length > 0) {
    log(`bundled plugins: ${installed.map((item) => item.name).join(", ")}`);
  }
  return installed;
}

function dropPackages() {
  const scope = join(modulesDir, "@deepseek-ai");
  if (existsSync(scope)) {
    for (const name of readdirSync(scope)) {
      const full = `@deepseek-ai/${name}`;
      if (!DROP_PREFIXES.some((prefix) => full.startsWith(prefix))) continue;
      rmSync(join(scope, name), { recursive: true, force: true });
    }
  }
  for (const name of readdirSync(modulesDir)) {
    if (name === "@deepseek-ai") continue;
    if (DROP_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      rmSync(join(modulesDir, name), { recursive: true, force: true });
    }
  }
}

function strip(dir, counters) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (STRIP_DIRS.has(entry.name)) {
        rmSync(full, { recursive: true, force: true });
        counters.dirs += 1;
        continue;
      }
      strip(full, counters);
      continue;
    }
    if (STRIP_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      rmSync(full, { force: true });
      counters.files += 1;
    }
  }
}

function dropForeignPrebuilds() {
  const foreign = FOREIGN_PREBUILD[platform];
  if (!foreign) return;
  const prebuilds = join(modulesDir, "node-pty/prebuilds");
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) {
      if (foreign.test(entry)) rmSync(join(prebuilds, entry), { recursive: true, force: true });
    }
  }
  const addonScope = join(modulesDir, "node-addon-require-builtin");
  if (existsSync(addonScope)) {
    for (const entry of readdirSync(addonScope)) {
      if (foreign.test(entry)) rmSync(join(addonScope, entry), { recursive: true, force: true });
    }
  }
}

function treeSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        bytes += statSync(full).size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function pack() {
  const tarPath = join(vendorDir, "payload.tar");
  rmSync(tarPath, { force: true });
  run("tar", ["-cf", tarPath, "-C", vendorDir, "node_modules"]);
  const name = `payload-${version}-${platform}-${arch}.tar.zst`;
  const target = join(outDir, name);
  mkdirSync(outDir, { recursive: true });
  log("compressing (zstd level 19)");
  await pipeline(
    createReadStream(tarPath),
    zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }),
    createWriteStream(target),
  );
  rmSync(tarPath, { force: true });
  return { name, path: target };
}

/** Dev-mode guard: the payload must exist and match the pinned version. */
function checkPayload() {
  const manifestPath = join(outDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("no payload built yet; run `pnpm prepare:dsh`");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== version) {
    throw new Error(`payload ${manifest.version} does not match pinned ${version}; run \`pnpm prepare:dsh\``);
  }
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error(
      `payload was built for ${manifest.platform}-${manifest.arch}, this host is ${platform}-${arch}; run \`pnpm prepare:dsh\``,
    );
  }
  if (!existsSync(join(outDir, manifest.file))) {
    throw new Error(`payload archive ${manifest.file} is missing; run \`pnpm prepare:dsh\``);
  }
  log(`payload ok: ${manifest.version} ${manifest.packedLabel ?? ""}`.trim());
}

async function main() {
  if (checkOnly) {
    checkPayload();
    return;
  }
  for (const required of ["package-lock.json"]) {
    if (!existsSync(join(vendorDir, required))) {
      throw new Error(`vendor/dsh/${required} is missing; run npm install --package-lock-only`);
    }
  }

  const installed = installedVersion();
  const alreadyPrepared =
    installed === version && existsSync(markerFile) &&
    JSON.parse(readFileSync(markerFile, "utf8")).version === version;

  if (repack && !existsSync(modulesDir)) {
    throw new Error("--repack needs vendor/dsh/node_modules; run without it first");
  }

  if (!alreadyPrepared || !repack) {
    if (installed !== version) install();
    const plugins = installPlugins();
    dropPackages();
    dropForeignPrebuilds();
    const counters = { files: 0, dirs: 0 };
    log("stripping sources, typings and debug maps");
    strip(modulesDir, counters);
    log(`removed ${counters.files} files and ${counters.dirs} directories`);
    writeFileSync(
      markerFile,
      JSON.stringify({ version, platform, arch, plugins, preparedAt: new Date().toISOString() }, null, 2) + "\n",
    );
  } else {
    log(`reusing prepared tree for ${version}`);
  }

  const size = treeSize(modulesDir);
  log(`tree: ${(size.bytes / 1e6).toFixed(1)} MB, ${size.files} files`);

  const archive = await pack();
  const bytes = statSync(archive.path).size;
  const manifest = {
    version,
    platform,
    arch,
    file: archive.name,
    bytes,
    sha256: sha256(archive.path),
    files: size.files,
    unpackedBytes: size.bytes,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  log(`payload: ${archive.name} — ${(bytes / 1e6).toFixed(1)} MB`);

  if (verify) {
    const { verifyPayload } = await import("./verify.mjs");
    await verifyPayload({ archivePath: archive.path, version, platform, arch });
  }
  log("done");
}

main().catch((error) => {
  process.stderr.write(`[dsh] failed: ${error.stack ?? error}\n`);
  process.exit(1);
});
