import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { agentApi, type AgentOutputPayload } from "../lib/agent";

type Props = {
  taskId: string;
  /** Forward keystrokes and PTY resizes; only while the task is alive. */
  interactive: boolean;
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
 * The console can attach mid-turn, so these one-time sequences were emitted
 * before the panel existed and are never replayed. Without them xterm keeps the
 * mouse for text selection, which is why clicking the TUI did nothing but
 * select text.
 */
const TUI_MODES = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h";

/**
 * GPU-backed renderer. Without it xterm repaints cell by cell through the DOM,
 * which cannot keep up with a TUI that redraws the screen ~60 times a second.
 * Returns null when the webview has no usable WebGL context; the DOM renderer
 * stays as the fallback.
 */
function attachWebgl(term: Terminal): WebglAddon | null {
  try {
    const addon = new WebglAddon();
    // Drivers drop the context when the window is occluded or the GPU is
    // reclaimed; releasing the addon lets xterm fall back to the DOM renderer
    // instead of leaving a blank canvas.
    addon.onContextLoss(() => addon.dispose());
    term.loadAddon(addon);
    return addon;
  } catch {
    return null;
  }
}

/**
 * Live terminal view for a task's TUI.
 *
 * The PTY stream is rendered by a real terminal emulator, so colours, cursor
 * movement and full-screen redraws look like the agent running in a shell. The
 * panel is bidirectional while the task is alive: keystrokes go back to the PTY
 * and the PTY is resized to the panel, which makes the TUI re-layout.
 *
 * Nothing is recorded, so the panel starts blank when opened mid-turn and asks
 * the TUI for a full repaint instead (see the resize nudge below).
 */
export function AgentTerminal({ taskId, interactive, className }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  // Read from the terminal callbacks without re-creating the emulator.
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
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
    try {
      // Size the canvas before the GPU renderer allocates its glyph atlas.
      fit.fit();
    } catch {
      // Panel not laid out yet (hidden/zero width); `applySize` retries.
    }
    const webgl = attachWebgl(term);
    termRef.current = term;
    if (interactiveRef.current) {
      // 面板可能是中途挂上来的，TUI 启动时发出的鼠标上报/括号粘贴序列看不到，
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
      // Nothing is recorded, so live output is all there is: subscribe first so
      // no frame is missed while the panel is still setting up.
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
      if (!interactiveRef.current) return;
      term.focus();
      // Opening the console mid-turn starts from a blank screen: the TUI only
      // sends diffs, so nudge the PTY size to make it redraw the whole screen.
      const cols = term.cols;
      const rows = term.rows;
      if (cols > 1) {
        void agentApi
          .resize(taskId, cols - 1, rows)
          .catch(() => {})
          .finally(() => {
            if (disposed) return;
            window.setTimeout(() => applySize(), 40);
          });
      }
    })();

    return () => {
      disposed = true;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      observer.disconnect();
      inputSub.dispose();
      if (unlisten) unlisten();
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [taskId]);

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

  return <div ref={hostRef} data-agent-terminal className={className} />;
}
