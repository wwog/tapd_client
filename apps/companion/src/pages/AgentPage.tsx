import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Plus,
  RefreshCw,
  Wrench,
} from "lucide-react";

import { asApiError } from "../lib/api";
import {
  dshApi,
  type DshEntry,
  type DshPendingRequest,
  type DshSession,
  type DshStatus,
  type DshToolStatus,
} from "../lib/dsh";
import { absoluteTime, relativeTime } from "../lib/format";
import { t, type MessageKey } from "../lib/i18n";
import { navigate } from "../lib/router";
import { isPageHidden, onPageVisibilityChange } from "../lib/visibility";

const LIST_POLL_MS = 8_000;
const SESSION_POLL_MS = 3_000;
/** Session title/status change rarely; refresh them every third poll. */
const META_EVERY = 3;
/** Soft cap on the composer's growth before it scrolls internally. */
const COMPOSER_MAX_HEIGHT = 120;

const PHASE_LABELS: Record<DshStatus["phase"], MessageKey> = {
  stopped: "mobile.agent.phaseStopped",
  starting: "mobile.agent.phaseStarting",
  ready: "mobile.agent.phaseReady",
  failed: "mobile.agent.phaseFailed",
};

const PHASE_DOTS: Record<DshStatus["phase"], string> = {
  stopped: "bg-slate-400",
  starting: "bg-amber-500",
  ready: "bg-emerald-500",
  failed: "bg-rose-500",
};

const SESSION_LABELS: Record<DshSession["status"], MessageKey> = {
  idle: "mobile.agent.sessionIdle",
  running: "mobile.agent.sessionRunning",
  failed: "common.failed",
};

const SESSION_DOTS: Record<DshSession["status"], string> = {
  idle: "bg-slate-300",
  running: "bg-sky-500",
  failed: "bg-rose-500",
};

const TOOL_LABELS: Record<DshToolStatus, MessageKey> = {
  running: "mobile.agent.toolRunning",
  ok: "common.done",
  error: "common.failed",
};

function ListSkeleton() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="border-b border-border px-4 py-3">
          <div className="h-4 w-2/3 animate-pulse rounded bg-overlay-soft" />
        </div>
      ))}
    </div>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="space-y-3 px-4 py-3" aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="rounded-lg border border-border px-3 py-2">
          <div className="h-3 w-2/3 animate-pulse rounded bg-overlay-soft" />
          <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-overlay-soft" />
        </div>
      ))}
    </div>
  );
}

function UserRow(props: { entry: Extract<DshEntry, { kind: "user" }> }) {
  return (
    <div className="flex justify-end">
      <p
        className="max-w-[85%] select-text break-words whitespace-pre-wrap rounded-2xl border border-border bg-surface px-3 py-2 text-ui-caption leading-5 text-slate-900"
        title={absoluteTime(props.entry.at)}
      >
        {props.entry.text}
      </p>
    </div>
  );
}

function AssistantRow(props: { entry: Extract<DshEntry, { kind: "assistant" }> }) {
  const entry = props.entry;
  const [open, setOpen] = useState(false);
  if (!entry.text && !entry.reasoning) return null;
  return (
    <div className="select-text" title={absoluteTime(entry.at)}>
      {entry.reasoning ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex items-center gap-0.5 text-ui-2xs text-slate-400 transition active:text-slate-600"
        >
          <ChevronRight size={12} className={`transition ${open ? "rotate-90" : ""}`} />
          {t("mobile.agent.reasoning")}
        </button>
      ) : null}
      {open && entry.reasoning ? (
        <p className="mt-1 rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-xs leading-5 break-words whitespace-pre-wrap text-slate-500">
          {entry.reasoning}
        </p>
      ) : null}
      {entry.text ? (
        <p className="mt-1 text-ui-caption leading-5 break-words whitespace-pre-wrap text-slate-900">
          {entry.text}
        </p>
      ) : null}
    </div>
  );
}

