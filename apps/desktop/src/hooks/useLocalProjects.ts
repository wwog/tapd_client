import { useCallback, useEffect, useRef, useState } from "react";

import {
  localApi,
  type LocalProject,
  type LocalProjectInput,
  type LocalProjectPatch,
} from "../lib/local";
import { readPref, writePref } from "../lib/uiPrefs";

/** Last local project the user opened; `null` means "TAPD project active". */
const PREF_KEY = "local.lastProject";

/**
 * Local projects (folders outside TAPD) and the selected one.
 *
 * Selection is mutually exclusive with a TAPD workspace: App clears it when a
 * workspace is picked and calls `select` when a local project is clicked. The
 * persisted id is restored once on load and only while it still exists, so a
 * deleted project cannot pin the local page to a missing row.
 */
export function useLocalProjects() {
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    readPref<string>(PREF_KEY),
  );
  /** The persisted selection is reconciled once, not on every null change. */
  const restored = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const { projects: next } = await localApi.listProjects();
      setProjects(next);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (loading || restored.current) return;
    restored.current = true;
    if (selectedId && projects.some((project) => project.id === selectedId)) return;
    if (selectedId === null) return;
    setSelectedId(null);
    writePref(PREF_KEY, null);
  }, [loading, projects, selectedId]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    writePref(PREF_KEY, id);
  }, []);

  const create = useCallback(async (input: LocalProjectInput) => {
    const { project } = await localApi.createProject(input);
    setProjects((current) => [
      ...current.filter((item) => item.id !== project.id),
      project,
    ]);
    return project;
  }, []);

  const update = useCallback(async (id: string, patch: LocalProjectPatch) => {
    const { project } = await localApi.updateProject(id, patch);
    setProjects((current) =>
      current.map((item) => (item.id === project.id ? project : item)),
    );
    return project;
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await localApi.deleteProject(id);
      const remaining = projects.filter((project) => project.id !== id);
      setProjects(remaining);
      if (selectedId === id) {
        const fallback = remaining[0]?.id ?? null;
        setSelectedId(fallback);
        writePref(PREF_KEY, fallback);
      }
    },
    [projects, selectedId],
  );

  return {
    projects,
    loading,
    error,
    selectedId,
    select,
    refresh,
    create,
    update,
    remove,
  };
}
