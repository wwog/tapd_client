import { useEffect } from "react";
import { Bot, Bug, RefreshCw, Settings } from "lucide-react";

import { retryConnection, useConnection } from "./lib/api";
import {
  refreshAgentTasks,
  setAgentPollMode,
  useAgentTasks,
} from "./lib/agentTasks";
import { startHeartbeat } from "./lib/heartbeat";
import { t, type MessageKey } from "./lib/i18n";
import { navigate, useRoute, type Route } from "./lib/router";
import { getSession } from "./lib/session";
import { NotificationBanner } from "./components/NotificationBanner";
import { PairPage } from "./pages/PairPage";
import { BugsPage } from "./pages/BugsPage";
import { BugDetailPage } from "./pages/BugDetailPage";
import { AgentPage } from "./pages/AgentPage";
import { AgentHistoryPage } from "./pages/AgentHistoryPage";
import { AgentTaskPage } from "./pages/AgentTaskPage";
import { CoworkersPage } from "./pages/CoworkersPage";
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
            {t("common.retry")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

type TabKey = "bugs" | "agent" | "settings";

/** Tab labels store keys and resolve through `t()` at render time. */
const TABS: ReadonlyArray<{ key: TabKey; label: MessageKey; hash: string }> = [
  { key: "bugs", label: "common.bugs", hash: "#/bugs" },
  { key: "agent", label: "mobile.tab.agent", hash: "#/agent" },
  { key: "settings", label: "common.settings", hash: "#/settings" },
];

/** Which tab owns the current route (pushed pages keep their parent tab). */
const tabOf = (route: Route): TabKey => {
  switch (route.name) {
    case "bugs":
    case "bug":
      return "bugs";
    case "agent":
    case "agent-history":
    case "agent-task":
    case "coworkers":
      return "agent";
    case "settings":
      return "settings";
    default:
      return "bugs";
  }
};

function TabBar(props: { active: TabKey; badge: number }) {
  return (
    <nav
      aria-label={t("mobile.nav.main")}
      className="tab-bar fixed inset-x-0 bottom-0 z-30 border-t border-border bg-canvas"
    >
      <div className="flex h-14 items-stretch">
        {TABS.map((tab) => {
          const active = tab.key === props.active;
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
                {tab.key === "settings" ? <Settings size={18} /> : null}
                {tab.key === "agent" && props.badge > 0 ? (
                  <span
                    aria-label={t("mobile.nav.pendingTasks", { n: props.badge })}
                    className="absolute -top-1.5 -right-2.5 min-w-4 rounded-full bg-rose-500 px-1 py-px text-center text-ui-2xs leading-3.5 text-white"
                  >
                    {props.badge > 99 ? "99+" : props.badge}
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
  const { state: agentState } = useAgentTasks();

  // Agent feed cadence follows the visible tab: 8s on Agent pages (live
  // phases), 30s elsewhere where only the badge consumes the feed.
  useEffect(() => {
    setAgentPollMode(tabOf(route) === "agent" ? "active" : "idle");
  }, [route]);

  // Presence handshake: the desktop marks this device online while beats
  // arrive, and the settings page renders the same state locally.
  useEffect(() => {
    if (session) startHeartbeat();
  }, [session]);

  // The agent feed is mounted before pairing but skips requests without a
  // session; fetch immediately once the pair handshake succeeds.
  useEffect(() => {
    if (session) void refreshAgentTasks();
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
      <div className="flex h-full flex-col">
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
  if (connection.kind === "not_logged_in") {
    // The hidden poller keeps running, so this clears itself once the
    // desktop logs back in.
    return (
      <GateScreen
        title={t("mobile.desktop.notLoggedIn")}
        hint={t("mobile.gate.notLoggedInHint")}
      />
    );
  }

  // awaiting_approval wins over queued for the Agent tab badge.
  const awaiting = agentState
    ? agentState.awaitingApprovalCount ??
      agentState.tasks.filter((task) => task.status === "awaiting_approval").length
    : 0;
  const queued = agentState
    ? agentState.queuedCount ?? agentState.tasks.filter((task) => task.status === "queued").length
    : 0;
  const badge = awaiting > 0 ? awaiting : queued;

  return (
    <div className="flex h-full flex-col">
      {/* Mounted behind the gates too: its poll requests are what detect
          recovery (desktop back online / logged back in). */}
      {route.name !== "pair" ? <NotificationBanner /> : null}
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-14">
        {route.name === "pair" ? <PairPage /> : null}
        {route.name === "bugs" ? <BugsPage /> : null}
        {route.name === "bug" ? (
          <BugDetailPage id={route.id} workspaceId={route.workspaceId} />
        ) : null}
        {route.name === "agent" ? <AgentPage /> : null}
        {route.name === "agent-history" ? <AgentHistoryPage /> : null}
        {route.name === "agent-task" ? <AgentTaskPage id={route.id} /> : null}
        {route.name === "coworkers" ? <CoworkersPage /> : null}
        {route.name === "settings" ? <SettingsPage /> : null}
      </main>
      {route.name !== "pair" ? <TabBar active={tabOf(route)} badge={badge} /> : null}
    </div>
  );
}
