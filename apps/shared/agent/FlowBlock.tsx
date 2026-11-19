import { memo, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  Brain,
  ChevronRight,
  Clock,
  FileText,
  PencilLine,
  Terminal,
} from "lucide-react";

import type { AgentLocale } from "./types";
import { agentLabel } from "./labels";
import {
  isClosed,
  latestStep,
  summaryKind,
  summaryLabel,
  type AgentFlow,
  type AgentThinking,
  type FlowLive,
  type LatestStep,
} from "./flows";
import { duration } from "./format";
import { ScrollingName } from "./ScrollingName";
import { ActionKindIcon, LeafRow, ThinkingBlock } from "./TraceRows";
import { AnswerBlock } from "./MessageParts";
import { Collapse } from "./Collapse";

const GROUP_ICON = {
  reads: FileText,
  commands: Terminal,
  files: PencilLine,
  thinking: Brain,
} as const;

type Props = {
  flow: AgentFlow;
  /** The turn is still running; only its open flow has a live header. */
  running: boolean;
  live?: FlowLive;
  locale: AgentLocale;
  /** The 说明 is the turn's answer and is rendered outside the process fold. */
  hideNote?: boolean;
};

/**
 * One flow: the steps between two 说明. Collapsed it is a single summary line
 * (or the latest step while running); opened it is the group breakdown, then
 * the 说明 — which never folds. A settled turn's answer is the exception: its
 * 说明 is rendered by `TurnBlock` outside the process fold, so the flow hides
 * its own copy.
 *
 * Memoized per flow: committed flows keep their identity across token deltas,
 * so only the open flow (the one receiving `live`) re-renders.
 */
function FlowBlockImpl({ flow, running, live, locale, hideNote = false }: Props) {
  const [open, setOpen] = useState(false);
  const step = useMemo(
    () => (running && !isClosed(flow) ? latestStep(flow, live, locale) : null),
    [flow, live, locale, running],
  );
  const summary = useMemo(
    () => (step ? null : summaryLabel(flow, locale)),
    [flow, locale, step],
  );
  const expandable = flow.steps.length > 0;
  const expanded = expandable && open;

  // A flow that only thought, with a single block: the flow header already
  // says 思考, so the expansion is the block itself (no extra step row).
  const thinkingOnly = useMemo(
    () => flow.steps.length > 0 && flow.steps.every((item) => item.kind === "thinking"),
    [flow.steps],
  );
  const flatThinking = thinkingOnly && flow.steps.length === 1;

  return (
    <div data-component="FlowBlock" className="flex min-w-0 flex-col gap-2">
      {/* Header and fold share one wrapper so the note below keeps the same
          root gap before, during and after the close animation. */}
      <div className="flex min-w-0 flex-col">
        {step ? (
        <StepHeader
          step={step}
          open={expanded}
          expandable={expandable}
          locale={locale}
          onToggle={() => setOpen((value) => !value)}
        />
      ) : summary ? (
        <SummaryHeader
          flow={flow}
          label={summary}
          locale={locale}
          open={expanded}
          expandable={expandable}
          onToggle={() => setOpen((value) => !value)}
        />
      ) : null}

      <Collapse open={expanded}>
        <div className="flex flex-col gap-2 border-l border-border pt-2 pl-3">
          {flatThinking ? (
            flow.steps.map((item) =>
              item.kind === "thinking" ? (
                <ThinkingBlock
                  key={item.key}
                  text={item.thinking.text}
                  locale={locale}
                />
              ) : null,
            )
          ) : (
            flow.steps.map((item) => {
              if (item.kind === "thinking") {
                return (
                  <ThinkingStep
                    key={item.key}
                    block={item.thinking}
                    locale={locale}
                  />
                );
              }
              if (item.kind === "tool") {
                return (
                  <LeafRow
                    key={item.key}
                    name={item.entry.name}
                    args={item.entry.args}
                    status={item.entry.status}
                    result={item.entry.result}
                    locale={locale}
                  />
                );
              }
              return (
                <LeafRow
                  key={item.key}
                  name={item.tool.name}
                  args={item.tool.args}
                  status="running"
                  locale={locale}
                />
              );
            })
          )}
        </div>
        </Collapse>
      </div>

      {hideNote ? null : flow.note ? (
        <AnswerBlock text={flow.note.text} locale={locale} />
      ) : flow.liveNote ? (
        <AnswerBlock text={flow.liveNote} locale={locale} streaming />
      ) : null}
    </div>
  );
}

export const FlowBlock = memo(FlowBlockImpl);

/**
 * One thinking step, in its chronological place among the flow's tool rows.
 * The row is the duration; opening it shows the reasoning text.
 */
