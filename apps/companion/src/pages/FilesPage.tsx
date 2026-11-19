import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  File,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  LoaderCircle,
  Music,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";

import {
  api,
  asApiError,
  type FsEntry,
  type FsListing,
  type LocalProject,
  type ProjectAgentConfig,
  type Workspace,
} from "../lib/api";
import {
  dirname,
  fileHash,
  filesHash,
  formatSize,
  isNoFolderError,
  normalizePath,
  pathSegments,
  ROOT_SOURCE_ID,
  visualKind,
  type FileVisualKind,
} from "../lib/files";
import { relativeTime } from "../lib/format";
import { t } from "../lib/i18n";
import {
  cached,
  invalidate,
  subscribeCache,
  TTL,
  WORKSPACES_KEY,
} from "../lib/reqCache";
import { navigate } from "../lib/router";

/** Last project the user browsed; kept across tab switches and reloads. */
const WORKSPACE_KEY = "companion.files.workspace";

/** One entry of the merged project selector. */
type FileSource = {
  id: string;
  /** Folder name; null only for the synthetic root (labelled at render time). */
  name: string | null;
  group: "tapd" | "local" | "root";
};

const readRememberedWorkspace = (): string | null => {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
};

const writeRememberedWorkspace = (workspaceId: string): void => {
  try {
    localStorage.setItem(WORKSPACE_KEY, workspaceId);
  } catch {
    // Private browsing: the selection stays session-local.
  }
};

/** Most recently visited workspace first, matching the bug list. */
const visitedStamp = (iso: string | null): number => {
  const timestamp = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(timestamp) ? 0 : timestamp;
};

const ROW_ICONS: Record<FileVisualKind, LucideIcon> = {
  dir: Folder,
  image: FileImage,
  audio: Music,
  video: FileVideo,
  markdown: FileText,
  text: FileCode,
  file: File,
};

function ListSkeleton() {
  return (
    <div data-component="ListSkeleton" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div key={row} className="border-b border-border px-4 py-3">
          <div className="h-4 w-2/3 animate-pulse rounded bg-overlay-soft" />
          <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-overlay-soft" />
        </div>
      ))}
    </div>
  );
}

function RetryButton(props: { onClick: () => void; label?: string }) {
  return (
    <button
      data-component="RetryButton"
      type="button"
      onClick={props.onClick}
      className="mt-4 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
    >
      <RefreshCw size={14} />
      {props.label ?? t("common.retry")}
    </button>
  );
}

