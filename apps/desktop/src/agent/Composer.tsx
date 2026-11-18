import { useState } from "react";
import clsx from "clsx";
import { Loader2, Send, Square } from "lucide-react";

import { t } from "../lib/i18n";
import { ChatTeamBar } from "./ChatTeamBar";
import { runtimeBlock, runtimeLabel } from "./runtime";
import { SessionModePicker } from "./SessionModePicker";
import { SessionModelPicker } from "./SessionModelPicker";
import { SessionUsageBar } from "./usage/SessionUsageBar";
import { agentActions, agentStore, isSessionRunning } from "./store";

/** Draft key before any session exists; the text follows the first one. */
const NEW_SESSION_KEY = "__new";

/**
 * Enter sends, Shift+Enter adds a line.
 *
 * One bordered card holds the editor and its toolbar: the text sits above the
 * controls, and only the card is outlined, so the two read as one field. The
 * primary button is a single state machine — while the session is running it
 * stops the turn, otherwise it sends the draft.
 */
export function Composer() {
  const state = agentStore.use();
  const sessionId = state.selectedId ?? NEW_SESSION_KEY;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const text = drafts[sessionId] ?? "";
  const setText = (value: string) =>
    setDrafts((current) => ({ ...current, [sessionId]: value }));
  const block = runtimeBlock(state);
  const running = isSessionRunning(state, state.selectedId);
  // Free chats get the collaboration bar; task sessions carry their own header.
  const task = state.tasks?.find((item) => item.id === state.selectedId);
  const chat = !task || task.kind === "chat";

  const send = async () => {
    if (block !== null || sending || !text.trim()) return;
    const draftKey = sessionId;
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
        {chat ? <ChatTeamBar /> : null}
        <div className="rounded-xl border border-border bg-surface transition focus-within:border-slate-300">
          <textarea
            value={text}
            rows={3}
            title={t("agent.composer.hint")}
            placeholder={t("agent.composer.placeholder")}
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
