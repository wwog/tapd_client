import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  Eye,
  Info,
  Loader2,
  X,
} from "lucide-react";

import {
  agentApi,
  type AgentSummary,
} from "../lib/agent";
import { applyExternalAppearance, useAppearance, type Appearance } from "../lib/appearance";
import { formatBytes } from "../lib/format";
import { bugTitle } from "../lib/bug";
import {
  formatNotificationTime,
  NOTIFICATION_KIND_LABELS,
  notificationApi,
  onIslandHover,
  onIslandLayout,
  onNotificationShow,
  pendingItems,
  type AiAction,
  type AiBlock,
  type AiPayload,
  type AiTone,
  type IslandLayout,
  type NotificationItem,
  type NotificationStateSnapshot,
} from "../lib/notification";
import {
  getUpdateSnapshot,
  startUpdateStore,
  subscribeUpdate,
  updateApi,
  updateOwnsScreen,
  type UpdateState,
} from "../lib/update";
import { useTauriEvent, useTauriSubscription } from "../lib/tauriEvent";

const PILL_LAYOUT: IslandLayout = { expanded: false, width: 210, height: 34, count: 0 };

/**
 * Only the fields the capsule actually renders. Poll snapshots are fresh
 * objects every tick, and a new object is a new render for the whole island.
 */
function sameStatus(
  a: NotificationStateSnapshot,
  b: NotificationStateSnapshot,
): boolean {
  return (
    a.running === b.running &&
    a.lastError === b.lastError &&
    JSON.stringify(a.settings) === JSON.stringify(b.settings)
  );
}

type Busy = { id: string; action: string } | null;

/**
 * Top-of-screen status capsule ("Dynamic Island"): collapsed it shows the
 * client's running state, expanded it morphs into the pending notification
 * cards. The window itself is transparent and chrome-less; the Rust side
 * animates the window size and tells us the layout via `island://layout`.
 */