const ThinkingStep = memo(function ThinkingStep({
  block,
  locale,
}: {
  block: AgentThinking;
  locale: AgentLocale;
}) {
  const [open, setOpen] = useState(false);
  const span =
    block.startedAtMs !== undefined &&
    block.completedAtMs !== undefined &&
    block.completedAtMs > block.startedAtMs
      ? block.completedAtMs - block.startedAtMs
      : null;
  const label =
    span === null
      ? agentLabel("flow.thinkingPlain", locale)
      : agentLabel("flow.thinkingStep", locale, {
          duration: duration(span, locale),
        });

  return (
    <div data-component="ThinkingStep" className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        title={
          open
            ? agentLabel("think.collapse", locale)
            : agentLabel("think.expand", locale)
        }
        onClick={() => setOpen((value) => !value)}
        className="group/think -ml-1 flex min-w-0 items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-left text-ui-xs text-slate-500 transition-colors hover:text-slate-700"
      >
        <Brain size={12} className="shrink-0 text-slate-400" />
        <span className="shrink-0 tabular-nums">{label}</span>
        <ChevronRight
          size={12}
          className={clsx(
            "shrink-0 text-slate-300 opacity-30 transition-[opacity,transform] group-hover/think:opacity-100 group-focus-visible/think:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      </button>
      <Collapse open={open}>
        <div className="mt-1 pl-3">
          <ThinkingBlock text={block.text} locale={locale} />
        </div>
      </Collapse>
    </div>
  );
});

/** The flow's folded summary line: `已查阅 n 项, 已执行 n 命令, …`. */
function SummaryHeader({
  flow,
  label,
  locale,
  open,
  expandable,
  onToggle,
}: {
  flow: AgentFlow;
  label: string;
  locale: AgentLocale;
  open: boolean;
  expandable: boolean;
  onToggle: () => void;
}) {
  const Icon = GROUP_ICON[summaryKind(flow)];
  return (
    <HeaderButton
      open={open}
      expandable={expandable}
      locale={locale}
      onToggle={onToggle}
    >
      <Icon size={12} className="shrink-0 text-slate-400" />
      <span className="shrink-0">{label}</span>
    </HeaderButton>
  );
}

/**
 * The open flow's latest step. Its verb is the step's own state: a finished
 * command reads 已执行, a blocked question reads 等待回答, a streaming reasoning
 * reads 正在思考. The raw command is shown here; the folded leaf shows the
 * model's description instead.
 */
function StepHeader({
  step,
  open,
  expandable,
  locale,
  onToggle,
}: {
  step: LatestStep;
  open: boolean;
  expandable: boolean;
  locale: AgentLocale;
  onToggle: () => void;
}) {
  const icon =
    step.kind === "thinking" ? (
      <Brain size={12} className="shrink-0 text-slate-400" />
    ) : step.phase === "waiting" ? (
      <Clock size={12} className="shrink-0 text-slate-400" />
    ) : (
      <ActionKindIcon kind={step.kind} failed={step.failed} />
    );

  return (
    <HeaderButton
      open={open}
      expandable={expandable}
      locale={locale}
      onToggle={onToggle}
    >
      {icon}
      <span
        className={clsx(
          "shrink-0",
          step.failed ? "text-rose-600" : "text-slate-500",
        )}
      >
        {step.verb}
      </span>
      {step.kind === "thinking" ? (
        <ScrollingName
          text={step.target}
          className="min-w-0 flex-1 text-slate-400"
        />
      ) : (
        <span
          className={clsx(
            "min-w-0 flex-1 truncate font-mono",
            step.failed ? "text-rose-700" : "text-slate-600",
          )}
        >
          {step.target}
        </span>
      )}
      {step.added ? (
        <span className="shrink-0 tabular-nums text-emerald-600">+{step.added}</span>
      ) : null}
      {step.removed ? (
        <span className="shrink-0 tabular-nums text-rose-500">-{step.removed}</span>
      ) : null}
    </HeaderButton>
  );
}

/** Shared row chrome for both flow headers (summary and latest step). */
function HeaderButton({
  open,
  expandable,
  locale,
  onToggle,
  children,
}: {
  open: boolean;
  expandable: boolean;
  locale: AgentLocale;
  onToggle: () => void;
  children: ReactNode;
}) {
  // Fit-content, clamped by the column: the chevron trails the content instead
  // of sitting at the far right, while a long target still truncates.
  const className =
    "group/flow -ml-1 flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-ui-caption text-slate-500 transition-colors hover:text-slate-700";
  if (!expandable) {
    return <span data-component="HeaderButton" className={className}>{children}</span>;
  }
  return (
    <button
      data-component="HeaderButton"
      type="button"
      aria-expanded={open}
      title={
        open ? agentLabel("flow.collapse", locale) : agentLabel("flow.expand", locale)
      }
      onClick={onToggle}
      className={className}
    >
      {children}
      <ChevronRight
        size={12}
        className={clsx(
          "shrink-0 text-slate-300 opacity-40 transition-[opacity,transform] group-hover/flow:opacity-100 group-focus-visible/flow:opacity-100",
          open && "rotate-90 opacity-100",
        )}
      />
    </button>
  );
}
