/**
 * Read-only code renderer: line numbers (hidden while wrapping) plus Prism
 * tokens from refractor. Unknown languages and very large bodies render as
 * plain monospace text.
 */
import clsx from "clsx";
import { createElement, useMemo, type ReactNode } from "react";

import { highlightCode, type HastNode } from "./language";
import "./code.css";

type Props = {
  text: string;
  path: string;
  wrap: boolean;
};

function renderNode(node: HastNode, key: number): ReactNode {
  if (node.type === "text") return node.value ?? "";
  if (node.type !== "element" || !node.tagName) return null;
  const className = node.properties?.className;
  const props: Record<string, unknown> = { key };
  if (className) {
    props.className = Array.isArray(className)
      ? className.join(" ")
      : String(className);
  }
  return createElement(
    node.tagName,
    props,
    (node.children ?? []).map((child, index) => renderNode(child, index)),
  );
}

export function CodeView({ text, path, wrap }: Props) {
  const tree = useMemo(() => highlightCode(text, path), [text, path]);
  const lineCount = useMemo(() => text.split("\n").length, [text]);

  return (
    <div
      className="flex min-h-0 flex-1 overflow-auto bg-surface"
      data-workbench-file="code"
    >
      {wrap ? null : (
        <div
          aria-hidden
          className="shrink-0 select-none border-r border-border bg-canvas/60 px-2 py-2 text-right font-mono text-ui-sm leading-5 text-slate-400"
        >
          {Array.from({ length: lineCount }, (_, index) => (
            <div key={index}>{index + 1}</div>
          ))}
        </div>
      )}
      <pre
        className={clsx(
          "explorer-code m-0 min-w-0 flex-1 px-3 py-2 font-mono text-ui-sm leading-5 text-slate-700",
          wrap ? "whitespace-pre-wrap break-words" : "w-max min-w-full whitespace-pre",
        )}
      >
        <code>
          {tree
            ? (tree.children ?? []).map((child, index) => renderNode(child, index))
            : text}
        </code>
      </pre>
    </div>
  );
}
