/**
 * Directory loading and expansion state for one explorer panel.
 *
 * The tree is lazy: `load(path)` fetches exactly one level and caches it, and
 * `buildRows` flattens only the directories the user has expanded. Expanded
 * paths persist per workspace under `uiPrefs["explorer.tree.v1"]`.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { fsApi, type FsEntry, type FsListing } from "../../lib/fs";
import { readPref, writePref } from "../../lib/uiPrefs";

export type DirState = {
  status: "loading" | "ready" | "error";
  listing?: FsListing;
  error?: string;
};

export type ExplorerRow =
  | { kind: "entry"; entry: FsEntry; depth: number }
  | {
      kind: "note";
      path: string;
      depth: number;
      note: "loading" | "error" | "empty";
      message?: string;
    };

/** Flattens the expanded part of the tree into renderable rows. */
export function buildRows(
  dirs: Record<string, DirState>,
  expanded: Set<string>,
  showHidden: boolean,
): ExplorerRow[] {
  const rows: ExplorerRow[] = [];

  const walk = (dir: string, depth: number): void => {
    const state = dirs[dir];
    if (!state || state.status !== "ready" || !state.listing) return;
    const entries = state.listing.entries.filter(
      (entry) => showHidden || !entry.hidden,
    );
    if (depth > 0 && entries.length === 0) {
      rows.push({ kind: "note", path: dir, depth, note: "empty" });
      return;
    }
    for (const entry of entries) {
      rows.push({ kind: "entry", entry, depth });
      // Symlinked directories are only known after `fs_stat`, but once the
      // panel expands one we render its listing like any other directory.
      if (
        (entry.kind !== "dir" && entry.kind !== "symlink") ||
        !expanded.has(entry.path)
      ) {
        continue;
      }
      const child = dirs[entry.path];
      if (!child || child.status === "loading") {
        rows.push({ kind: "note", path: entry.path, depth: depth + 1, note: "loading" });
      } else if (child.status === "error") {
        rows.push({
          kind: "note",
          path: entry.path,
          depth: depth + 1,
          note: "error",
          message: child.error,
        });
      } else {
        walk(entry.path, depth + 1);
      }
    }
  };

  walk("", 0);
  return rows;
}

/**
 * One listing request per path at a time. A refresh bumps the generation so
 * responses from the previous tree are dropped instead of resurrecting stale
 * directories.
 */
export function useExplorerTree(workspaceId: string): {
  dirs: Record<string, DirState>;
  load: (path: string) => void;
  refresh: (paths: string[]) => void;
} {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [epoch, setEpoch] = useState(0);
  const inFlight = useRef(new Set<string>());
  const loaded = useRef(new Set<string>());
  const generation = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    (path: string) => {
      if (loaded.current.has(path) || inFlight.current.has(path)) return;
      inFlight.current.add(path);
      const run = generation.current;

      setDirs((previous) => {
        if (previous[path]?.status === "ready") return previous;
        return { ...previous, [path]: { status: "loading" } };
      });

      fsApi
        .list({ workspaceId, path })
        .then((listing) => {
          if (!alive.current || run !== generation.current) return;
          loaded.current.add(path);
          setDirs((previous) => ({
            ...previous,
            [path]: { status: "ready", listing },
          }));
        })
        .catch((error: unknown) => {
          if (!alive.current || run !== generation.current) return;
          setDirs((previous) => ({
            ...previous,
            [path]: { status: "error", error: String(error) },
          }));
        })
        .finally(() => {
          if (run === generation.current) inFlight.current.delete(path);
        });
    },
    [workspaceId],
  );

  const refresh = useCallback(
    (paths: string[]) => {
      generation.current += 1;
      inFlight.current.clear();
      loaded.current.clear();
      setDirs({});
      setEpoch((value) => value + 1);
      load("");
      for (const path of paths) load(path);
    },
    [load],
  );

  // Root (and every refresh) always loads; `load` dedupes in-flight paths.
  useEffect(() => {
    load("");
  }, [load, epoch]);

  return { dirs, load, refresh };
}

const PREF_KEY = "explorer.tree.v1";

type TreePrefs = Record<string, string[]>;

function readExpanded(workspaceId: string): Set<string> {
  const stored = readPref<TreePrefs>(PREF_KEY);
  const paths = stored?.[workspaceId];
  if (!Array.isArray(paths)) return new Set();
  return new Set(
    paths.filter(
      (path): path is string => typeof path === "string" && path.length > 0,
    ),
  );
}

/** Expanded directory paths, persisted per workspace. */
export function useExplorerExpanded(workspaceId: string): {
  expanded: Set<string>;
  expand: (path: string) => void;
  collapse: (path: string) => void;
  toggle: (path: string) => void;
} {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    readExpanded(workspaceId),
  );

  useEffect(() => {
    const stored = readPref<TreePrefs>(PREF_KEY) ?? {};
    writePref(PREF_KEY, { ...stored, [workspaceId]: [...expanded].sort() });
  }, [expanded, workspaceId]);

  const expand = useCallback((path: string) => {
    setExpanded((previous) => {
      if (previous.has(path)) return previous;
      const next = new Set(previous);
      next.add(path);
      return next;
    });
  }, []);

  const collapse = useCallback((path: string) => {
    setExpanded((previous) => {
      if (!previous.has(path)) return previous;
      const next = new Set(previous);
      next.delete(path);
      return next;
    });
  }, []);

  const toggle = useCallback((path: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  return { expanded, expand, collapse, toggle };
}
