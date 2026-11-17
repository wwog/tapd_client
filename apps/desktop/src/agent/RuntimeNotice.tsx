import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import { Button } from "../components/ui";
import { t } from "../lib/i18n";
import { runtimeBlock, runtimeHint, runtimeLabel } from "./runtime";
import { agentActions, agentStore } from "./store";

/**
 * The runtime's real state directly above the composer. It is never a dash:
 * every not-ready phase names itself and offers the one action that changes it.
 */
export function RuntimeNotice() {
  const state = agentStore.use();

  if (state.preparingSince !== null) {
    return <PreparingLine since={state.preparingSince} />;
  }

  const block = runtimeBlock(state);
  const hint = block ? runtimeHint(block, state) : undefined;

  return (
    <>
      {block ? (
        <div className="flex items-center gap-2 px-4 pt-2 text-ui-sm">
          {block === "starting" || block === "checking" ? (
            <Loader2 size={12} className="shrink-0 animate-spin text-slate-400" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-slate-500" title={hint}>
            {runtimeLabel(block)}
          </span>
          <RuntimeAction block={block} />
        </div>
      ) : null}
      {state.lastError ? <ErrorLine error={state.lastError} /> : null}
    </>
  );
}

function RuntimeAction({ block }: { block: NonNullable<ReturnType<typeof runtimeBlock>> }) {
  switch (block) {
    case "model":
      return (
        <Button size="sm" onClick={() => agentActions.openConfig("models")}>
          {t("agent.runtime.config")}
        </Button>
      );
    case "payload":
      return (
        <Button size="sm" onClick={() => void agentActions.prepareRuntime()}>
          {t("agent.runtime.prepare")}
        </Button>
      );
    case "node":
    case "failed":
      return (
        <Button size="sm" onClick={() => void agentActions.startRuntime()}>
          {t("common.retry")}
        </Button>
      );
    case "status":
      return (
        <Button size="sm" onClick={() => void agentActions.refreshStatus()}>
          {t("common.retry")}
        </Button>
      );
    // `stopped` is transient: the runtime starts with the app and comes back on
    // its own, so there is nothing for the user to press.
    case "stopped":
      return null;
    case "starting":
    case "checking":
      return null;
  }
}

function PreparingLine({ since }: { since: number }) {
  const [seconds, setSeconds] = useState(() =>
    Math.max(0, Math.floor((Date.now() - since) / 1000)),
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSeconds(Math.max(0, Math.floor((Date.now() - since) / 1000)));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [since]);

  return (
    <div
      className="flex items-center gap-2 px-4 pt-2 text-ui-sm"
      title={t("agent.runtime.preparingHint")}
    >
      <Loader2 size={12} className="shrink-0 animate-spin text-slate-400" />
      <span className="min-w-0 flex-1 truncate text-slate-500">
        {t("agent.runtime.preparing", { seconds })}
      </span>
    </div>
  );
}

function ErrorLine({ error }: { error: { code: string | null; message: string } }) {
  return (
    <div className="flex items-start gap-2 px-4 pt-2 text-ui-sm text-rose-600">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 break-all" title={error.code ?? undefined}>
        {error.message}
      </span>
    </div>
  );
}
