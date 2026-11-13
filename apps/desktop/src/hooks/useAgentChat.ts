import { useEffect, useRef, useState } from "react";

import { agentApi, type AgentChat } from "../lib/agent";

export type AgentChatState = {
  data: AgentChat | null;
  /** 命令级错误（网络 / 任务不存在）；transcript 自身错误在 `data.error`。 */
  error: string | null;
  loading: boolean;
};

/**
 * 按需拉取一个任务的 transcript。
 *
 * - 任务运行中：每秒拉一次；页面隐藏时跳过请求，恢复可见后自动继续。
 * - 任务结束 / 只读查看：只拉一次，避免无意义轮询。
 * - 切换任务立即清空旧数据，防止上一个任务的对话串到新任务里。
 */
export function useAgentChat(taskId: string | null, enabled: boolean): AgentChatState {
  const [data, setData] = useState<AgentChat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const lastTaskRef = useRef<string | null>(null);
  const fingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    // 只有切换任务才清空；任务结束时 enabled 变 false，保留最后一帧 transcript。
    if (lastTaskRef.current !== taskId) {
      lastTaskRef.current = taskId;
      fingerprintRef.current = null;
      setData(null);
      setError(null);
    }
    if (!taskId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;
    setLoading(true);

    const load = async () => {
      if (cancelled || inFlight || document.hidden) return;
      inFlight = true;
      try {
        const next = await agentApi.chat(taskId, fingerprintRef.current);
        if (!cancelled) {
          // 后端命中指纹时返回 unchanged，连消息数组都不用传输。
          if (!next.unchanged) {
            if (!next.error) fingerprintRef.current = next.fingerprint;
            // 指纹没变（或错误文案没变）时复用同一个对象，React 会跳过重绘。
            setData((previous) =>
              previous &&
              !next.error &&
              !previous.error &&
              previous.fingerprint === next.fingerprint
                ? previous
                : previous && next.error && previous.error === next.error
                  ? previous
                  : next,
            );
          }
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };

    if (enabledRef.current) {
      const tick = () => {
        if (cancelled) return;
        void load().finally(() => {
          if (!cancelled) timer = window.setTimeout(tick, 1000);
        });
      };
      tick();
    } else {
      void load();
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [taskId, enabled]);

  return { data, error, loading };
}
