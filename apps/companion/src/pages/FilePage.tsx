import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";

import {
  api,
  asApiError,
  fileRawUrl,
  type FsContent,
  type FsContentKind,
} from "../lib/api";
import { copyText } from "../lib/clipboard";
import {
  basename,
  dirname,
  filesHash,
  formatSize,
  isNoFolderError,
  normalizePath,
} from "../lib/files";
import { relativeTime } from "../lib/format";
import { t, type MessageKey } from "../lib/i18n";
import { navigate } from "../lib/router";

const KIND_LABELS: Record<FsContentKind, MessageKey> = {
  text: "mobile.files.kindText",
  markdown: "mobile.files.kindMarkdown",
  image: "mobile.files.kindImage",
  audio: "mobile.files.kindAudio",
  video: "mobile.files.kindVideo",
  binary: "mobile.files.kindBinary",
  tooLarge: "mobile.files.kindTooLarge",
};

/**
 * Beyond this many lines the gutter is dropped: building a two-million-line
 * number column would freeze the phone, and the text stays readable without it.
 */
const MAX_NUMBERED_LINES = 5000;

function CodeBlock(props: { text: string }) {
  const lineCount = useMemo(
    () => (props.text.match(/\n/g)?.length ?? 0) + 1,
    [props.text],
  );
  const gutter = useMemo(() => {
    if (lineCount > MAX_NUMBERED_LINES) return null;
    const lines: string[] = [];
    for (let line = 1; line <= lineCount; line += 1) lines.push(String(line));
    return lines.join("\n");
  }, [lineCount]);

  return (
    <div className="mt-3 overflow-x-auto overscroll-x-contain border-y border-border bg-surface">
      <div className="flex min-w-max">
        {gutter ? (
          <pre
            aria-hidden="true"
            className="sticky left-0 z-10 select-none border-r border-border bg-surface px-2 py-3 text-right font-mono text-ui-xs leading-5 text-slate-400"
          >
            {gutter}
          </pre>
        ) : null}
        <pre className="select-text px-3 py-3 font-mono text-ui-xs leading-5 text-slate-700">
          {props.text}
        </pre>
      </div>
    </div>
  );
}

function MetaRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border py-2.5 last:border-b-0">
      <span className="shrink-0 text-ui-xs text-slate-500">{props.label}</span>
      <span className="min-w-0 break-all text-right text-ui-caption text-slate-700">
        {props.value}
      </span>
    </div>
  );
}

/**
 * Read-only preview for one project file. Text is rendered as text (React
 * escapes it); nothing here interprets file content as HTML.
 */