export function IslandWindow() {
  const [layout, setLayout] = useState<IslandLayout>(PILL_LAYOUT);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [snapshot, setSnapshot] = useState<NotificationStateSnapshot | null>(null);
  const [agentSummary, setAgentSummary] = useState<AgentSummary | null>(null);
  /** Pointer on the capsule: reported by AppKit (`island://hover`), because the
   *  window never becomes key and WebKit only tracks hover for that one. */
  const [nativeHover, setNativeHover] = useState(false);
  /** DOM hover, kept for platforms without the native tracking above. */
  const [domHover, setDomHover] = useState(false);
  const hovered = nativeHover || domHover;
  /** Hovering the collapsed capsule asks Rust to grow the Agent summary card. */
  const [peeking, setPeeking] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Update progress/error panel replaces the capsule while active. */
  const updateState = useSyncExternalStore(
    subscribeUpdate,
    getUpdateSnapshot,
    getUpdateSnapshot,
  );
  const updateActive = updateOwnsScreen(updateState?.phase);
  /** `always` keeps the capsule on screen; `activity` shows it only when it
   *  has something to report. */
  const resident = useAppearance().islandDisplay === "always";

  useEffect(() => {
    startUpdateStore();
  }, []);
  // Click vs double-click: a single click waits briefly so a double-click can
  // open the main window instead.
  const clickTimer = useRef<number | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await notificationApi.state();
      // Every poll deserializes a fresh object; keeping the previous one when
      // nothing the capsule renders changed avoids a pointless re-render.
      // The card list arrives through `notification://show`, not this snapshot.
      setSnapshot((current) =>
        current && sameStatus(current, next) ? current : next,
      );
      setItems((current) =>
        current.length > 0 ? current : pendingItems(next.items).slice(0, Math.max(1, next.settings.maxVisible)),
      );
    } catch {
      // The Rust side owns the window; a failed status read is not fatal.
    }
  }, []);

  /** Refreshes the Agent snapshot. */
  const refreshAgentSummary = useCallback(async () => {
    try {
      setAgentSummary(await agentApi.summary());
    } catch {
      // Keep the last snapshot; the next tick or event will retry.
    }
  }, []);

  useTauriSubscription(
    () =>
      onNotificationShow(({ items: next }) => {
        setItems(next);
        void refreshStatus();
      }),
    [refreshStatus],
  );

  useTauriSubscription(() => onIslandLayout(setLayout), []);
  useTauriSubscription(() => onIslandHover(setNativeHover), []);

  // The main window broadcasts appearance changes; the island applies them so
  // the capsule follows light/dark without a reload.
  useTauriEvent<Appearance>("appearance://changed", applyExternalAppearance);

  useTauriEvent<AgentSummary>("agent://summary", setAgentSummary);

  useEffect(() => {
    void refreshStatus();
    void refreshAgentSummary();

    // Keep the capsule honest even between polls; also self-heals if the
    // initial `island://layout` was emitted before the webview loaded.
    // Agent state arrives through `agent://summary`.
    const timer = window.setInterval(() => {
      void refreshStatus();
      void refreshAgentSummary();
    }, 30_000);

    return () => {
      window.clearInterval(timer);
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    };
  }, [refreshStatus, refreshAgentSummary]);

  const run = async (item: NotificationItem, action: "handle" | "view" | "ignore") => {
    if (busy) return;
    setBusy({ id: item.id, action });
    setErrors((previous) => {
      const next = { ...previous };
      delete next[item.id];
      return next;
    });

    try {
      if (action === "handle") await notificationApi.handle(item.id);
      else if (action === "view") await notificationApi.view(item.id);
      else await notificationApi.ignore(item.id);
      setItems((previous) => previous.filter((candidate) => candidate.id !== item.id));
      void refreshStatus();
    } catch (error) {
      setErrors((previous) => ({ ...previous, [item.id]: String(error) }));
    } finally {
      setBusy(null);
    }
  };

  /** Reports an AI card's button click back to the waiting MCP call. */
  const runAi = async (item: NotificationItem, actionId: string) => {
    if (busy) return;
    setBusy({ id: item.id, action: `ai:${actionId}` });
    setErrors((previous) => {
      const next = { ...previous };
      delete next[item.id];
      return next;
    });

    try {
      await notificationApi.aiAction(item.id, actionId);
      setItems((previous) => previous.filter((candidate) => candidate.id !== item.id));
      void refreshStatus();
    } catch (error) {
      setErrors((previous) => ({ ...previous, [item.id]: String(error) }));
    } finally {
      setBusy(null);
    }
  };

  // Only treat the agent as clickable when there is actually something to show.
  const agentTaskId =
    agentSummary &&
    ((agentSummary.awaitingApproval ?? 0) > 0 ||
      (agentSummary.awaitingMerge ?? 0) > 0 ||
      agentSummary.running)
      ? agentSummary.activeTaskId
      : null;
  const agentAwaiting = agentSummary?.awaitingApproval ?? 0;
  const agentMerging = agentSummary?.awaitingMerge ?? 0;
  /** Name of the runtime doing the work; falls back to the generic label. */
  const agentRuntimeLabel = agentSummary?.runtimeName?.trim() || "Agent";
  /** Capsule wording: review first, then merge, then running. */
  const agentStatusLabel =
    agentAwaiting > 0
      ? "Agent 待审核"
      : agentMerging > 0
        ? "Agent 待合并"
        : `${agentRuntimeLabel} 修复中`;

  const { label: statusLabel, tone } = useMemo(() => {
    if (updateState?.available) {
      return { label: `可更新 v${updateState.available.version}`, tone: "alert" as const };
    }
    if ((agentSummary?.awaitingApproval ?? 0) > 0) {
      return { label: "Agent 待审核", tone: "review" as const };
    }
    if ((agentSummary?.awaitingMerge ?? 0) > 0) {
      return { label: "Agent 待合并", tone: "review" as const };
    }
    if (agentSummary?.running) {
      return {
        label: `${agentSummary.runtimeName?.trim() || "Agent"} 修复中`,
        tone: "agent" as const,
      };
    }
    if (!snapshot) return { label: "连接中", tone: "idle" as const };
    if (!snapshot.running) return { label: "通知已暂停", tone: "paused" as const };
    if (snapshot.lastError) return { label: "同步异常", tone: "error" as const };
    if (items.length > 0) return { label: "待处理", tone: "alert" as const };
    return { label: "待命", tone: "ok" as const };
  }, [
    agentSummary,
    items.length,
    snapshot,
    updateState?.available,
  ]);

  /** The capsule only offers the peek while it is actually reporting Agent
   *  work; an update notice or pending cards take precedence. */
  const agentActive =
    (agentSummary?.awaitingApproval ?? 0) > 0 ||
    (agentSummary?.awaitingMerge ?? 0) > 0 ||
    Boolean(agentSummary?.running);

  // Resident mode keeps the capsule on screen; "仅通知" hides it while
  // everything is idle. The Rust side ignores this while cards or an update
  // own the island, so expanded notifications are never hidden mid-interaction.
  const idle = statusLabel === "待命";
  const lastVisible = useRef<boolean | null>(null);
  useEffect(() => {
    if (updateActive) return;
    const visible = resident || !idle;
    if (lastVisible.current === visible) return;
    lastVisible.current = visible;
    void notificationApi.setIslandVisible(visible).catch(() => {
      lastVisible.current = null;
    });
  }, [idle, resident, updateActive]);

  // The peek only makes sense on the collapsed capsule while the Agent has
  // something in flight; notification cards, an update panel and a finished
  // Agent all close it.
  useEffect(() => {
    setPeeking(hovered && agentActive && !layout.expanded && !updateActive);
  }, [hovered, agentActive, layout.expanded, updateActive]);

  // Rust owns the window size, so each peek change round-trips once.
  const peekSynced = useRef(false);
  useEffect(() => {
    if (!peekSynced.current) {
      peekSynced.current = true;
      return;
    }
    void notificationApi.setPeek(peeking).catch(() => undefined);
  }, [peeking]);

  if (updateActive) {
    return <UpdateCapsule state={updateState} />;
  }

  if (!layout.expanded) {
    return (
      <div
        className="flex h-full w-full flex-col items-center overflow-hidden"
        // The card sits inside the same window: leaving it closes the peek,
        // moving from the pill down into the card keeps it open. macOS reports
        // this natively; the DOM events only cover the platforms without it.
        onMouseLeave={() => setDomHover(false)}
      >
        <div className="flex h-[34px] shrink-0 items-center">
          <button
            type="button"
            onMouseEnter={() => setDomHover(true)}
            onMouseDown={(event) => {
              if (event.button === 0) dragStart.current = { x: event.clientX, y: event.clientY };
            }}
            onMouseMove={(event) => {
              const start = dragStart.current;
              if (!start) return;
              if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
              dragStart.current = null;
              // Hand the drag to the window manager; the final position is
              // persisted by the Rust side once the drag settles. The peek (if
              // open) stays put: resizing mid-drag would fight the drag.
              void notificationApi.startDrag().catch(() => undefined);
            }}
            onMouseUp={() => {
              dragStart.current = null;
            }}
            onClick={() => {
              if (clickTimer.current !== null) return;
              clickTimer.current = window.setTimeout(() => {
                clickTimer.current = null;
                setPeeking(false);
                if (agentTaskId) {
                  void agentApi.openTask(agentTaskId).catch(() => undefined);
                } else if (items.length > 0) {
                  void notificationApi.expandIsland(true).catch(() => undefined);
                } else {
                  void notificationApi.openMain();
                }
              }, 240);
            }}
            onDoubleClick={() => {
              if (clickTimer.current !== null) {
                window.clearTimeout(clickTimer.current);
                clickTimer.current = null;
              }
              setPeeking(false);
              void notificationApi.openMain();
            }}
            title={
              // While the summary card is open the native tooltip would only
              // repeat it (and cover it).
              peeking
                ? undefined
                : agentTaskId
                  ? `${agentStatusLabel} · 单击打开任务 · 可拖动`
                  : items.length > 0
                    ? "单击展开通知 · 双击打开客户端 · 可拖动"
                    : "双击打开客户端 · 可拖动"
            }
            className={clsx(
              "island-pill group flex cursor-grab items-center gap-2 rounded-full px-3 py-1.5 text-ui-sm text-island-muted border border-island-line backdrop-blur-xl transition active:cursor-grabbing",
              // `hover:` only fires in a key window; the native hover state does
              // not, so it picks the same background itself.
              hovered ? "bg-island-hover" : "bg-island hover:bg-island-hover",
            )}
          >
            <StatusDot tone={tone} />
            <span className="font-normal text-island-ink">TAPD</span>
            {idle ? null : (
              <span className="min-w-0 truncate text-island-muted">{statusLabel}</span>
            )}
            {items.length > 0 ? (
              <span className="rounded-full bg-sky-500 px-1.5 py-0.5 text-ui-xs font-normal leading-none text-white">
                {items.length}
              </span>
            ) : null}
          </button>
        </div>
        {peeking && agentActive && agentSummary ? (
          <AgentPeekCard
            summary={agentSummary}
            onOpenDetail={() => {
              const { workspaceId, bugId } = agentSummary;
              if (!workspaceId || !bugId) return;
              setPeeking(false);
              void notificationApi
                .openBug(workspaceId, bugId)
                .catch(() => undefined);
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col gap-1.5 overflow-hidden p-1.5">
      {items.length === 0 ? (
        <div className="island-expand grid flex-1 place-items-center rounded-2xl bg-island text-ui-sm text-island-muted border border-island-line backdrop-blur-xl">
          暂无待处理通知
        </div>
      ) : (
        <>
          {items.map((item) => {
          const itemBusy = busy?.id === item.id ? busy.action : null;
          const error = errors[item.id];

          // AI / MCP cards use the generic payload and custom action buttons.
          if (item.source === "ai" && item.ai) {
            return (
              <AiCard
                key={item.id}
                item={item}
                payload={item.ai}
                busyAction={itemBusy}
                error={error}
                onAction={(actionId) => void runAi(item, actionId)}
                onDismiss={() => void run(item, "ignore")}
              />
            );
          }

          return (
            <article
              key={item.id}
              className="island-expand relative flex min-h-0 flex-1 flex-col rounded-2xl bg-island p-3 border border-island-line backdrop-blur-xl"
            >
              <button
                type="button"
                aria-label="关闭（忽略）"
                title="关闭（忽略）"
                disabled={Boolean(busy)}
                onClick={() => void run(item, "ignore")}
                className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-island-muted transition hover:bg-island-soft-hover hover:text-island-ink disabled:opacity-40"
              >
                {itemBusy === "ignore" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <X size={13} />
                )}
              </button>

              <div className="flex items-center gap-1.5 pr-7 text-ui-xs text-island-muted">
                <span className="truncate font-normal text-island-ink">
                  {item.workspaceName}
                </span>
                <KindBadge kind={item.kind} />
                <span className="ml-auto shrink-0 tabular-nums">
                  {formatNotificationTime(item.created)}
                </span>
              </div>

              <h2
                className="mt-1 line-clamp-2 text-ui-base font-normal leading-5 text-island-ink"
                title={bugTitle(item.title)}
              >
                {bugTitle(item.title)}
              </h2>

              <div className="mt-1 flex items-center gap-1.5 text-ui-xs text-island-muted">
                {item.severity ? (
                  <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-rose-700">
                    {item.severity}
                  </span>
                ) : null}
                {item.priority ? (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700">
                    {item.priority}优先级
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-right">
                  创建人 {item.creator || "—"}
                </span>
              </div>

              <div className="mt-auto flex items-center gap-1.5 pt-2">
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void run(item, "handle")}
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-sky-500 px-2.5 py-1.5 text-ui-sm font-normal text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {itemBusy === "handle" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Check size={12} />
                  )}
                  处理
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void run(item, "view")}
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-island-soft px-2.5 py-1.5 text-ui-sm font-normal text-island-ink border border-island-line transition hover:bg-island-soft-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {itemBusy === "view" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Eye size={12} />
                  )}
                  查看缺陷
                </button>
              </div>

              {error ? (
                <p className="mt-1.5 line-clamp-2 text-ui-xs leading-4 text-rose-700" title={error}>
                  {error}
                </p>
              ) : null}
            </article>
          );
        })}
        </>
      )}
    </div>
  );
}

const AI_TONE_META: Record<
  AiTone,
  {
    label: string;
    icon: typeof Info;
    iconBg: string;
    iconColor: string;
    badge: string;
  }
> = {
  info: {
    label: "提示",
    icon: Info,
    iconBg: "bg-sky-500/15",
    iconColor: "text-sky-700",
    badge: "bg-sky-400/15 text-sky-700",
  },
  success: {
    label: "成功",
    icon: CheckCircle2,
    iconBg: "bg-emerald-500/15",
    iconColor: "text-emerald-700",
    badge: "bg-emerald-400/15 text-emerald-700",
  },
  warning: {
    label: "警告",
    icon: AlertTriangle,
    iconBg: "bg-amber-500/15",
    iconColor: "text-amber-700",
    badge: "bg-amber-400/15 text-amber-700",
  },
  error: {
    label: "失败",
    icon: AlertTriangle,
    iconBg: "bg-rose-500/15",
    iconColor: "text-rose-700",
    badge: "bg-rose-400/15 text-rose-700",
  },
  progress: {
    label: "进行中",
    icon: Loader2,
    iconBg: "bg-sky-500/15",
    iconColor: "text-sky-700",
    badge: "bg-sky-400/15 text-sky-700",
  },
};

const AI_ACTION_CLASS: Record<string, string> = {
  primary: "bg-sky-500 text-white hover:bg-sky-400",
  secondary:
    "bg-island-soft text-island-ink border border-island-line hover:bg-island-soft-hover",
  danger: "bg-rose-500/90 text-white hover:bg-rose-400",
};

/** Generic card for AI / MCP notifications (tone + blocks + actions). */
function AiCard(props: {
  item: NotificationItem;
  payload: AiPayload;
  busyAction: string | null;
  error?: string;
  onAction: (actionId: string) => void;
  onDismiss: () => void;
}) {
  const { item, payload, busyAction, error, onAction, onDismiss } = props;
  const meta = AI_TONE_META[payload.tone] ?? AI_TONE_META.info;
  const Icon = meta.icon;
  const dismissBusy = busyAction === "ignore";

  return (
    <article className="island-expand relative flex min-h-0 flex-1 flex-col rounded-2xl bg-island p-3 border border-island-line backdrop-blur-xl">
      <button
        type="button"
        aria-label="关闭"
        title="关闭"
        disabled={Boolean(busyAction)}
        onClick={onDismiss}
        className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-island-muted transition hover:bg-island-soft-hover hover:text-island-ink disabled:opacity-40"
      >
        {dismissBusy ? <Loader2 size={12} className="animate-spin" /> : <X size={13} />}
      </button>

      <div className="flex items-center gap-1.5 pr-7 text-ui-xs text-island-muted">
        <span className={clsx("grid h-4 w-4 shrink-0 place-items-center rounded-full", meta.iconBg)}>
          <Icon
            size={11}
            className={clsx(meta.iconColor, payload.tone === "progress" && "animate-spin")}
          />
        </span>
        <span className="truncate font-normal text-island-ink" title={payload.client || item.workspaceName}>
          {payload.client || item.workspaceName || "AI"}
        </span>
        <span className={clsx("shrink-0 rounded px-1.5 py-0.5 text-ui-2xs font-normal", meta.badge)}>
          {meta.label}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">
          {formatNotificationTime(item.created)}
        </span>
      </div>

      <h2
        className="mt-1 line-clamp-2 text-ui-base font-normal leading-5 text-island-ink"
        title={item.title}
      >
        {item.title}
      </h2>

      <AiBlocks blocks={payload.blocks} />

      <div className="mt-auto flex items-center gap-1.5 pt-2">
        {payload.actions.length === 0 ? (
          <button
            type="button"
            disabled={Boolean(busyAction)}
            onClick={onDismiss}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-island-soft px-2.5 py-1.5 text-ui-sm font-normal text-island-ink border border-island-line transition hover:bg-island-soft-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {dismissBusy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            知道了
          </button>
        ) : (
          payload.actions.map((action) => (
            <AiActionButton
              key={action.id}
              action={action}
              busy={busyAction === `ai:${action.id}`}
              disabled={Boolean(busyAction)}
              onClick={() => onAction(action.id)}
            />
          ))
        )}
      </div>

      {error ? (
        <p className="mt-1.5 line-clamp-2 text-ui-xs leading-4 text-rose-700" title={error}>
          {error}
        </p>
      ) : null}
    </article>
  );
}

function AiActionButton(props: {
  action: AiAction;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const { action, busy, disabled, onClick } = props;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "inline-flex flex-1 items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 text-ui-sm font-normal transition disabled:cursor-not-allowed disabled:opacity-50",
        AI_ACTION_CLASS[action.style ?? "secondary"] ?? AI_ACTION_CLASS.secondary,
      )}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : null}
      {action.label}
    </button>
  );
}

