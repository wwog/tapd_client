import { featureCommand } from "./feature";

/** One shell session the backend keeps for a terminal panel tab. */
export type TerminalMeta = {
  id: string;
  /** Tab label; the backend sets it to the working directory's name. */
  title: string;
  cwd: string;
  shell: string;
  /** Exit code, or null while the process is running. */
  exited: number | null;
};

/** `terminal://output`: `seq` is the session's cumulative byte count. */
export type TerminalOutputPayload = { id: string; data: string; seq: number };
export type TerminalExitPayload = { id: string; code: number | null };
export type TerminalSessionsPayload = { sessions: TerminalMeta[] };

export type TerminalCreateRequest = {
  /** Project whose configured folder becomes the working directory. */
  workspaceId?: string;
  /** Explicit directory; overrides the project's folder (restarts). */
  cwd?: string;
  cols?: number;
  rows?: number;
};

/**
 * Shell sessions live in the backend so they survive panel closes: the view is
 * disposable, the PTY is not. Output streams on `terminal://output`,
 * `terminal_replay` returns the recorded bytes for a remounting view, and
 * `terminal://sessions` keeps every window's tab list identical.
 */
export const terminalApi = {
  create: (request: TerminalCreateRequest) =>
    featureCommand<{ session: TerminalMeta }>("terminal_create", request),
  list: () => featureCommand<{ sessions: TerminalMeta[] }>("terminal_list"),
  input: (id: string, data: string) =>
    featureCommand<null>("terminal_input", { id, data }),
  resize: (id: string, cols: number, rows: number) =>
    featureCommand<null>("terminal_resize", { id, cols, rows }),
  close: (id: string) => featureCommand<null>("terminal_close", { id }),
  replay: (id: string) =>
    featureCommand<{ data: string; seq: number }>("terminal_replay", { id }),
};
