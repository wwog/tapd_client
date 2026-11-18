/**
 * Trajectory inspector: the selected row's facts, payloads and timing.
 *
 * Tabs mirror the reference panel — 概述 for the summary, then the payloads a
 * record actually has (a tool has 参数/结果/Schema/计时, a message has 预览/原始内容).
 * `variant` picks the presentation: "panel" is the resizable inline pane
 * beside the ledger (desktop), "sheet" a fixed bottom sheet over a dimmed
 * backdrop (mobile) — same tabs and body, rounded top edge, slide-up entrance,
 * backdrop click closes. Both are plain CSS; no animation library.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";

import type { AgentLocale, AgentUsage } from "../types";
import { agentLabel } from "../labels";
import { JsonTree, parseJsonContainer } from "./JsonTree";
import {
  formatClock,
  formatDurationMs,
  parentAssistant,
  recordDuration,
  resultText,
  type TrajRecord,
} from "./model";

type Tab = "summary" | "preview" | "raw" | "input" | "output" | "schema" | "timing";

type TabLabelKey =
  | "traj.tabSummary"
  | "traj.tabPreview"
  | "traj.tabRaw"
  | "traj.tabInput"
  | "traj.tabOutput"
  | "traj.tabSchema"
  | "traj.tabTiming";

const TABS: Record<TrajRecord["kind"], readonly { id: Tab; label: TabLabelKey }[]> = {
  user: [
    { id: "summary", label: "traj.tabSummary" },
    { id: "preview", label: "traj.tabPreview" },
    { id: "raw", label: "traj.tabRaw" },
  ],
  assistant: [
    { id: "summary", label: "traj.tabSummary" },
    { id: "preview", label: "traj.tabPreview" },
    { id: "raw", label: "traj.tabRaw" },
  ],
  tool: [
    { id: "summary", label: "traj.tabSummary" },
    { id: "input", label: "traj.tabInput" },
    { id: "output", label: "traj.tabOutput" },
    { id: "schema", label: "traj.tabSchema" },
    { id: "timing", label: "traj.tabTiming" },
  ],
  notice: [
    { id: "summary", label: "traj.tabSummary" },
    { id: "preview", label: "traj.tabPreview" },
    { id: "raw", label: "traj.tabRaw" },
  ],
  system: [
    { id: "summary", label: "traj.tabSummary" },
    { id: "preview", label: "traj.tabPreview" },
    { id: "raw", label: "traj.tabRaw" },
  ],
};

const DETAILS_MIN_WIDTH = 320;
const DETAILS_MAX_WIDTH = 720;

function stateLabel(record: TrajRecord, locale: AgentLocale): string {
  if (record.state === "error") return agentLabel("traj.stateFailed", locale);
  if (record.state === "running") return agentLabel("traj.statePending", locale);
  return agentLabel("traj.stateCompleted", locale);
}

function kindLabel(kind: TrajRecord["kind"], locale: AgentLocale): string {
  if (kind === "user") return agentLabel("traj.kindUser", locale);
  if (kind === "assistant") return agentLabel("traj.kindAssistant", locale);
  if (kind === "notice") return agentLabel("traj.kindNotice", locale);
  if (kind === "system") return agentLabel("traj.kindSystem", locale);
  return agentLabel("traj.kindTool", locale);
}

/** Kind tag: same colors as the ledger glyphs. */
function KindTag({ kind, locale }: { kind: TrajRecord["kind"]; locale: AgentLocale }) {
  return (
    <span
      className={clsx(
        "shrink-0 rounded px-1 py-px text-ui-2xs",
        kind === "user" && "bg-sky-50 text-sky-700",
        kind === "assistant" && "bg-violet-50 text-violet-700",
        kind === "notice" && "bg-slate-100 text-slate-600",
        kind === "system" && "bg-cyan-50 text-cyan-700",
        kind === "tool" && "bg-amber-50 text-amber-700",
      )}
    >
      {kindLabel(kind, locale)}
    </span>
  );
}

