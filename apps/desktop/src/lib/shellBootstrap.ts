/**
 * Locally stored snapshots read before the first render.
 *
 * The project column's visibility depends on data that used to arrive one tick
 * after mount (`app_info` for hidden projects, the cached workspace context for
 * the project count, the local project list). The column was therefore hidden
 * on the first frame and popped in as soon as those resolved. The native window
 * stays hidden until the first paint, so reading the same snapshots while it is
 * still invisible costs no flash and makes the first frame final.
 */
import { api, type AppInfo, type WorkspaceContext } from "./api";
import { cacheApi } from "./cache";
import { localApi, type LocalProject } from "./local";

export type ShellBootstrap = {
  /** Whether the snapshots below are real reads (not the empty defaults). */
  ready: boolean;
  info: AppInfo | null;
  context: WorkspaceContext | null;
  localProjects: LocalProject[];
};

let snapshot: ShellBootstrap = {
  ready: false,
  info: null,
  context: null,
  localProjects: [],
};

/** Loads the snapshots; failures keep the empty defaults and normal loading. */
export async function preloadShellBootstrap(): Promise<void> {
  const [info, context, local] = await Promise.allSettled([
    api.appInfo(),
    cacheApi.workspaceContext(),
    localApi.listProjects(),
  ]);
  snapshot = {
    ready: true,
    info: info.status === "fulfilled" ? info.value : null,
    context: context.status === "fulfilled" ? context.value.data : null,
    localProjects: local.status === "fulfilled" ? local.value.projects : [],
  };
}

export function shellBootstrap(): ShellBootstrap {
  return snapshot;
}
