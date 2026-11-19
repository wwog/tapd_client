#!/usr/bin/env node
// Adds data-component="<Name>" to the root element of every React component
// (function / arrow / memo / forwardRef) across apps/*/src.
//
// Usage:
//   node scripts/codemod-data-component.mjs [--write]
//   node scripts/codemod-data-component.mjs --revert --write
// Without --write it only reports what would change.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.resolve("apps/desktop/package.json"));
const ts = require("typescript");

const ROOT = path.resolve("apps");
const WRITE = process.argv.includes("--write");
const REVERT = process.argv.includes("--revert");

const isCapitalized = (name) => /^[A-Z]/.test(name);

function collectFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-companion") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
}

/** Unwrap `memo(...)` / `forwardRef(...)` / `React.memo(...)` initializers to the component fn. */
function unwrapComponentFn(node) {
  if (!node) return null;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : "";
    if (name === "memo" || name === "forwardRef" || name === "observer") {
      return unwrapComponentFn(node.arguments[0]);
    }
  }
  return null;
}

/** `export const Public = memo(Impl)` → Impl becomes "Public" in the DOM. */
function publicNames(sf) {
  const map = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isCapitalized(node.name.text) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const callee = node.initializer.expression;
      const wrapper = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      const inner = node.initializer.arguments[0];
      if ((wrapper === "memo" || wrapper === "forwardRef") && inner && ts.isIdentifier(inner)) {
        map.set(inner.text, node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return map;
}

/** Every function in the file that looks like a React component (capitalized name). */
function findComponents(sf) {
  const found = [];
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && isCapitalized(node.name.text) && node.body) {
      found.push({ name: node.name.text, fn: node });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isCapitalized(node.name.text)
    ) {
      const fn = unwrapComponentFn(node.initializer);
      if (fn) found.push({ name: node.name.text, fn });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/** Top-level return expressions of a component body (nested callbacks excluded). */
function collectReturns(fn) {
  const out = [];
  if (!fn.body) return out;
  if (!ts.isBlock(fn.body)) {
    out.push(fn.body);
    return out;
  }
  const visit = (node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) out.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

function unwrapExpr(e) {
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression(e)
    ) {
      e = e.expression;
      continue;
    }
    return e;
  }
}

function isCreatePortalCall(e) {
  if (!ts.isCallExpression(e)) return false;
  const callee = e.expression;
  if (ts.isIdentifier(callee)) return callee.text === "createPortal";
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "createPortal";
  return false;
}

/** Push the JSX roots of a returned expression; `other` entries are unsupported shapes. */
function jsxRoots(expr, out) {
  const e = unwrapExpr(expr);
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) out.push({ kind: "element", node: e });
  else if (ts.isJsxFragment(e)) out.push({ kind: "fragment", node: e });
  else if (ts.isConditionalExpression(e)) {
    jsxRoots(e.whenTrue, out);
    jsxRoots(e.whenFalse, out);
  } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    jsxRoots(e.right, out);
  } else if (isCreatePortalCall(e) && e.arguments.length > 0) {
    jsxRoots(e.arguments[0], out);
  } else {
    out.push({ kind: "other", node: e });
  }
}

function lineStartOf(text, pos) {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

const skipped = [];
const stats = { files: 0, changed: 0 };

const files = [];
collectFiles(ROOT, files);

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes("<")) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = path.relative(process.cwd(), file);
  const names = publicNames(sf);
  const edits = [];

  for (const component of findComponents(sf)) {
    const componentName = names.get(component.name) ?? component.name;
    for (const expr of collectReturns(component.fn)) {
      const roots = [];
      jsxRoots(expr, roots);
      for (const root of roots) {
        const line = sf.getLineAndCharacterOfPosition(root.node.getStart(sf)).line + 1;
        if (root.kind === "fragment") {
          if (!REVERT) skipped.push(`${rel}:${line} ${componentName} — fragment root`);
          continue;
        }
        if (root.kind === "other") {
          if (!REVERT) {
            const snippet = root.node.getText(sf).slice(0, 40).replace(/\s+/g, " ");
            if (snippet !== "null") skipped.push(`${rel}:${line} ${componentName} — ${snippet}`);
          }
          continue;
        }
        const opening = ts.isJsxElement(root.node) ? root.node.openingElement : root.node;
        const tag = opening.tagName;
        if (!ts.isIdentifier(tag) || !/^[a-z]/.test(tag.text)) {
          if (!REVERT) skipped.push(`${rel}:${line} ${componentName} — <${tag.getText(sf)}> root`);
          continue;
        }
        const props = opening.attributes.properties;
        const first = props[0];

        if (REVERT) {
          // Only undo our own insertion: attribute glued to the tag name.
          if (
            first &&
            ts.isJsxAttribute(first) &&
            first.name.getText(sf) === "data-component" &&
            first.getStart(sf) === tag.end + 1
          ) {
            edits.push({ start: tag.end, end: first.end, text: "" });
          }
          continue;
        }

        if (props.some((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "data-component")) continue;

        const attr = `data-component="${componentName}"`;
        const multiline = first && sf.getLineAndCharacterOfPosition(first.getStart(sf)).line !== line - 1;
        const insertion = multiline
          ? `\n${text.slice(lineStartOf(text, first.getStart(sf)), first.getStart(sf))}${attr}`
          : ` ${attr}`;
        edits.push({ start: tag.end, end: tag.end, text: insertion });
      }
    }
  }

  if (edits.length === 0) continue;
  stats.files += 1;
  stats.changed += edits.length;
  edits.sort((a, b) => b.start - a.start);
  let next = text;
  for (const e of edits) next = next.slice(0, e.start) + e.text + next.slice(e.end);
  if (WRITE) fs.writeFileSync(file, next);
}

const verb = REVERT ? "reverted" : WRITE ? "applied" : "dry-run";
console.log(`${verb}: ${stats.changed} attributes in ${stats.files} files (scanned ${files.length} tsx files)`);
if (skipped.length) {
  console.log(`\nSkipped roots (${skipped.length}):`);
  console.log(skipped.join("\n"));
}
