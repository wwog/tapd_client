import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
import { pickExportDir } from "../lib/exportDir";
import { api } from "../lib/api";
import { dshApi } from "../lib/dsh";
import { ScrollingName } from "../components/ScrollingName";
import { GoalChip } from "./GoalChip";
import { AGENT_COLUMN } from "./layout";
import { moveIndex } from "./listNav";
import { PromptHistoryPanel } from "./PromptHistoryPanel";
import { runtimeBlock, runtimeLabel } from "./runtime";
import { SessionModePicker } from "./SessionModePicker";
import { SessionModelPicker } from "./SessionModelPicker";
import { SessionUsageBar } from "./usage/SessionUsageBar";
import { SlashPalette } from "./SlashPalette";
import {
  buildSlashItems,
  fileMention,
  permissionArg,
  slashIntent,
  slashQuery,
  type SlashCommand,
} from "./slashCommands";
import {
  collectPromptHistory,
  filterHistory,
} from "./promptHistory";
import {
  agentActions,
  agentStore,
  agentTaskView,
  agentTeamView,
  isSessionRunning,
  sessionPermissionMode,
  sessionPlan,
  taskReviewable,
} from "./store";
import { isWorkflowTask } from "./workflow";

/** Draft key before any session exists; the text follows the first one. */
const NEW_SESSION_KEY = "__new";

/** Stable empty catalog, so `buildSlashItems` keeps its memo. */
const EMPTY_COMMANDS: never[] = [];

