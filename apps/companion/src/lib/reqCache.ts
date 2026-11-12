/**
 * Module-level request cache with stale-while-revalidate semantics:
 *
 * - `cached(key, ttl, loader)` resolves immediately with the cached value when
 *   it is still fresh (<= ttl), WITHOUT issuing a request.
 * - When the value is stale it returns the old value right away and
 *   revalidates in the background; subscribers are notified once fresh data
 *   lands (pages re-read via `cached`, which is then a fresh hit).
 * - A cache miss loads once even under concurrent callers.
 *
 * 页面隐藏（visibilitychange）暂停所有轮询；写操作成功后用 `invalidate` /
 * `invalidatePrefix` 精确丢弃对应键，下一次读取自动回源。
 *
 * -------------------------------------------------------------------------
 * 请求频次预算（后续优化的事实源）
 * -------------------------------------------------------------------------
 * 端点                              触发时机                                频次上限
 * --------------------------------  --------------------------------------  ---------------------------
 * GET  /companion/api/state         缺陷页挂载（「我的」scope 需要 me）      TTL 15s，命中不发请求
 * GET  /companion/api/workspaces    缺陷页挂载                              TTL 5min
 * POST /companion/api/bugs          挂载 / 查询变化 / 翻页 / 排序 / 范围     每个查询键 TTL 30s（SWR）
 * GET  /companion/api/bug           详情挂载 / 写操作成功后                 每 bug TTL 60s（SWR）
 * GET  /companion/api/bug/transitions  打开「状态流转」sheet                每 bug TTL 60s（SWR）
 * GET  /companion/api/members       筛选面板展开 / 切换项目                 每项目 TTL 30min（lib/members.ts，
 *                                                                          内存 + sessionStorage；服务端另有 2h）
 * GET  /companion/api/notifications 30s 轮询（全页面，兼掉线探针）           30s，隐藏暂停
 * POST /companion/api/feature
 *      agent_tasks_list             Agent 页/任务详情 8s；其他页面 30s       隐藏暂停；恢复可见立即补一轮
 *                                   （角标）                                （lib/agentTasks.ts）
 * POST /companion/api/bug/comment   仅用户点击触发                          成功后失效详情 + 该项目列表键
 * POST /companion/api/bug/update-field / transition / claim  同上          同上
 * POST /companion/api/feature
 *      agent_enqueue_bug            仅用户点击「入队」触发                  成功后失效该项目列表键
 *
 * 其他：搜索输入 300ms 防抖保持；不做下拉刷新，列表新鲜度完全依赖 SWR 过期后台刷新。
 * -------------------------------------------------------------------------
 */

type Entry = {
  /** Last resolved value; `undefined` only while the first load is in flight. */
  value: unknown;
  /** Epoch ms of `value`; 0 while loading. */
  at: number;
  /** In-flight load/revalidation promise, used for dedup and cleanup. */
  refreshing: Promise<unknown> | null;
};

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

const emit = (key: string): void => {
  for (const listener of listeners.get(key) ?? []) listener();
};

/** Re-read helper for subscribers: run `cached` again, now a fresh hit. */
export function subscribeCache(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/**
 * Cached read. Fresh hits resolve synchronously; stale hits resolve with the
 * old value while a single background revalidation runs; misses load once.
 * The returned promise rejects on miss-load failure; stale revalidation
 * failures keep the old value and are swallowed (the read already resolved).
 */
export function cached<T>(key: string, maxAgeMs: number, loader: () => Promise<T>): Promise<T> {
  const entry = entries.get(key);
  if (!entry) {
    const pending = loader().then(
      (value) => {
        entries.set(key, { value, at: Date.now(), refreshing: null });
        emit(key);
        return value;
      },
      (err) => {
        const current = entries.get(key);
        if (current && current.refreshing === pending) entries.delete(key);
        throw err;
      },
    );
    entries.set(key, { value: undefined, at: 0, refreshing: pending });
    return pending;
  }

  // First load still in flight (`at === 0`): await it instead of handing out
  // the not-yet-existing value (concurrent callers, StrictMode double effects).
  if (entry.at === 0 && entry.refreshing) {
    return entry.refreshing as Promise<T>;
  }

  if (Date.now() - entry.at <= maxAgeMs) {
    return Promise.resolve(entry.value as T);
  }

  if (!entry.refreshing) {
    const revalidate = loader().then(
      (value) => {
        entries.set(key, { value, at: Date.now(), refreshing: null });
        emit(key);
        return value;
      },
      () => {
        // Keep serving the stale value; allow a later read to retry.
        const current = entries.get(key);
        if (current && current.refreshing === revalidate) current.refreshing = null;
        throw new Error("revalidate-failed");
      },
    );
    entry.refreshing = revalidate;
    revalidate.catch(() => {});
  }
  return Promise.resolve(entry.value as T);
}

/** Drops one key; subscribers re-read (a miss) on their next tick. */
export function invalidate(key: string): void {
  entries.delete(key);
  emit(key);
}

/** Drops every key under a prefix, e.g. all list pages of one workspace. */
export function invalidatePrefix(prefix: string): void {
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) {
      entries.delete(key);
      emit(key);
    }
  }
}

/* -- Key scheme shared by pages and write paths --------------------------- */

export const STATE_KEY = "state";
export const WORKSPACES_KEY = "workspaces";

export const bugListPrefix = (workspaceId: string): string => `bugs.${workspaceId}.`;
export const bugDetailKey = (workspaceId: string, bugId: string): string =>
  `bug.${workspaceId}.${bugId}`;
export const transitionsKey = (workspaceId: string, bugId: string): string =>
  `transitions.${workspaceId}.${bugId}`;

/** Bug writes (claim / transition / comment / enqueue) invalidate the bug's
 * detail, its transitions and every list key of the workspace. */
export function invalidateBug(workspaceId: string, bugId: string): void {
  invalidate(bugDetailKey(workspaceId, bugId));
  invalidate(transitionsKey(workspaceId, bugId));
  invalidatePrefix(bugListPrefix(workspaceId));
}

/* -- Shared TTLs (see the budget table above) ------------------------------ */

export const TTL = {
  state: 15_000,
  workspaces: 5 * 60_000,
  bugs: 30_000,
  bugDetail: 60_000,
  transitions: 60_000,
} as const;
