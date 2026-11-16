/**
 * Local-only projects and their work items.
 *
 * These never touch TAPD: a local project is a folder on disk plus a three-state
 * item list (待处理 / 处理中 / 已完成), and any item can be handed to an Agent. The
 * commands are routed through the same `feature_command` surface as the Agent
 * and notification modules.
 */
import type { AgentTask } from "./agent";
import { featureCommand } from "./feature";

export type LocalProject = {
  id: string;
  name: string;
  repoPath: string;
  /** Appended to Agent prompts for tasks handed over from this project. */
  rule: string;
  createdAt: string;
  updatedAt: string;
};

/** Waiting, being worked on, or finished. */
export type WorkItemStatus = "pending" | "in_progress" | "done";

export type WorkItem = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  /** The Agent task this item was last handed to, if any. */
  agentTaskId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `name` is optional on create: the backend falls back to the folder basename. */
export type LocalProjectInput = {
  name?: string;
  repoPath: string;
  rule?: string;
};

export type LocalProjectPatch = {
  name?: string;
  repoPath?: string;
  rule?: string;
};

export type WorkItemInput = {
  title: string;
  description?: string;
};

export type WorkItemPatch = {
  title?: string;
  description?: string;
  status?: WorkItemStatus;
};

/** Per-task Agent options, mirroring the compose sheet. */
export type WorkItemEnqueue = {
  extraPrompt?: string | null;
  attachments?: string[];
  runtimeId?: string | null;
  model?: string | null;
  permissionMode?: string | null;
};

export const localApi = {
  listProjects: () =>
    featureCommand<{ projects: LocalProject[] }>("local_projects_list"),
  createProject: (request: LocalProjectInput) =>
    featureCommand<{ project: LocalProject }>("local_project_create", request),
  updateProject: (id: string, patch: LocalProjectPatch) =>
    featureCommand<{ project: LocalProject }>("local_project_update", {
      id,
      ...patch,
    }),
  deleteProject: (id: string) =>
    featureCommand<{ deleted: boolean }>("local_project_delete", { id }),
  listItems: (projectId: string) =>
    featureCommand<{ items: WorkItem[] }>("local_items_list", { projectId }),
  createItem: (projectId: string, input: WorkItemInput) =>
    featureCommand<{ item: WorkItem }>("local_item_create", {
      projectId,
      ...input,
    }),
  updateItem: (id: string, patch: WorkItemPatch) =>
    featureCommand<{ item: WorkItem }>("local_item_update", { id, ...patch }),
  deleteItem: (id: string) =>
    featureCommand<{ deleted: boolean }>("local_item_delete", { id }),
  /** Hands one item to an Agent and links the created task back to it. */
  enqueueItem: (id: string, options: WorkItemEnqueue = {}) =>
    featureCommand<{ task: AgentTask; item: WorkItem }>("local_item_enqueue", {
      id,
      ...options,
    }),
};
