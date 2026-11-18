import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  FolderGit2,
  GitBranch,
  LayoutGrid,
  Loader2,
  MessageSquare,
  Send,
  Square,
  Users,
  type LucideIcon,
} from "lucide-react";

import { t } from "../lib/i18n";
import { showToast } from "../lib/toast";
import { ScrollingName } from "../components/ScrollingName";
import { runtimeBlock, runtimeLabel } from "./runtime";
import { SessionModePicker } from "./SessionModePicker";
import { SessionModelPicker } from "./SessionModelPicker";
import { SessionUsageBar } from "./usage/SessionUsageBar";
import {
  agentActions,
  agentStore,
  agentTaskView,
  agentTeamView,
  isSessionRunning,
  taskReviewable,
} from "./store";

/** Draft key before any session exists; the text follows the first one. */
const NEW_SESSION_KEY = "__new";

/**
 * One compact control in the composer's work bar. It reads as text until it is
 * active; the only border in the composer is the card's own, so a row of these
 * never turns into a second toolbar.
 */
function WorkBarButton(props: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  error?: string | null;
  onClick?: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      aria-pressed={props.active}
      disabled={props.disabled}
      title={props.error || props.title}
      onClick={props.onClick}
      className={clsx(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-ui-2xs transition",
        props.active
          ? "bg-sky-50 text-sky-700"
          : "text-slate-500 hover:bg-overlay-soft hover:text-slate-700",
        props.error && "text-rose-600",
        props.disabled &&
          "cursor-default opacity-50 hover:bg-transparent hover:text-slate-500",
      )}
    >
      <Icon size={11} />
      {props.label}
    </button>
  );
}

/**
 * Enter sends, Shift+Enter adds a line.
 *
 * One bordered card holds the work bar, the editor and its toolbar: the top
 * row names the project and branch and carries the two start-only choices
 * (coworkers, worktree); the text sits below; only the card is outlined.
 * The primary button is a single state machine — while the session is running
 * it stops the turn, otherwise it sends the draft.
 */
