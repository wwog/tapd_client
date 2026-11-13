import { RefreshCw } from "lucide-react";

import { t } from "../../lib/i18n";
import type { PageView } from "../layout/types";
import { AccountPage } from "../../components/AccountPage";
import { AgentPage } from "../../components/AgentPage";
import { BugListView } from "../../components/BugListView";
import { CoworkerPage } from "../../components/CoworkerPage";
import { McpPage } from "../../components/McpPage";
import { ProjectSettings } from "../../components/ProjectSettings";
import { SettingsPage } from "../../components/SettingsPage";
import { SkeletonRows } from "../../components/Skeleton";
import { Button } from "../../components/ui";
import type { PanelProps } from "./context";
import { usePageHost } from "../components/pageContext";

/**
 * Hosts one full page view. App no longer has a global `view` switch; every
 * page tab renders its own view from the panel resource.
 */
export function PagePanel({ panel }: PanelProps) {
  const host = usePageHost();
  const view: PageView =
    panel.resource.type === "page" ? panel.resource.view : "bugs";

  switch (view) {
    case "bugs":
      return (
        <div className="flex h-full min-h-0 flex-col">
          {host.contextError ? (
            <div className="p-5">
              <div className="rounded-xl border border-rose-100 bg-rose-50 p-4 text-ui-caption leading-6 text-rose-700">
                <div className="font-normal">{t("app.projects.loadFailed")}</div>
                <div className="mt-1 break-all">{host.contextError}</div>
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={() => void host.loadContext()}
                  icon={<RefreshCw size={13} />}
                >
                  {t("app.projects.reload")}
                </Button>
              </div>
            </div>
          ) : host.workspace ? (
            <BugListView
              key={host.workspace.id}
              workspace={host.workspace}
              me={host.context?.user.nick ?? host.info.me}
              scope={host.scope}
              onScopeChange={host.setScope}
              onOpenBug={host.onOpenBug}
              activeBugId={host.activeBugId}
              onOpenWeb={host.onOpenWeb}
              onCopy={host.onCopy}
              onAgentFix={host.onAgentFix}
              onAgentCompose={host.onAgentCompose}
              agentInFlight={host.agentInFlight}
              onOpenAgentTask={host.onOpenAgentTask}
              onCancelTask={host.onCancelTask}
              onClaim={host.onClaim}
              refreshToken={host.refreshToken}
            />
          ) : (
            <div className="min-h-0 flex-1 p-4">
              <SkeletonRows
                rows={10}
                columns={["w-2/5", "w-16", "w-12", "w-16", "w-20", "w-16", "w-24"]}
                label={t("app.projects.skeleton")}
              />
            </div>
          )}
        </div>
      );

    case "projects":
      return (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mx-auto max-w-4xl">
            <ProjectSettings
              context={host.context}
              hiddenWorkspaceIds={host.hiddenWorkspaceIds}
              onSetWorkspaceVisible={host.onSetWorkspaceVisible}
              toast={host.toast}
            />
          </div>
        </div>
      );

    case "agent":
      return (
        <AgentPage
          focusTaskId={host.agentFocusTaskId}
          focusReviewToken={host.agentReviewFocus}
          onOpenBug={host.onOpenBugById}
          toast={host.toast}
          onFocusConsumed={host.onClearAgentFocus}
        />
      );

    case "coworker":
      return <CoworkerPage toast={host.toast} />;

    case "mcp":
      return (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <McpPage
            workspaces={host.context?.workspaces ?? []}
            onCopy={host.onCopy}
            toast={host.toast}
          />
        </div>
      );

    case "account":
      return (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <AccountPage
            info={host.info}
            context={host.context}
            onShowLogin={host.onShowLogin}
            onLogout={host.onLogout}
            onRefresh={host.onRefresh}
            toast={host.toast}
          />
        </div>
      );

    default:
      return (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <SettingsPage
            info={host.info}
            onOpenPath={host.onOpenPath}
            onCopy={(text) => void host.onCopy(text)}
            onShowOnboarding={host.onShowOnboarding}
            toast={host.toast}
          />
        </div>
      );
  }
}
