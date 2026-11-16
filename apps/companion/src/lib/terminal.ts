/**
 * Terminal session transport: the feature commands that list/create/close
 * sessions, the one-shot WebSocket ticket, and the WebSocket that carries the
 * PTY stream.
 *
 * The socket lives outside React on purpose. It owns reconnection, backoff and
 * the page-visibility pause, so an unmount/re-mount of the view never leaves a
 * duplicate connection behind.
 */
import { feature } from "./api";
import { isPageHidden, onPageVisibilityChange } from "./visibility";

export type TerminalMeta = {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  /** Exit code, or null while the process is still running. */
  exited: number | null;
};

export type TerminalStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export type TerminalHandlers = {
  /** Live output (append). */
  onData: (data: string) => void;
  /** Full history: reset the emulator before writing. */
  onReplay: (data: string) => void;
  onExit: (code: number | null) => void;
  /** The desktop no longer knows this session (`error` frame, e.g. `not_found`). */
  onUnavailable: () => void;
  onStatus: (status: TerminalStatus) => void;
};

export type TerminalSocket = {
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  close: () => void;
  status: () => TerminalStatus;
};

export const terminalApi = {
  list: () => feature<{ sessions: TerminalMeta[] }>("terminal_list", {}),
  create: (options: { cols?: number; rows?: number; workspaceId?: string } = {}) =>
    feature<{ session: TerminalMeta }>("terminal_create", options),
  close: (id: string) => feature<null>("terminal_close", { id }),
  /** One-shot WebSocket credential (TTL 60s, single use); never reused. */
  ticket: (id: string) => feature<{ ticket: string }>("terminal_ticket", { id }),
};

const WS_PATH = "/companion/api/terminal/ws";
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 10_000;

const socketUrl = (sessionId: string, ticket: string): string => {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ ticket, id: sessionId });
  return `${scheme}//${window.location.host}${WS_PATH}?${query.toString()}`;
};

/**
 * Connects one terminal session. Each attempt fetches a fresh single-use
 * ticket, then reconnects with exponential backoff (1s → 2s → 4s → … capped at
 * 10s) after an unexpected drop; while the page is hidden it waits instead of
 * retrying, and resumes as soon as it is visible. An `exit`/`error` frame or
 * `close()` ends the loop for good.
 */
