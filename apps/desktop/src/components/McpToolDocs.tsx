import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { BookOpen, Copy } from "lucide-react";

import type { McpToolInfo } from "../lib/api";
import { Dialog } from "./Dialog";

const COPY_BUTTON =
  "inline-flex shrink-0 items-center gap-1 rounded border border-border bg-surface px-2 py-1 text-ui-xs text-slate-600 transition hover:border-slate-300";

/** The subset of JSON Schema used by the MCP manifest. */
type JsonSchema = {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
};

const MAX_DEPTH = 3;

/**
 * In-app API docs for the MCP tools: a name list on the left, the selected
 * tool's description and parameter list on the right. Opening it from a tool
 * chip focuses that tool.
 */
export function McpToolDocs(props: {
  tools: McpToolInfo[];
  initialTool: string;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(props.initialTool);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);

  const tool = props.tools.find((item) => item.name === selected) ?? props.tools[0];
  const schema = useMemo(() => parseSchema(tool?.schema), [tool]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0 });
  }, [selected]);

  return (
    <Dialog
      title="MCP 接口文档"
      icon={<BookOpen size={16} className="text-slate-400" />}
      size="wide"
      bodyScroll={false}
      onClose={props.onClose}
    >
      <div className="flex h-full gap-4">
        <nav
          className="w-60 shrink-0 overflow-y-auto border-r border-slate-100 pr-2"
          aria-label="接口列表"
        >
          <ul className="space-y-0.5">
            {props.tools.map((item) => {
              const active = item.name === tool?.name;
              return (
                <li key={item.name}>
                  <button
                    type="button"
                    ref={active ? selectedRef : undefined}
                    onClick={() => setSelected(item.name)}
                    title={item.description}
                    className={clsx(
                      "w-full rounded-lg px-2 py-1.5 text-left font-mono text-ui-xs transition",
                      active
                        ? "bg-sky-50 text-sky-700"
                        : "text-slate-500 hover:bg-slate-50 hover:text-slate-800",
                    )}
                  >
                    {item.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div ref={detailRef} className="min-w-0 flex-1 overflow-y-auto pr-1">
          {tool ? (
            <>
              <div className="flex items-start justify-between gap-3">
                <h3 className="min-w-0 select-text break-all font-mono text-ui-base text-slate-900">
                  {tool.name}
                </h3>
                <button
                  type="button"
                  onClick={() => props.onCopy(tool.schema)}
                  className={COPY_BUTTON}
                >
                  <Copy size={10} />
                  复制 Schema
                </button>
              </div>
              <p className="mt-1.5 select-text text-ui-caption leading-6 text-slate-500">
                {tool.description}
              </p>

              <h4 className="mt-4 text-ui-sm text-slate-600">参数</h4>
              {schema ? (
                <ParamTree schema={schema} depth={0} />
              ) : (
                <pre className="select-text theme-static-dark mt-2 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-ui-xs leading-5 text-slate-200">
                  {tool.schema}
                </pre>
              )}
            </>
          ) : (
            <p className="text-ui-sm text-slate-400">接口列表为空</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ParamTree(props: { schema: JsonSchema; depth: number }) {
  const entries = Object.entries(props.schema.properties ?? {});
  if (entries.length === 0) {
    return <p className="mt-2 text-ui-xs text-slate-400">无参数</p>;
  }
  const required = new Set(props.schema.required ?? []);

  return (
    <div className="mt-1 divide-y divide-slate-100 border-t border-slate-100">
      {entries.map(([name, child]) => (
        <ParamRow
          key={name}
          name={name}
          schema={child}
          required={required.has(name)}
          depth={props.depth}
        />
      ))}
    </div>
  );
}

function ParamRow(props: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  depth: number;
}) {
  const { schema, depth } = props;
  const nested =
    depth < MAX_DEPTH
      ? schema.properties
        ? schema
        : schema.items?.properties
          ? schema.items
          : null
      : null;
  const constraints = constraintLabels(schema);

  return (
    <div className="py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="select-text font-mono text-ui-sm text-slate-700">{props.name}</span>
        <span className="font-mono text-ui-2xs text-slate-400">{typeLabel(schema)}</span>
        {props.required ? (
          <span className="text-ui-2xs text-rose-500">必填</span>
        ) : null}
        {constraints.map((label) => (
          <span key={label} className="font-mono text-ui-2xs text-slate-400">
            {label}
          </span>
        ))}
      </div>
      {schema.description ? (
        <p className="mt-1 select-text text-ui-xs leading-5 text-slate-500">
          {schema.description}
        </p>
      ) : null}
      {nested ? (
        <div className="mt-2 ml-1 border-l border-slate-100 pl-3">
          {schema.type === "array" ? (
            <div className="text-ui-2xs text-slate-400">元素字段</div>
          ) : null}
          <ParamTree schema={nested} depth={depth + 1} />
        </div>
      ) : null}
    </div>
  );
}

function parseSchema(raw: string | undefined): JsonSchema | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? (value as JsonSchema) : null;
  } catch {
    return null;
  }
}

function typeLabel(schema: JsonSchema): string {
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
  if (type === "array") {
    return `${schema.items ? typeLabel(schema.items) : "any"}[]`;
  }
  if (!type && schema.properties) return "object";
  return type ?? "any";
}

function constraintLabels(schema: JsonSchema): string[] {
  const labels: string[] = [];
  if (schema.enum) labels.push(schema.enum.map(literal).join(" · "));
  if (schema.default !== undefined) labels.push(`默认 ${literal(schema.default)}`);
  if (schema.minimum !== undefined) labels.push(`≥ ${schema.minimum}`);
  if (schema.maximum !== undefined) labels.push(`≤ ${schema.maximum}`);
  if (schema.maxItems !== undefined) labels.push(`最多 ${schema.maxItems} 项`);
  return labels;
}

function literal(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}
