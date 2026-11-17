/**
 * Trajectory inspector: the selected row's facts, payloads and timing.
 *
 * Tabs mirror the reference panel — 概述 for the summary, then the payloads a
 * record actually has (a tool has 参数/结果/Schema/计时, a message has 预览/原始内容).
 * The pane is resizable and closes back to the full-width ledger.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";

import { t } from "../../lib/i18n";
import type { DshEntryUsage } from "../../lib/dsh";
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

const TABS: Record<TrajRecord["kind"], readonly { id: Tab; label: "agent.traj.tabSummary" | "agent.traj.tabPreview" | "agent.traj.tabRaw" | "agent.traj.tabInput" | "agent.traj.tabOutput" | "agent.traj.tabSchema" | "agent.traj.tabTiming" }[]> = {
  user: [
    { id: "summary", label: "agent.traj.tabSummary" },
    { id: "preview", label: "agent.traj.tabPreview" },
    { id: "raw", label: "agent.traj.tabRaw" },
  ],
  assistant: [
    { id: "summary", label: "agent.traj.tabSummary" },
    { id: "preview", label: "agent.traj.tabPreview" },
    { id: "raw", label: "agent.traj.tabRaw" },
  ],
  tool: [
    { id: "summary", label: "agent.traj.tabSummary" },
    { id: "input", label: "agent.traj.tabInput" },
    { id: "output", label: "agent.traj.tabOutput" },
    { id: "schema", label: "agent.traj.tabSchema" },
    { id: "timing", label: "agent.traj.tabTiming" },
  ],
};

const DETAILS_MIN_WIDTH = 320;
const DETAILS_MAX_WIDTH = 720;

function stateLabel(record: TrajRecord): string {
  if (record.state === "error") return t("agent.traj.stateFailed");
  if (record.state === "running") return t("agent.traj.statePending");
  return t("agent.traj.stateCompleted");
}

function kindLabel(kind: TrajRecord["kind"]): string {
  if (kind === "user") return t("agent.traj.kindUser");
  if (kind === "assistant") return t("agent.traj.kindAssistant");
  return t("agent.traj.kindTool");
}

/** Kind tag: same colors as the ledger glyphs. */
function KindTag({ kind }: { kind: TrajRecord["kind"] }) {
  return (
    <span
      className={clsx(
        "shrink-0 rounded px-1 py-px text-ui-2xs",
        kind === "user" && "bg-sky-50 text-sky-700",
        kind === "assistant" && "bg-violet-50 text-violet-700",
        kind === "tool" && "bg-amber-50 text-amber-700",
      )}
    >
      {kindLabel(kind)}
    </span>
  );
}

