import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import { useResolvedTheme } from "../lib/appearance";
import { t } from "../lib/i18n";
import { terminalApi, type TerminalOutputPayload } from "../lib/terminal";
import { showToast } from "../lib/toast";
import { attachWebgl, TERMINAL_FONT, TERMINAL_THEMES } from "../lib/xterm";

type Props = {
  sessionId: string;
  /** The visible tab: only it takes focus, input and PTY sizes. */
  active: boolean;
  /** The process is still running; a dead PTY takes neither input nor sizes. */
  live: boolean;
};

/** A frame that arrived while `terminal_replay` was still in flight. */
type Output = { seq: number; data: string };

/**
 * One backend shell session rendered by xterm.
 *
 * Output is replayed from the backend on mount, because the panel (and this
 * view) unmount when it closes while the PTY keeps running. Live output is
 * buffered from the first frame so nothing that arrives between subscribing and
 * the replay snapshot is lost, and frames already contained in that snapshot
 * are dropped instead of being written twice.
 */
export function ShellTerminal({ sessionId, active, live }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const theme = useResolvedTheme();
  // Read from the xterm callbacks and the creation effect without re-creating
  // the emulator when they change.
  const activeRef = useRef(active);
  activeRef.current = active;
  const liveRef = useRef(live);
  liveRef.current = live;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  /** Re-fits the visible view; owned by the mount effect. */
  const applySizeRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      ...TERMINAL_FONT,
      cursorBlink: liveRef.current,
      macOptionClickForcesSelection: true,
      theme: TERMINAL_THEMES[themeRef.current],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      // Size the canvas before the GPU renderer allocates its glyph atlas.
      fit.fit();
    } catch {
      // Not laid out yet (the panel is still animating open); the observer retries.
    }
    const webgl = attachWebgl(term);
    termRef.current = term;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let resizeTimer: number | null = null;
    let replaying = true;
    let lastSeq = -1;
    const buffered: Output[] = [];

    /** Fits the emulator to the panel and pushes the size to the PTY. */
    const applySize = () => {
      if (disposed || !liveRef.current || !activeRef.current) return;
      try {
        fit.fit();
      } catch {
        // Zero-sized container: the next observer tick tries again.
        return;
      }
      if (term.cols < 2 || term.rows < 1) return;
      void terminalApi.resize(sessionId, term.cols, term.rows).catch(() => {});
    };
    applySizeRef.current = applySize;

    const observer = new ResizeObserver(() => {
      // Hidden tabs keep their exact size, so only the visible one is refitted.
      if (!activeRef.current) return;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        applySize();
      }, 120);
    });
    observer.observe(host);

    // xterm emits one frame per keystroke. Sending each one separately costs an
    // IPC round trip and a separate PTY write, which makes fast typing crawl;
    // a burst is flushed once the typist pauses. Keys that change the shell's
    // mode (Enter, Tab, Ctrl codes, escape sequences) must land immediately.
    let pendingInput = "";
    let inputTimer: number | null = null;
    const flushInput = () => {
      if (inputTimer !== null) {
        window.clearTimeout(inputTimer);
        inputTimer = null;
      }
      if (!pendingInput) return;
      const data = pendingInput;
      pendingInput = "";
      void terminalApi.input(sessionId, data).catch(() => {});
    };
    const queueInput = (data: string) => {
      pendingInput += data;
      const immediate =
        data.startsWith("\x1b") ||
        (data.length === 1 && (data.charCodeAt(0) < 0x20 || data.charCodeAt(0) === 0x7f)) ||
        data.includes("\r") ||
        data.includes("\n") ||
        pendingInput.length >= 1024;
      if (immediate) {
        flushInput();
        return;
      }
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      inputTimer = window.setTimeout(flushInput, 40);
    };

    const inputSub = term.onData((data) => {
      if (!liveRef.current || !activeRef.current) return;
      queueInput(data);
    });

    /** Writes an output frame in order, dropping the ones already on screen. */
    const write = (frame: Output) => {
      if (frame.seq <= lastSeq) return;
      lastSeq = frame.seq;
      term.write(frame.data);
    };

    void (async () => {
      // Subscribe first: the replay snapshot only covers what was recorded
      // before this call, so anything newer arrives as an event.
      try {
        unlisten = await listen<TerminalOutputPayload>("terminal://output", (event) => {
          const { id, data, seq } = event.payload;
          if (disposed || id !== sessionId) return;
          if (replaying) {
            buffered.push({ seq, data });
            return;
          }
          write({ seq, data });
        });
      } catch {
        // Browser preview outside Tauri: nothing streams, the view stays blank.
      }
      if (disposed) {
        unlisten?.();
        unlisten = null;
        return;
      }

      try {
        const replay = await terminalApi.replay(sessionId);
        if (disposed) return;
        lastSeq = replay.seq;
        if (replay.data) term.write(replay.data);
      } catch {
        // Without a snapshot the buffered frames are all we have: keep them and
        // report that the scrollback above them is missing.
        showToast("error", t("terminal.replayFailed"));
      }
      if (disposed) return;
      for (const frame of buffered) write(frame);
      buffered.length = 0;
      replaying = false;

      applySize();
      if (activeRef.current && liveRef.current) term.focus();
    })();

    return () => {
      disposed = true;
      applySizeRef.current = () => undefined;
      // Typed-but-unflushed bytes still belong to the shell.
      flushInput();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      observer.disconnect();
      inputSub.dispose();
      if (unlisten) unlisten();
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId]);

  // Theme switches re-colour the existing buffer instead of remounting xterm.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = TERMINAL_THEMES[theme];
  }, [theme]);

  // Switching tabs focuses the terminal and re-syncs the PTY, whose size was
  // left alone while the tab was hidden.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.cursorBlink = live;
    if (!active) return;
    applySizeRef.current();
    if (live) term.focus();
  }, [active, live]);

  return <div data-component="ShellTerminal" ref={hostRef} className="h-full w-full" />;
}
