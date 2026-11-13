import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowUp, ChevronLeft, Eye, EyeOff, Keyboard as KeyboardIcon } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { t, type MessageKey } from "../lib/i18n";
import { usePrefs } from "../lib/prefs";
import { navigate } from "../lib/router";
import {
  appendCommand,
  connect,
  readCommandHistory,
  terminalApi,
  writeCommandHistory,
  type TerminalSocket,
  type TerminalStatus,
} from "../lib/terminal";
import { TerminalKeyBar } from "../components/TerminalKeyBar";

const STATUS_LABELS: Record<TerminalStatus, MessageKey> = {
  connecting: "mobile.terminal.connecting",
  connected: "mobile.terminal.connected",
  reconnecting: "mobile.terminal.reconnecting",
  disconnected: "mobile.terminal.disconnected",
};

const STATUS_DOTS: Record<TerminalStatus, string> = {
  connecting: "bg-amber-500",
  connected: "bg-emerald-500",
  reconnecting: "bg-amber-500",
  disconnected: "bg-slate-400",
};

const DARK_THEME: ITheme = {
  background: "#17191e",
  foreground: "#e4e4e7",
  cursor: "#38bdf8",
  cursorAccent: "#17191e",
  selectionBackground: "#3f3f46",
  black: "#18181b",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

const LIGHT_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#18181b",
  cursor: "#0ea5e9",
  cursorAccent: "#ffffff",
  selectionBackground: "#bae6fd",
  black: "#18181b",
  red: "#b91c1c",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#1d4ed8",
  magenta: "#7e22ce",
  cyan: "#0e7490",
  white: "#e4e4e7",
  brightBlack: "#71717a",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#ca8a04",
  brightBlue: "#2563eb",
  brightMagenta: "#9333ea",
  brightCyan: "#0891b2",
  brightWhite: "#fafafa",
};

/** The app theme is published on the root element by `initPrefs`. */
const readTheme = (): ITheme =>
  document.documentElement.dataset.theme === "dark" ? DARK_THEME : LIGHT_THEME;

const RESIZE_DEBOUNCE_MS = 120;

/** Mode and draft survive a reload but not the tab (per-device, per-session). */
const MODE_STORAGE_KEY = "companion.terminal.mode";
const DRAFT_STORAGE_PREFIX = "companion.terminal.draft.";
const DRAFT_SAVE_DEBOUNCE_MS = 200;

/** A visual viewport this much shorter than the layout viewport means keyboard. */
const KEYBOARD_MIN_INSET_PX = 80;

function readLineMode(): boolean {
  try {
    return sessionStorage.getItem(MODE_STORAGE_KEY) !== "direct";
  } catch {
    return true;
  }
}

function saveLineMode(lineMode: boolean): void {
  try {
    sessionStorage.setItem(MODE_STORAGE_KEY, lineMode ? "line" : "direct");
  } catch {
    // Storage unavailable: the mode still works for this visit.
  }
}

