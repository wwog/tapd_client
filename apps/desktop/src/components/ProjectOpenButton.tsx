import { useEffect, useState } from "react";

import { agentSettingsApi } from "../lib/agentSettings";
import { api } from "../lib/api";
import { OpenWithButton } from "./OpenWithButton";

type Props = {
  workspaceId: string;
  onError: (message: string) => void;
};

/**
 * Header button for the folder bound to a TAPD project. The app list is the
 * `directory` kind, which only offers code editors (VS Code, Xcode, Zed,
 * Cursor) plus Finder — folders never go to a browser or an image viewer.
 */
export function ProjectOpenButton({ workspaceId, onError }: Props) {
  const [repoPath, setRepoPath] = useState("");

  // The folder lives in the agent settings, so re-read it whenever the project
  // changes. Switching views remounts this button, which picks up edits made
  // in 项目管理.
  useEffect(() => {
    let cancelled = false;
    setRepoPath("");

    void agentSettingsApi
      .get()
      .then((config) => {
        if (cancelled) return;
        setRepoPath((config.projects?.[workspaceId]?.repoPath ?? "").trim());
      })
      .catch(() => {
        // No config means no bound folder; the header stays clean.
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (!repoPath) return null;

  return (
    <OpenWithButton
      kind="directory"
      path={repoPath}
      onOpen={(target) => api.openDirectory(repoPath, target)}
      onError={onError}
    />
  );
}
