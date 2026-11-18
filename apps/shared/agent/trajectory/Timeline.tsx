/**
 * Overview timeline above the ledger: three lanes (input / model / tools),
 * drag to focus a time range, wheel to zoom, right-drag to pan.
 *
 * The panel is a navigation aid, not a chart: spans keep the ledger's colors
 * and every gesture ends in either a ledger focus or a selected row.
 */
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import clsx from "clsx";

import type { AgentLocale } from "../types";
import { agentLabel } from "../labels";
import { formatClock, formatDurationMs, type TrajRecord, type TrajTurn } from "./model";
import {
  deriveTimeline,
  type TrajSpan,
  type TrajTimeRange,
  type TrajTimelineMode,
} from "./projection";

const MINIMUM_DRAG_PX = 3;
const MINIMUM_ZOOM_OPERATIONS = 4;
/** Duration mode counts epoch milliseconds, so its floor is a time window. */
const MINIMUM_ZOOM_MS = 20_000;
const EDGE_PAN_ZONE_FRACTION = 0.08;
const EDGE_PAN_STEP_FRACTION = 0.025;
const MAXIMUM_EDGE_PAN_PX = 32;
const TOOLTIP_DELAY_MS = 500;

const LANE_LABELS = ["traj.laneInput", "traj.laneModel", "traj.laneTools"] as const;

type TooltipState = { label: string; x: number; y: number } | null;

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function orderedRange(left: number, right: number): TrajTimeRange {
  return left <= right ? { start: left, end: right } : { start: right, end: left };
}

function centeredRange(
  center: number,
  width: number,
  minimum: number,
  maximum: number,
): TrajTimeRange {
  const clampedWidth = Math.min(maximum - minimum, Math.max(0, width));
  const start = Math.min(
    Math.max(center - clampedWidth / 2, minimum),
    maximum - clampedWidth,
  );
  return { start, end: start + clampedWidth };
}

function rangeFraction(
  range: TrajTimeRange,
  start: number,
  duration: number,
  minimum: number,
  maximum: number,
): { start: number; end: number } {
  const bounded = orderedRange(
    Math.min(maximum, Math.max(minimum, range.start)),
    Math.min(maximum, Math.max(minimum, range.end)),
  );
  return {
    start: (bounded.start - start) / duration,
    end: (bounded.end - start) / duration,
  };
}

function spanTiming(record: TrajRecord | undefined): {
  ttftMs?: number;
  decodingMs?: number;
} {
  if (
    record === undefined ||
    record.kind !== "assistant" ||
    record.startedAtMs === undefined ||
    record.firstTokenAtMs === undefined ||
    record.endedAtMs === undefined
  ) {
    return {};
  }
  const { startedAtMs: start, firstTokenAtMs: first, endedAtMs: completed } = record;
  if (first < start || completed < first) return {};
  return { ttftMs: first - start, decodingMs: completed - first };
}

type SpanLabelKey =
  | "traj.kindUser"
  | "traj.kindAssistant"
  | "traj.kindTool"
  | "traj.kindNotice"
  | "traj.kindSystem";

const KIND_LABEL: Record<TrajSpan["kind"], SpanLabelKey> = {
  user: "traj.kindUser",
  assistant: "traj.kindAssistant",
  tool: "traj.kindTool",
  notice: "traj.kindNotice",
  system: "traj.kindSystem",
};

function spanLabel(span: TrajSpan, record: TrajRecord | undefined, locale: AgentLocale): string {
  const heading = agentLabel(KIND_LABEL[span.kind], locale);
  if (record === undefined) return heading;
  const duration = record.startedAtMs === undefined
    ? undefined
    : Math.max(0, (record.endedAtMs ?? record.startedAtMs) - record.startedAtMs);
  const lines = [heading];
  if (record.startedAtMs !== undefined) {
    lines.push(
      duration === undefined || duration === 0
        ? agentLabel("traj.startedAt", locale, { time: formatClock(record.startedAtMs, locale) })
        : `${formatClock(record.startedAtMs, locale)} → ${formatClock(record.startedAtMs + duration, locale)}`,
    );
    if (duration !== undefined) {
      lines.push(agentLabel("traj.total", locale, { duration: formatDurationMs(duration, locale) }));
    }
  }
  const { ttftMs, decodingMs } = spanTiming(record);
  if (ttftMs !== undefined && decodingMs !== undefined) {
    lines.push(
      agentLabel("traj.ttftDecoding", locale, {
        ttft: formatDurationMs(ttftMs, locale),
        decoding: formatDurationMs(decodingMs, locale),
      }),
    );
  }
  return lines.join("\n");
}

