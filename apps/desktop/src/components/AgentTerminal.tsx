import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { agentApi, type AgentOutputPayload } from "../lib/agent";

type Props = {
  taskId: string;
  /** Forward keystrokes and PTY resizes; only while the task is alive. */
  interactive: boolean;
  /** Translate LF to CRLF for non-interactive output such as history logs. */
  convertEol?: boolean;
  /** Increment to move keyboard focus into the terminal (e.g. "去终端处理"). */
  focusToken?: number;
  className?: string;
};

/** Dark palette matching the rest of the console. */
const THEME = {
  background: "#09090b",
  foreground: "#e4e4e7",
  cursor: "#38bdf8",
  cursorAccent: "#09090b",
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

/**
 * Terminal modes the opencode TUI turns on at startup: mouse reporting
 * (click/drag/wheel) plus bracketed paste.
 *
 * The replay starts mid-stream, so these one-time sequences are not in the log
 * tail. Without them xterm keeps the mouse for text selection, which is why
 * clicking the TUI did nothing but select text.
 */
const TUI_MODES = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h";

/**
 * Terminal view for a task's opencode TUI.
 *
 * The PTY output is replayed into a real terminal emulator, so colours, cursor
 * movement and full-screen redraws look like opencode running in a shell.
 * While the task is alive the panel is bidirectional: keystrokes go back to the
 * PTY and the PTY is resized to the panel, which makes the TUI re-layout.
 */
export function AgentTerminal({
  taskId,
  interactive,
  convertEol = false,
  focusToken,
  className,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // Read from the terminal callbacks without re-creating the emulator.
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol,
      cursorBlink: interactiveRef.current,
      // 鼠标上报打开后，macOS 上用 Option+拖动才能选中文本（同 iTerm）。
      macOptionClickForcesSelection: true,
      fontFamily: '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.1,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    if (interactiveRef.current) {
      // 日志回放是从中途开始的，TUI 启动时打开的鼠标上报/括号粘贴序列不在尾部，
      // 不补上的话鼠标只会在本地选中文本，点击传不到 TUI。
      term.write(TUI_MODES);
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let resizeTimer: number | null = null;

    /** Fits the emulator to the panel and pushes the size to the PTY. */
    const applySize = () => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        // The panel is not laid out yet (hidden/zero width); try again later.
        return;
      }
      if (!interactiveRef.current) return;
      void agentApi.resize(taskId, term.cols, term.rows).catch(() => {});
    };

    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        applySize();
      }, 120);
    });
    observer.observe(host);

    const inputSub = term.onData((data) => {
      if (!interactiveRef.current) return;
      void agentApi.input(taskId, data).catch(() => {});
    });

    void (async () => {
      // Replay what is already on disk, then subscribe: doing it in this order
      // keeps the stream free of duplicates from the just-read file.
      try {
        const { data } = await agentApi.taskLog(taskId);
        if (disposed) return;
        if (data) term.write(data);
      } catch {
        // No log yet (task just started): live output is enough.
      }
      if (disposed) return;

      unlisten = await listen<AgentOutputPayload>("agent://output", (event) => {
        if (event.payload.taskId !== taskId) return;
        term.write(event.payload.data);
      });
      if (disposed) {
        unlisten();
        unlisten = null;
        return;
      }

      applySize();
      if (interactiveRef.current) term.focus();
    })();

    return () => {
      disposed = true;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      observer.disconnect();
      inputSub.dispose();
      if (unlisten) unlisten();
      term.dispose();
      termRef.current = null;
    };
  }, [taskId, convertEol]);

  // The task can finish while the panel stays open: stop accepting input and
  // sync the size one last time.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.cursorBlink = interactive;
    if (!interactive) return;
    term.focus();
    void agentApi.resize(taskId, term.cols, term.rows).catch(() => {});
  }, [interactive, taskId]);

  // External "focus terminal" request; the terminal effect above owns creation.
  useEffect(() => {
    if (focusToken === undefined) return;
    termRef.current?.focus();
  }, [focusToken]);

  return <div ref={hostRef} data-agent-terminal className={className} />;
}
