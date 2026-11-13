/**
 * Read-only file viewer: text/code with syntax highlighting, Markdown preview,
 * images, native audio/video controls and a metadata fallback for binary or
 * oversized files.
 *
 * Bodies come from `fs_read`; media is streamed from the loopback `/file`
 * route (it needs Range support for video seeking). Reactivation compares the
 * file mtime and silently re-reads when it changed outside the app.
 */
import clsx from "clsx";
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  Eye,
  FileAudio,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  WrapText,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { formatBytes, formatTimestamp } from "../../lib/format";
import {
  basename,
  dirname,
  ensureFileEndpoint,
  fileSrc,
  fsApi,
  type FsContent,
} from "../../lib/fs";
import { t } from "../../lib/i18n";
import { Breadcrumb } from "../explorer/Breadcrumb";
import { CodeView } from "../explorer/CodeView";
import { MarkdownView } from "../explorer/MarkdownView";
import { visualKindForPath } from "../explorer/language";
import { usePanelServices, type PanelProps } from "./context";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; content: FsContent }
  | { status: "error"; error: string };

const actionClass =
  "rounded-md p-1 text-slate-500 transition hover:bg-overlay hover:text-slate-700";
const activeActionClass = "rounded-md p-1 bg-sky-50 text-sky-700";

const CHECKERBOARD: CSSProperties = {
  backgroundImage:
    "conic-gradient(var(--color-overlay-soft) 25%, transparent 0 50%, var(--color-overlay-soft) 0 75%, transparent 0)",
  backgroundSize: "16px 16px",
};

function FileGlyph({ path }: { path: string }) {
  switch (visualKindForPath(path)) {
    case "image":
      return <FileImage size={13} className="shrink-0 text-violet-500" />;
    case "audio":
      return <FileAudio size={13} className="shrink-0 text-cyan-500" />;
    case "video":
      return <FileVideo size={13} className="shrink-0 text-rose-500" />;
    case "markdown":
    case "text":
      return <FileText size={13} className="shrink-0 text-slate-400" />;
    case "code":
      return <FileCode2 size={13} className="shrink-0 text-sky-500" />;
    default:
      return <FileText size={13} className="shrink-0 text-slate-400" />;
  }
}

