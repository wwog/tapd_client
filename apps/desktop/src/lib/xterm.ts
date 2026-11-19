/**
 * Shared xterm setup for the agent console and the shell terminal panel.
 *
 * Both views want the same font metrics, scrollback and GPU renderer; only the
 * palette differs (the agent console is always dark, the shell panel follows
 * the app theme), so the theme is chosen per view and everything else lives
 * here.
 */
import { WebglAddon } from "@xterm/addon-webgl";
import type { ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

/** Font settings shared by every xterm view. */
export const TERMINAL_FONT = {
  fontFamily: '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.1,
  scrollback: 5000,
} as const;

/**
 * Palettes per app theme. Backgrounds match `--color-surface` so the terminal
 * never shows a seam against the card it sits in.
 */
export const TERMINAL_THEMES: Record<"light" | "dark", ITheme> = {
  dark: {
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
  },
  light: {
    background: "#ffffff",
    foreground: "#18181b",
    cursor: "#0284c7",
    cursorAccent: "#ffffff",
    selectionBackground: "#bae6fd",
    black: "#18181b",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#ca8a04",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#d4d4d8",
    brightBlack: "#52525b",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#eab308",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#ffffff",
  },
};

/**
 * GPU-backed renderer. Without it xterm repaints cell by cell through the DOM,
 * which cannot keep up with a TUI that redraws the screen ~60 times a second.
 * Returns null when the webview has no usable WebGL context; the DOM renderer
 * stays as the fallback.
 */
export function attachWebgl(term: Terminal): WebglAddon | null {
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
