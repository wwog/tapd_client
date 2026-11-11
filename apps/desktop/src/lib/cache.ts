import { featureCommand } from "./feature";
import type {
  BugDetail,
  BugListPage,
  BugQuery,
  WorkspaceContext,
  WorkspaceMember,
} from "./api";

/**
 * A cached payload returned by the Rust offline cache. `fetchedAt` is a Unix
 * timestamp in seconds; `data === null` means there is no snapshot yet (first
 * launch / after logout).
 */
export type Cached<T> = {
  data: T | null;
  fetchedAt: number | null;
};

export const cacheApi = {
  workspaceContext: () =>
    featureCommand<Cached<WorkspaceContext>>("cache_workspace_context"),
  bugList: (query: BugQuery) =>
    featureCommand<Cached<BugListPage>>("cache_bug_list", { query }),
  bugDetail: (workspaceId: string, bugId: string) =>
    featureCommand<Cached<BugDetail>>("cache_bug_detail", { workspaceId, bugId }),
  workspaceMembers: (workspaceId: string) =>
    featureCommand<Cached<WorkspaceMember[]>>("cache_workspace_members", {
      workspaceId,
    }),
};