export function FilePage(props: { workspaceId: string | null; path: string }) {
  const { workspaceId } = props;
  const path = normalizePath(props.path);
  const name = basename(path);
  const parent = dirname(path);

  const [content, setContent] = useState<FsContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [noFolder, setNoFolder] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId || !path) {
      setContent(null);
      setLoading(false);
      setNoFolder(false);
      setError(
        workspaceId
          ? t("mobile.files.missingPath")
          : t("mobile.files.missingWorkspace"),
      );
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNoFolder(false);
    void api
      .file(workspaceId, path)
      .then((data) => {
        if (cancelled) return;
        setContent(data);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        const failure = asApiError(err);
        setContent(null);
        setError(failure.message);
        // Rust reports the unbound project as code `no_folder`; the message
        // prefix is the contract fallback.
        setNoFolder(
          failure.code === "no_folder" || isNoFolderError(failure.message),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path, nonce]);

  const back = () => {
    if (window.history.length > 1) window.history.back();
    else navigate(filesHash(workspaceId, parent));
  };

  const copyPath = async () => {
    setCopyError(null);
    const ok = await copyText(path);
    if (!ok) {
      setCopyError(t("common.copyFailed"));
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const rawUrl = workspaceId && path ? fileRawUrl(workspaceId, path) : "";
  const modified =
    content && content.mtime > 0
      ? relativeTime(new Date(content.mtime * 1000).toISOString())
      : "—";
  const text = content?.text ?? "";
  const isText = content?.kind === "text" || content?.kind === "markdown";

  const renderBinary = (item: FsContent) => (
    <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface p-4">
      <p className="text-ui-caption text-slate-700">{t("mobile.files.noPreview")}</p>
      <p
        className="mt-1 text-ui-xs text-slate-400"
        title={t("mobile.files.previewHint")}
      >
        {t("mobile.files.previewHint")}
      </p>
      <div className="mt-3">
        <MetaRow label={t("mobile.files.type")} value={t(KIND_LABELS[item.kind])} />
        <MetaRow label={t("mobile.files.size")} value={formatSize(item.size)} />
        <MetaRow label={t("mobile.files.modified")} value={modified} />
      </div>
      {rawUrl ? (
        <a
          href={rawUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-ui-sm text-primary-foreground transition active:bg-primary-hover"
        >
          <ExternalLink size={14} />
          {t("mobile.files.openRaw")}
        </a>
      ) : null}
    </section>
  );

  return (
    <div>
      <header className="sticky top-0 z-20 border-b border-border bg-canvas">
        <div className="flex items-center gap-1.5 px-2 py-2">
          <button
            type="button"
            aria-label={t("mobile.nav.back")}
            onClick={back}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-slate-500 transition active:bg-overlay-soft"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-900">
            {name}
          </span>
          <button
            type="button"
            aria-label={copied ? t("common.copied") : t("mobile.files.copyPath")}
            title={copied ? t("common.copied") : t("mobile.files.copyPath")}
            onClick={() => void copyPath()}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-slate-500 transition active:bg-overlay-soft"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </div>
        <p className="truncate px-4 pb-1 font-mono text-ui-xs text-slate-400" title={path}>
          {parent ? <span>{parent}/</span> : null}
          <span className="text-slate-700">{name}</span>
        </p>
        {content && content.kind !== "binary" && content.kind !== "tooLarge" ? (
          <p className="truncate px-4 pb-2 text-ui-xs text-slate-400">
            {t(KIND_LABELS[content.kind])} · {formatSize(content.size)} · {modified}
          </p>
        ) : null}
        {copyError ? (
          <p className="px-4 pb-2 text-ui-xs text-rose-600">{copyError}</p>
        ) : null}
      </header>

      {loading && !content ? (
        <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-slate-400">
          <LoaderCircle size={14} className="animate-spin" />
          {t("mobile.files.reading")}
        </div>
      ) : null}

      {error && noFolder ? (
        <div className="px-4 py-10 text-center">
          <p className="text-ui-base text-slate-500" title={t("mobile.files.noFolderHint")}>
            {t("mobile.files.noFolder")}
          </p>
          <button
            type="button"
            onClick={() => setNonce((value) => value + 1)}
            className="mt-4 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
          >
            <RefreshCw size={14} />
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      {error && !noFolder ? (
        <div className="px-4 py-8 text-center">
          <p className="text-ui-caption text-rose-600" title={t("mobile.files.fileFailed")}>
            {error}
          </p>
          <button
            type="button"
            onClick={() => setNonce((value) => value + 1)}
            className="mt-4 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
          >
            <RefreshCw size={14} />
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      {content && isText ? (
        content.truncated ? (
          <p className="px-4 py-2 text-ui-xs text-amber-600">
            {t("mobile.files.contentTruncated")}
          </p>
        ) : null
      ) : null}

      {content && isText ? (
        text.length > 0 ? (
          <CodeBlock text={text} />
        ) : (
          <p className="px-4 py-8 text-center text-ui-caption text-slate-400">
            {t("mobile.files.emptyFile")}
          </p>
        )
      ) : null}

      {content && content.kind === "image" && rawUrl ? (
        <a
          href={rawUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={t("mobile.files.openImageHint")}
          className="block px-3 pt-3"
        >
          <img
            src={rawUrl}
            alt={name}
            className="mx-auto block max-w-full rounded-xl border border-border bg-surface"
          />
        </a>
      ) : null}

      {content && content.kind === "audio" && rawUrl ? (
        <div className="px-3 pt-3">
          <audio controls preload="metadata" src={rawUrl} className="w-full" />
        </div>
      ) : null}

      {content && content.kind === "video" && rawUrl ? (
        <div className="px-3 pt-3">
          <video
            controls
            playsInline
            preload="metadata"
            src={rawUrl}
            className="mx-auto block max-w-full rounded-xl border border-border bg-surface"
          />
        </div>
      ) : null}

      {content &&
      content.kind !== "text" &&
      content.kind !== "markdown" &&
      content.kind !== "image" &&
      content.kind !== "audio" &&
      content.kind !== "video"
        ? renderBinary(content)
        : null}
    </div>
  );
}
