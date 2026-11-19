import { useEffect } from "react";
import { Bug, Bot, Folder, ListChecks, RefreshCw, Settings, Terminal } from "lucide-react";

import { retryConnection, useConnection } from "./lib/api";
import { useAgentFeed, useAgentFeedPolling } from "./lib/dsh";
import { startHeartbeat } from "./lib/heartbeat";
import { t, type MessageKey } from "./lib/i18n";
import { navigate, useRoute, type Route } from "./lib/router";
import { getSession } from "./lib/session";
import { NotificationBanner } from "./components/NotificationBanner";
import { PairPage } from "./pages/PairPage";
import { AgentPage } from "./pages/AgentPage";
import { AgentSessionPage } from "./pages/AgentSessionPage";
import { BugsPage } from "./pages/BugsPage";
import { BugDetailPage } from "./pages/BugDetailPage";
import { CoworkersPage } from "./pages/CoworkersPage";
import { SettingsPage } from "./pages/SettingsPage";
import { FilesPage } from "./pages/FilesPage";
import { FilePage } from "./pages/FilePage";
import { LocalPage } from "./pages/LocalPage";
import { TerminalPage } from "./pages/TerminalPage";
import { TerminalSessionPage } from "./pages/TerminalSessionPage";

/** Full-screen gate: one-line title, explanation folded into `title`. */
function GateScreen(props: { title: string; hint: string; retry?: boolean }) {
  return (
    <div data-component="GateScreen" className="grid h-full place-items-center p-6" title={props.hint}>
      <div className="text-center">
        <h1 className="text-ui-lg text-slate-900">{props.title}</h1>
        {props.retry ? (
          <button
            type="button"
            onClick={retryConnection}
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
          >
            <RefreshCw size={14} />
            {t("common.retry")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

type TabKey = "bugs" | "agent" | "local" | "files" | "terminal" | "settings";

/** Tab labels store keys and resolve through `t()` at render time. */
const TABS: ReadonlyArray<{ key: TabKey; label: MessageKey; hash: string }> = [
  { key: "bugs", label: "common.bugs", hash: "#/bugs" },
  { key: "agent", label: "mobile.tab.agent", hash: "#/agent" },
  { key: "local", label: "mobile.local.title", hash: "#/local" },
  { key: "files", label: "mobile.files.title", hash: "#/files" },
  { key: "terminal", label: "mobile.terminal.title", hash: "#/terminal" },
  { key: "settings", label: "common.settings", hash: "#/settings" },
];

/** Which tab owns the current route (pushed pages keep their parent tab). */
const tabOf = (route: Route): TabKey => {
  switch (route.name) {
    case "bugs":
    case "bug":
      return "bugs";
    case "agent":
    case "agent-session":
      return "agent";
    case "local":
      return "local";
    case "coworkers":
      return "settings";
    case "files":
    case "file":
      return "files";
    case "terminal":
    case "terminal-session":
      return "terminal";
    case "settings":
      return "settings";
    default:
      return "bugs";
  }
};

function TabBar(props: { active: TabKey; agentBadge: number }) {
  return (
    <nav
      data-component="TabBar"
      aria-label={t("mobile.nav.main")}
      className="tab-bar fixed inset-x-0 bottom-0 z-30 border-t border-border bg-canvas"
    >
      <div className="flex h-14 items-stretch">
        {TABS.map((tab) => {
          const active = tab.key === props.active;
          const badge = tab.key === "agent" ? props.agentBadge : 0;
          return (
            <button
              key={tab.key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => navigate(tab.hash)}
              className={`relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 transition active:bg-overlay-soft ${
                active ? "text-slate-900" : "text-slate-400"
              }`}
            >
              <span className="relative">
                {tab.key === "bugs" ? <Bug size={18} /> : null}
                {tab.key === "agent" ? <Bot size={18} /> : null}
                {tab.key === "local" ? <ListChecks size={18} /> : null}
                {tab.key === "files" ? <Folder size={18} /> : null}
                {tab.key === "terminal" ? <Terminal size={18} /> : null}
                {tab.key === "settings" ? <Settings size={18} /> : null}
                {badge > 0 ? (
                  <span
                    title={t("mobile.agent.badgeHint", { n: badge })}
                    className="absolute -top-1.5 -right-2 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] leading-none text-white"
                  >
                    {badge > 99 ? "99+" : badge}
                  </span>
                ) : null}
              </span>
              <span className="text-ui-2xs">{t(tab.label)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export default function App() {
  const route = useRoute();
  const connection = useConnection();
  const session = getSession();
  // The task/approval feed is polled here once: the badge is part of the tab
  // bar, so the loop must live above the pages that consume the snapshot.
  const feed = useAgentFeed();
  useAgentFeedPolling(Boolean(session));
  const agentBadge =
    feed.pending.length +
    (feed.tasks ?? []).filter(
      (task) => task.workflow === "awaiting_review" || task.workflow === "finalizing",
    ).length;
  // Presence handshake: the desktop marks this device online while beats
  // arrive, and the settings page renders the same state locally.
  useEffect(() => {
    if (session) startHeartbeat();
  }, [session]);

  // Pairing is the only entry. Never rewrite the URL while there is no
  // session: a scan opens `#/pair?t=<code>`, and navigating to a bare
  // `#/pair` here would drop the code before PairPage can read it. With a
  // session, a bare `#/pair` (no code) is just a stray route.
  useEffect(() => {
    if (session && route.name === "pair" && !route.query.get("t")) {
      navigate("#/bugs");
    }
  }, [route, session]);

  if (!session) {
    return (
      <div data-component="App" className="flex h-full flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <PairPage />
        </main>
      </div>
    );
  }

  if (connection.kind === "offline") {
    return (
      <GateScreen
        title={t("mobile.gate.offlineTitle")}
        hint={t("mobile.gate.offlineHint")}
        retry
      />
    );
  }
  // Local projects/items and the built-in dsh runtime never call TAPD, so
  // those pages stay usable before the desktop signs in.
  const worksWithoutLogin =
    route.name === "local" || route.name === "agent" || route.name === "agent-session";
  if (connection.kind === "not_logged_in" && !worksWithoutLogin) {
    // The hidden poller keeps running, so this clears itself once the
    // desktop logs back in.
    return (
      <GateScreen
        title={t("mobile.desktop.notLoggedIn")}
        hint={t("mobile.gate.notLoggedInHint")}
      />
    );
  }

  // Terminal sessions take the whole screen: the key bar replaces the tab bar.
  const fullBleed = route.name === "terminal-session";
  // The session page scrolls its transcript on its own, so `main` must not
  // scroll too: two nested scrollers made the composer float over the rows.
  const ownScroll = route.name === "agent-session";

  return (
    <div data-component="App" className="flex h-full flex-col">
      {/* Mounted behind the gates too: its poll requests are what detect
          recovery (desktop back online / logged back in). */}
      {route.name !== "pair" ? <NotificationBanner /> : null}
      <main
        className={
          fullBleed
            ? "min-h-0 flex-1 overflow-hidden"
            : ownScroll
              ? "min-h-0 flex-1 overflow-hidden pb-14"
              : "min-h-0 flex-1 overflow-y-auto overscroll-contain pb-14"
        }
      >
        {route.name === "pair" ? <PairPage /> : null}
        {route.name === "bugs" ? <BugsPage /> : null}
        {route.name === "agent" ? <AgentPage /> : null}
        {route.name === "agent-session" ? (
          // One instance per session: transcript, draft and poll state must
          // not leak from the previous session when the route id changes.
          <AgentSessionPage key={route.id} id={route.id} />
        ) : null}
        {route.name === "local" ? <LocalPage projectId={route.projectId} /> : null}
        {route.name === "bug" ? (
          <BugDetailPage id={route.id} workspaceId={route.workspaceId} />
        ) : null}
        {route.name === "coworkers" ? <CoworkersPage /> : null}
        {route.name === "files" ? (
          <FilesPage workspaceId={route.workspaceId} path={route.path} />
        ) : null}
        {route.name === "file" ? (
          // Keyed by target: copied/error state must not leak between files.
          <FilePage
            key={`${route.workspaceId ?? ""}:${route.path}`}
            workspaceId={route.workspaceId}
            path={route.path}
          />
        ) : null}
        {route.name === "terminal" ? <TerminalPage /> : null}
        {route.name === "terminal-session" ? (
          // One instance per session: exit/ended/title/draft state must not
          // leak from the previous session when the route id changes.
          <TerminalSessionPage key={route.id} id={route.id} />
        ) : null}
        {route.name === "settings" ? <SettingsPage /> : null}
      </main>
      {route.name !== "pair" && !fullBleed ? (
        <TabBar active={tabOf(route)} agentBadge={agentBadge} />
      ) : null}
    </div>
  );
}