function Clock({ timestamp }: { timestamp: number | undefined }) {
  const [unix, setUnix] = useState(false);
  if (timestamp === undefined) return <span>{t("agent.traj.notAvailable")}</span>;
  return (
    <button
      type="button"
      className="select-text text-left transition hover:text-slate-900"
      title={unix ? t("agent.traj.showLocal") : t("agent.traj.showUnix")}
      onClick={() => setUnix((value) => !value)}
    >
      {unix ? (timestamp / 1_000).toFixed(3) : formatClock(timestamp)}
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

function TokenRows({ usage }: { usage: DshEntryUsage | undefined }) {
  if (usage === undefined) {
    return <Row label={t("agent.traj.usage")}>{t("agent.traj.usageNotReported")}</Row>;
  }
  return (
    <>
      <Row label={t("agent.traj.usageInput")}>{usage.inputTokens.toLocaleString()}</Row>
      {usage.cacheReadTokens > 0 ? (
        <Row label={t("agent.traj.usageCacheRead")}>{usage.cacheReadTokens.toLocaleString()}</Row>
      ) : null}
      {usage.cacheWriteTokens > 0 ? (
        <Row label={t("agent.traj.usageCacheWrite")}>
          {usage.cacheWriteTokens.toLocaleString()}
        </Row>
      ) : null}
      <Row label={t("agent.traj.usageOutput")}>{usage.outputTokens.toLocaleString()}</Row>
    </>
  );
}

function AssistantTiming({ record }: { record: TrajRecord }) {
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
      <Row label={t("agent.traj.started")}>
        <Clock timestamp={started} />
      </Row>
      <Row label={t("agent.traj.totalDuration")}>{formatDurationMs(total)}</Row>
      <Row label={t("agent.traj.ttft")}>{formatDurationMs(ttft)}</Row>
      <Row label={t("agent.traj.generation")}>{formatDurationMs(generation)}</Row>
      <Row label={t("agent.traj.throughput")}>
        {throughput === undefined
          ? t("agent.traj.notAvailable")
          : t("agent.traj.tokensPerSecond", { value: throughput })}
      </Row>
    </dl>
  );
}

function RecordTiming({ record }: { record: TrajRecord }) {
  if (record.kind === "assistant") return <AssistantTiming record={record} />;
  return (
    <dl className="py-2 text-ui-xs">
      <Row label={t("agent.traj.started")}>
        <Clock timestamp={record.startedAtMs} />
      </Row>
      <Row label={t("agent.traj.duration")}>{formatDurationMs(recordDuration(record))}</Row>
      <Row label={t("agent.traj.timingSource")}>
        {record.startedAtMs === undefined
          ? t("agent.traj.notAvailable")
          : record.endedAtMs === undefined
            ? t("agent.traj.timingRunning")
            : t("agent.traj.timingSession")}
      </Row>
    </dl>
  );
}

/** Raw payload block: JSON tree when it parses, plain text otherwise. */
function Payload({ text, preview = false }: { text: string | undefined; preview?: boolean }) {
  if (text === undefined || text === "") {
    return <p className="px-3.5 py-2 text-ui-xs text-slate-400">{t("agent.traj.noPayload")}</p>;
  }
  const json = parseJsonContainer(text);
  if (json !== undefined) return <JsonTree value={json} preview={preview} className="px-3.5 py-2" />;
  return (
    <pre className="select-text overflow-auto whitespace-pre-wrap break-words px-3.5 py-2 font-mono text-ui-xs leading-5 text-slate-600">
      {text}
    </pre>
  );
}

type Props = {
  record: TrajRecord;
  records: readonly TrajRecord[];
  /** Dragged width; `null` follows the default clamp. Owned by the panel so a
   *  new selection does not reset it. */
  width: number | null;
  onWidthChange: (width: number | null) => void;
  onSelect: (index: number) => void;
  onClose: () => void;
};

/** Right-hand inspector for one selected ledger row. */
export function TrajectoryInspector({
  record,
  records,
  width,
  onWidthChange,
  onSelect,
  onClose,
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
    entry?.kind === "assistant" ? entry.text : entry?.kind === "user" ? entry.text : undefined;
  const thinking = entry?.kind === "assistant" ? entry.reasoning : undefined;
  const parent = parentAssistant(records, record);
  const location =
    record.turn > 0
      ? `${t("agent.traj.turnLabel", { turn: record.turn })} · ${record.group}`
      : record.group;

  const activate = (next: Tab) => setTab(next);

  const clamp = (next: number, split: number) => {
    const max = Math.min(DETAILS_MAX_WIDTH, Math.max(DETAILS_MIN_WIDTH, split - 280));
    return Math.min(max, Math.max(DETAILS_MIN_WIDTH, next));
  };

  return (
    <aside
      ref={asideRef}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-surface"
      style={{
        width: width ?? "clamp(320px, 38%, 440px)",
        maxWidth: "calc(100% - 280px)",
      }}
      aria-label={t("agent.traj.inspectorAria")}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("agent.traj.resize")}
        aria-valuenow={Math.round(width ?? 0)}
        tabIndex={0}
        title={t("agent.traj.resize")}
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
          onWidthChange(clamp(drag.startWidth + drag.startX - event.clientX, drag.split));
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
          onWidthChange(clamp(current + step, split));
          event.preventDefault();
        }}
        onDoubleClick={() => onWidthChange(null)}
      />

      <div className="flex h-[42px] shrink-0 items-center justify-between gap-2 border-b border-border pr-2 pl-3">
        <div className="flex min-w-0 items-center gap-2">
          <KindTag kind={record.kind} />
          <span className="min-w-0 truncate font-mono text-ui-2xs text-slate-400" title={location}>
            {location}
          </span>
        </div>
        <button
          type="button"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-ui-base text-slate-400 transition hover:bg-overlay hover:text-slate-700"
          aria-label={t("agent.traj.closeInspector")}
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div
        className="flex h-[34px] shrink-0 gap-px overflow-x-auto border-b border-border px-2 [scrollbar-width:none]"
        role="tablist"
        aria-label={t("agent.traj.inspectorAria")}
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
            {t(item.label)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {tab === "summary" ? (
          <>
            <dl className="py-2 text-ui-xs">
              {record.kind === "tool" && parent !== undefined ? (
                <Row label={t("agent.traj.hierarchy")}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-0.5 text-slate-600 transition hover:text-slate-900"
                    onClick={() => onSelect(parent.index)}
                  >
                    {t("agent.traj.assistantMessage")}
                    <ChevronRight size={11} className="text-slate-300" />
                  </button>
                </Row>
              ) : null}
              <Row label={t("agent.traj.status")}>
                <span className={record.state === "error" ? "text-rose-600" : undefined}>
                  {stateLabel(record)}
                </span>
              </Row>
              {record.kind === "assistant" ? (
                <TokenRows usage={entry?.kind === "assistant" ? entry.usage : undefined} />
              ) : null}
              {record.kind !== "assistant" ? (
                <Row label={t("agent.traj.duration")}>
                  {formatDurationMs(recordDuration(record))}
                </Row>
              ) : null}
            </dl>

            <div className="flex flex-col">
              {record.kind === "tool" ? (
                <>
                  <Section label={t("agent.traj.tabInput")} onOpen={() => activate("input")}>
                    <Payload text={args} preview />
                  </Section>
                  <Section label={t("agent.traj.tabOutput")} onOpen={() => activate("output")}>
                    <Payload text={result} preview />
                  </Section>
                  <Section label={t("agent.traj.tabSchema")} onOpen={() => activate("schema")}>
                    <p className="py-1 text-ui-xs text-slate-400">
                      {t("agent.traj.schemaUnavailable")}
                    </p>
                  </Section>
                </>
              ) : (
                <Section label={t("agent.traj.tabPreview")} onOpen={() => activate("preview")}>
                  {thinking !== undefined && thinking !== "" ? (
                    <p className="mb-1 text-ui-xs text-slate-400">{thinking}</p>
                  ) : null}
                  <p className="whitespace-pre-wrap break-words text-ui-xs leading-5 text-slate-600 select-text">
                    {messageText ?? record.text}
                  </p>
                </Section>
              )}
              <Section label={t("agent.traj.tabTiming")} onOpen={() => activate("timing")}>
                <div className="-mx-3.5">
                  <RecordTiming record={record} />
                </div>
              </Section>
            </div>
          </>
        ) : null}

        {tab === "preview" ? (
          <div className="px-3.5 py-3">
            {thinking !== undefined && thinking !== "" ? (
              <div className="mb-3">
                <div className="mb-1 text-ui-2xs text-slate-400">{t("agent.traj.thinking")}</div>
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
            text={
              [thinking, messageText]
                .filter((value): value is string => value !== undefined && value !== "")
                .join("\n\n") || record.text
            }
          />
        ) : null}

        {tab === "input" ? <Payload text={args} /> : null}
        {tab === "output" ? <Payload text={result} /> : null}

        {tab === "schema" ? (
          <p className="px-3.5 py-3 text-ui-xs text-slate-400">
            {t("agent.traj.schemaUnavailable")}
          </p>
        ) : null}

        {tab === "timing" ? <RecordTiming record={record} /> : null}
      </div>
    </aside>
  );
}