type Props = {
  turns: readonly TrajTurn[];
  locale: AgentLocale;
  mode: TrajTimelineMode;
  range: TrajTimeRange | null;
  selectedIndex: number | null;
  searchMatchIndexes: ReadonlySet<number> | null;
  onRangeChange: (range: TrajTimeRange | null) => void;
  onRecordSelect: (index: number) => void;
  onRecordFocus: (index: number) => void;
};

/** Fixed full-domain overview; the ledger below reads its selection. */
export const TrajectoryTimeline = memo(function TrajectoryTimeline({
  turns,
  locale,
  mode,
  range,
  selectedIndex,
  searchMatchIndexes,
  onRangeChange,
  onRecordSelect,
  onRecordFocus,
}: Props) {
  const model = useMemo(() => deriveTimeline(turns, mode), [turns, mode]);
  const recordByIndex = useMemo(() => {
    const map = new Map<number, TrajRecord>();
    for (const turn of turns) {
      for (const group of turn.groups) {
        for (const record of group.records) map.set(record.index, record);
      }
    }
    return map;
  }, [turns]);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    anchorTime: number;
    anchorClientX: number;
    recordIndex: number | null;
  } | null>(null);
  const panRef = useRef<{
    pointerId: number;
    anchorClientX: number;
    anchorStart: number;
    moved: boolean;
    pannable: boolean;
  } | null>(null);
  const [draft, setDraft] = useState<TrajTimeRange | null>(null);
  const [hover, setHover] = useState<{ fraction: number; recordIndex: number | null } | null>(null);
  const [viewport, setViewport] = useState<TrajTimeRange | null>(null);
  const [animateViewport, setAnimateViewport] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipState>(null);
  const tooltipTimer = useRef<number | null>(null);

  const clearTooltip = () => {
    if (tooltipTimer.current !== null) {
      window.clearTimeout(tooltipTimer.current);
      tooltipTimer.current = null;
    }
    setTooltip(null);
  };

  useEffect(() => () => clearTooltip(), []);

  // A selection outside a changed domain (mode switch, new records) is stale.
  useEffect(() => {
    if (model !== null && range !== null && (range.end < model.start || range.start > model.end)) {
      onRangeChange(null);
    }
  }, [model, onRangeChange, range]);

  useEffect(() => {
    if (model === null) return;
    setAnimateViewport(false);
    // A zoomed viewport that no longer fits (records replaced or truncated)
    // would push the domain off-screen; clamp it to the new model instead.
    setViewport((current) => {
      if (current === null) return null;
      const duration = Math.max(1, current.end - current.start);
      if (duration >= model.end - model.start) return null;
      if (current.end < model.start || current.start > model.end) return null;
      const start = Math.min(Math.max(current.start, model.start), model.end - duration);
      return start === current.start ? current : { start, end: start + duration };
    });
  }, [model]);

  // Keep the selected row's span inside the zoomed viewport.
  useEffect(() => {
    if (model === null || selectedIndex === null) return;
    const span = model.spans.find((candidate) => candidate.index === selectedIndex);
    if (span === undefined) return;
    setAnimateViewport(true);
    setViewport((current) => {
      if (current === null) return current;
      if (span.end > current.start && span.start < current.end) return current;
      const duration = Math.max(1, current.end - current.start);
      const desiredStart = span.end <= current.start ? span.start : span.end - duration;
      const nextStart = Math.min(
        Math.max(desiredStart, model.start),
        Math.max(model.start, model.end - duration),
      );
      return nextStart === current.start ? current : { start: nextStart, end: nextStart + duration };
    });
  }, [model, selectedIndex]);

  const fullDuration = Math.max(1, (model?.end ?? 0) - (model?.start ?? 0));
  const viewportDuration = Math.min(
    fullDuration,
    Math.max(1, (viewport?.end ?? 0) - (viewport?.start ?? 0)),
  );
  const viewportStart =
    model === null || viewport === null
      ? model?.start ?? 0
      : Math.min(Math.max(viewport.start, model.start), model.end - viewportDuration);
  const domainDuration = viewport === null ? fullDuration : viewportDuration;
  const domainStart = viewport === null ? model?.start ?? 0 : viewportStart;

  const domainStyle: CSSProperties | undefined =
    model === null
      ? undefined
      : {
          left: `${(-(domainStart - model.start) / domainDuration) * 100}%`,
          width: `${(fullDuration / domainDuration) * 100}%`,
        };

  const committed =
    model === null || range === null
      ? null
      : rangeFraction(range, domainStart, domainDuration, model.start, model.end);
  const draftFraction =
    model === null || draft === null
      ? null
      : rangeFraction(draft, domainStart, domainDuration, model.start, model.end);
  const visibleRange = draftFraction ?? committed;
  const activeRange = draft ?? range;

  useEffect(() => {
    const track = trackRef.current;
    if (track === null || model === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setAnimateViewport(false);
      const rect = track.getBoundingClientRect();
      const anchorFraction = clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
      // The floor is mode-aware: 4 operations in sequence mode, but duration
      // mode counts epoch milliseconds where 4 ms is an empty slice.
      const floor = mode === "duration" ? MINIMUM_ZOOM_MS : MINIMUM_ZOOM_OPERATIONS;
      const nextDuration = Math.min(
        fullDuration,
        Math.max(
          Math.min(floor, fullDuration),
          domainDuration * Math.exp(event.deltaY * 0.0015),
        ),
      );
      if (nextDuration >= fullDuration * 0.999) {
        setViewport(null);
        return;
      }
      const anchorTime = domainStart + anchorFraction * domainDuration;
      const nextStart = Math.min(
        Math.max(anchorTime - anchorFraction * nextDuration, model.start),
        model.end - nextDuration,
      );
      setViewport({ start: nextStart, end: nextStart + nextDuration });
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
  }, [domainDuration, domainStart, fullDuration, mode, model]);

  if (model === null) {
    return (
      <section
        className="shrink-0 select-none border-b border-border"
        aria-label={agentLabel("traj.timelineAria", locale)}
      >
        <div className="grid h-[50px] grid-cols-[44px_minmax(0,1fr)] overflow-hidden bg-canvas">
          <LaneLabels locale={locale} />
          <div className="relative grid place-items-center text-ui-2xs text-slate-400">
            {agentLabel("traj.noTiming", locale)}
          </div>
        </div>
      </section>
    );
  }

  const minimumSelectionDuration = Math.min(domainDuration, fullDuration / model.spans.length);

  const fractionAt = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
  };

  const recordIndexAt = (event: PointerEvent<HTMLDivElement>): number | null => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const value = target?.closest<HTMLElement>("[data-timeline-record-index]")?.dataset
      .timelineRecordIndex;
    if (value === undefined) return null;
    const index = Number(value);
    return Number.isFinite(index) ? index : null;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    clearTooltip();
    // Right-drag pans; starting one mid-drag would leave the draft behind,
    // because a mouse reports both buttons under one pointer id.
    if (event.button === 2) {
      if (dragRef.current !== null) return;
      panRef.current = {
        pointerId: event.pointerId,
        anchorClientX: event.clientX,
        anchorStart: domainStart,
        moved: false,
        pannable: viewport !== null,
      };
      if (viewport !== null) setAnimateViewport(false);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const anchor = fractionAt(event);
    const anchorTime = domainStart + anchor * domainDuration;
    const recordIndex = recordIndexAt(event);
    setHover({ fraction: anchor, recordIndex });
    dragRef.current = {
      pointerId: event.pointerId,
      anchorTime,
      anchorClientX: event.clientX,
      recordIndex,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({ start: anchorTime, end: anchorTime });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = fractionAt(event);
    const recordIndex = recordIndexAt(event);
    setHover({ fraction, recordIndex });

    const pan = panRef.current;
    if (pan !== null && pan.pointerId === event.pointerId) {
      if (Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX) pan.moved = true;
      if (!pan.pannable) return;
      const delta = (event.clientX - pan.anchorClientX) / Math.max(1, rect.width);
      const nextStart = Math.min(
        Math.max(pan.anchorStart - delta * domainDuration, model.start),
        model.end - domainDuration,
      );
      setViewport({ start: nextStart, end: nextStart + domainDuration });
      return;
    }

    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    let nextDomainStart = domainStart;
    if (viewport !== null) {
      const localX = event.clientX - rect.left;
      const edgeWidth = Math.min(
        MAXIMUM_EDGE_PAN_PX,
        Math.max(1, rect.width * EDGE_PAN_ZONE_FRACTION),
      );
      const direction = localX < edgeWidth ? -1 : localX > rect.width - edgeWidth ? 1 : 0;
      if (direction !== 0) {
        const edgeDistance =
          direction < 0 ? edgeWidth - localX : localX - (rect.width - edgeWidth);
        const strength = clampFraction(edgeDistance / edgeWidth);
        const desiredStart =
          domainStart + direction * domainDuration * EDGE_PAN_STEP_FRACTION * Math.max(0.2, strength);
        nextDomainStart = Math.min(
          Math.max(desiredStart, model.start),
          model.end - domainDuration,
        );
        if (nextDomainStart !== domainStart) {
          setAnimateViewport(false);
          setViewport({ start: nextDomainStart, end: nextDomainStart + domainDuration });
        }
      }
    }
    const pointTime = nextDomainStart + fraction * domainDuration;
    setDraft(orderedRange(drag.anchorTime, pointTime));
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan !== null && pan.pointerId === event.pointerId) {
      const moved = pan.moved || Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX;
      panRef.current = null;
      if (!moved) onRangeChange(null);
      return;
    }
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const pointFraction = fractionAt(event);
    const pointTime = domainStart + pointFraction * domainDuration;
    const selected = orderedRange(drag.anchorTime, pointTime);
    dragRef.current = null;
    setDraft(null);
    const click = Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX;
    const clickedSpan =
      click && drag.recordIndex !== null
        ? model.spans.find((span) => span.index === drag.recordIndex)
        : undefined;
    if (clickedSpan !== undefined) {
      onRangeChange(null);
      onRecordSelect(clickedSpan.index);
      return;
    }
    const committedRange =
      selected.end - selected.start < minimumSelectionDuration
        ? centeredRange(
            click ? selected.start : (selected.start + selected.end) / 2,
            minimumSelectionDuration,
            model.start,
            model.end,
          )
        : selected;
    onRangeChange(committedRange);
    if (click) {
      const point = selected.start;
      const nearest = model.spans.reduce((candidate, span) => {
        const distance = point < span.start ? span.start - point : point > span.end ? point - span.end : 0;
        const candidateDistance =
          point < candidate.start
            ? candidate.start - point
            : point > candidate.end
              ? point - candidate.end
              : 0;
        return distance < candidateDistance ? span : candidate;
      });
      onRecordFocus(nearest.index);
    }
  };

  const resetGestures = () => {
    dragRef.current = null;
    panRef.current = null;
    setDraft(null);
    setHover(null);
    clearTooltip();
  };

  const onPointerCancel = () => {
    resetGestures();
  };

  const scheduleTooltip = (
    span: TrajSpan,
    element: HTMLElement,
    event: PointerEvent<HTMLSpanElement>,
  ) => {
    clearTooltip();
    const rect = element.getBoundingClientRect();
    tooltipTimer.current = window.setTimeout(() => {
      tooltipTimer.current = null;
      setTooltip({
        label: spanLabel(span, recordByIndex.get(span.index), locale),
        x: Math.min(Math.max(rect.left, 8), window.innerWidth - 320),
        y: event.clientY,
      });
    }, TOOLTIP_DELAY_MS);
  };

  return (
    <section
      className="shrink-0 select-none border-b border-border"
      aria-label={agentLabel("traj.timelineAria", locale)}
    >
      <div className="grid h-[50px] grid-cols-[44px_minmax(0,1fr)] overflow-hidden bg-canvas">
        <LaneLabels locale={locale} />
        <div
          ref={trackRef}
          className="relative cursor-crosshair touch-none overflow-hidden"
          aria-label={agentLabel("traj.timelineAria", locale)}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || range === null) return;
            event.preventDefault();
            onRangeChange(null);
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={resetGestures}
          onPointerLeave={() => {
            if (dragRef.current === null && panRef.current === null) {
              setHover(null);
              clearTooltip();
            }
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            onRangeChange(null);
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {hover !== null && hover.recordIndex === null && draft === null ? (
            <div
              className="pointer-events-none absolute inset-y-0 z-[4] w-0.5 bg-sky-500"
              style={{ left: `clamp(0px, calc(${hover.fraction * 100}% - 1px), calc(100% - 2px))` }}
              aria-hidden="true"
            />
          ) : null}

          {visibleRange !== null ? (
            <>
              <div
                className="pointer-events-none absolute inset-y-0 z-[1] bg-sky-500/10"
                style={{
                  left: `${visibleRange.start * 100}%`,
                  width: `${(visibleRange.end - visibleRange.start) * 100}%`,
                }}
                aria-hidden="true"
              />
              <div
                className="pointer-events-none absolute inset-y-0 z-[4]"
                style={{
                  left: `${visibleRange.start * 100}%`,
                  width: `${(visibleRange.end - visibleRange.start) * 100}%`,
                }}
                aria-hidden="true"
              >
                <span className="absolute inset-y-0 left-0 w-[3px] bg-sky-500" />
                <span className="absolute inset-y-0 right-0 w-[3px] bg-sky-500" />
              </div>
            </>
          ) : null}

          <div
            className={clsx(
              "pointer-events-none absolute inset-y-0 z-[3]",
              animateViewport && "transition-[left] duration-150",
            )}
            style={domainStyle}
            aria-hidden="true"
          >
            {model.turnBoundaries
              .filter(
                (boundary) =>
                  boundary.time > model.start &&
                  boundary.time >= domainStart &&
                  boundary.time <= domainStart + domainDuration,
              )
              .map((boundary) => (
                <span
                  key={boundary.turn}
                  className="absolute inset-y-0 w-px bg-border"
                  style={{
                    left: `${((boundary.time - model.start) / fullDuration) * 100}%`,
                  }}
                />
              ))}
          </div>

          <div
            className={clsx(
              "absolute inset-y-[7px] z-[2]",
              animateViewport && "transition-[left] duration-150",
            )}
            style={domainStyle}
          >
            {model.spans
              .filter(
                (span) =>
                  span.index === selectedIndex ||
                  (span.end >= domainStart && span.start <= domainStart + domainDuration),
              )
              .map((span) => {
                const left = (span.start - model.start) / fullDuration;
                const width = (span.end - span.start) / fullDuration;
                const record = recordByIndex.get(span.index);
                const { ttftMs, decodingMs } = spanTiming(record);
                const ttftFraction =
                  ttftMs === undefined || decodingMs === undefined || ttftMs + decodingMs <= 0
                    ? null
                    : ttftMs / (ttftMs + decodingMs);
                const outside =
                  activeRange !== null &&
                  !(span.start <= activeRange.end && span.end >= activeRange.start);
                const dimmed =
                  searchMatchIndexes !== null && !searchMatchIndexes.has(span.index);
                return (
                  <span
                    key={span.index}
                    role="presentation"
                    data-timeline-record-index={span.index}
                    onPointerEnter={(event) => scheduleTooltip(span, event.currentTarget, event)}
                    onPointerLeave={clearTooltip}
                    className={clsx(
                      "absolute top-0 h-2 min-w-[2px] rounded-[1px]",
                      span.kind === "user" && "bg-sky-500/75",
                      span.kind === "tool" && "bg-amber-500/85",
                      span.kind === "assistant" && "bg-violet-400",
                      span.kind === "notice" && "bg-slate-400/70",
                      span.kind === "system" && "bg-cyan-500/85",
                      span.isError && "bg-rose-500",
                      dimmed && "opacity-15",
                      !dimmed && outside && "opacity-20",
                      span.index === selectedIndex &&
                        "z-[1] opacity-100 outline-2 outline-offset-1 outline-sky-400",
                    )}
                    style={{
                      left: `calc(${left * 100}% + min(${width * 8}%, 1px))`,
                      width: `max(2px, calc(${width * 100}% - 2 * min(${width * 8}%, 1px)))`,
                      top: `${span.lane * 14}px`,
                      ...(span.kind === "assistant" && ttftFraction !== null
                        ? {
                            background: `linear-gradient(to right, var(--color-violet-300) 0%, var(--color-violet-300) ${
                              ttftFraction * 100
                            }%, var(--color-violet-400) ${ttftFraction * 100}%, var(--color-violet-400) 100%)`,
                          }
                        : {}),
                    }}
                  />
                );
              })}
          </div>
        </div>
      </div>

      {tooltip !== null ? (
        <div
          className="pointer-events-none fixed z-50 max-w-[320px] whitespace-pre rounded-md border border-border bg-surface px-2 py-1 text-ui-2xs leading-4 text-slate-600 select-text"
          style={{ left: tooltip.x, top: tooltip.y + 14 }}
          role="tooltip"
        >
          {tooltip.label}
        </div>
      ) : null}
    </section>
  );
});

function LaneLabels({ locale }: { locale: AgentLocale }) {
  return (
    <div className="relative border-r border-border text-ui-2xs text-slate-400" aria-hidden="true">
      {LANE_LABELS.map((key, lane) => (
        <span
          key={key}
          className="absolute right-1 flex h-2 items-center"
          style={{ top: `${lane * 14 + 7}px` }}
        >
          {agentLabel(key, locale)}
        </span>
      ))}
    </div>
  );
}
