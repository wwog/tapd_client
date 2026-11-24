import { createContext, useContext, type ReactNode } from "react";

import type { AgentUsage } from "./types";

/**
 * Capabilities the host app injects for the parts of the chat view that are
 * app-specific: rich Markdown rendering, the usage popover, reading local
 * image bytes. Everything here has a plain fallback, so a host may pass none
 * of them and the view still renders.
 */
export type AgentHost = {
  /** Renders assistant text as Markdown; the default is pre-wrapped plain text. */
  renderMarkdown?: (source: string) => ReactNode;
  /** Renders the per-reply usage chip under a message; default hides it. */
  renderUsage?: (usage: AgentUsage, provider?: string, model?: string) => ReactNode;
  /** Reads a local image into a data URL for a `read_image` result preview. */
  loadImage?: (path: string) => Promise<string>;
  /** Opens an inline picture in the app's full-screen media preview. */
  previewImage?: (item: { src: string; label: string }) => void;
  /** Reads one prompt attachment (dsh store) into a data URL. */
  loadAttachmentImage?: (image: {
    attachmentId: string;
    mediaType: string;
  }) => Promise<string>;
  /** Reveals a `@path` mention in the host file system. */
  openPath?: (path: string) => void;
  /**
   * Opens a changed file as a diff against the task's baseline. Hosts that can
   * show diffs (the desktop workbench) inject it; the change card falls back to
   * `openPath` when they do not.
   */
  openDiff?: (path: string) => void;
  /** Opens the source record a task came from (bug detail, local item page). */
  openTaskDetail?: (
    target:
      | { kind: "bug"; workspaceId: string; bugId: string }
      | { kind: "local"; projectId: string },
  ) => void;
};

const DEFAULT_HOST: AgentHost = {};

const HostContext = createContext<AgentHost>(DEFAULT_HOST);

/** Provides host capabilities above the shared chat view (once per page). */
export const AgentHostProvider = HostContext.Provider;

/** The host capabilities in scope; safe to call anywhere inside the view. */
export function useAgentHost(): AgentHost {
  return useContext(HostContext);
}