function readDraft(sessionId: string): string {
  try {
    return sessionStorage.getItem(DRAFT_STORAGE_PREFIX + sessionId) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(sessionId: string, draft: string): void {
  try {
    if (draft) sessionStorage.setItem(DRAFT_STORAGE_PREFIX + sessionId, draft);
    else sessionStorage.removeItem(DRAFT_STORAGE_PREFIX + sessionId);
  } catch {
    // Storage full or unavailable: the draft keeps working in memory.
  }
}

/**
 * Interactive xterm session. The emulator owns rendering and input; the
 * transport owns reconnection, so this page only maps xterm callbacks onto the
 * socket and refits on layout changes.
 */
export function TerminalSessionPage(props: { id: string }) {
  const { id } = props;
  const prefs = usePrefs();
  const [title, setTitle] = useState<string | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  // undefined = still running, null = exited without a code.
  const [exited, setExited] = useState<number | null | undefined>(undefined);
  /** The desktop forgot this session (closed there, or it restarted). */
  const [sessionEnded, setSessionEnded] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  /**
   * Line mode: the command is edited locally and sent as one frame on Enter.
   * A tunnel round trip is 0.8–2s, so per-key echo can never feel responsive;
   * local editing removes network latency from typing entirely. Direct mode
   * forwards every key for full-screen programs (vim, agent TUIs).
   */
  const [lineMode, setLineMode] = useState(readLineMode);
  const [draft, setDraft] = useState(() => readDraft(id));
  /** Masking is a display toggle for this visit only; never persisted. */
  const [masked, setMasked] = useState(false);
  /** Key row manually expanded while the soft keyboard is up. */
  const [keysOpen, setKeysOpen] = useState(false);
  /**
   * The visible area as iOS reports it. The page is pinned to this box so the
   * keyboard cannot cover the terminal: the visual viewport shrinks (and may
   * pan) while the layout viewport stays full height.
   */
  const [viewportBox, setViewportBox] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<TerminalSocket | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);
  // Read by the persistent onData callback without re-creating the emulator.
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;
  const lineModeRef = useRef(lineMode);
  lineModeRef.current = lineMode;
  // The composer's live text: a keystroke may submit before React re-renders.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [history, setHistory] = useState<string[]>(readCommandHistory);
  // null = editing a fresh line; otherwise the index into `history`.
  const historyIndexRef = useRef<number | null>(null);
  // What the user had typed when they started browsing history.
  const heldDraftRef = useRef("");

  // The session page only knows the id; the list carries the title.
  useEffect(() => {
    let cancelled = false;
    void terminalApi
      .list()
      .then(({ sessions }) => {
        if (cancelled) return;
        const found = sessions.find((session) => session.id === id);
        if (!found) return;
        setTitle(found.title || found.cwd);
        if (found.exited !== null) setExited(found.exited);
      })
      .catch(() => {
        // Title stays generic; connectivity is reported by the socket status.
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      lineHeight: 1.1,
      scrollback: 5000,
      cursorBlink: true,
      theme: readTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    const applyFit = () => {
      try {
        fit.fit();
      } catch {
        // Host not laid out yet (hidden / zero width); the next resize retries.
        return;
      }
      socketRef.current?.sendResize(term.cols, term.rows);
    };
    try {
      fit.fit();
    } catch {
      // Deferred to the resize observer.
    }

    let resizeTimer: number | null = null;
    const scheduleFit = () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        applyFit();
      }, RESIZE_DEBOUNCE_MS);
    };

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    // The soft keyboard shrinks the visual viewport without resizing the host.
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", scheduleFit);

    const inputSub = term.onData((data) => {
      // Sticky Ctrl: the next single character becomes its control code.
      if (ctrlRef.current && data.length === 1) {
        ctrlRef.current = false;
        setCtrl(false);
        socketRef.current?.sendInput(String.fromCharCode(data.charCodeAt(0) & 0x1f));
        return;
      }
      socketRef.current?.sendInput(data);
    });

    const socket = connect(id, {
      onData: (data) => term.write(data),
      onReplay: (data) => {
        term.reset();
        term.write(data);
      },
      onExit: (code) => setExited(code),
      onUnavailable: () => setSessionEnded(true),
      onStatus: (next) => {
        setStatus(next);
        if (next === "connected") applyFit();
      },
    });
    socketRef.current = socket;

    return () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      observer.disconnect();
      viewport?.removeEventListener("resize", scheduleFit);
      inputSub.dispose();
      socket.close();
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [id]);

  // Theme changes arrive through prefs; the root element is the source.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = readTheme();
  }, [prefs]);

  // In line mode the composer owns typing; xterm must not swallow keystrokes
  // through its hidden textarea.
  useEffect(() => {
    if (termRef.current) termRef.current.options.disableStdin = lineMode;
  }, [lineMode]);

  // The iOS keyboard shrinks (and may pan) the visual viewport, not the layout
  // viewport. Following it keeps the header, terminal, composer and key bar
  // inside the area that is actually visible above the keyboard.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const apply = () =>
      setViewportBox({
        top: viewport.offsetTop,
        left: viewport.offsetLeft,
        width: viewport.width,
        height: viewport.height,
      });
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
    };
  }, []);

  const keyboardOpen =
    viewportBox !== null && viewportBox.height < window.innerHeight - KEYBOARD_MIN_INSET_PX;

  // A half-typed command survives leaving the page or a reload. Writes are
  // debounced; submitting or clearing the line removes the entry.
  useEffect(() => {
    const timer = window.setTimeout(() => saveDraft(id, draft), DRAFT_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [id, draft]);

  // The debounce may still be pending when the page unmounts.
  useEffect(() => () => saveDraft(id, draftRef.current), [id]);

  // The keyboard covers the key row: start collapsed each time it rises.
  useEffect(() => {
    if (!keyboardOpen) setKeysOpen(false);
  }, [keyboardOpen]);

  const sendInput = (data: string) => socketRef.current?.sendInput(data);

  /** Hands the locally edited line to the shell without executing it. */
  const flushDraft = () => {
    const data = draftRef.current;
    if (!data) return;
    draftRef.current = "";
    setDraft("");
    historyIndexRef.current = null;
    heldDraftRef.current = "";
    sendInput(data);
  };

  /** Sends the draft (if any) followed by a key sequence, in order. */
  const sendKey = (data: string) => {
    if (lineModeRef.current) flushDraft();
    setCtrl(false);
    sendInput(data);
  };

  /** Writes the line and parks the caret at its end (history recall). */
  const setComposerLine = (value: string) => {
    draftRef.current = value;
    setDraft(value);
    window.requestAnimationFrame(() => {
      const input = composerRef.current;
      input?.setSelectionRange(value.length, value.length);
    });
  };

  /**
   * ↑/↓ walk the local command history (oldest last). The first ↑ stashes what
   * was typed, and ↓ past the newest entry restores it.
   */
  const recallHistory = (direction: -1 | 1) => {
    if (direction === -1) {
      if (history.length === 0) return;
      let index = historyIndexRef.current;
      if (index === null) {
        heldDraftRef.current = draftRef.current;
        index = history.length - 1;
      } else if (index > 0) {
        index -= 1;
      } else {
        return;
      }
      historyIndexRef.current = index;
      setComposerLine(history[index]);
      return;
    }
    const index = historyIndexRef.current;
    if (index === null) return;
    if (index < history.length - 1) {
      historyIndexRef.current = index + 1;
      setComposerLine(history[index + 1]);
      return;
    }
    historyIndexRef.current = null;
    setComposerLine(heldDraftRef.current);
  };

  /** Key-row ←/→: move the composer caret by one character. */
  const moveCaret = (direction: -1 | 1) => {
    const input = composerRef.current;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const next = Math.min(
      input.value.length,
      Math.max(0, direction === -1 ? start - 1 : end + 1),
    );
    input.focus();
    input.setSelectionRange(next, next);
  };

  /** Enter: the whole line and the newline go out as one write. */
  const submitDraft = () => {
    const data = draftRef.current;
    draftRef.current = "";
    setDraft("");
    saveDraft(id, "");
    historyIndexRef.current = null;
    heldDraftRef.current = "";
    const next = appendCommand(history, data);
    if (next !== history) {
      setHistory(next);
      writeCommandHistory(next);
    }
    sendInput(`${data}\r`);
  };

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // An IME candidate confirmation is not a submit.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      submitDraft();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      sendKey("\t");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      sendKey("\x1b");
      return;
    }
    // ↑/↓ browse the local history; ←/→ fall through so the input moves its
    // caret natively.
    if (event.key === "ArrowUp") {
      event.preventDefault();
      recallHistory(-1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      recallHistory(1);
      return;
    }
    if (ctrl && event.key.length === 1) {
      event.preventDefault();
      setCtrl(false);
      flushDraft();
      sendInput(String.fromCharCode(event.key.toUpperCase().charCodeAt(0) & 0x1f));
    }
  };

  return (
    <div
      className="fixed z-20 flex min-h-0 flex-col overflow-hidden bg-canvas"
      style={{
        top: viewportBox?.top ?? 0,
        left: viewportBox?.left ?? 0,
        width: viewportBox?.width ?? "100vw",
        height: viewportBox?.height ?? "100dvh",
        // A fixed page escapes #root's safe-area padding; the key bar needs its
        // own clearance so it does not sit on the home indicator.
        paddingTop: "env(safe-area-inset-top)",
        paddingRight: "env(safe-area-inset-right)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
      }}
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-border bg-canvas px-2 py-2">
        <button
          type="button"
          aria-label={t("mobile.nav.back")}
          onClick={() => navigate("#/terminal")}
          className="rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-700">
          {title ?? t("mobile.terminal.title")}
        </span>
        <button
          type="button"
          title={t("mobile.terminal.modeHint")}
          aria-pressed={lineMode}
          onClick={() => {
            const next = !lineMode;
            setLineMode(next);
            saveLineMode(next);
            if (next) composerRef.current?.focus();
            else termRef.current?.focus();
          }}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-ui-2xs text-slate-600 transition active:bg-overlay-soft"
        >
          {t(lineMode ? "mobile.terminal.lineMode" : "mobile.terminal.directMode")}
        </button>
        {keyboardOpen && !sessionEnded ? (
          <button
            type="button"
            aria-label={t(keysOpen ? "mobile.terminal.keysCollapse" : "mobile.terminal.keysExpand")}
            title={t(keysOpen ? "mobile.terminal.keysCollapse" : "mobile.terminal.keysExpand")}
            aria-expanded={keysOpen}
            // Keep the composer focused: taking focus would dismiss the keyboard.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setKeysOpen((value) => !value)}
            className="shrink-0 rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
          >
            <KeyboardIcon size={16} />
          </button>
        ) : null}
        <span className="flex shrink-0 items-center gap-1.5 pr-1 text-ui-xs text-slate-500">
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOTS[status]}`} />
          {t(STATUS_LABELS[status])}
        </span>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-surface">
        <div
          ref={hostRef}
          className="h-full w-full"
          onClickCapture={(event) => {
            if (!lineMode) return;
            // Typing belongs to the composer in line mode; stop xterm's hidden
            // textarea from taking focus and eating the keystrokes.
            event.preventDefault();
            event.stopPropagation();
            composerRef.current?.focus();
          }}
        />

        {sessionEnded ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas px-6 text-center">
            <p className="text-ui-base text-slate-700">{t("mobile.terminal.sessionEnded")}</p>
            <p className="text-ui-sm text-slate-500">{t("mobile.terminal.sessionEndedHint")}</p>
            <button
              type="button"
              onClick={() => navigate("#/terminal")}
              className="mt-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
            >
              {t("mobile.terminal.backToList")}
            </button>
          </div>
        ) : exited !== undefined ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
            <p className="text-ui-base text-slate-500">{t("mobile.terminal.exited")}</p>
            <button
              type="button"
              onClick={() => navigate("#/terminal")}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
            >
              {t("mobile.nav.back")}
            </button>
          </div>
        ) : null}
      </div>

      {lineMode && exited === undefined && !sessionEnded ? (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-border bg-canvas px-2 py-1.5">
          <input
            ref={composerRef}
            type={masked ? "password" : "text"}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={t("mobile.terminal.composerPlaceholder")}
            aria-label={t("mobile.terminal.composerPlaceholder")}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-ui-base text-slate-900 placeholder:text-slate-400 focus:outline-2 focus:outline-sky-200"
          />
          <button
            type="button"
            aria-label={t(masked ? "mobile.terminal.showInput" : "mobile.terminal.hideInput")}
            title={t(masked ? "mobile.terminal.showInput" : "mobile.terminal.hideInput")}
            aria-pressed={masked}
            // Keep the composer focused: taking focus would dismiss the keyboard.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setMasked((value) => !value)}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-500 transition active:bg-overlay-soft"
          >
            {masked ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button
            type="button"
            aria-label={t("mobile.terminal.send")}
            title={t("mobile.terminal.send")}
            disabled={draft.length === 0}
            onClick={submitDraft}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition disabled:opacity-40"
          >
            <ArrowUp size={16} />
          </button>
        </div>
      ) : null}

      {!sessionEnded && (!keyboardOpen || keysOpen) ? (
        <TerminalKeyBar
          ctrl={ctrl}
          onToggleCtrl={() => setCtrl((value) => !value)}
          onKey={sendKey}
          onKeyboard={() =>
            lineMode ? composerRef.current?.focus() : termRef.current?.focus()
          }
          onCaretLeft={lineMode ? () => moveCaret(-1) : undefined}
          onCaretRight={lineMode ? () => moveCaret(1) : undefined}
        />
      ) : null}
    </div>
  );
}