function Clock({
  timestamp,
  locale,
}: {
  timestamp: number | undefined;
  locale: AgentLocale;
}) {
  const [unix, setUnix] = useState(false);
  if (timestamp === undefined) return <span>{agentLabel("traj.notAvailable", locale)}</span>;
  return (
    <button
      type="button"
      className="select-text text-left transition hover:text-slate-900"
      title={unix ? agentLabel("traj.showLocal", locale) : agentLabel("traj.showUnix", locale)}
      onClick={() => setUnix((value) => !value)}
    >
      {unix ? (timestamp / 1_000).toFixed(3) : formatClock(timestamp, locale)}
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-[22px] grid-cols-[94px_minmax(0,1fr)] items-center px-3.5">
      <dt className="text-slate-400">{label}</dt>
      <dd className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-slate-700">
        {children}
      </dd>
    </div>
  );
}

/** Collapsible-looking section that opens its tab when the heading is clicked. */
function Section({
  label,
  onOpen,
  children,
}: {
  label: string;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-6 flex-col overflow-hidden">
      <button
        type="button"
        className="flex h-6 w-full shrink-0 items-end gap-1 px-3.5 pb-0.5 text-left text-ui-xs text-slate-500 transition hover:text-slate-700"
        title={label}
        onClick={onOpen}
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronRight size={10} className="shrink-0" />
      </button>
      <div className="max-h-40 min-h-0 overflow-auto px-3.5 pb-1">{children}</div>
    </section>
  );
}

function TokenRows({ usage, locale }: { usage: AgentUsage | undefined; locale: AgentLocale }) {
  if (usage === undefined) {
    return (
      <Row label={agentLabel("traj.usage", locale)}>
        {agentLabel("traj.usageNotReported", locale)}
      </Row>
    );
  }
  return (
    <>
      <Row label={agentLabel("traj.usageInput", locale)}>
        {usage.inputTokens.toLocaleString()}
      </Row>
      {(usage.cacheReadTokens ?? 0) > 0 ? (
        <Row label={agentLabel("traj.usageCacheRead", locale)}>
          {(usage.cacheReadTokens ?? 0).toLocaleString()}
        </Row>
      ) : null}
      {(usage.cacheWriteTokens ?? 0) > 0 ? (
        <Row label={agentLabel("traj.usageCacheWrite", locale)}>
          {(usage.cacheWriteTokens ?? 0).toLocaleString()}
        </Row>
      ) : null}
      <Row label={agentLabel("traj.usageOutput", locale)}>
        {usage.outputTokens.toLocaleString()}
      </Row>
    </>
  );
}

function AssistantTiming({ record, locale }: { record: TrajRecord; locale: AgentLocale }) {
  const entry = record.entry?.kind === "assistant" ? record.entry : undefined;
  const started = record.startedAtMs;
  const first = record.firstTokenAtMs;
  const completed = record.endedAtMs;
  const total =
    started === undefined || completed === undefined ? undefined : Math.max(0, completed - started);
  const ttft =
    started === undefined || first === undefined ? undefined : Math.max(0, first - started);
  const generation =
    first === undefined || completed === undefined ? undefined : Math.max(0, completed - first);
  const output = entry?.usage?.outputTokens;
  const throughput =
    output !== undefined && generation !== undefined && generation > 0
      ? (output / (generation / 1_000)).toFixed(1)
      : undefined;

  return (
    <dl className="py-2 text-ui-xs">
      <Row label={agentLabel("traj.started", locale)}>
        <Clock timestamp={started} locale={locale} />
      </Row>
      <Row label={agentLabel("traj.totalDuration", locale)}>
        {formatDurationMs(total, locale)}
      </Row>
      <Row label={agentLabel("traj.ttft", locale)}>{formatDurationMs(ttft, locale)}</Row>
      <Row label={agentLabel("traj.generation", locale)}>
        {formatDurationMs(generation, locale)}
      </Row>
      <Row label={agentLabel("traj.throughput", locale)}>
        {throughput === undefined
          ? agentLabel("traj.notAvailable", locale)
          : agentLabel("traj.tokensPerSecond", locale, { value: throughput })}
      </Row>
    </dl>
  );
}

