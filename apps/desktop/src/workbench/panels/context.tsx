/**
 * Services every panel can reach without prop-drilling through the split tree.
 *
 * The host (`Workbench`) provides one object; panel components read it with
 * `usePanelServices()`. Domain data stays in the existing hooks (`useDetailPane`,
 * `useTerminalPanel`, ...) — this context only exposes what panels render and
 * the actions they may trigger.
 */
import { createContext, useContext } from "react";

import type { BugDetail, ExportResult, OpenMediaMode, WorkspaceMember } from "../../lib/api";
import type { AgentInFlight } from "../../lib/agent";
import type { ToastFn } from "../../lib/feature";
import type { TerminalMeta } from "../../lib/terminal";
import type { PanelOpenSpec, PanelRef } from "../layout/types";

/** Everything the bug detail panel needs (mirrors the old DetailPaneHost props). */
export type BugPanelServices = {
  detail: BugDetail | null;
  loading: boolean;
  error: string | null;
  exporting: boolean;
  lastExport: ExportResult | null;
  me: string | null;
  members: WorkspaceMember[];
  membersLoading: boolean;
  agentInFlight: Map<string, AgentInFlight>;
  onOpenWeb: (url: string) => void;
  onCopy: (text: string) => void;
  onExport: (detail: BugDetail) => void;
  onAgentFix: (detail: BugDetail) => void;
  onAgentCompose: (detail: BugDetail) => void;
  onOpenAgentTask: (taskId: string) => void;
  onOpenPath: (path: string) => void;
  onOpenMedia: (url: string, mode: OpenMediaMode, kind?: string, target?: string) => void;
  onRefreshMembers: () => void;
  onClaim: (detail: BugDetail) => Promise<void>;
  onAddComment: (detail: BugDetail, comment: string) => Promise<void>;
  onChangeField: (detail: BugDetail, field: string, value: string) => Promise<void>;
  onTransition: (
    detail: BugDetail,
    status: string,
    fields?: Record<string, string>,
  ) => Promise<void>;
  onClose: () => void;
};

/** Terminal sessions are backend-owned; the panel only renders one of them. */
export type TerminalPanelServices = {
  sessions: TerminalMeta[];
  /** Spawns a shell (the new session arrives through `terminal://sessions`). */
  create: () => void;
  /** Closes the PTY; the layout drops the tab once the session list updates. */
  close: (sessionId: string) => void;
  restart: (session: TerminalMeta) => void;
};

export type PanelServices = {
  toast: ToastFn;
  /** Opens or focuses another panel (explorer row → file, bug link → bug). */
  open: (spec: PanelOpenSpec) => string;
  closePanel: (panelId: string) => void;
  pinPanel: (panelId: string) => void;
  copy: (text: string) => Promise<void>;
  openPath: (path: string) => void;
  /** Display name of a project (tab labels, breadcrumbs). */
  workspaceName: (workspaceId: string) => string;
  /** Project currently selected in the side bar. */
  currentWorkspaceId: string;
  bug: BugPanelServices;
  terminal: TerminalPanelServices;
};

const PanelServicesContext = createContext<PanelServices | null>(null);

export const PanelServicesProvider = PanelServicesContext.Provider;

export function usePanelServices(): PanelServices {
  const services = useContext(PanelServicesContext);
  if (!services) {
    throw new Error("usePanelServices must be used inside <PanelServicesProvider>");
  }
  return services;
}

/** Props every panel implementation receives from the host. */
export type PanelProps = {
  panel: PanelRef;
  /** Its tab is the visible one in its group. */
  active: boolean;
};
