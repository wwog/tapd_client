import { useEffect, useState } from "react";

import { agentApi } from "./agent";

/** The runtime that will receive the next task, as shown in the UI. */
export type CurrentAgent = {
  name: string;
  binary: string;
};

/**
 * Reads the default runtime from Agent 页 →「配置」.
 *
 * `reloadKey` lets a dialog refresh the label when it opens; the setting itself
 * is persisted by the config pane, not here.
 */
export function useCurrentAgent(reloadKey?: unknown): CurrentAgent | null {
  const [current, setCurrent] = useState<CurrentAgent | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void Promise.all([agentApi.configGet(), agentApi.runtimes()])
        .then(([configResult, runtimeResult]) => {
          if (cancelled) return;
          const runtime =
            runtimeResult.runtimes.find(
              (item) => item.id === configResult.config.runtimeId,
            ) ?? runtimeResult.runtimes[0];
          if (!runtime) return;
          setCurrent({
            name: runtime.name,
            binary: configResult.config.binaryPath || runtime.binary,
          });
        })
        .catch(() => undefined);
    };
    load();
    // The management page broadcasts this after saving, so open views do not
    // keep showing the previous agent.
    const reload = () => load();
    window.addEventListener("agent:runtime-changed", reload);
    return () => {
      cancelled = true;
      window.removeEventListener("agent:runtime-changed", reload);
    };
  }, [reloadKey]);

  return current;
}
