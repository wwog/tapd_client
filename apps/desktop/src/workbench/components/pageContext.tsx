/**
 * Data and actions the page panels render. This is view-layer context created
 * by `App`; the frozen `workbench/panels/context.tsx` only carries panel
 * services (bug detail, terminals, open/close).
 */
import { createContext, useContext } from "react";

import type {
  AppInfo,
  BugSummary,
  OpenMediaMode,
  Workspace,
  WorkspaceContext,
} from "../../lib/api";
import type { AgentInFlight } from "../../lib/agent";
import type { ToastFn } from "../../lib/feature";
import type { BugScope } from "../../components/bugListPrefs";

export type PageHostServices = {
  info: AppInfo;
  context: WorkspaceContext | null;
  contextLoading: boolean;
  contextError: string | null;
  workspace: Workspace | null;
  workspaceId: string;
  scope: BugScope;
  setScope: (scope: BugScope) => void;
  /** Bug detail currently loaded by the workbench, for the list highlight. */
  activeBugId: string | null;
  projectsKnown: boolean;
  hiddenWorkspaceIds: string[];
  agentInFlight: Map<string, AgentInFlight>;
  agentFocusTaskId: string | null;
  agentReviewFocus: number;
  refreshToken: number;
  toast: ToastFn;
  onOpenBug: (bug: BugSummary) => void;
  onOpenBugById: (workspaceId: string, bugId: string) => void;
  /** Opens a URL outside the app (TAPD links, media). */
  onOpenWeb: (url: string) => void;
  /** Reveals a local path in the OS. */
  onOpenPath: (path: string) => void;
  onCopy: (text: string) => Promise<void>;
  onClaim: (bug: BugSummary) => Promise<void>;
  onAgentFix: (bug: BugSummary) => void;
  onAgentCompose: (bug: BugSummary) => void;
  onOpenAgentTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => Promise<void> | void;
  onClearAgentFocus: () => void;
  onSetWorkspaceVisible: (workspaceId: string, visible: boolean) => void;
  onOpenMedia: (url: string, mode: OpenMediaMode, kind?: string, target?: string) => void;
  loadContext: () => Promise<void> | void;
  refreshBase: () => Promise<void> | void;
  onShowLogin: () => void;
  onLogout: () => void;
  onRefresh: () => void;
  onShowOnboarding: () => void;
};

const PageHostContext = createContext<PageHostServices | null>(null);

export const PageHostProvider = PageHostContext.Provider;

export function usePageHost(): PageHostServices {
  const value = useContext(PageHostContext);
  if (!value) {
    throw new Error("usePageHost must be used inside <PageHostProvider>");
  }
  return value;
}