function RecordTiming({ record, locale }: { record: TrajRecord; locale: AgentLocale }) {
  if (record.kind === "assistant") return <AssistantTiming record={record} locale={locale} />;
  return (
    <dl className="py-2 text-ui-xs">
      <Row label={agentLabel("traj.started", locale)}>
        <Clock timestamp={record.startedAtMs} locale={locale} />
      </Row>
      <Row label={agentLabel("traj.duration", locale)}>
        {formatDurationMs(recordDuration(record), locale)}
      </Row>
      <Row label={agentLabel("traj.timingSource", locale)}>
        {record.startedAtMs === undefined
          ? agentLabel("traj.notAvailable", locale)
          : record.endedAtMs === undefined
            ? agentLabel("traj.timingRunning", locale)
            : agentLabel("traj.timingSession", locale)}
      </Row>
    </dl>
  );
}

/** Raw payload block: JSON tree when it parses, plain text otherwise. */
function Payload({
  text,
  locale,
  preview = false,
}: {
  text: string | undefined;
  locale: AgentLocale;
  preview?: boolean;
}) {
  if (text === undefined || text === "") {
    return (
      <p className="px-3.5 py-2 text-ui-xs text-slate-400">
        {agentLabel("traj.noPayload", locale)}
      </p>
    );
  }
  const json = parseJsonContainer(text);
  if (json !== undefined) {
    return <JsonTree value={json} preview={preview} className="px-3.5 py-2" locale={locale} />;
  }
  return (
    <pre className="select-text overflow-auto whitespace-pre-wrap break-words px-3.5 py-2 font-mono text-ui-xs leading-5 text-slate-600">
      {text}
    </pre>
  );
}

type Props = {
  record: TrajRecord;
  records: readonly TrajRecord[];
  locale: AgentLocale;
  /** Dragged width ("panel" only); `null` follows the default clamp. Owned by
   *  the panel so a new selection does not reset it. */
  width?: number | null;
  onWidthChange?: (width: number | null) => void;
  onSelect: (index: number) => void;
  onClose: () => void;
  /** "panel" (default): inline beside the ledger. "sheet": fixed bottom sheet
   *  over a backdrop — the mobile presentation. */
  variant?: "panel" | "sheet";
};

/** Pure-CSS entrance for the sheet, declared once per mount. */
const SHEET_CSS = `
@keyframes traj-sheet-in {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  [data-traj-sheet] { animation: none !important; }
}
`;