/**
 * One compact control in the composer's work bar. It reads as text until it is
 * active; the only border in the composer is the card's own, so a row of these
 * never turns into a second toolbar.
 *
 * A locked control (the session already started, or a workflow task) drops
 * every hover variant: it is a plain state label, so hovering must not suggest
 * it could be toggled.
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
      data-component="WorkBarButton"
      type="button"
      aria-pressed={props.active}
      disabled={props.disabled}
      title={props.error || props.title}
      onClick={props.onClick}
      className={clsx(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-ui-2xs transition",
        props.disabled && "cursor-default",
        props.active
          ? "bg-sky-50 text-sky-700"
          : "text-slate-500",
        !props.disabled &&
          !props.active &&
          "hover:bg-overlay-soft hover:text-slate-700",
        props.error && "text-rose-600",
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
  const [slashIndex, setSlashIndex] = useState(0);
  /** Draft the palette was dismissed for; a new keystroke reopens it. */
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(0);
  /** Rising counters that open the composer's own model / mode sheets. */
  const [signals, setSignals] = useState({ model: 0, mode: 0 });
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const text = drafts[sessionId] ?? "";
  const setText = (value: string) =>
    setDrafts((current) => ({ ...current, [sessionId]: value }));
  /** Empties this chat's draft, including the slot a send may have outgrown
   *  (allocation moves the selection off `__new` mid-flight). */
  const clearDraft = () =>
    setDrafts((current) => ({
      ...current,
      [sessionId]: "",
      [NEW_SESSION_KEY]: "",
    }));
  const block = runtimeBlock(state);
  const running = isSessionRunning(state, state.selectedId);
  const task = state.tasks?.find((item) => item.id === state.selectedId);
  const chat = !isWorkflowTask(task);
  const reviewing = taskReviewable(task);
  const project = task?.project ?? null;
  const branch = task?.branch ?? null;
  const worktree = Boolean(task?.worktreePath);

  // Both choices are start-only: a task is created with the config default, a
  // free chat may switch them until its first message. After that the row is
  // read-only (the controls stay visible so the state is still legible).
  const started =
    task != null &&
    (isWorkflowTask(task) ||
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
  const paneView = agentTaskView(state, state.selectedId);
  const goal = state.selectedId ? state.sessions[state.selectedId]?.goal : undefined;

  // 「继续修改」in the review pane switches back here and asks for the caret.
  const focusAt = state.composerFocusAt;
  useEffect(() => {
    if (focusAt > 0) editorRef.current?.focus();
  }, [focusAt]);

  // ---------------------------------------------------------------------
  // `/` palette and ↑ history
  // ---------------------------------------------------------------------

  const catalogKey = state.selectedId ?? NEW_SESSION_KEY;
  const descriptors = state.commandCatalog[catalogKey] ?? EMPTY_COMMANDS;
  const slashItems = useMemo(
    () => buildSlashItems(text, descriptors, (key) => t(key)),
    [text, descriptors],
  );
  const slashOpen =
    slashQuery(text) !== undefined && slashDismissed !== text;

  /** Engine command names for routing a typed line without opening the menu. */
  const runtimeNames = useMemo(
    () => new Set(descriptors.map((descriptor) => descriptor.name)),
    [descriptors],
  );

  const historyItems = useMemo(() => {
    const session = state.selectedId;
    const own = session ? state.entries[session]?.items : undefined;
    const ownTexts = own
      ?.filter((entry) => entry.kind === "user")
      .map((entry) => entry.text);
    const pending = session ? state.pendingPrompts[session] : undefined;
    return filterHistory(
      collectPromptHistory([pending, ownTexts, state.promptHistory ?? undefined]),
      historyOpen ? text : "",
    );
  }, [
    historyOpen,
    state.entries,
    state.pendingPrompts,
    state.promptHistory,
    state.selectedId,
    text,
  ]);

  // A new draft restarts both lists at the top.
  useEffect(() => {
    setSlashIndex(0);
    setHistoryIndex(0);
  }, [text]);

  useEffect(() => {
    if (!slashOpen) return;
    if (state.commandCatalog[catalogKey] !== undefined) return;
    void agentActions.loadCommands(state.selectedId);
  }, [catalogKey, slashOpen, state.commandCatalog, state.selectedId]);

  useEffect(() => {
    if (historyOpen) void agentActions.loadPromptHistory(true);
  }, [historyOpen]);

  const focusEditor = () => editorRef.current?.focus();

  /** Puts the caret after the last character once the new value is committed. */
  const caretToEnd = () => {
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    });
  };

  /** Appends a snippet to the current draft (file references, history picks). */
  const applyInsert = (snippet: string, base: string) => {
    const head = base.replace(/\s+$/u, "");
    setText(head === "" ? snippet : `${head} ${snippet}`);
    setHistoryOpen(false);
    caretToEnd();
  };

  /** The directory a `@` reference should be relative to, when there is one. */
  const mentionBase = (): string => {
    if (task?.worktreePath) return task.worktreePath;
    const repo = state.projects?.find((item) => item.id === task?.project?.id);
    return repo?.repoPath ?? "";
  };

  /** Opens the system picker and replaces the draft with `@path` references. */
  const pickFiles = async (args: string) => {
    if (args.trim()) {
      applyInsert(
        args
          .split(/\s+/u)
          .filter(Boolean)
          .map(fileMention)
          .join(" "),
        "",
      );
      focusEditor();
      return;
    }
    const selected = await openDialog({
      multiple: true,
      title: t("agent.cmd.filePick"),
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length === 0) return;
    const base = mentionBase();
    applyInsert(
      paths
        .map((path) =>
          base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path,
        )
        .map(fileMention)
        .join(" "),
      "",
    );
    focusEditor();
  };

  const exportLog = async () => {
    const id = agentStore.get().selectedId;
    if (!id) {
      showToast("error", t("agent.cmd.noSession"));
      return;
    }
    const dir = await pickExportDir();
    if (!dir) return;
    try {
      const result = await dshApi.exportSession(id, dir);
      await api.revealPath(result.path);
    } catch (error) {
      showToast("error", t("agent.cmd.exportFailed", { error: String(error) }));
    }
  };

  /**
   * Runs one of the five commands this app owns. The caller clears the draft
   * first: a command line is not message content, and `file` writes the
   * references it produced straight back.
   */
  const runNative = async (name: string, args: string): Promise<void> => {
    if (name === "file") {
      await pickFiles(args);
      return;
    }
    if (name === "model") {
      setSignals((current) => ({ ...current, model: current.model + 1 }));
      return;
    }
    if (name === "export") {
      await exportLog();
      return;
    }
    if (name === "permission") {
      const mode = permissionArg(args);
      if (!mode) {
        // `/permission` with no argument opens the picker, it does not guess.
        try {
          await agentActions.ensureSession();
        } catch (error) {
          showToast("error", String(error));
          return;
        }
        setSignals((current) => ({ ...current, mode: current.mode + 1 }));
        return;
      }
      try {
        const id = await agentActions.ensureSession();
        await agentActions.selectSessionMode(id, mode);
      } catch (error) {
        showToast("error", String(error));
      }
      return;
    }
    if (name === "plan") {
      const message = args.trim();
      try {
        const id = await agentActions.ensureSession();
        const current = agentStore.get();
        if (message.toLowerCase() === "off") {
          // Leaving plan keeps the permission mode underneath it.
          await agentActions.selectSessionMode(
            id,
            sessionPermissionMode(current, id) ?? "auto",
          );
          return;
        }
        if (message !== "") {
          // A message enters the plan and becomes its first instruction, the
          // way dsh steers the rest of the line into plan mode.
          if (!sessionPlan(current, id)) {
            await agentActions.selectSessionMode(id, "plan");
          }
          await agentActions.sendPrompt(message);
          return;
        }
        // Bare `/plan` toggles, which is what the palette row promises.
        await agentActions.selectSessionMode(
          id,
          sessionPlan(current, id)
            ? sessionPermissionMode(current, id) ?? "auto"
            : "plan",
        );
      } catch (error) {
        showToast("error", String(error));
      }
    }
  };

  const send = async () => {
    if (block !== null || sending || !text.trim()) return;
    // From the task pane (or the review section) a message means "keep
    // editing": show the transcript first, so the reply lands where the reader
    // can follow it.
    if (task && (reviewing || paneView === "task")) {
      agentActions.setTaskView(task.id, "chat");
    }
    setSending(true);
    const accepted = await agentActions.sendPrompt(text);
    if (accepted) clearDraft();
    setSending(false);
  };

  /**
   * Enter. A line that names a known command takes the command path; anything
   * else (including `/unknown`) is an ordinary message, which is exactly what
   * dsh does with text it cannot resolve.
   */
  const submit = async () => {
    const draft = text.trim();
    if (!draft) return;
    const intent = slashIntent(draft, runtimeNames);
    setSlashDismissed(null);
    if (intent.kind === "native") {
      // The command line is not content: clear it before anything runs, so a
      // cancelled picker leaves an empty draft instead of `/file`.
      setText("");
      await runNative(intent.name, intent.args);
      focusEditor();
      return;
    }
    if (intent.kind === "runtime") {
      if (await agentActions.runCommand(intent.line)) clearDraft();
      return;
    }
    await send();
  };

  /** A palette row. No-input commands run; input ones rewrite the draft. */
  const pickSlash = async (command: SlashCommand) => {
    setSlashDismissed(null);
    if (command.action.kind === "insert") {
      setText(command.action.text);
      focusEditor();
      return;
    }
    if (command.action.kind === "runtime") {
      if (await agentActions.runCommand(`/${command.name}`)) clearDraft();
      return;
    }
    setText("");
    await runNative(command.name, "");
    focusEditor();
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
    <div data-component="Composer" className="px-6 pb-3 pt-2">
      <div className={AGENT_COLUMN}>
        <div className="relative rounded-2xl border border-border bg-surface transition focus-within:border-slate-300">
          {/* The two keyboard lists float above the card, like dsh desktop:
              they never push the transcript while a draft is being shaped. */}
          {slashOpen ? (
            <SlashPalette
              items={slashItems}
              index={slashIndex}
              onPick={(command) => void pickSlash(command)}
              onHover={setSlashIndex}
            />
          ) : historyOpen ? (
            <PromptHistoryPanel
              items={historyItems}
              index={historyIndex}
              onPick={(picked) => {
                setText(picked);
                setHistoryOpen(false);
                focusEditor();
              }}
              onHover={setHistoryIndex}
            />
          ) : null}
          {project ? (
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              {/* The task pane above already names the project and branch. */}
              {paneView === "task" ? null : (
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
              )}
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
            // Leaving the field drops both lists; a row click keeps the focus
            // (mousedown is prevented), so this only fires on a real exit.
            onBlur={() => {
              setSlashDismissed(text);
              setHistoryOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              const key = event.key;

              // The `/` menu owns the arrows, Enter/Tab and Escape while it is
              // open; anything else is ordinary editing of the query.
              if (slashOpen) {
                if (key === "ArrowDown" || key === "ArrowUp") {
                  event.preventDefault();
                  setSlashIndex((index) =>
                    moveIndex(index, key === "ArrowDown" ? 1 : -1, slashItems.length),
                  );
                  return;
                }
                if (key === "Escape") {
                  event.preventDefault();
                  setSlashDismissed(text);
                  return;
                }
                if (key === "Enter" || key === "Tab") {
                  const command = slashItems[slashIndex];
                  if (command) {
                    event.preventDefault();
                    void pickSlash(command);
                    return;
                  }
                  // No match: Enter still sends, which is how an unknown
                  // `/line` reaches the model.
                }
              }

              // The ↑ panel behaves the same way over history rows.
              if (historyOpen) {
                if (key === "ArrowDown" || key === "ArrowUp") {
                  event.preventDefault();
                  setHistoryIndex((index) =>
                    moveIndex(index, key === "ArrowDown" ? 1 : -1, historyItems.length),
                  );
                  return;
                }
                if (key === "Escape") {
                  event.preventDefault();
                  setHistoryOpen(false);
                  return;
                }
                if (key === "Enter" || key === "Tab") {
                  const picked = historyItems[historyIndex];
                  if (picked !== undefined) {
                    event.preventDefault();
                    setText(picked);
                    setHistoryOpen(false);
                    return;
                  }
                }
              }

              // ↑ on an empty draft opens history (a caret move otherwise).
              if (key === "ArrowUp" && text === "") {
                event.preventDefault();
                setHistoryIndex(0);
                setHistoryOpen(true);
                return;
              }

              if (key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              // Enter always sends (the runtime queues it); only the button
              // carries the send/stop state, so a keystroke never kills a run.
              void submit();
            }}
            className="block w-full resize-none bg-transparent px-3 pb-1 pt-2 text-ui-caption leading-6 text-slate-700 placeholder:text-slate-300 focus:outline-none"
          />
          <div className="flex items-center gap-2 px-2 pb-2 pt-0.5">
            <SessionModePicker openSignal={signals.mode} />
            {/* Only operable controls live inside the field: the session's
                figures are read-only status, so they sit under the card. */}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <SessionModelPicker openSignal={signals.model} />
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
        <div className="mt-1.5 flex items-center justify-center">
          <SessionUsageBar
            usage={state.selectedId ? state.sessions[state.selectedId]?.usage : undefined}
          />
          {goal ? (
            <>
              <span className="px-1.5 text-ui-xs text-slate-300">·</span>
              <GoalChip goal={goal} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
