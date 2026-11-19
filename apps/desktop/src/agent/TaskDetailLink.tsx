/**
 * Compact link from a task back to the record it came from: the TAPD bug
 * detail panel, or the local item's project page.
 *
 * The capability comes from the agent host, so the same row works in the task
 * pane and in the end-of-transcript receipt without prop-drilling through the
 * message stream.
 */
import { SquareArrowOutUpRight } from "lucide-react";
import clsx from "clsx";

import type { DshTask } from "../lib/dsh";
import { t } from "../lib/i18n";
import { useAgentHost } from "../../../shared/agent/host";

export function TaskDetailLink({
  task,
  className,
}: {
  task: DshTask;
  className?: string;
}) {
  const host = useAgentHost();
  const project = task.project;
  const open = host.openTaskDetail;
  if (!project || !open) return null;

  const bug = task.kind === "bug" && project.kind === "tapd" && task.bugId;
  const local = task.kind === "local_item" && project.kind === "local";
  if (!bug && !local) return null;

  return (
    <button
      type="button"
      title={bug ? t("agent.task.openBug") : t("agent.task.openItem")}
      onClick={() => {
        if (bug && task.bugId) {
          open({ kind: "bug", workspaceId: project.id, bugId: task.bugId });
        } else {
          open({ kind: "local", projectId: project.id });
        }
      }}
      className={clsx(
        "inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-ui-xs text-sky-700 transition hover:bg-sky-50 hover:text-sky-800",
        className,
      )}
    >
      <SquareArrowOutUpRight size={11} />
      {bug ? t("agent.task.openBug") : t("agent.task.openItem")}
    </button>
  );
}
