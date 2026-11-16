import { useCallback, useEffect, useState } from "react";

import type { AgentRuntimeStatus } from "../lib/agent";
import { chatApi, type ChatSessionView } from "../lib/chat";
import { useTauriEvent } from "../lib/tauriEvent";

export type ChatSessionsState = {
  /** null 表示首帧还没拿到列表。 */
  sessions: ChatSessionView[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

/**
 * 对话会话列表。
 *
 * 后端在会话生命周期变化时推送 `chat://state` 整表；运行中的状态复用
 * `agent://runtime`，只更新本页已有的会话，避免每条 hook 都重拉列表。
 */
export function useChatSessions(): ChatSessionsState {
  const [sessions, setSessions] = useState<ChatSessionView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await chatApi.sessions();
      setSessions(result.sessions);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useTauriEvent<{ sessions: ChatSessionView[] }>("chat://state", (payload) => {
    setSessions(payload.sessions);
    setLoading(false);
    setError(null);
  });

  useTauriEvent<{ taskId: string; status: AgentRuntimeStatus | null }>(
    "agent://runtime",
    (payload) => {
      setSessions((current) => {
        if (!current) return current;
        const index = current.findIndex((session) => session.id === payload.taskId);
        if (index < 0) return current;
        const next = current.slice();
        const session = next[index];
        next[index] = payload.status
          ? { ...session, runtime: payload.status }
          : { ...session, runtime: undefined };
        return next;
      });
    },
  );

  return { sessions, loading, error, refresh };
}
