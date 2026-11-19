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
import type { ToastFn } from "../../lib/feature";
import type { FileTabTarget } from "../../lib/fs";
import type { LocalProject } from "../../lib/local";
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
  /**
   * Bug detail currently loaded by the workbench, for the list highlight.
   * Each project page compares its own workspace against this target.
   */
  activeBug: { workspaceId: string; bugId: string } | null;
  /** Local (non-TAPD) projects and the one selected in the side bar. */
  localProjects: LocalProject[];
  localProject: LocalProject | null;
  localLoading: boolean;
  localError: string | null;
  projectsKnown: boolean;
  hiddenWorkspaceIds: string[];
  refreshToken: number;
  toast: ToastFn;
  onOpenBug: (bug: BugSummary) => void;
  onOpenBugById: (workspaceId: string, bugId: string) => void;
  /** Selects a workflow task and opens the Agent page on it. */
  onOpenAgentTask: (sessionId: string) => void;
  /** Opens one local work item in the secondary detail panel. */
  onOpenLocalItem: (
    projectId: string,
    itemId: string,
    label?: string,
  ) => void;
  /** Brings the global workflow queue page to the front. */
  onOpenQueue: () => void;
  /** Cancels a queued/running task (the row reports failures as a toast). */
  onCancelAgentTask: (sessionId: string) => Promise<void>;
  /** Opens a URL outside the app (TAPD links, media). */
  onOpenWeb: (url: string) => void;
  /** Reveals a local path in the OS. */
  onOpenPath: (path: string) => void;
  onCopy: (text: string) => Promise<void>;
  onClaim: (bug: BugSummary) => Promise<void>;
  onSetWorkspaceVisible: (workspaceId: string, visible: boolean) => void;
  onSelectLocalProject: (id: string) => void;
  onCreateLocalProject: () => void;
  onEditLocalProject: (project: LocalProject) => void;
  onDeleteLocalProject: (project: LocalProject) => void;
  onOpenMedia: (url: string, mode: OpenMediaMode, kind?: string, target?: string) => void;
  /** Opens a local path from an agent reply in a new file-viewer tab. */
  onOpenFile: (target: FileTabTarget) => void;
  /** Opens the project settings page from a page that needs a repository. */
  onOpenProjects: () => void;
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