export function Composer() {
  const state = agentStore.use();
  const sessionId = state.selectedId ?? NEW_SESSION_KEY;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const text = drafts[sessionId] ?? "";
  const setText = (value: string) =>
    setDrafts((current) => ({ ...current, [sessionId]: value }));
  const block = runtimeBlock(state);
  const running = isSessionRunning(state, state.selectedId);
  const task = state.tasks?.find((item) => item.id === state.selectedId);
  const chat = !task || task.kind === "chat";
  const reviewing = taskReviewable(task);
  const project = task?.project ?? null;
  const branch = task?.branch ?? null;
  const worktree = Boolean(task?.worktreePath);

  // Both choices are start-only: a task is created with the config default, a
  // free chat may switch them until its first message. After that the row is
  // read-only (the controls stay visible so the state is still legible).
  const started =
    task != null &&
    (task.kind !== "chat" ||
      task.messageCount > 0 ||
      (state.pendingPrompts[task.id]?.length ?? 0) > 0 ||
      task.status === "running");
  const canChoose = Boolean(task && project && !started);

  const team = task ? state.team[task.id] : undefined;
  const teamEnabled = task
    ? (state.chatTeamDrafts[task.id] ?? Boolean(team?.enabled))
    : false;
  const teamBusy = task ? Boolean(state.teamBusy[task.id]) : false;
  const teamError = task ? state.teamErrors[task.id] : null;
  const teamView = task ? agentTeamView(state, task.id) : "chat";

  // 「继续修改」in the review pane switches back here and asks for the caret.
  const focusAt = state.composerFocusAt;
  useEffect(() => {
    if (focusAt > 0) editorRef.current?.focus();
  }, [focusAt]);

  const send = async () => {
    if (block !== null || sending || !text.trim()) return;
    const draftKey = sessionId;
    // From the task pane (or the review section) a message means "keep
    // editing": show the transcript first, so the reply lands where the reader
    // can follow it.
    if (task && (reviewing || agentTaskView(state, task.id) === "task")) {
      agentActions.setTaskView(task.id, "chat");
    }
    setSending(true);
    const accepted = await agentActions.sendPrompt(text);
    if (accepted) {
      setDrafts((current) => ({ ...current, [draftKey]: "" }));
    }
    setSending(false);
  };

  const stop = async () => {
    const id = state.selectedId;
    if (!id || stopping) return;
    setStopping(true);
    await agentActions.cancelTurn(id);
    setStopping(false);
  };

  /** Session-level workspace choice; a dirty worktree refuses to be removed. */
  const toggleWorktree = async (enabled: boolean) => {
    if (!task || worktreeBusy || !canChoose) return;
    setWorktreeBusy(true);
    try {
      await agentActions.chatWorktree(task.id, enabled);
    } catch (error) {
      showToast("error", t("agent.chat.worktreeFailed", { error: String(error) }));
    } finally {
      setWorktreeBusy(false);
    }
  };

  const toggleTeam = () => {
    if (!task || teamBusy || !canChoose) return;
    void agentActions.setTeamEnabled(task.id, !teamEnabled);
  };

  const toggleBoard = () => {
    if (!task) return;
    agentActions.setTeamView(task.id, teamView === "board" ? "chat" : "board");
  };

  const lockedHint = t("agent.chat.lockedHint");
  const primaryBusy = running ? stopping : sending;
  const primaryDisabled = running ? stopping : block !== null || sending || !text.trim();
  const primaryTitle = running
    ? t("agent.task.stop")
    : block
      ? runtimeLabel(block)
      : t("common.send");

  return (
    <div className="px-6 pb-3 pt-2">
      <div className="mx-auto max-w-[46rem]">
        <div className="rounded-2xl border border-border bg-surface transition focus-within:border-slate-300">
          {project ? (
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-slate-500">
                <FolderGit2 size={12} className="shrink-0" />
                <ScrollingName text={project.name} className="max-w-[12rem]" />
                {branch ? (
                  <>
                    <span className="shrink-0 text-slate-300">·</span>
                    <GitBranch size={12} className="shrink-0" />
                    <ScrollingName text={branch} className="max-w-[14rem]" />
                  </>
                ) : null}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {teamEnabled ? (
                  <WorkBarButton
                    icon={teamView === "board" ? MessageSquare : LayoutGrid}
                    label={
                      teamView === "board"
                        ? t("agent.team.viewChat")
                        : t("agent.team.viewBoard")
                    }
                    onClick={toggleBoard}
                  />
                ) : null}
                <WorkBarButton
                  icon={Users}
                  label={t("agent.chat.team")}
                  active={teamEnabled}
                  disabled={!canChoose || teamBusy}
                  error={teamError}
                  title={canChoose ? t("agent.chat.teamHint") : lockedHint}
                  onClick={toggleTeam}
                />
                {chat ? (
                  <WorkBarButton
                    icon={GitBranch}
                    label={t("agent.chat.worktree")}
                    active={worktree}
                    disabled={!canChoose || worktreeBusy}
                    title={canChoose ? t("agent.chat.worktreeHint") : lockedHint}
                    onClick={() => void toggleWorktree(!worktree)}
                  />
                ) : (
                  <WorkBarButton
                    icon={GitBranch}
                    label={t("agent.chat.worktree")}
                    active
                    disabled
                    title={lockedHint}
                  />
                )}
              </span>
            </div>
          ) : null}
          <textarea
            ref={editorRef}
            value={text}
            rows={3}
            title={t("agent.composer.hint")}
            placeholder={
              reviewing
                ? t("agent.review.continuePlaceholder")
                : t("agent.composer.placeholder")
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              // Enter always sends (the runtime queues it); only the button
              // carries the send/stop state, so a keystroke never kills a run.
              void send();
            }}
            className="block w-full resize-none bg-transparent px-3 pb-1 pt-2 text-ui-caption leading-6 text-slate-700 placeholder:text-slate-300 focus:outline-none"
          />
          <div className="flex items-center gap-2 px-2 pb-2 pt-0.5">
            <SessionModePicker />
            {/* Only operable controls live inside the field: the session's
                figures are read-only status, so they sit under the card. */}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <SessionModelPicker />
              <button
                type="button"
                title={primaryTitle}
                aria-label={running ? t("agent.task.stop") : t("common.send")}
                aria-pressed={running}
                disabled={primaryDisabled}
                onClick={() => (running ? void stop() : void send())}
                className={clsx(
                  // Semantic primary, not `bg-slate-900`: the dark theme
                  // inverts slate, so that painted a white block under a white
                  // arrow. `primary-foreground` keeps the glyph readable.
                  "grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition hover:bg-primary-hover",
                  "disabled:cursor-default disabled:bg-slate-200 disabled:text-slate-400",
                )}
              >
                {primaryBusy ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : running ? (
                  <Square size={11} fill="currentColor" />
                ) : (
                  <Send size={13} />
                )}
              </button>
            </span>
          </div>
        </div>
        <div className="mt-1.5 flex justify-center">
          <SessionUsageBar
            usage={state.selectedId ? state.sessions[state.selectedId]?.usage : undefined}
          />
        </div>
      </div>
    </div>
  );
}
