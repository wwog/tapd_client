import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, ExternalLink, FolderOpen, ScrollText, X } from "lucide-react";

import { agentApi, type AgentTask, type AgentTaskStatus } from "../lib/agent";
import { stripAnsi } from "../lib/ansi";
import { bugTitle } from "../lib/bug";
import { copyText, resumeTaskSession } from "../lib/desktop";
import { AgentTerminal } from "./AgentTerminal";

/** Statuses where the PTY is still alive and accepts keystrokes. */
const LIVE_STATUSES: AgentTaskStatus[] = [
  "queued",
  "preparing",
  "running",
  "waiting_review",
];

type Props = {
  task: AgentTask | null;
  onClose: () => void;
  toast: (kind: "ok" | "error", text: string) => void;
};

/**
 * Shows the opencode TUI of a task in an embedded terminal. Running tasks are
 * interactive (typing goes to the PTY); finished tasks replay the recorded IO.
 */
export function AgentLogViewer({ task, onClose, toast }: Props) {
  const [copied, setCopied] = useState(false);
  const interactive = task
    ? (task.transport ?? "pty") === "pty" && LIVE_STATUSES.includes(task.status)
    : false;
  // Escape must reach the TUI while the user is typing in it.
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;

  useEffect(() => {
    if (!task) return;
    setCopied(false);
  }, [task]);

  useEffect(() => {
    if (!task) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (interactiveRef.current && target?.closest("[data-agent-terminal]")) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [task, onClose]);

  if (!task) return null;

  const copyLog = async () => {
    try {
      const { data } = await agentApi.taskLog(task.id);
      if (!(await copyText(stripAnsi(data)))) {
        toast("error", "复制失败");
        return;
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (reason) {
      toast("error", `复制失败：${String(reason)}`);
    }
  };

  const openFile = () => {
    void invoke("open_path", { path: task.logPath }).catch((reason) =>
      toast("error", String(reason)),
    );
  };

  const resume = async () => {
    await resumeTaskSession(task, toast);
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/30 p-6 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-[min(86vh,860px)] w-[min(1180px,94vw)] flex-col overflow-hidden rounded-2xl bg-surface  border border-black/10">
        <header className="flex shrink-0 items-start gap-3 border-b border-slate-100 px-4 py-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-zinc-900 text-sky-300">
            <ScrollText size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-ui-base font-normal text-slate-900">
              {bugTitle(task.title) || "Agent 终端"}
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-slate-400">
              <span>
                {task.workspaceName || task.workspaceId} · #{task.bugId.slice(-7)}
              </span>
              {task.sessionId ? (
                <span className="truncate font-mono">{task.sessionId}</span>
              ) : null}
              <span className="truncate font-mono" title={task.logPath}>
                {task.logPath}
              </span>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭终端"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden bg-zinc-950 p-2">
          <AgentTerminal
            key={task.id}
            taskId={task.id}
            interactive={interactive}
            convertEol={task.transport !== "pty"}
            className="h-full w-full"
          />
        </div>

        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-100 bg-surface px-4 py-2.5">
          <button
            type="button"
            onClick={() => void copyLog()}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ui-sm text-slate-600 transition hover:border-slate-300"
          >
            <Copy size={11} />
            {copied ? "已复制" : "复制文本"}
          </button>
          <button
            type="button"
            onClick={openFile}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ui-sm text-slate-600 transition hover:border-slate-300"
          >
            <FolderOpen size={11} />
            打开日志文件
          </button>
          <span className="ml-auto text-ui-xs text-slate-400">
            {interactive
              ? "实时终端：可直接输入，窗口大小会同步给 Agent"
              : "已结束的任务只回放输出，不能输入"}
          </span>
          {task.sessionId ? (
            <button
              type="button"
              onClick={() => void resume()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ui-sm text-slate-600 transition hover:border-slate-300"
            >
              <ExternalLink size={11} />
              终端恢复
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