export function connect(sessionId: string, handlers: TerminalHandlers): TerminalSocket {
  let currentStatus: TerminalStatus = "connecting";
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  // A ticket request is in flight; it counts as an attempt in progress.
  let opening = false;
  let attempt = 0;
  let ended = false;
  let closed = false;

  const setStatus = (next: TerminalStatus) => {
    if (currentStatus === next) return;
    currentStatus = next;
    handlers.onStatus(next);
  };

  const clearRetry = () => {
    if (retryTimer === null) return;
    window.clearTimeout(retryTimer);
    retryTimer = null;
  };

  const open = async (): Promise<void> => {
    if (closed || ended || opening) return;
    if (socket && socket.readyState !== WebSocket.CLOSED) return;
    opening = true;
    // Tickets are single-use and expire; a retry must always ask for a new one.
    let ticket: string;
    try {
      ({ ticket } = await terminalApi.ticket(sessionId));
    } catch {
      opening = false;
      if (closed || ended) return;
      schedule();
      return;
    }
    opening = false;
    if (closed || ended) return;
    if (socket && socket.readyState !== WebSocket.CLOSED) return;
    let next: WebSocket;
    try {
      next = new WebSocket(socketUrl(sessionId, ticket));
    } catch {
      schedule();
      return;
    }
    socket = next;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");

    next.onopen = () => {
      if (closed || socket !== next) return;
      attempt = 0;
      setStatus("connected");
      // Anything typed while the socket was down still belongs to the shell.
      flushInput();
    };

    next.onmessage = (event) => {
      // Events can still be queued when the view unmounts; never touch the
      // disposed emulator afterwards.
      if (closed) return;
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      const { type, data, code } = message as {
        type?: unknown;
        data?: unknown;
        code?: unknown;
      };
      if (type === "replay" && typeof data === "string") {
        handlers.onReplay(data);
        return;
      }
      if (type === "data" && typeof data === "string") {
        handlers.onData(data);
        return;
      }
      if (type === "exit") {
        ended = true;
        clearRetry();
        setStatus("disconnected");
        handlers.onExit(typeof code === "number" ? code : null);
        return;
      }
      // The desktop reports an unknown session after the upgrade (a browser
      // socket cannot read a 404 handshake), so stop retrying: reconnecting
      // would only hammer a session that is gone.
      if (type === "error") {
        ended = true;
        clearRetry();
        setStatus("disconnected");
        handlers.onUnavailable();
      }
    };

    // Browsers fire `error` right before `close`; reconnection is handled by
    // `close` alone so a failed upgrade retries exactly once per attempt.
    next.onclose = () => {
      if (socket === next) socket = null;
      if (closed) return;
      if (ended) {
        setStatus("disconnected");
        return;
      }
      schedule();
    };
  };

  const schedule = () => {
    if (closed || ended) return;
    if (isPageHidden()) {
      // Mobile browsers freeze the page; retrying in the background only
      // burns attempts. The visibility listener reconnects on return.
      setStatus("reconnecting");
      return;
    }
    clearRetry();
    const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
    attempt += 1;
    setStatus("reconnecting");
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void open();
    }, delay);
  };

  const offVisibility = onPageVisibilityChange(() => {
    if (closed || ended) return;
    if (isPageHidden()) {
      // Ship what was typed before the page freezes; a frozen tab cannot send.
      flushInput();
      clearRetry();
      return;
    }
    if (!socket && retryTimer === null && !opening) void open();
  });

  void open();

  // A socket can enter CLOSING between the readyState check and `send`;
  // dropping that frame is better than throwing out of a key handler.
  const send = (payload: Record<string, unknown>) => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // The close handler reconnects.
    }
  };

  /**
   * xterm reports one frame per keystroke. Coalescing a burst saves socket
   * messages, but an idle debounce starves continuous typing: every key resets
   * the timer, so nothing is sent until the typist stops. The timer therefore
   * starts at the first pending byte and is never pushed back — latency is
   * bounded by `INPUT_MAX_WAIT_MS` while a burst still goes out as one write.
   * Keys that change the shell's mode (Enter, Tab, Ctrl, escape sequences)
   * must land immediately.
   */
  const INPUT_MAX_WAIT_MS = 30;
  const INPUT_MAX_CHARS = 1024;
  let pendingInput = "";
  let inputTimer: number | null = null;

  function flushInput(): void {
    if (inputTimer !== null) {
      window.clearTimeout(inputTimer);
      inputTimer = null;
    }
    if (!pendingInput) return;
    const data = pendingInput;
    pendingInput = "";
    send({ type: "input", data });
  }

  function queueInput(data: string): void {
    pendingInput += data;
    const immediate =
      data.startsWith("\x1b") ||
      (data.length === 1 && data.charCodeAt(0) < 0x20) ||
      data.includes("\r") ||
      data.includes("\n") ||
      pendingInput.length >= INPUT_MAX_CHARS;
    if (immediate) {
      flushInput();
      return;
    }
    // The first pending byte starts the clock; later keys join the same frame.
    if (inputTimer === null) {
      inputTimer = window.setTimeout(flushInput, INPUT_MAX_WAIT_MS);
    }
  }

  return {
    sendInput: queueInput,
    sendResize: (cols, rows) => send({ type: "resize", cols, rows }),
    close: () => {
      if (closed) return;
      closed = true;
      // The view is going away; whatever was typed must still reach the shell.
      flushInput();
      clearRetry();
      offVisibility();
      if (socket) {
        socket.close();
        socket = null;
      }
      currentStatus = "disconnected";
    },
    status: () => currentStatus,
  };
}

/**
 * Locally edited command lines kept across sessions of the same tab. The line
 * composer answers ↑/↓ from this list instead of the shell, so recalling a
 * command costs no round trip.
 */
export const COMMAND_HISTORY_LIMIT = 50;
const COMMAND_HISTORY_KEY = "companion.terminal.history";

/** Oldest first; malformed entries are dropped rather than trusted. */
export function readCommandHistory(): string[] {
  try {
    const raw = sessionStorage.getItem(COMMAND_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .slice(-COMMAND_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Pure append: blank lines and an immediate repeat of the newest entry are not
 * recorded (the same array instance comes back so callers can skip the write).
 */
export function appendCommand(history: string[], command: string): string[] {
  if (!command.trim()) return history;
  if (history[history.length - 1] === command) return history;
  return [...history, command].slice(-COMMAND_HISTORY_LIMIT);
}

export function writeCommandHistory(history: readonly string[]): void {
  try {
    sessionStorage.setItem(COMMAND_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Storage full or unavailable: history is a convenience, not state.
  }
}
