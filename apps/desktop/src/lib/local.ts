/**
 * Local-only projects and their work items.
 *
 * These never touch TAPD: a local project is a folder on disk plus an item list
 * (待处理 / 已完成; in-progress items stay in 待处理 with a status mark).
 * Commands are routed through the same `feature_command` surface as the
 * notification module.
 */
import { featureCommand } from "./feature";

export type LocalProject = {
  id: string;
  name: string;
  repoPath: string;
  /** Appended to agent prompts for tasks handed over from this project. */
  rule: string;
  createdAt: string;
  updatedAt: string;
};

/** Waiting, being worked on, or finished. */
export type WorkItemStatus = "pending" | "in_progress" | "done";

/** User-facing importance mark; `normal` when the item was created without one. */
export type WorkItemImportance = "low" | "normal" | "high";

export type WorkItem = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: WorkItemStatus;
  importance: WorkItemImportance;
  /** Set while an agent task works on this item. */
  agentTaskId?: string | null;
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
  importance?: WorkItemImportance;
};

export type WorkItemPatch = {
  title?: string;
  description?: string;
  status?: WorkItemStatus;
  importance?: WorkItemImportance;
};

/** Tauri event emitted when a task changes an item's status or task link. */
export const LOCAL_ITEMS_EVENT = "local://items";

/** Tauri event emitted after a local project is created, edited or deleted. */
export const LOCAL_PROJECTS_EVENT = "local://projects";

export type LocalItemsEvent = {
  /** Missing/null means every open project page should refresh. */
  projectId?: string | null;
  /** Null on a project-wide refresh or a delete. */
  itemId?: string | null;
  /** Null when the item was deleted. */
  status?: WorkItemStatus | null;
};

/**
 * Imperative opener for one project's「新增事项」dialog. The button lives in
 * the tab strip (`ActiveTabExtra`), while the dialog state belongs to the page,
 * so the mounted page registers itself here and the tab simply asks for it.
 */
const itemCreateOpeners = new Map<string, () => void>();

/** Registers the page's dialog opener; returns the effect cleanup. */
export function registerLocalItemCreate(
  projectId: string,
  open: () => void,
): () => void {
  itemCreateOpeners.set(projectId, open);
  return () => {
    if (itemCreateOpeners.get(projectId) === open) itemCreateOpeners.delete(projectId);
  };
}

/** Opens the project page's create dialog; false when no page is mounted. */
export function openLocalItemCreate(projectId: string): boolean {
  const open = itemCreateOpeners.get(projectId);
  if (!open) return false;
  open();
  return true;
}

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
  getItem: (id: string) =>
    featureCommand<{ item: WorkItem }>("local_item_get", { id }),
  createItem: (projectId: string, input: WorkItemInput) =>
    featureCommand<{ item: WorkItem }>("local_item_create", {
      projectId,
      ...input,
    }),
  updateItem: (id: string, patch: WorkItemPatch) =>
    featureCommand<{ item: WorkItem }>("local_item_update", { id, ...patch }),
  deleteItem: (id: string) =>
    featureCommand<{ deleted: boolean }>("local_item_delete", { id }),
};
