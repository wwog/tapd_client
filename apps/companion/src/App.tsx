import { useEffect } from "react";
import { RefreshCw } from "lucide-react";

import { retryConnection, useConnection } from "./lib/api";
import { navigate, useRoute } from "./lib/router";
import { getSession } from "./lib/session";
import { NotificationBanner } from "./components/NotificationBanner";
import { PairPage } from "./pages/PairPage";
import { BugsPage } from "./pages/BugsPage";
import { BugDetailPage } from "./pages/BugDetailPage";
import { SettingsPage } from "./pages/SettingsPage";

/** Full-screen gate: one-line title, explanation folded into `title`. */
function GateScreen(props: { title: string; hint: string; retry?: boolean }) {
  return (
    <div className="grid h-full place-items-center p-6" title={props.hint}>
      <div className="text-center">
        <h1 className="text-ui-lg text-slate-900">{props.title}</h1>
        {props.retry ? (
          <button
            type="button"
            onClick={retryConnection}
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
          >
            <RefreshCw size={14} />
            重试
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const connection = useConnection();
  const session = getSession();

  // Pairing is the only entry: without a session every route is #/pair,
  // with one #/pair is only kept when it carries a fresh pairing code.
  useEffect(() => {
    if (!session && route.name !== "pair") navigate("#/pair");
    if (session && route.name === "pair" && !route.query.get("t")) {
      navigate("#/bugs");
    }
  }, [route, session]);

  if (!session && route.name !== "pair") return null;

  if (connection.kind === "offline") {
    return <GateScreen title="桌面端掉线" hint="无法连接桌面端，恢复网络后重试。" retry />;
  }
  if (connection.kind === "not_logged_in") {
    // The hidden poller keeps running, so this clears itself once the
    // desktop logs back in.
    return <GateScreen title="桌面端未登录" hint="桌面端登录后本页会自动恢复。" />;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Mounted behind the gates too: its poll requests are what detect
          recovery (desktop back online / logged back in). */}
      {route.name !== "pair" ? <NotificationBanner /> : null}
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {route.name === "pair" ? <PairPage /> : null}
        {route.name === "bugs" ? <BugsPage /> : null}
        {route.name === "bug" ? (
          <BugDetailPage id={route.id} workspaceId={route.workspaceId} />
        ) : null}
        {route.name === "settings" ? <SettingsPage /> : null}
      </main>
    </div>
  );
}