export function FilePanel({ panel, active }: PanelProps) {
  const services = usePanelServices();
  const resource = panel.resource;
  const workspaceId =
    resource.type === "file" ? resource.workspaceId : services.currentWorkspaceId;
  const path = resource.type === "file" ? resource.path : "";
  const projectName =
    services.workspaceName(workspaceId) || t("explorer.root");

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [wrap, setWrap] = useState(false);
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const [fit, setFit] = useState(true);
  const [src, setSrc] = useState<string | undefined>(() =>
    fileSrc(workspaceId, path),
  );
  const [imageSize, setImageSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  /** Last mtime read from disk; null until the first successful read. */
  const loadedMtime = useRef<number | null>(null);

  // Reset view toggles when the panel switches files.
  useEffect(() => {
    setWrap(false);
    setMarkdownPreview(true);
    setFit(true);
    setImageSize(null);
  }, [workspaceId, path]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fsApi
      .read({ workspaceId, path })
      .then((content) => {
        if (!cancelled) {
          loadedMtime.current = content.mtime;
          setState({ status: "ready", content });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", error: String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path, reloadToken]);

  // Re-read on activation when the file changed on disk. Depending only on
  // `active` / `path` keeps an actively-written log from triggering a reload
  // loop; the mtime comes from the last completed read.
  useEffect(() => {
    if (!active || loadedMtime.current === null) return;
    const loaded = loadedMtime.current;
    let cancelled = false;
    fsApi
      .stat({ workspaceId, path })
      .then((stat) => {
        if (!cancelled && stat.mtime !== loaded) {
          setReloadToken((value) => value + 1);
        }
      })
      .catch(() => {
        // The file may have disappeared; the next read reports it.
      });
    return () => {
      cancelled = true;
    };
  }, [active, path, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    const apply = () => {
      if (!cancelled) setSrc(fileSrc(workspaceId, path));
    };
    apply();
    if (!fileSrc(workspaceId, path)) {
      void ensureFileEndpoint().then(apply);
    }
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path]);

  const content = state.status === "ready" ? state.content : null;

  const absolutePath = useCallback(async (): Promise<string> => {
    const listing = await fsApi.list({ workspaceId, path: dirname(path) });
    const root = listing.root.replace(/[\\/]+$/, "");
    return path ? `${root}/${path}` : root;
  }, [path, workspaceId]);

  const copyPath = useCallback(async () => {
    try {
      await services.copy(await absolutePath());
    } catch (error) {
      services.toast("error", String(error));
    }
  }, [absolutePath, services]);

  const openExternal = useCallback(async () => {
    try {
      services.openPath(await absolutePath());
    } catch (error) {
      services.toast("error", String(error));
    }
  }, [absolutePath, services]);

  const refresh = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  const showsText =
    content?.kind === "text" ||
    (content?.kind === "markdown" && !markdownPreview);

  const body = (() => {
    if (state.status === "loading") {
      return (
        <div className="flex flex-1 items-center justify-center gap-2 text-ui-sm text-slate-400">
          <Loader2 size={13} className="animate-spin" />
          {t("file.loading")}
        </div>
      );
    }
    if (state.status === "error") {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="break-all text-ui-sm leading-5 text-rose-600">
            {t("file.loadFailed", { error: state.error })}
          </p>
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-ui-xs text-slate-600 transition hover:bg-overlay"
          >
            <RefreshCw size={10} />
            {t("explorer.refresh")}
          </button>
        </div>
      );
    }

    switch (state.content.kind) {
      case "text":
        return (
          <CodeView text={state.content.text ?? ""} path={path} wrap={wrap} />
        );
      case "markdown":
        return markdownPreview ? (
          <MarkdownView text={state.content.text ?? ""} />
        ) : (
          <CodeView text={state.content.text ?? ""} path={path} wrap={wrap} />
        );
      case "image":
        return (
          <div
            className="relative min-h-0 flex-1 overflow-auto"
            style={CHECKERBOARD}
            data-workbench-file="image"
          >
            <div
              className={clsx(
                "flex items-center justify-center p-4",
                fit ? "absolute inset-0" : "min-h-full min-w-full",
              )}
            >
              {src ? (
                <img
                  src={src}
                  alt={basename(path)}
                  draggable={false}
                  onLoad={(event) =>
                    setImageSize({
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    })
                  }
                  className={clsx(
                    "rounded-md",
                    fit ? "max-h-full max-w-full object-contain" : "max-w-none",
                  )}
                />
              ) : (
                <Loader2 size={13} className="animate-spin text-slate-400" />
              )}
            </div>
          </div>
        );
      case "video":
        return (
          <div
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4"
            data-workbench-file="video"
          >
            {src ? (
              <video
                controls
                src={src}
                className="max-h-full max-w-full rounded-lg border border-border"
              />
            ) : (
              <Loader2 size={13} className="animate-spin text-slate-400" />
            )}
          </div>
        );
      case "audio":
        return (
          <div
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4"
            data-workbench-file="audio"
          >
            {src ? (
              <audio controls src={src} className="w-full max-w-xl" />
            ) : (
              <Loader2 size={13} className="animate-spin text-slate-400" />
            )}
          </div>
        );
      case "binary":
      case "tooLarge":
      default:
        return (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
            data-workbench-file={state.content.kind}
          >
            <AlertTriangle size={20} className="text-slate-300" />
            <p className="text-ui-caption text-slate-600">
              {state.content.kind === "tooLarge"
                ? t("file.tooLarge")
                : t("file.binary")}
            </p>
            <p className="text-ui-xs text-slate-400">
              {formatBytes(state.content.size)}
            </p>
            <button
              type="button"
              onClick={() => void openExternal()}
              className="mt-1 inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-ui-xs text-slate-600 transition hover:bg-overlay"
            >
              <ExternalLink size={10} />
              {t("file.openExternal")}
            </button>
          </div>
        );
    }
  })();

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-surface"
      data-panel-id={panel.id}
      data-panel-active={active ? "true" : "false"}
      data-workbench-file="panel"
    >
      <div
        className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2"
        data-workbench-file="header"
      >
        <FileGlyph path={path} />
        <span
          className="min-w-0 flex-1 truncate text-ui-sm text-slate-700"
          title={path}
        >
          {basename(path)}
        </span>

        {content?.kind === "markdown" ? (
          <button
            type="button"
            aria-label={
              markdownPreview ? t("file.source") : t("file.markdown")
            }
            title={markdownPreview ? t("file.source") : t("file.markdown")}
            aria-pressed={!markdownPreview}
            onClick={() => setMarkdownPreview((value) => !value)}
            className={
              markdownPreview ? actionClass : activeActionClass
            }
          >
            {markdownPreview ? <FileCode2 size={12} /> : <Eye size={12} />}
          </button>
        ) : null}

        {showsText ? (
          <button
            type="button"
            aria-label={t("file.wrap")}
            title={t("file.wrap")}
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
            className={wrap ? activeActionClass : actionClass}
          >
            <WrapText size={12} />
          </button>
        ) : null}

        {content?.kind === "image" ? (
          <button
            type="button"
            aria-label={fit ? t("file.actualSize") : t("file.fit")}
            title={fit ? t("file.actualSize") : t("file.fit")}
            aria-pressed={!fit}
            onClick={() => setFit((value) => !value)}
            className={fit ? actionClass : activeActionClass}
          >
            {fit ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
          </button>
        ) : null}

        <button
          type="button"
          aria-label={t("file.copyPath")}
          title={t("file.copyPath")}
          onClick={() => void copyPath()}
          className={actionClass}
        >
          <Copy size={12} />
        </button>
        <button
          type="button"
          aria-label={t("file.openExternal")}
          title={t("file.openExternal")}
          onClick={() => void openExternal()}
          className={actionClass}
        >
          <ExternalLink size={12} />
        </button>
        <button
          type="button"
          aria-label={t("explorer.refresh")}
          title={t("explorer.refresh")}
          onClick={refresh}
          className={actionClass}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
        <Breadcrumb rootLabel={projectName} path={dirname(path)} />
        {content ? (
          <span className="shrink-0 text-ui-xs text-slate-400">
            {formatBytes(content.size)}
            {" · "}
            {formatTimestamp(content.mtime * 1000)}
            {content.kind === "image" && imageSize ? (
              <>
                {" · "}
                {`${imageSize.width} × ${imageSize.height}`}
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      {content?.truncated ? (
        <div
          className="shrink-0 border-b border-amber-100 bg-amber-50 px-3 py-1 text-ui-xs text-amber-700"
          data-workbench-file="truncated"
        >
          {t("file.truncated")}
        </div>
      ) : null}

      {body}
    </div>
  );
}