function AiBlocks({ blocks }: { blocks: AiBlock[] }) {
  if (blocks.length === 0) return null;

  return (
    <div className="mt-1 min-h-0 space-y-1 overflow-hidden">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "text":
            return (
              <p
                key={index}
                className="line-clamp-2 whitespace-pre-wrap break-words text-ui-sm leading-4 text-island-muted"
              >
                {block.text}
              </p>
            );
          case "code":
            return (
              <pre
                key={index}
                className="line-clamp-2 overflow-hidden rounded bg-island-soft px-1.5 py-1 font-mono text-ui-xs leading-4 text-island-ink"
              >
                {block.text}
              </pre>
            );
          case "fields":
            return (
              <div key={index} className="space-y-0.5">
                {block.fields.map((field, fieldIndex) => (
                  <div
                    key={fieldIndex}
                    className="flex items-center justify-between gap-2 text-ui-xs leading-4"
                  >
                    <span className="shrink-0 text-island-muted">{field.label}</span>
                    <span className="min-w-0 truncate text-right text-island-ink" title={field.value}>
                      {field.value || "—"}
                    </span>
                  </div>
                ))}
              </div>
            );
          case "progress": {
            const percent = block.percent ?? 30;
            return (
              <div key={index} className="space-y-1">
                <div className="flex items-center justify-between text-ui-xs text-island-muted">
                  <span className="truncate">{block.label ?? "进度"}</span>
                  {block.percent != null ? (
                    <span className="ml-2 shrink-0 tabular-nums">
                      {Math.round(block.percent)}%
                    </span>
                  ) : null}
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-island-soft">
                  <div
                    className="h-full rounded-full bg-sky-400 transition-[width] duration-300"
                    style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                  />
                </div>
              </div>
            );
          }
          case "divider":
            return <div key={index} className="h-px bg-island-line" />;
          default:
            return null;
        }
      })}
    </div>
  );
}

