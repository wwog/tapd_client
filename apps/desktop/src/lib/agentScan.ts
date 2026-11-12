import { useCallback, useEffect, useMemo, useState } from "react";

import { agentApi, type AgentScanResult, type AgentScanSnapshot } from "./agent";
import { useTauriEvent } from "./tauriEvent";

/**
 * 本机 Agent 检测结果的共享缓存。
 *
 * 后端每个自然日最多自动扫描一次；设置页、Agent 配置页和提交面板共用这
 * 一份缓存和同一条 `agent://scan` 事件，避免重复探测（每次都要启动 CLI）。
 */
let cached: AgentScanSnapshot | null = null;
let inflight: Promise<AgentScanSnapshot> | null = null;
const listeners = new Set<(snapshot: AgentScanSnapshot) => void>();

function publish(snapshot: AgentScanSnapshot) {
  cached = snapshot;
  for (const listener of listeners) listener(snapshot);
}

function load(force: boolean): Promise<AgentScanSnapshot> {
  if (!force && cached) return Promise.resolve(cached);
  // 并发的刷新（例如两个页面同时挂载）共用一次探测。
  if (inflight) return inflight;
  inflight = agentApi
    .scan(force)
    .then((snapshot) => {
      publish(snapshot);
      return snapshot;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export type AgentScanState = {
  snapshot: AgentScanSnapshot | null;
  /** 检测结果按 runtimeId 索引，便于列表直接查。 */
  byRuntime: Map<string, AgentScanResult>;
  loading: boolean;
  error: string | null;
  /** `force` 为 true 时忽略缓存重新探测。 */
  refresh: (force?: boolean) => Promise<void>;
};

export function useAgentScan(): AgentScanState {
  const [snapshot, setSnapshot] = useState<AgentScanSnapshot | null>(cached);
  const [loading, setLoading] = useState(cached === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const listener = (next: AgentScanSnapshot) => setSnapshot(next);
    listeners.add(listener);

    let cancelled = false;
    // 首次挂载：即使缓存未过期也向 Rust 要一次，拿到上次运行落盘的结果。
    if (!cached) {
      setLoading(true);
      load(false)
        .catch((cause) => {
          if (!cancelled) setError(String(cause));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }

    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);

  // 后端的每日自动检测完成后会广播结果。
  useTauriEvent<AgentScanSnapshot>("agent://scan", (next) => publish(next));

  const refresh = useCallback(async (force = true) => {
    setLoading(true);
    setError(null);
    try {
      await load(force);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const byRuntime = useMemo(() => {
    const map = new Map<string, AgentScanResult>();
    for (const result of snapshot?.results ?? []) map.set(result.runtimeId, result);
    return map;
  }, [snapshot]);

  return { snapshot, byRuntime, loading, error, refresh };
}

/** 是否至少有可用结果；用于区分“还没检测”和“检测了但没装”。 */
export function hasScanResults(snapshot: AgentScanSnapshot | null): boolean {
  return (snapshot?.results.length ?? 0) > 0;
}
