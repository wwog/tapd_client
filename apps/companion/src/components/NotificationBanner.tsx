import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { api, useConnection, type CompanionNotification } from "../lib/api";
import { navigate } from "../lib/router";
import { getSession } from "../lib/session";
import { isPageHidden, onPageVisibilityChange } from "../lib/visibility";

const SEEN_KEY = "companion.notifSeenAt";
const POLL_MS = 30_000;

const stampOf = (item: CompanionNotification): number => {
  const timestamp = Date.parse(item.detectedAt || item.created);
  return Number.isNaN(timestamp) ? Date.now() : timestamp;
};

const readSeenAt = (): number => {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
};

/** Local read marker; phone-side only, never written back to the desktop. */
const markSeen = (at: number): void => {
  try {
    localStorage.setItem(SEEN_KEY, String(Math.max(at, readSeenAt())));
  } catch {
    // Ignore.
  }
};

/**
 * HTTPS (tunnel) only: system-level Web Notification. HTTP LAN keeps the
 * in-page banner; any failure here falls back to it silently.
 */
async function raiseSystemNotification(title: string, count: number): Promise<void> {
  if (!(window.isSecureContext && "serviceWorker" in navigator)) return;
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") return;
    new Notification("TAPD 伴侣", {
      body: count > 1 ? `${title} 等 ${count} 条新通知` : title,
      tag: "companion-notification",
    });
  } catch {
    // In-page banner already covers this item.
  }
}

type Fresh = {
  title: string;
  bugId: string;
  workspaceId: string | null;
  count: number;
  at: number;
};

/**
 * Mirrors the desktop notification engine: 30s poll, diffed against the local
 * last-seen marker. Mounted on every route (also behind the offline /
 * not-logged-in gates) because its poll is what notices recovery.
 */
export function NotificationBanner() {
  const connection = useConnection();
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const latestStampRef = useRef(0);

  useEffect(() => {
    if (!getSession()) return;
    let stopped = false;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const items = await api.notifications();
        if (stopped) return;
        const seenAt = readSeenAt();
        const newest = [...items]
          .sort((a, b) => stampOf(b) - stampOf(a))
          .filter((item) => stampOf(item) > seenAt);
        if (newest.length === 0) return;
        const latest = newest[0];
        const at = stampOf(latest);
        if (at > latestStampRef.current) {
          latestStampRef.current = at;
          // Side effects only for genuinely newer items, not re-polls.
          void raiseSystemNotification(latest.title, newest.length);
          if (navigator.vibrate) navigator.vibrate(200);
        }
        setFresh((prev) =>
          prev && prev.at >= at && prev.bugId === latest.bugId
            ? prev
            : {
                title: latest.title,
                bugId: latest.bugId,
                workspaceId: latest.workspaceId,
                count: newest.length,
                at,
              },
        );
      } catch {
        // Poll failures surface through the connection gate.
      }
    };
    const start = () => {
      if (timer === null && !stopped && !isPageHidden()) {
        timer = window.setInterval(() => void tick(), POLL_MS);
      }
    };
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    void tick();
    start();
    // 隐藏暂停轮询；恢复可见时只在真的暂停过的情况下立即补一轮。
    const offVisibility = onPageVisibilityChange(() => {
      if (isPageHidden()) {
        stop();
      } else if (timer === null && !stopped) {
        void tick();
        start();
      }
    });
    return () => {
      stopped = true;
      stop();
      offVisibility();
    };
  }, []);

  if (!fresh || connection.kind !== "ok" || !getSession()) return null;

  const open = () => {
    markSeen(fresh.at);
    setFresh(null);
    if (!fresh.bugId) return;
    navigate(
      fresh.workspaceId
        ? `#/bug/${fresh.bugId}?w=${encodeURIComponent(fresh.workspaceId)}`
        : `#/bug/${fresh.bugId}`,
    );
  };

  const dismiss = () => {
    markSeen(fresh.at);
    setFresh(null);
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-2">
      <button type="button" onClick={open} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-ui-caption text-slate-900">{fresh.title}</span>
        {fresh.count > 1 ? (
          <span className="text-ui-xs text-slate-400">{fresh.count} 条新通知</span>
        ) : null}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="关闭"
        className="shrink-0 rounded-md p-1 text-slate-400 transition active:bg-overlay-soft"
      >
        <X size={16} />
      </button>
    </div>
  );
}
