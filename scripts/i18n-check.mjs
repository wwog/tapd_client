#!/usr/bin/env node
/**
 * i18n coverage checker (see docs/I18N.md).
 *
 * Messages are addressed by semantic keys. This verifies, across desktop,
 * companion and Rust:
 *   - every `t("key")` / `tr("key")` resolves to a catalogue entry,
 *   - no Chinese literal is rendered outside the catalogue,
 *   - keys are unique, short, dot-namespaced and ASCII,
 *   - both languages are present and their placeholders match.
 *
 * Chinese literals kept in module-level constants are accepted when the exact
 * string is a catalogue value: those constants store a key at render time.
 * Mark any other intentional Chinese with `// i18n-exempt: <reason>`.
 *
 * Usage: node scripts/i18n-check.mjs [--verbose]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const ts = require("typescript");

const CJK = /[\u3400-\u9fff]/;
const KEY = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const MAX_KEY = 48;
const verbose = process.argv.includes("--verbose");

const FRONTENDS = [
  {
    name: "desktop",
    dir: path.join(root, "apps/desktop/src"),
    catalog: path.join(root, "apps/desktop/src/lib/i18n/catalog"),
  },
  {
    name: "companion",
    dir: path.join(root, "apps/companion/src"),
    catalog: path.join(root, "apps/companion/src/lib/i18n/catalog"),
  },
];

const RUST_ROOTS = [
  path.join(root, "apps/desktop/src-tauri/src"),
  path.join(root, "crates/tapd-core/src"),
  path.join(root, "crates/tapd-mcp/src"),
  path.join(root, "crates/tapd-workflow/src"),
];
const RUST_CATALOG = path.join(root, "crates/tapd-i18n/src/catalog");

function walk(dir, filter) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...walk(full, filter));
    } else if (filter(full)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file) => path.relative(root, file);

// ---------------------------------------------------------------- frontends

const isTranslateCall = (node) => {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return ts.isIdentifier(callee) && (callee.text === "t" || callee.text === "tr");
};

const stringValue = (node) => {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
};

const placeholders = (text) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

/** Reads one catalogue directory: key -> { zh, en }, plus the values. */
function readCatalogue(dir) {
  const entries = new Map();
  const duplicates = [];
  const problems = [];
  const values = new Set();

  for (const file of walk(dir, (f) => f.endsWith(".ts") && !f.endsWith("index.ts"))) {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (ts.isPropertyAssignment(node)) {
        const name =
          stringValue(node.name) ?? (ts.isIdentifier(node.name) ? node.name.text : null);
        if (name !== null) {
          if (entries.has(name)) duplicates.push(`${name} (${rel(file)})`);
          const array = ts.isArrayLiteralExpression(node.initializer)
            ? node.initializer
            : null;
          if (!array || array.elements.length !== 2) {
            problems.push(`${rel(file)} ${name}: expected [zh, en]`);
          } else {
            const zhNode = array.elements[0];
            const enNode = array.elements[1];
            const zh = stringValue(zhNode);
            const en = stringValue(enNode);
            const zhFn = ts.isArrowFunction(zhNode) || ts.isFunctionExpression(zhNode);
            const enFn = ts.isArrowFunction(enNode) || ts.isFunctionExpression(enNode);
            if (zh === null && !zhFn) {
              problems.push(`${rel(file)} ${name}: Chinese must be a string`);
            }
            if (en === null && !enFn) {
              problems.push(`${rel(file)} ${name}: English must be a string`);
            }
            if (zh !== null) values.add(zh);
            if (en !== null) {
              values.add(en);
              if (CJK.test(en)) problems.push(`${rel(file)} ${name}: English contains CJK`);
              if (zh !== null) {
                const a = placeholders(zh).join(",");
                const b = placeholders(en).join(",");
                if (a !== b) {
                  problems.push(
                    `${rel(file)} ${name}: placeholders ${JSON.stringify(a)} != ${JSON.stringify(b)}`,
                  );
                }
              }
            }
            entries.set(name, { zh, en, file });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { entries, duplicates, problems, values };
}

function checkFrontend(front) {
  const catalogue = readCatalogue(front.catalog);
  const files = walk(
    front.dir,
    (file) =>
      /\.(ts|tsx)$/.test(file) &&
      !file.includes("/lib/i18n/") &&
      !file.endsWith(".d.ts"),
  );
  const untranslated = [];
  const used = new Set();
  const problems = [...catalogue.problems];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const exempt = new Set();
    text.split("\n").forEach((line, index) => {
      if (line.includes("i18n-exempt")) exempt.add(index);
    });
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const lineOf = (node) =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    const visit = (node) => {
      if (ts.isCallExpression(node) && isTranslateCall(node)) {
        const key = stringValue(node.arguments[0]);
        if (key !== null) used.add(key);
        node.arguments.forEach((arg) => {
          if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) {
            ts.forEachChild(arg, visit);
          }
        });
        return;
      }

      if (ts.isJsxText(node)) {
        if (CJK.test(node.text) && !exempt.has(lineOf(node) - 1)) {
          untranslated.push(`${rel(file)}:${lineOf(node)}  JSX text  ${node.text.trim()}`);
        }
        return;
      }

      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (CJK.test(node.text) && !exempt.has(lineOf(node) - 1)) {
          // A constant holding the Chinese half of an entry is fine: the call
          // site passes the key, not this text.
          const isConstantValue =
            catalogue.values.has(node.text) &&
            (ts.isPropertyAssignment(node.parent) ||
              ts.isArrayLiteralExpression(node.parent));
          if (!isConstantValue) {
            untranslated.push(
              `${rel(file)}:${lineOf(node)}  ${
                ts.isStringLiteral(node) ? "string" : "template"
              }  ${node.text.trim().slice(0, 80)}`,
            );
          }
        }
        return;
      }

      if (ts.isTemplateExpression(node)) {
        const pieces = [node.head, ...node.templateSpans.map((span) => span.literal)];
        if (pieces.some((piece) => CJK.test(piece.text)) && !exempt.has(lineOf(node) - 1)) {
          untranslated.push(`${rel(file)}:${lineOf(node)}  template literal`);
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const missing = [...used].filter((key) => !catalogue.entries.has(key)).sort();
  const unused = [...catalogue.entries.keys()].filter((key) => !used.has(key)).sort();
  const malformed = [...catalogue.entries.keys()].filter(
    (key) => !KEY.test(key) || key.length > MAX_KEY,
  );

  return {
    name: front.name,
    entries: catalogue.entries.size,
    used: used.size,
    untranslated,
    missing,
    duplicates: catalogue.duplicates,
    unused,
    problems: problems.concat(malformed.map((key) => `malformed key ${key}`)),
  };
}

// --------------------------------------------------------------------- rust

function checkRust() {
  const files = RUST_ROOTS.flatMap((dir) => walk(dir, (file) => file.endsWith(".rs")));
  const untranslated = [];
  const used = new Set();

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    let testDepth = 0;
    let depth = 0;

    lines.forEach((line, index) => {
      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;

      if (testDepth > 0) {
        depth += opens - closes;
        if (depth <= testDepth - 1) testDepth = 0;
        if (testDepth === 0) depth = 0;
        return;
      }
      if (/^\s*#\[cfg\(test\)\]/.test(line)) {
        testDepth = depth + 1;
        depth += opens - closes;
        return;
      }
      depth += opens - closes;
      if (depth < 0) depth = 0;

      const code = line.replace(/\/\/.*$/, "");
      if (/i18n-exempt/.test(line)) return;

      // tr("key") / tr_args("key", …): collect the key so unused keys are real.
      for (const match of code.matchAll(/\btr(?:_args)?\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        used.add(match[1]);
      }

      if (!CJK.test(code)) return;

      const literals = [...code.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
      const chinese = literals.filter((value) => CJK.test(value));
      if (chinese.length === 0) return;

      const wrapped = chinese.every((value) => {
        const index = code.indexOf(`"${value}"`);
        return /\btr(?:_args)?\(\s*$/.test(code.slice(0, index));
      });
      if (wrapped) {
        chinese.forEach((value) => used.add(value));
        return;
      }
      untranslated.push(`${rel(file)}:${index + 1}  ${chinese[0]}`);
    });
  }

  const entries = new Map();
  const duplicates = [];
  const problems = [];
  for (const file of walk(
    RUST_CATALOG,
    (f) => f.endsWith(".rs") && !f.endsWith("mod.rs"),
  )) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)/g,
    )) {
      const [, key, zh, en] = match;
      if (entries.has(key)) duplicates.push(`${key} (${rel(file)})`);
      entries.set(key, { zh, en });
      if (!KEY.test(key) || key.length > MAX_KEY) problems.push(`malformed key ${key}`);
      if (!zh.trim()) problems.push(`${key}: empty Chinese`);
      if (!en.trim()) problems.push(`${key}: empty English`);
      if (CJK.test(en)) problems.push(`${key}: English contains CJK`);
    }
  }

  const missing = [...used].filter((key) => !entries.has(key)).sort();
  const unused = [...entries.keys()].filter((key) => !used.has(key)).sort();

  return {
    name: "rust",
    entries: entries.size,
    used: used.size,
    untranslated,
    missing,
    duplicates,
    unused,
    problems,
  };
}

// -------------------------------------------------------------------- main

const reports = [...FRONTENDS.map(checkFrontend), checkRust()];
let failed = false;

for (const report of reports) {
  const problems =
    report.untranslated.length +
    report.missing.length +
    report.problems.length +
    report.duplicates.length;
  if (problems > 0) failed = true;
  console.log(
    `\n${report.name}: ${report.entries} keys, ${report.used} in use, ` +
      `${report.untranslated.length} untranslated, ${report.missing.length} missing, ` +
      `${report.duplicates.length} duplicate, ${report.problems.length} invalid, ` +
      `${report.unused.length} unused`,
  );
  const show = (title, items, limit = verbose ? Infinity : 25) => {
    if (items.length === 0) return;
    console.log(`  ${title} (${items.length}):`);
    items.slice(0, limit).forEach((item) => console.log(`    ${item}`));
    if (items.length > limit) console.log(`    … ${items.length - limit} more`);
  };
  show("untranslated Chinese", report.untranslated);
  show("missing catalogue key", report.missing);
  show("duplicate key", report.duplicates);
  show("invalid entry", report.problems);
  if (verbose) show("unused key", report.unused);
}

process.exit(failed ? 1 : 0);