/** File row metadata: size for files, relative time for everything. */
function rowMeta(entry: FsEntry): string {
  const time =
    entry.mtime > 0
      ? relativeTime(new Date(entry.mtime * 1000).toISOString())
      : "";
  return [entry.kind === "dir" ? null : formatSize(entry.size), time]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/**
 * Read-only project browser: project switch, breadcrumb, one directory level
 * at a time, and a pushed preview page for files. No layout/tree editing.
 */
export function FilesPage(props: { workspaceId: string | null; path: string }) {
  const path = normalizePath(props.path);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [rememberedId, setRememberedId] = useState<string | null>(
    readRememberedWorkspace,
  );
  const [localProjects, setLocalProjects] = useState<LocalProject[]>([]);
  const [localLoaded, setLocalLoaded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  /** TAPD folder map; null means "unknown", in which case nothing is hidden. */
  const [tapdRepoPaths, setTapdRepoPaths] = useState<Record<
    string,
    ProjectAgentConfig
  > | null>(null);
  const [configSettled, setConfigSettled] = useState(false);
  const [sourcesNonce, setSourcesNonce] = useState(0);

  const [listing, setListing] = useState<FsListing | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noFolder, setNoFolder] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [showHidden, setShowHidden] = useState(false);

  // Project list: same cache/subscription pattern as the bug list.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void cached(WORKSPACES_KEY, TTL.workspaces, api.workspaces)
        .then((context) => {
          if (cancelled) return;
          const sorted = [...context.workspaces].sort(
            (a, b) =>
              visitedStamp(b.lastVisitedTime) - visitedStamp(a.lastVisitedTime),
          );
          setWorkspaces(sorted);
          setWorkspaceError(null);
        })
        .catch((err) => {
          if (!cancelled) setWorkspaceError(asApiError(err).message);
        })
        .finally(() => {
          if (!cancelled) setWorkspaceLoaded(true);
        });
    };
    load();
    const off = subscribeCache(WORKSPACES_KEY, load);
    return () => {
      cancelled = true;
      off();
    };
  }, [sourcesNonce]);

  // Local projects always carry a folder, so they are always browseable.
  useEffect(() => {
    let cancelled = false;
    void api
      .localProjects()
      .then((data) => {
        if (cancelled) return;
        setLocalProjects(data.projects);
        setLocalError(null);
      })
      .catch((err) => {
        if (!cancelled) setLocalError(asApiError(err).message);
      })
      .finally(() => {
        if (!cancelled) setLocalLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sourcesNonce]);

  // Only TAPD workspaces with a configured folder can be browsed. A failed
  // read leaves the map unknown: show them all rather than hiding everything.
  useEffect(() => {
    let cancelled = false;
    void api
      .agentSettings()
      .then((config) => {
        // No `projects` map at all means "unknown", not "nothing configured".
        if (!cancelled) setTapdRepoPaths(config.projects ?? null);
      })
      .catch(() => {
        if (!cancelled) setTapdRepoPaths(null);
      })
      .finally(() => {
        if (!cancelled) setConfigSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sourcesNonce]);

  const sources = useMemo<FileSource[]>(() => {
    const hasFolder = (workspaceId: string) =>
      !tapdRepoPaths || Boolean(tapdRepoPaths[workspaceId]?.repoPath?.trim());
    return [
      ...workspaces
        .filter((workspace) => hasFolder(workspace.id))
        .map((workspace) => ({
          id: workspace.id,
          name: workspace.name || workspace.prettyName,
          group: "tapd" as const,
        })),
      ...localProjects.map((project) => ({
        id: project.id,
        name: project.name,
        group: "local" as const,
      })),
      { id: ROOT_SOURCE_ID, name: null, group: "root" as const },
    ];
  }, [workspaces, tapdRepoPaths, localProjects]);

  const sourceGroups = useMemo(
    () => ({
      tapd: sources.filter((source) => source.group === "tapd"),
      local: sources.filter((source) => source.group === "local"),
      root: sources.filter((source) => source.group === "root"),
    }),
    [sources],
  );

  /** Root has no data name; its label comes from the catalogue. */
  const sourceLabel = (source: FileSource): string =>
    source.name ?? t("mobile.files.rootDir");

  // The selector cannot be resolved until every source list is known, or a
  // remembered project would be replaced by the root before its list loads.
  const sourcesSettled = workspaceLoaded && localLoaded && configSettled;

  // Route project wins; otherwise the remembered one, then the first source.
  const selectedId = useMemo(() => {
    if (!sourcesSettled) return null;
    const known = (id: string | null): string | null =>
      id && sources.some((source) => source.id === id) ? id : null;
    return known(props.workspaceId) ?? known(rememberedId) ?? sources[0]?.id ?? null;
  }, [sourcesSettled, props.workspaceId, rememberedId, sources]);

  // Remember whichever project is actually being browsed (including the
  // default), so the tab reopens where the user left off.
  useEffect(() => {
    if (selectedId) writeRememberedWorkspace(selectedId);
  }, [selectedId]);

  const selectedSource =
    sources.find((source) => source.id === selectedId) ?? null;

  const reloadSources = () => {
    invalidate(WORKSPACES_KEY);
    setSourcesNonce((value) => value + 1);
  };

  const requestKey = `${selectedId ?? ""}|${path}`;
  // A listing only renders for the request that produced it; a refresh keeps
  // the old rows while the new request is in flight.
  const visibleListing = loadedKey === requestKey ? listing : null;

  useEffect(() => {
    if (!selectedId) {
      setListing(null);
      setLoadedKey(null);
      setLoading(false);
      setError(null);
      setNoFolder(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNoFolder(false);
    void api
      .files(selectedId, path)
      .then((data) => {
        if (cancelled) return;
        setListing(data);
        setLoadedKey(requestKey);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        const failure = asApiError(err);
        setError(failure.message);
        // Rust reports the unbound project as code `no_folder`; the message
        // prefix is the contract fallback.
        setNoFolder(
          failure.code === "no_folder" || isNoFolderError(failure.message),
        );
        setListing(null);
        setLoadedKey(requestKey);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, path, requestKey, nonce]);

  const rows = useMemo(() => {
    const entries = (visibleListing?.entries ?? []).filter(
      (entry) => showHidden || !entry.hidden,
    );
    return [...entries].sort((a, b) => {
      const aDir = a.kind === "dir" ? 0 : 1;
      const bDir = b.kind === "dir" ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name);
    });
  }, [visibleListing, showHidden]);

  const selectWorkspace = (workspaceId: string) => {
    setRememberedId(workspaceId);
    writeRememberedWorkspace(workspaceId);
    navigate(filesHash(workspaceId, ""));
  };

  const openEntry = (entry: FsEntry) => {
    if (!selectedId) return;
    if (entry.kind === "dir") {
      navigate(filesHash(selectedId, entry.path));
    } else {
      navigate(fileHash(selectedId, entry.path));
    }
  };

  const crumbs = [
    {
      // The root source is filesystem `/`, not a project folder.
      name: selectedSource ? sourceLabel(selectedSource) : t("mobile.files.root"),
      path: "",
    },
    ...pathSegments(path).map((name, index, all) => ({
      name,
      path: all.slice(0, index + 1).join("/"),
    })),
  ];

  const sourceError = workspaceError ?? localError ?? null;
  // Hiding dotfiles can empty an otherwise populated folder; say so instead of
  // claiming the folder has no entries at all.
  const onlyHidden =
    visibleListing !== null &&
    visibleListing.entries.length > 0 &&
    rows.length === 0;

  return (
    <div data-component="FilesPage">
      <header className="sticky top-0 z-20 border-b border-border bg-canvas">
        <div className="flex items-center gap-2 px-4 pt-3 pb-1">
          <h1 className="text-ui-base text-slate-900">{t("mobile.files.title")}</h1>
          <button
            type="button"
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
            onClick={() => setNonce((value) => value + 1)}
            className="ml-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-slate-500 transition active:bg-overlay-soft"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} />
          </button>
        </div>
        <div className="flex items-center gap-2 px-4 pb-2">
          {sources.length > 1 ? (
            <select
              aria-label={t("mobile.files.sources")}
              value={selectedId ?? ""}
              disabled={!sourcesSettled}
              onChange={(event) => selectWorkspace(event.target.value)}
              className="min-h-11 min-w-0 max-w-[60%] truncate rounded-lg border border-border bg-surface px-2 py-1.5 text-ui-sm text-slate-700 disabled:opacity-40"
            >
              {sourceGroups.tapd.length > 0 ? (
                <optgroup label={t("mobile.files.groupTapd")}>
                  {sourceGroups.tapd.map((source) => (
                    <option key={`${source.group}:${source.id}`} value={source.id}>
                      {sourceLabel(source)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {sourceGroups.local.length > 0 ? (
                <optgroup label={t("mobile.files.groupLocal")}>
                  {sourceGroups.local.map((source) => (
                    <option key={`${source.group}:${source.id}`} value={source.id}>
                      {sourceLabel(source)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <optgroup label={t("mobile.files.groupRoot")}>
                {sourceGroups.root.map((source) => (
                  <option key={`${source.group}:${source.id}`} value={source.id}>
                    {sourceLabel(source)}
                  </option>
                ))}
              </optgroup>
            </select>
          ) : (
            <span className="min-w-0 flex-1 truncate text-ui-sm text-slate-500">
              {selectedSource ? sourceLabel(selectedSource) : t("common.loadingDots")}
            </span>
          )}
          <button
            type="button"
            aria-pressed={showHidden}
            aria-label={t("mobile.files.showHidden")}
            title={t("mobile.files.showHidden")}
            onClick={() => setShowHidden((value) => !value)}
            className={`ml-auto inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-ui-sm transition ${
              showHidden
                ? "border-sky-200 bg-sky-50 text-sky-700"
                : "border-border bg-surface text-slate-500"
            }`}
          >
            {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
            {t("mobile.files.showHidden")}
          </button>
        </div>
        <div className="flex items-center gap-0.5 overflow-x-auto overscroll-x-contain px-3 pb-1">
          <button
            type="button"
            aria-label={t("mobile.files.parent")}
            title={t("mobile.files.parent")}
            disabled={!path}
            onClick={() => navigate(filesHash(selectedId, dirname(path)))}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-slate-500 transition active:bg-overlay-soft disabled:opacity-40"
          >
            <ChevronLeft size={16} />
          </button>
          {crumbs.map((crumb, index) => {
            const current = index === crumbs.length - 1;
            return (
              <Fragment key={`${index}:${crumb.path}`}>
                {index > 0 ? (
                  <span className="shrink-0 text-ui-sm text-slate-300">/</span>
                ) : null}
                {current ? (
                  <span className="max-w-[12rem] min-w-0 truncate px-1.5 text-ui-sm text-slate-900">
                    {crumb.name}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => navigate(filesHash(selectedId, crumb.path))}
                    className="inline-flex min-h-11 shrink-0 items-center rounded-md px-1.5 text-ui-sm text-slate-500 transition active:bg-overlay-soft"
                  >
                    {crumb.name}
                  </button>
                )}
              </Fragment>
            );
          })}
        </div>
      </header>

      {!sourcesSettled ? (
        <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-slate-400">
          <LoaderCircle size={14} className="animate-spin" />
          {t("common.loadingDots")}
        </div>
      ) : null}

      {sourceError ? (
        <div className="flex items-center gap-2 border-b border-border px-4 py-1">
          <p
            className="min-w-0 flex-1 truncate text-ui-xs text-rose-600"
            title={t("mobile.files.sourcesLoadFailed")}
          >
            {sourceError}
          </p>
          <button
            type="button"
            onClick={reloadSources}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-ui-xs text-slate-600 transition active:bg-overlay-soft"
          >
            <RefreshCw size={13} />
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      {selectedId && loading && !visibleListing && !error ? <ListSkeleton /> : null}

      {error && noFolder ? (
        <div className="px-4 py-10 text-center">
          <p
            className="text-ui-base text-slate-500"
            title={t("mobile.files.noFolderHint")}
          >
            {t("mobile.files.noFolder")}
          </p>
          <RetryButton onClick={() => setNonce((value) => value + 1)} />
        </div>
      ) : null}

      {error && !noFolder ? (
        <div className="px-4 py-8 text-center">
          <p className="text-ui-caption text-rose-600" title={t("mobile.files.loadFailed")}>
            {error}
          </p>
          <RetryButton onClick={() => setNonce((value) => value + 1)} />
        </div>
      ) : null}

      {visibleListing?.truncated ? (
        <p className="border-b border-border px-4 py-2 text-ui-xs text-amber-600">
          {t("mobile.files.truncated")}
        </p>
      ) : null}

      {visibleListing && rows.length === 0 && !error ? (
        onlyHidden ? (
          <p
            className="px-4 py-10 text-center text-ui-base text-slate-400"
            title={t("mobile.files.emptyHiddenHint")}
          >
            {t("mobile.files.emptyHidden")}
          </p>
        ) : (
          <p
            className="px-4 py-10 text-center text-ui-base text-slate-400"
            title={t("mobile.files.emptyHint")}
          >
            {t("mobile.files.empty")}
          </p>
        )
      ) : null}

      {rows.map((entry) => {
        const Icon = ROW_ICONS[visualKind(entry)];
        const meta = rowMeta(entry);
        return (
          <div key={entry.path} className="flex items-stretch border-b border-border">
            <button
              type="button"
              onClick={() => openEntry(entry)}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left transition active:bg-overlay-soft"
            >
              <Icon size={18} className="shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui-caption text-slate-900">
                  {entry.name}
                </span>
                {meta ? (
                  <span className="mt-0.5 block truncate text-ui-xs text-slate-500">
                    {meta}
                  </span>
                ) : null}
              </span>
              {entry.kind === "dir" ? (
                <ChevronRight size={15} className="shrink-0 text-slate-300" />
              ) : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}