/**
 * Hover summary under the collapsed capsule: which bug the current Agent task
 * belongs to, plus the fields worth seeing before opening it. Its height/gap
 * must match the Rust `PEEK_CARD_HEIGHT` / `PEEK_GAP` constants, which size the
 * window.
 */
function AgentPeekCard({
  summary,
  onOpenDetail,
}: {
  summary: AgentSummary;
  onOpenDetail: () => void;
}) {
  const title = summary.title ? bugTitle(summary.title) : "";
  const review = summary.awaitingApproval ?? 0;
  const merge = summary.awaitingMerge ?? 0;
  const pending = review + merge;
  const canOpen = Boolean(summary.workspaceId && summary.bugId);
  // Both counts fit side by side only while they are small; keep one kind of
  // label per state so 300px stays readable.
  const status =
    review > 0 && merge > 0
      ? `待审核 ${review} · 待合并 ${merge}`
      : review > 0
        ? review > 1
          ? `待审核 ${review}`
          : "待审核"
        : merge > 0
          ? merge > 1
            ? `待合并 ${merge}`
            : "待合并"
          : "修复中";
  return (
    <div className="mt-1.5 flex h-[112px] w-full flex-col justify-center rounded-xl border border-island-line bg-island px-3 py-2 text-island-ink backdrop-blur-xl">
      <div className="flex items-center gap-1.5 text-ui-xs text-island-muted">
        <span
          className={clsx(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            pending > 0 ? "bg-rose-500" : "bg-sky-500",
          )}
        />
        <span className="truncate text-island-ink">{summary.workspaceName || "未知项目"}</span>
        {summary.bugId ? (
          <span className="shrink-0 tabular-nums">#{summary.bugId}</span>
        ) : null}
        <span className="ml-auto shrink-0 pl-1.5">{status}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-ui-sm" title={title || undefined}>
        {title || "正在准备任务…"}
      </p>
      <div className="mt-1.5 flex items-center gap-1.5 text-ui-xs">
        {summary.severity ? (
          <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-rose-700">
            {summary.severity}
          </span>
        ) : null}
        {summary.priority ? (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700">
            {summary.priority}优先级
          </span>
        ) : null}
        {canOpen ? (
          <button
            type="button"
            onClick={onOpenDetail}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-island-line bg-island-soft px-2 py-0.5 text-ui-xs text-island-ink transition hover:bg-island-soft-hover"
          >
            <Eye size={11} />
            打开详情
          </button>
        ) : null}
      </div>
    </div>
  );
}