function ToolRow(props: { entry: Extract<DshEntry, { kind: "tool" }> }) {
  const entry = props.entry;
  const [open, setOpen] = useState(false);
  const failed = entry.status === "error";
  return (
    <div
      className={`rounded-lg border ${failed ? "border-rose-200 bg-rose-50" : "border-border bg-surface"}`}
      title={absoluteTime(entry.at)}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition active:bg-overlay-soft"
      >
        {entry.status === "running" ? (
          <LoaderCircle size={12} className="shrink-0 animate-spin text-sky-500" />
        ) : (
          <Wrench
            size={12}
            className={`shrink-0 ${failed ? "text-rose-500" : "text-slate-400"}`}
          />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-slate-600">
          {entry.name}
        </span>
        <span
          className={`shrink-0 text-ui-2xs ${
            failed
              ? "text-rose-700"
              : entry.status === "running"
                ? "text-sky-600"
                : "text-slate-400"
          }`}
        >
          {t(TOOL_LABELS[entry.status])}
        </span>
        <ChevronDown
          size={12}
          className={`shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className={`border-t px-3 py-2 ${failed ? "border-rose-200" : "border-border"}`}>
          {entry.args ? (
            <>
              <p className="text-ui-2xs text-slate-400">{t("mobile.agent.toolArgs")}</p>
              <pre
                className={`mt-1 overflow-x-auto font-mono text-ui-2xs break-all whitespace-pre-wrap select-text ${
                  failed ? "text-rose-700" : "text-slate-600"
                }`}
              >
                {entry.args}
              </pre>
            </>
          ) : null}
          {entry.result ? (
            <>
              <p className="mt-2 text-ui-2xs text-slate-400">{t("mobile.agent.toolResult")}</p>
              <pre
                className={`mt-1 overflow-x-auto font-mono text-ui-2xs break-all whitespace-pre-wrap select-text ${
                  failed ? "text-rose-700" : "text-slate-600"
                }`}
              >
                {entry.result}
              </pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TurnRow(props: { entry: Extract<DshEntry, { kind: "turn" }> }) {
  if (props.entry.state === "start") return <div className="border-t border-border" aria-hidden="true" />;
  return (
    <div className="flex items-center gap-2" title={absoluteTime(props.entry.at)}>
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0 text-ui-2xs text-slate-400">
        {props.entry.reason || t("mobile.agent.turnEnded")}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function EntryRow(props: { entry: DshEntry }) {
  const entry = props.entry;
  switch (entry.kind) {
    case "user":
      return <UserRow entry={entry} />;
    case "assistant":
      return <AssistantRow entry={entry} />;
    case "tool":
      return <ToolRow entry={entry} />;
    case "turn":
      return <TurnRow entry={entry} />;
  }
}

/**
 * Agent tab: the built-in dsh runtime on the desktop. The phone starts a
 * session (or opens an existing one) and renders its transcript; approvals and
 * questions still belong to the desktop.
 */
export function AgentPage() {
  const [status, setStatus] = useState<DshStatus | null>(null);
  const [statusError, setStatusError] = useState<{
    message: string;
    title: MessageKey;
  } | null>(null);
  const [sessions, setSessions] = useState<DshSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const [statusResult, sessionsResult] = await Promise.allSettled([
      dshApi.status(),
      dshApi.sessions(),
    ]);
    if (!alive.current) return;
    if (statusResult.status === "fulfilled") {
      setStatus(statusResult.value);
      setStatusError(null);
    } else {
      setStatusError({
        message: asApiError(statusResult.reason).message,
        title: "mobile.agent.statusLoadFailed",
      });
    }
    if (sessionsResult.status === "fulfilled") {
      setSessions(sessionsResult.value.sessions);
      setSessionsError(null);
    } else {
      setSessionsError(asApiError(sessionsResult.reason).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!isPageHidden()) void refresh();
    }, LIST_POLL_MS);
    const off = onPageVisibilityChange(() => {
      if (!isPageHidden()) void refresh();
    });
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [refresh]);

  /** Failed runtime: extract the payload and start it again. */
  const startRuntime = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const next = await dshApi.start();
      if (alive.current) {
        setStatus(next);
        setStatusError(null);
      }
    } catch (err) {
      if (alive.current) {
        setStatusError({
          message: asApiError(err).message,
          title: "mobile.agent.startFailed",
        });
      }
    } finally {
      if (alive.current) setStarting(false);
    }
  };

  const createSession = async () => {
    if (creating) return;
    setCreating(true);
    setActionError(null);
    try {
      const { sessionId } = await dshApi.newSession();
      navigate(`#/agent/session/${encodeURIComponent(sessionId)}`);
    } catch (err) {
      if (alive.current) setActionError(asApiError(err).message);
    } finally {
      if (alive.current) setCreating(false);
    }
  };

  const runtimeLabel =
    status?.phase === "ready"
      ? [status.provider, status.model]
          .filter((value): value is string => Boolean(value))
          .join(" · ")
      : "";
  const failure = status?.phase === "failed" ? (status.error ?? status.errorCode) : null;

  return (
    <div>
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-canvas px-4 py-2">
        <h1 className="min-w-0 flex-1 text-ui-base text-slate-900">{t("mobile.tab.agent")}</h1>
        <button
          type="button"
          disabled={creating}
          onClick={() => void createSession()}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-50"
        >
          {creating ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}
          {creating ? t("mobile.agent.creating") : t("mobile.agent.newSession")}
        </button>
      </header>

      <section className="border-b border-border px-4 py-3">
        {status ? (
          <p className="flex items-center gap-2 text-ui-caption text-slate-900">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${PHASE_DOTS[status.phase]} ${
                status.phase === "starting" ? "animate-pulse" : ""
              }`}
            />
            <span className="shrink-0">{t(PHASE_LABELS[status.phase])}</span>
            {runtimeLabel ? (
              <span className="min-w-0 truncate font-mono text-ui-xs text-slate-400" title={runtimeLabel}>
                {runtimeLabel}
              </span>
            ) : null}
            {status.phase === "failed" ? (
              <button
                type="button"
                disabled={starting}
                onClick={() => void startRuntime()}
                className="ml-auto inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
              >
                {starting ? (
                  <LoaderCircle size={12} className="animate-spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
                {t("common.retry")}
              </button>
            ) : null}
          </p>
        ) : statusError ? null : (
          <p className="text-ui-caption text-slate-400">{t("common.reading")}</p>
        )}
        {failure ? (
          <p className="mt-1 text-ui-sm leading-5 text-rose-600" title={status?.errorCode}>
            {failure}
          </p>
        ) : null}
        {statusError ? (
          <p className="mt-1 text-ui-caption leading-5 text-rose-600" title={t(statusError.title)}>
            {statusError.message}
          </p>
        ) : null}
      </section>

      {actionError ? (
        <p
          className="px-4 py-3 text-ui-caption text-rose-600"
          title={t("mobile.agent.newSessionFailed")}
        >
          {actionError}
        </p>
      ) : null}

      {sessionsError ? (
        <p
          className="px-4 py-3 text-ui-caption text-rose-600"
          title={t("mobile.agent.loadFailed")}
        >
          {sessionsError}
        </p>
      ) : null}

      {sessions === null && !sessionsError ? <ListSkeleton /> : null}

      {sessions && sessions.length === 0 && !sessionsError ? (
        <p
          className="px-4 py-10 text-center text-ui-base text-slate-400"
          title={t("mobile.agent.emptyHint")}
        >
          {t("mobile.agent.empty")}
        </p>
      ) : null}

      {sessions?.map((session) => (
        <button
          key={session.id}
          type="button"
          onClick={() => navigate(`#/agent/session/${encodeURIComponent(session.id)}`)}
          className="flex min-h-11 w-full items-center gap-2 border-b border-border px-4 py-3 text-left transition active:bg-overlay-soft"
        >
          <span
            title={t(SESSION_LABELS[session.status])}
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${SESSION_DOTS[session.status]}`}
          />
          <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-900">
            {session.title || t("mobile.agent.untitledSession")}
          </span>
          <span className="shrink-0 text-ui-xs text-slate-400">
            {relativeTime(session.updatedAt)}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * One dsh session: header (title + status), polled transcript, composer.
 * The phone cannot answer approvals/questions, so a blocked request shows
 * one quiet pointer to the desktop instead of dead buttons.
 */
export function AgentSessionPage(props: { id: string }) {
  const { id } = props;
  const [entries, setEntries] = useState<DshEntry[] | null>(null);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [session, setSession] = useState<DshSession | null>(null);
  /** Requests the runtime is blocked on; only the desktop can answer them. */
  const [pending, setPending] = useState<DshPendingRequest[]>([]);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const alive = useRef(true);
  const entriesInFlight = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadEntries = useCallback(
    async (poll: boolean) => {
      if (entriesInFlight.current) return;
      entriesInFlight.current = true;
      if (poll) setSyncing(true);
      try {
        const result = await dshApi.entries(id);
        if (alive.current) {
          // `known: false` means the desktop restarted before the bridge saw
          // this session; the transcript is simply empty, not a failure.
          setEntries(result.entries);
          setEntriesError(null);
        }
      } catch (err) {
        if (alive.current) setEntriesError(asApiError(err).message);
      } finally {
        entriesInFlight.current = false;
        if (alive.current && poll) setSyncing(false);
      }
    },
    [id],
  );

  const loadSession = useCallback(async () => {
    try {
      const [result, blocking] = await Promise.all([dshApi.sessions(), dshApi.pending()]);
      if (!alive.current) return;
      setSession(result.sessions.find((row) => row.id === id) ?? null);
      setPending(blocking.requests);
      setMetaError(null);
    } catch (err) {
      if (alive.current) setMetaError(asApiError(err).message);
    }
  }, [id]);

  useEffect(() => {
    let ticks = 0;
    const poll = () => {
      if (isPageHidden()) return;
      void loadEntries(true);
      if (ticks++ % META_EVERY === 0) void loadSession();
    };
    void loadEntries(false);
    void loadSession();
    const timer = window.setInterval(poll, SESSION_POLL_MS);
    const off = onPageVisibilityChange(() => {
      if (isPageHidden()) return;
      void loadEntries(true);
      void loadSession();
    });
    return () => {
      window.clearInterval(timer);
      off();
    };
  }, [loadEntries, loadSession]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await dshApi.prompt(id, text);
      if (!alive.current) return;
      setDraft("");
    } catch (err) {
      // The draft is kept so the message can be retried.
      if (alive.current) setSendError(asApiError(err).message);
      return;
    } finally {
      if (alive.current) setSending(false);
    }
    // The prompt is queued; entry polling picks the committed rows up.
    void loadEntries(true);
    void loadSession();
  }, [draft, sending, id, loadEntries, loadSession]);

  // Composer grows with the draft up to a soft cap, then scrolls internally.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  const sorted = useMemo(
    () => (entries ? [...entries].sort((left, right) => left.seq - right.seq) : null),
    [entries],
  );

  // Follow new rows only when the reader was already at the bottom.
  useEffect(() => {
    if (!sorted || sorted.length === 0) return;
    const element = bottomRef.current;
    if (!element) return;
    const latest = sorted[sorted.length - 1].seq;
    const firstLoad = lastSeq.current === 0;
    const nearBottom = element.getBoundingClientRect().top <= window.innerHeight + 64;
    if (firstLoad || (latest > lastSeq.current && nearBottom)) {
      element.scrollIntoView({ block: "end" });
    }
    lastSeq.current = latest;
  }, [sorted]);

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Desktop keyboards send on Enter; the send button covers phones.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  // Only a request the runtime itself reports as blocking counts; a tool row
  // still `running` is not proof the agent is waiting for a human.
  const awaitingInteraction = pending.some((item) => item.sessionId === id);
  const title = session?.title || t("mobile.agent.untitledSession");

  return (
    <div>
      <header className="sticky top-0 z-20 flex items-center gap-1.5 border-b border-border bg-canvas px-2 py-2">
        <button
          type="button"
          aria-label={t("mobile.nav.back")}
          onClick={() => navigate("#/agent")}
          className="shrink-0 rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-900" title={title}>
          {title}
        </span>
        {session ? (
          <span className="flex shrink-0 items-center gap-1.5 text-ui-xs text-slate-500">
            <span
              className={`h-1.5 w-1.5 rounded-full ${SESSION_DOTS[session.status]}`}
              title={t(SESSION_LABELS[session.status])}
            />
            {t(SESSION_LABELS[session.status])}
          </span>
        ) : null}
      </header>

      {/* Fixed-height line so the poll indicator never shifts the transcript. */}
      <div className="h-5 px-4 text-ui-2xs leading-5 text-slate-400">
        {syncing ? t("mobile.agent.syncing") : ""}
      </div>

      {metaError ? (
        <p className="px-4 pb-1 text-ui-xs text-rose-600" title={t("mobile.agent.loadFailed")}>
          {metaError}
        </p>
      ) : null}

      {entriesError ? (
        <p
          className="px-4 py-2 text-ui-xs text-rose-600"
          title={t("mobile.agent.entriesLoadFailed")}
        >
          {entriesError}
        </p>
      ) : null}

      {entries === null && !entriesError ? <TranscriptSkeleton /> : null}

      {sorted && sorted.length === 0 ? (
        <div className="grid place-items-center px-6 py-16 text-center">
          <p className="text-ui-base text-slate-400" title={t("mobile.agent.emptyTranscriptHint")}>
            {t("mobile.agent.emptyTranscript")}
          </p>
        </div>
      ) : null}

      {sorted && sorted.length > 0 ? (
        <div className="space-y-3 px-4 py-3">
          {sorted.map((entry) => (
            <EntryRow key={entry.seq} entry={entry} />
          ))}
        </div>
      ) : null}

      {awaitingInteraction ? (
        <div
          className="mx-4 mt-3 rounded-lg border border-border bg-surface px-3 py-2"
          title={t("mobile.agent.approvalHint")}
        >
          <p className="text-ui-xs leading-5 text-slate-500">{t("mobile.agent.approvalTitle")}</p>
        </div>
      ) : null}

      <div className="sticky bottom-14 z-20 border-t border-border bg-canvas px-3 py-2">
        {sendError ? (
          <p className="mb-1 text-ui-xs leading-5 text-rose-600" title={t("mobile.agent.promptFailed")}>
            {sendError}
          </p>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={t("mobile.agent.composerPlaceholder")}
            title={t("mobile.agent.composerHint")}
            className="max-h-30 min-h-11 min-w-0 flex-1 resize-none rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-caption leading-5 text-slate-700 transition placeholder:text-slate-400 focus:border-sky-300 focus:outline-2 focus:outline-sky-200"
          />
          <button
            type="button"
            aria-label={t("common.send")}
            disabled={sending || draft.trim().length === 0}
            onClick={() => void send()}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition active:bg-primary-hover disabled:opacity-40"
          >
            {sending ? (
              <LoaderCircle size={16} className="animate-spin" />
            ) : (
              <ArrowUp size={16} />
            )}
          </button>
        </div>
      </div>

      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
