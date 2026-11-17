import { useState } from "react";
import { Send } from "lucide-react";

import { Button } from "../components/ui";
import { t } from "../lib/i18n";
import { runtimeBlock, runtimeLabel } from "./runtime";
import { SessionModePicker } from "./SessionModePicker";
import { SessionModelPicker } from "./SessionModelPicker";
import { SessionUsageBar } from "./usage/SessionUsageBar";
import { agentActions, agentStore } from "./store";

/** Draft key before any session exists; the text follows the first one. */
const NEW_SESSION_KEY = "__new";

/**
 * Enter sends, Shift+Enter adds a line. The send button is disabled while the
 * runtime is not ready; the notice above states why and offers the action.
 * Drafts are per session: typing half a prompt and switching tasks must not
 * leave the text pointed at the other conversation.
 */
export function Composer() {
  const state = agentStore.use();
  const sessionId = state.selectedId ?? NEW_SESSION_KEY;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const text = drafts[sessionId] ?? "";
  const setText = (value: string) =>
    setDrafts((current) => ({ ...current, [sessionId]: value }));
  const block = runtimeBlock(state);
  const disabled = block !== null || sending;

  const send = async () => {
    if (disabled || !text.trim()) return;
    const draftKey = sessionId;
    setSending(true);
    const accepted = await agentActions.sendPrompt(text);
    if (accepted) {
      setDrafts((current) => ({ ...current, [draftKey]: "" }));
    }
    setSending(false);
  };

  return (
    <div className="px-4 pb-3 pt-2">
      <div className="mx-auto max-w-3xl">
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
            void send();
          }}
          className="w-full resize-none rounded-xl border border-border bg-surface px-3 py-2 text-ui-caption leading-6 text-slate-700 transition placeholder:text-slate-300"
        />
        <div className="mt-2 flex items-center gap-2">
          <SessionModelPicker />
          <SessionModePicker />
          <span className="h-3 w-px shrink-0 bg-border" />
          <SessionUsageBar
            usage={
              state.selectedId ? state.sessions[state.selectedId]?.usage : undefined
            }
          />
          <span className="ml-auto" title={block ? runtimeLabel(block) : undefined}>
            <Button
              variant="primary"
              size="sm"
              icon={<Send size={13} />}
              loading={sending}
              disabled={disabled || !text.trim()}
              onClick={() => void send()}
            >
              {t("common.send")}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