function StatusDot({
  tone,
}: {
  tone: "ok" | "alert" | "paused" | "error" | "idle" | "review" | "agent";
}) {
  return (
    <span className="relative grid h-2 w-2 shrink-0 place-items-center">
      <span
        className={clsx(
          "absolute h-full w-full rounded-full",
          // The resident idle dot stays calm; a permanent ping would nag.
          tone === "alert" && "island-breathe bg-sky-400",
          tone === "review" && "island-breathe bg-rose-400",
          tone === "agent" && "island-breathe bg-sky-400",
        )}
      />
      <span
        className={clsx(
          "h-2 w-2 rounded-full",
          tone === "ok" && "bg-emerald-500",
          tone === "alert" && "bg-sky-500",
          tone === "paused" && "bg-slate-400",
          tone === "error" && "bg-rose-500",
          tone === "idle" && "bg-amber-500",
          tone === "review" && "bg-rose-500",
          tone === "agent" && "bg-sky-500",
        )}
      />
    </span>
  );
}

/**
 * The 3x capsule shown while an update owns the screen. The Rust side sizes
 * the window to 630x102; the panel is intentionally compact enough to fit.
 */
function UpdateCapsule({ state }: { state: UpdateState | null }) {
  const phase = state?.phase ?? "idle";
  const progress = state?.progress;
  const failed = phase === "error";
  const target = state?.available?.version;
  const percent = progress?.percent;
  const [cancelling, setCancelling] = useState(false);

  const cancel = async () => {
    setCancelling(true);
    try {
      await updateApi.cancel();
    } catch {
      // The main window is restored by the Rust side; a failed call leaves
      // the error panel in place so the user can retry.
    } finally {
      setCancelling(false);
    }
  };

  const manual = () => {
    void updateApi.openManual().catch(() => undefined);
  };

  if (failed) {
    return (
      <div className="island-expand flex h-full w-full items-center gap-3 rounded-[22px] bg-island px-6 text-island-ink border border-island-line backdrop-blur-xl">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-rose-500/15 text-rose-700">
          <AlertTriangle size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ui-sm font-normal">更新失败</p>
          <p
            className="mt-0.5 truncate text-ui-xs text-island-muted"
            title={state?.error ?? undefined}
          >
            {state?.error ?? "下载或安装过程中出现错误。"}
          </p>
        </div>
        <button
          type="button"
          onClick={manual}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-island-soft px-3 py-1.5 text-ui-xs font-normal text-island-ink border border-island-line transition hover:bg-island-soft-hover"
        >
          <Download size={12} />
          手动下载
        </button>
        <button
          type="button"
          disabled={cancelling}
          onClick={() => void cancel()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-island-soft px-3 py-1.5 text-ui-xs font-normal text-island-muted border border-island-line transition hover:bg-island-soft-hover disabled:opacity-50"
        >
          {cancelling ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
          取消
        </button>
      </div>
    );
  }

  const title =
    phase === "installing"
      ? "正在解包并安装"
      : phase === "ready"
        ? "更新完成"
        : "正在下载更新";
  const right =
    phase === "downloading" && percent != null
      ? `${percent.toFixed(0)}%`
      : phase === "installing"
        ? "安装中"
        : "完成";
  const detail =
    phase === "downloading"
      ? progress?.total
        ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
        : formatBytes(progress?.received)
      : phase === "ready"
        ? "应用即将重启…"
        : "校验更新包并写入应用目录…";

  return (
    <div className="island-expand flex h-full w-full flex-col justify-center gap-2 rounded-[22px] bg-island px-6 py-3 text-island-ink border border-island-line backdrop-blur-xl">
      <div className="flex items-center gap-2">
        {phase === "ready" ? (
          <CheckCircle2 size={15} className="text-emerald-700" />
        ) : (
          <Loader2 size={15} className="animate-spin text-sky-700" />
        )}
        <span className="text-ui-sm font-normal tracking-wide">{title}</span>
        <span className="font-mono text-ui-2xs text-island-muted">
          v{state?.currentVersion ?? "—"}
          {target ? ` → v${target}` : ""}
        </span>
        <span className="ml-auto text-ui-caption tabular-nums text-island-ink">
          {right}
        </span>
      </div>

      <div className="h-1 w-full overflow-hidden rounded-full bg-island-soft">
        <div
          className={clsx(
            "h-full rounded-full transition-[width] duration-200",
            phase === "ready" ? "bg-emerald-400" : "bg-sky-500",
            phase === "installing" && "w-full animate-pulse",
          )}
          style={{
            width:
              phase === "downloading" || phase === "ready"
                ? `${percent ?? 4}%`
                : "100%",
          }}
        />
      </div>

      <div className="flex items-center justify-between text-ui-2xs text-island-muted">
        <span className="tabular-nums">{detail}</span>
        <span>更新期间主窗口不可打开</span>
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: NotificationItem["kind"] }) {
  return (
    <span
      className={clsx(
        "shrink-0 rounded px-1.5 py-0.5 text-ui-2xs font-normal",
        kind === "new" && "bg-sky-400/15 text-sky-700",
        kind === "transferred" && "bg-violet-400/15 text-violet-700",
        kind === "reopened" && "bg-amber-400/15 text-amber-700",
        kind === "ai" && "bg-island-soft text-island-muted",
      )}
    >
      {NOTIFICATION_KIND_LABELS[kind]}
    </span>
  );
}