/** Right-hand inspector for one selected ledger row. */
export function TrajectoryInspector({
  record,
  records,
  locale,
  width = null,
  onWidthChange,
  onSelect,
  onClose,
  variant = "panel",
}: Props) {
  const tabs = TABS[record.kind];
  const [tab, setTab] = useState<Tab>("summary");
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number; split: number } | null>(
    null,
  );
  const asideRef = useRef<HTMLElement | null>(null);

  // A new selection starts at its summary, like the reference panel.
  useEffect(() => setTab("summary"), [record.id]);

  const entry = record.entry;
  const args = entry?.kind === "tool" ? entry.args : undefined;
  const result = entry?.kind === "tool" ? resultText(entry.result) : undefined;
  const messageText =
    entry?.kind === "assistant" ||
    entry?.kind === "user" ||
    entry?.kind === "notice" ||
    entry?.kind === "system"
      ? entry.text
      : undefined;
  const thinking = entry?.kind === "assistant" ? entry.reasoning : undefined;
  const parent = parentAssistant(records, record);
  const location =
    record.turn > 0
      ? `${agentLabel("traj.turnLabel", locale, { turn: record.turn })} · ${record.group}`
      : record.group;

  const activate = (next: Tab) => setTab(next);

  const clamp = (next: number, split: number) => {
    const max = Math.min(DETAILS_MAX_WIDTH, Math.max(DETAILS_MIN_WIDTH, split - 280));
    return Math.min(max, Math.max(DETAILS_MIN_WIDTH, next));
  };

  // Header, tabs and tab bodies are identical in both presentations; only the
  // shell (resizable pane vs fixed bottom sheet) differs.
  const header = (
    <div className="flex h-[42px] shrink-0 items-center justify-between gap-2 border-b border-border pr-2 pl-3">
      <div className="flex min-w-0 items-center gap-2">
        <KindTag kind={record.kind} locale={locale} />
        <span className="min-w-0 truncate font-mono text-ui-2xs text-slate-400" title={location}>
          {location}
        </span>
      </div>
      <button
        type="button"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ui-base text-slate-400 transition hover:bg-overlay hover:text-slate-700"
        aria-label={agentLabel("traj.closeInspector", locale)}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );

  const tabsRow = (
    <div
      className="flex h-[34px] shrink-0 gap-px overflow-x-auto border-b border-border px-2 [scrollbar-width:none]"
      role="tablist"
      aria-label={agentLabel("traj.inspectorAria", locale)}
    >
      {tabs.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          className={clsx(
            "relative shrink-0 px-2.5 text-ui-xs transition",
            tab === item.id
              ? "text-sky-600 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-t after:bg-sky-500"
              : "text-slate-400 hover:bg-overlay hover:text-slate-700",
          )}
          onClick={() => activate(item.id)}
        >
          {agentLabel(item.label, locale)}
        </button>
      ))}
    </div>
  );

  const body = (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {tab === "summary" ? (
        <>
          <dl className="py-2 text-ui-xs">
            {record.kind === "tool" && parent !== undefined ? (
              <Row label={agentLabel("traj.hierarchy", locale)}>
                <button
                  type="button"
                  className="inline-flex items-center gap-0.5 text-slate-600 transition hover:text-slate-900"
                  onClick={() => onSelect(parent.index)}
                >
                  {agentLabel("traj.assistantMessage", locale)}
                  <ChevronRight size={11} className="text-slate-300" />
                </button>
              </Row>
            ) : null}
            <Row label={agentLabel("traj.status", locale)}>
              <span className={record.state === "error" ? "text-rose-600" : undefined}>
                {stateLabel(record, locale)}
              </span>
            </Row>
            {record.kind === "assistant" ? (
              <TokenRows
                usage={entry?.kind === "assistant" ? entry.usage : undefined}
                locale={locale}
              />
            ) : null}
            {record.kind !== "assistant" ? (
              <Row label={agentLabel("traj.duration", locale)}>
                {formatDurationMs(recordDuration(record), locale)}
              </Row>
            ) : null}
          </dl>

          <div className="flex flex-col">
            {record.kind === "tool" ? (
              <>
                <Section label={agentLabel("traj.tabInput", locale)} onOpen={() => activate("input")}>
                  <Payload text={args} locale={locale} preview />
                </Section>
                <Section label={agentLabel("traj.tabOutput", locale)} onOpen={() => activate("output")}>
                  <Payload text={result} locale={locale} preview />
                </Section>
                <Section label={agentLabel("traj.tabSchema", locale)} onOpen={() => activate("schema")}>
                  <p className="py-1 text-ui-xs text-slate-400">
                    {agentLabel("traj.schemaUnavailable", locale)}
                  </p>
                </Section>
              </>
            ) : (
              <Section label={agentLabel("traj.tabPreview", locale)} onOpen={() => activate("preview")}>
                {thinking !== undefined && thinking !== "" ? (
                  <p className="mb-1 text-ui-xs text-slate-400">{thinking}</p>
                ) : null}
                <p className="whitespace-pre-wrap break-words text-ui-xs leading-5 text-slate-600 select-text">
                  {messageText ?? record.text}
                </p>
              </Section>
            )}
            <Section label={agentLabel("traj.tabTiming", locale)} onOpen={() => activate("timing")}>
              <div className="-mx-3.5">
                <RecordTiming record={record} locale={locale} />
              </div>
            </Section>
          </div>
        </>
      ) : null}

      {tab === "preview" ? (
        <div className="px-3.5 py-3">
          {thinking !== undefined && thinking !== "" ? (
            <div className="mb-3">
              <div className="mb-1 text-ui-2xs text-slate-400">
                {agentLabel("traj.thinking", locale)}
              </div>
              <p className="whitespace-pre-wrap break-words text-ui-xs leading-5 text-slate-400 select-text">
                {thinking}
              </p>
            </div>
          ) : null}
          <p className="whitespace-pre-wrap break-words text-ui-xs leading-5 text-slate-700 select-text">
            {messageText ?? record.text}
          </p>
        </div>
      ) : null}

      {tab === "raw" ? (
        <Payload
          locale={locale}
          text={
            [thinking, messageText]
              .filter((value): value is string => value !== undefined && value !== "")
              .join("\n\n") || record.text
          }
        />
      ) : null}

      {tab === "input" ? <Payload text={args} locale={locale} /> : null}
      {tab === "output" ? <Payload text={result} locale={locale} /> : null}

      {tab === "schema" ? (
        <p className="px-3.5 py-3 text-ui-xs text-slate-400">
          {agentLabel("traj.schemaUnavailable", locale)}
        </p>
      ) : null}

      {tab === "timing" ? <RecordTiming record={record} locale={locale} /> : null}
    </div>
  );

  if (variant === "sheet") {
    return (
      <>
        <style>{SHEET_CSS}</style>
        <div
          className="fixed inset-0 z-40 bg-black/30"
          onClick={onClose}
          aria-hidden="true"
        />
        <aside
          data-traj-sheet
          role="dialog"
          aria-modal="true"
          aria-label={agentLabel("traj.inspectorAria", locale)}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[72vh] min-h-0 flex-col overscroll-contain rounded-t-2xl border-t border-x border-border bg-surface [padding-bottom:env(safe-area-inset-bottom)]"
          style={{ animation: "traj-sheet-in 180ms ease-out" }}
        >
          <div className="flex shrink-0 justify-center pt-2" aria-hidden="true">
            <span className="h-1 w-10 rounded-full bg-slate-200" />
          </div>
          {header}
          {tabsRow}
          {body}
        </aside>
      </>
    );
  }

  return (
    <aside
      ref={asideRef}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-surface"
      style={{
        width: width ?? "clamp(320px, 38%, 440px)",
        maxWidth: "calc(100% - 280px)",
      }}
      aria-label={agentLabel("traj.inspectorAria", locale)}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={agentLabel("traj.resize", locale)}
        aria-valuenow={Math.round(width ?? 0)}
        tabIndex={0}
        title={agentLabel("traj.resize", locale)}
        className="absolute inset-y-0 -left-1 z-[6] w-2 cursor-col-resize touch-none focus-visible:bg-sky-100"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const aside = asideRef.current;
          const split = aside?.parentElement;
          if (aside === null || split === null || split === undefined) return;
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: aside.getBoundingClientRect().width,
            split: split.getBoundingClientRect().width,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag === null || drag.pointerId !== event.pointerId) return;
          onWidthChange?.(clamp(drag.startWidth + drag.startX - event.clientX, drag.split));
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const aside = asideRef.current;
          const split = aside?.parentElement?.getBoundingClientRect().width ?? 0;
          const current = width ?? aside?.getBoundingClientRect().width ?? 0;
          const step = event.key === "ArrowLeft" ? 16 : -16;
          onWidthChange?.(clamp(current + step, split));
          event.preventDefault();
        }}
        onDoubleClick={() => onWidthChange?.(null)}
      />

      {header}
      {tabsRow}
      {body}
    </aside>
  );
}
