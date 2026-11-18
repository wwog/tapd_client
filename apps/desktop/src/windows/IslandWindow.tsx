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
  Send,
  Sparkles,
  X,
} from "lucide-react";

import { applyExternalAppearance, useAppearance, type Appearance } from "../lib/appearance";
import { ScrollingName } from "../components/ScrollingName";
import { formatBytes } from "../lib/format";
import { bugTitle } from "../lib/bug";
import {
  formatNotificationTime,
  NOTIFICATION_KIND_LABELS,
  notificationApi,
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
import { getLocale, t, type MessageKey } from "../lib/i18n";

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

  useTauriSubscription(
    () =>
      onNotificationShow(({ items: next }) => {
        setItems(next);
        void refreshStatus();
      }),
    [refreshStatus],
  );

  useTauriSubscription(() => onIslandLayout(setLayout), []);

  // The main window broadcasts appearance changes; the island applies them so
  // the capsule follows light/dark without a reload.
  useTauriEvent<Appearance>("appearance://changed", applyExternalAppearance);

  useEffect(() => {
    void refreshStatus();

    // Keep the capsule honest even between polls; also self-heals if the
    // initial `island://layout` was emitted before the webview loaded.
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 30_000);

    return () => {
      window.clearInterval(timer);
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    };
  }, [refreshStatus]);

  const run = async (
    item: NotificationItem,
    action: "handle" | "view" | "ignore" | "fix",
  ) => {
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
      else if (action === "fix") await notificationApi.fix(item.id);
      else await notificationApi.ignore(item.id);
      setItems((previous) => previous.filter((candidate) => candidate.id !== item.id));
      void refreshStatus();
    } catch (error) {
      setErrors((previous) => ({ ...previous, [item.id]: String(error) }));
    } finally {
      setBusy(null);
    }
  };

  /** Reports an AI card decision (button id, or typed text) back to the
   *  request that raised the card. */
  const runAi = async (
    item: NotificationItem,
    actionId: string | null,
    value?: string,
  ) => {
    if (busy) return;
    setBusy({ id: item.id, action: `ai:${actionId ?? "custom"}` });
    setErrors((previous) => {
      const next = { ...previous };
      delete next[item.id];
      return next;
    });

    try {
      await notificationApi.aiAction(item.id, actionId, value);
      setItems((previous) => previous.filter((candidate) => candidate.id !== item.id));
      void refreshStatus();
    } catch (error) {
      setErrors((previous) => ({ ...previous, [item.id]: String(error) }));
    } finally {
      setBusy(null);
    }
  };

  // The label is translated copy, so the memo must re-run after a language
  // switch; `locale` is only here for that dependency.
  const locale = getLocale();
  const { label: statusLabel, tone } = useMemo(() => {
    if (updateState?.available) {
      return {
        label: t("app.island.updateAvailable", { version: updateState.available.version }),
        tone: "alert" as const,
      };
    }
    if (!snapshot) return { label: t("app.island.connecting"), tone: "idle" as const };
    if (!snapshot.running)
      return { label: t("app.island.notificationsPaused"), tone: "paused" as const };
    if (snapshot.lastError)
      return { label: t("app.island.syncError"), tone: "error" as const };
    if (items.length > 0) return { label: t("app.island.pending"), tone: "alert" as const };
    return { label: t("app.island.standby"), tone: "ok" as const };
  }, [
    items.length,
    locale,
    snapshot,
    updateState?.available,
  ]);

  // Resident mode keeps the capsule on screen; "仅通知" hides it while
  // everything is idle. The Rust side ignores this while cards or an update
  // own the island, so expanded notifications are never hidden mid-interaction.
  const idle = tone === "ok";
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
      <div className="flex h-full w-full flex-col items-center overflow-hidden">
        <div className="flex h-8.5 shrink-0 items-center">
          <button
            type="button"
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
                if (items.length > 0) {
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
                : items.length > 0
                  ? t("app.island.tipNotifications")
                  : t("app.island.tipOpen")
            }
            className="island-pill group flex cursor-grab items-center gap-2 rounded-full bg-island px-3 py-1.5 text-ui-sm text-island-muted border border-island-line active:cursor-grabbing"
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
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col gap-1.5 overflow-hidden p-1.5">
      {items.length === 0 ? (
        <div className="island-expand grid flex-1 place-items-center rounded-2xl bg-island text-ui-sm text-island-muted border border-island-line">
          {t("app.island.empty")}
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
                onAction={(actionId, value) => void runAi(item, actionId, value)}
                onDismiss={() => void run(item, "ignore")}
              />
            );
          }

          return (
            <article
              key={item.id}
              className="island-expand relative flex min-h-0 flex-1 flex-col rounded-2xl bg-island p-3 border border-island-line"
            >
              <button
                type="button"
                aria-label={t("app.island.dismiss")}
                title={t("app.island.dismiss")}
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
                    {t("app.island.priority", { priority: item.priority })}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-right">
                  {t("app.island.creator", { creator: item.creator || "—" })}
                </span>
              </div>

              <div className="mt-auto flex items-center gap-1.5 pt-2">
                {/* 384px card, three buttons: equal width keeps them on one row. */}
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void run(item, "fix")}
                  className="inline-flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg bg-sky-500 px-2 py-1.5 text-ui-sm font-normal text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {itemBusy === "fix" ? (
                    <Loader2 size={12} className="shrink-0 animate-spin" />
                  ) : (
                    <Sparkles size={12} className="shrink-0" />
                  )}
                  <span className="truncate">{t("app.island.fix")}</span>
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void run(item, "handle")}
                  className="inline-flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg bg-island-soft px-2 py-1.5 text-ui-sm font-normal text-island-ink border border-island-line transition hover:bg-island-soft-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {itemBusy === "handle" ? (
                    <Loader2 size={12} className="shrink-0 animate-spin" />
                  ) : (
                    <Check size={12} className="shrink-0" />
                  )}
                  <span className="truncate">{t("app.island.handle")}</span>
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void run(item, "view")}
                  className="inline-flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg bg-island-soft px-2 py-1.5 text-ui-sm font-normal text-island-ink border border-island-line transition hover:bg-island-soft-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {itemBusy === "view" ? (
                    <Loader2 size={12} className="shrink-0 animate-spin" />
                  ) : (
                    <Eye size={12} className="shrink-0" />
                  )}
                  <span className="truncate">{t("app.island.viewBug")}</span>
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
    /** Catalogue key so `t()` runs at render, not at module scope. */
    label: MessageKey;
    icon: typeof Info;
    iconBg: string;
    iconColor: string;
    badge: string;
  }
