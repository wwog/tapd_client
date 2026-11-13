import clsx from "clsx";
import type { MouseEvent as ReactMouseEvent } from "react";

import type {
  BugDetail,
  ExportResult,
  OpenMediaMode,
  WorkspaceMember,
} from "../lib/api";
import type { AgentInFlight } from "../lib/agent";
import { BugDetailDrawer } from "./BugDetailDrawer";
import { t } from "../lib/i18n";

type Props = {
  rendered: boolean;
  open: boolean;
  width: number;
  resizing: boolean;
  onResizeStart: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  detail: BugDetail | null;
  loading: boolean;
  error: string | null;
  exporting: boolean;
  lastExport: ExportResult | null;
  onClose: () => void;
  onOpenWeb: (url: string) => void;
  onCopy: (text: string) => void;
  onExport: (detail: BugDetail) => void;
  onAgentFix: (detail: BugDetail) => void;
  onAgentCompose: (detail: BugDetail) => void;
  agentInFlight: Map<string, AgentInFlight>;
  onOpenAgentTask: (taskId: string) => void;
  onOpenPath: (path: string) => void;
  onOpenMedia: (
    url: string,
    mode: OpenMediaMode,
    kind?: string,
    target?: string,
  ) => void;
  me: string | null;
  members: WorkspaceMember[];
  membersLoading: boolean;
  onRefreshMembers: () => void;
  onClaim: (detail: BugDetail) => Promise<void>;
  onAddComment: (detail: BugDetail, comment: string) => Promise<void>;
  onChangeField: (detail: BugDetail, field: string, value: string) => Promise<void>;
  onTransition: (
    detail: BugDetail,
    status: string,
    fields?: Record<string, string>,
  ) => Promise<void>;
};

/**
 * Right detail pane (Codex-style): part of the layout, so the top drag strip
 * stays reachable while it is open. Delegates content to BugDetailDrawer.
 */
export function DetailPaneHost({
  rendered,
  open,
  width,
  resizing,
  onResizeStart,
  detail,
  loading,
  error,
  exporting,
  lastExport,
  onClose,
  onOpenWeb,
  onCopy,
  onExport,
  onAgentFix,
  onAgentCompose,
  agentInFlight,
  onOpenAgentTask,
  onOpenPath,
  onOpenMedia,
  me,
  members,
  membersLoading,
  onRefreshMembers,
  onClaim,
  onAddComment,
  onChangeField,
  onTransition,
}: Props) {
  if (!rendered) return null;

  return (
    <div
      aria-hidden={!open}
      inert={!open}
      // Animate the pane's own width instead of sliding it in: the list
      // beside it shrinks in the same frames, so the shared edge moves as
      // one piece. The content is pinned to the right edge of the pane so
      // it is revealed rather than dragged across the screen.
      className={clsx(
        "relative flex h-full shrink-0 justify-end overflow-hidden",
        !resizing && "transition-[width] duration-300 ease-out",
      )}
      style={{ width: open ? width : 0 }}
    >
      <div className="flex h-full shrink-0 flex-col pb-2 pr-2" style={{ width }}>
        <BugDetailDrawer
          open={open}
          detail={detail}
          loading={loading}
          error={error}
          exporting={exporting}
          lastExport={lastExport}
          onClose={onClose}
          onOpenWeb={onOpenWeb}
          onCopy={onCopy}
          onExport={onExport}
          onAgentFix={onAgentFix}
          onAgentCompose={onAgentCompose}
          agentInFlight={agentInFlight}
          onOpenAgentTask={onOpenAgentTask}
          onOpenPath={onOpenPath}
          onOpenMedia={onOpenMedia}
          me={me}
          members={members}
          membersLoading={membersLoading}
          onRefreshMembers={onRefreshMembers}
          onClaim={onClaim}
          onAddComment={onAddComment}
          onChangeField={onChangeField}
          onTransition={onTransition}
        />
      </div>

      {open ? (
        <button
          type="button"
          aria-label={t("app.detail.resize")}
          title={t("app.detail.resizeHint")}
          onMouseDown={onResizeStart}
          className={clsx(
            "absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize",
            resizing ? "bg-sky-400/50" : "bg-transparent transition hover:bg-overlay",
          )}
        />
      ) : null}
    </div>
  );
}
