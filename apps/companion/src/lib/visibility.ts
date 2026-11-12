/**
 * Page visibility shared by every poller: hidden pauses timers, becoming
 * visible again fires listeners so they can catch up immediately.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let installed = false;

function install(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("visibilitychange", () => {
    // 嵌入式 webview 可能在属性更新前就派发事件；推迟一个宏任务，
    // 让 handler 读到稳定后的 visibilityState（决定暂停/补一轮）。
    window.setTimeout(() => {
      for (const listener of listeners) listener();
    }, 0);
  });
}

export const isPageHidden = (): boolean =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

export function onPageVisibilityChange(listener: Listener): () => void {
  install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