> = {
  info: {
    label: "app.aiTone.info",
    icon: Info,
    iconBg: "bg-sky-500/15",
    iconColor: "text-sky-700",
    badge: "bg-sky-400/15 text-sky-700",
  },
  success: {
    label: "common.success",
    icon: CheckCircle2,
    iconBg: "bg-emerald-500/15",
    iconColor: "text-emerald-700",
    badge: "bg-emerald-400/15 text-emerald-700",
  },
  warning: {
    label: "app.aiTone.warning",
    icon: AlertTriangle,
    iconBg: "bg-amber-500/15",
    iconColor: "text-amber-700",
    badge: "bg-amber-400/15 text-amber-700",
  },
  error: {
    label: "common.failed",
    icon: AlertTriangle,
    iconBg: "bg-rose-500/15",
    iconColor: "text-rose-700",
    badge: "bg-rose-400/15 text-rose-700",
  },
  progress: {
    label: "app.aiTone.progress",
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
  /** A button pick, or `null` + text for the card's "other answer" field. */
  onAction: (actionId: string | null, value?: string) => void;
  onDismiss: () => void;
}) {
  const { item, payload, busyAction, error, onAction, onDismiss } = props;
  const meta = AI_TONE_META[payload.tone] ?? AI_TONE_META.info;
  const Icon = meta.icon;
  const dismissBusy = busyAction === "ignore";
  /** Agent question options: one full-width row each, label over description.
   *  Older payloads have no flag, so a hint alone also means "list". A single
   *  action never stacks, unless the card also takes a typed answer below. */
  const stacked =
    payload.actions.length > 1
      ? (payload.stackActions ??
        payload.actions.some((action) => action.description))
      : Boolean(payload.allowCustom);

  return (
    <article className="island-expand relative flex min-h-0 flex-1 flex-col rounded-2xl bg-island p-3 border border-island-line">
      <button
        type="button"
        aria-label={t("common.close")}
        title={t("common.close")}
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
        <ScrollingName
          text={payload.client || item.workspaceName || "AI"}
          className="min-w-0 font-normal text-island-ink"
        />
        <span className={clsx("shrink-0 rounded px-1.5 py-0.5 text-ui-2xs font-normal", meta.badge)}>
          {t(meta.label)}
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

      <div
        className={clsx(
          "mt-auto flex pt-2",
          stacked ? "min-h-0 flex-1 flex-col gap-1" : "items-center gap-1.5",
        )}
      >
        {payload.actions.length === 0 ? (
          <button
            type="button"
            disabled={Boolean(busyAction)}
            onClick={onDismiss}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-island-soft px-2.5 py-1.5 text-ui-sm font-normal text-island-ink border border-island-line transition hover:bg-island-soft-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {dismissBusy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {t("common.gotIt")}
          </button>
        ) : stacked ? (
          payload.actions.map((action) => (
            <AiOptionRow
              key={action.id}
              action={action}
              busy={busyAction === `ai:${action.id}`}
              disabled={Boolean(busyAction)}
              onClick={() => onAction(action.id)}
            />
          ))
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
        {payload.allowCustom ? (
          <CustomAnswer
            busy={busyAction === "ai:custom"}
            disabled={Boolean(busyAction)}
            onSubmit={(text) => onAction(null, text)}
          />
        ) : null}
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
      {busy ? <Loader2 size={12} className="shrink-0 animate-spin" /> : null}
      {/* Centred while it fits, scrolls in place when it does not. */}
      <ScrollingName text={action.label} className="flex-1 text-center" />
    </button>
  );
}

/**
 * Agent question option: a full-width row with the label over its description,
 * both kept to one line. Too-long text scrolls on hover at a constant pace
 * (same as a bug title) instead of wrapping the button into a second line.
 */
function AiOptionRow(props: {
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
        "flex min-h-0 flex-1 flex-col justify-center gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-50",
        AI_ACTION_CLASS[action.style ?? "secondary"] ?? AI_ACTION_CLASS.secondary,
      )}
    >
      <span className="flex items-center gap-1 text-ui-sm font-normal">
        {busy ? <Loader2 size={12} className="shrink-0 animate-spin" /> : null}
        <ScrollingName text={action.label} className="flex-1" />
      </span>
      {action.description ? (
        <ScrollingName
          text={action.description}
          className="text-ui-2xs font-normal opacity-80"
        />
      ) : null}
    </button>
  );
}

/**
 * "Other answer" field under a question card's options.
 *
 * The capsule is a non-activating window, so it cannot receive keystrokes on
 * its own: focusing the field asks the Rust side for the keyboard, and sending
 * hands it back to the app the user came from.
 */
function CustomAnswer(props: {
  busy: boolean;
  disabled: boolean;
  onSubmit: (text: string) => void;
}) {
  const { busy, disabled, onSubmit } = props;
  const [text, setText] = useState("");
  /** Set on send so the unmount blur does not release the keyboard twice. */
  const sent = useRef(false);
  const value = text.trim();

  const lend = (active: boolean, restore = false) => {
    void notificationApi.setAnswerFocus(active, restore).catch(() => undefined);
  };

  return (
    <form
      className="flex shrink-0 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value || disabled) return;
        sent.current = true;
        onSubmit(value);
        lend(false, true);
      }}
    >
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onFocus={() => lend(true)}
        onBlur={() => {
          if (sent.current) return;
          lend(false);
        }}
        disabled={disabled}
        maxLength={500}
        aria-label={t("agent.question.custom")}
        placeholder={t("agent.question.custom")}
        spellCheck={false}
        className="min-w-0 flex-1 rounded-lg border border-island-line bg-island-soft px-2 py-1 text-ui-sm text-island-ink transition placeholder:text-island-muted disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={disabled || !value}
        aria-label={t("common.send")}
        title={t("common.send")}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-island-muted transition hover:bg-island-soft-hover hover:text-island-ink disabled:opacity-40"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
      </button>
    </form>
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
                className="line-clamp-2 whitespace-pre-wrap wrap-break-word text-ui-sm leading-4 text-island-muted"
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
                    <ScrollingName
                      text={field.value || "—"}
                      className="min-w-0 text-right text-island-ink"
                    />
                  </div>
                ))}
              </div>
            );
          case "progress": {
            const percent = block.percent ?? 30;
            return (
              <div key={index} className="space-y-1">
                <div className="flex items-center justify-between text-ui-xs text-island-muted">
                  <span className="truncate">{block.label ?? t("app.island.progress")}</span>
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
      <div className="island-expand flex h-full w-full items-center gap-3 rounded-[22px] bg-island px-6 text-island-ink border border-island-line">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-rose-500/15 text-rose-700">
          <AlertTriangle size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ui-sm font-normal">{t("app.update.failed")}</p>
          <p
            className="mt-0.5 truncate text-ui-xs text-island-muted"
            title={state?.error ?? undefined}
          >
            {state?.error ?? t("app.update.failedDetail")}
          </p>
        </div>
        <button
          type="button"
          onClick={manual}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-island-soft px-3 py-1.5 text-ui-xs font-normal text-island-ink border border-island-line transition hover:bg-island-soft-hover"
        >
          <Download size={12} />
          {t("app.update.manual")}
        </button>
        <button
          type="button"
          disabled={cancelling}
          onClick={() => void cancel()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-island-soft px-3 py-1.5 text-ui-xs font-normal text-island-muted border border-island-line transition hover:bg-island-soft-hover disabled:opacity-50"
        >
          {cancelling ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
          {t("common.cancel")}
        </button>
      </div>
    );
  }

  const title =
    phase === "installing"
      ? t("app.update.unpacking")
      : phase === "ready"
        ? t("app.update.done")
        : t("app.update.downloading");
  const right =
    phase === "downloading" && percent != null
      ? `${percent.toFixed(0)}%`
      : phase === "installing"
        ? t("app.update.installing")
        : t("common.done");
  const detail =
    phase === "downloading"
      ? progress?.total
        ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
        : formatBytes(progress?.received)
      : phase === "ready"
        ? t("app.update.restartSoon")
        : t("app.update.verifying");

  return (
    <div className="island-expand flex h-full w-full flex-col justify-center gap-2 rounded-[22px] bg-island px-6 py-3 text-island-ink border border-island-line">
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
        <span>{t("app.update.mainWindowLocked")}</span>
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
      {t(NOTIFICATION_KIND_LABELS[kind])}
    </span>
  );
}
