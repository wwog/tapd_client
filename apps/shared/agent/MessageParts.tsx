import { memo, useDeferredValue, useEffect, useState } from "react";
import clsx from "clsx";
import { Check, Copy, FileText } from "lucide-react";

import type { AgentImage, AgentLocale, AgentUsage } from "./types";
import { agentLabel } from "./labels";
import { useAgentHost } from "./host";
import { copyText } from "./clipboard";
import { clock } from "./format";

/**
 * One human prompt: the image attachments it carried, then its text with
 * `@path` references drawn as chips.
 *
 * Images are read through the host (`loadAttachmentImage`): the bytes live in
 * dsh's content-addressed store, not in the row, so a replayed conversation
 * still shows them. A host without that capability (the paired phone) gets a
 * filename row instead of a broken picture.
 */
export const UserBubble = memo(function UserBubble({
  text,
  images,
}: {
  text: string;
  images?: AgentImage[];
  locale: AgentLocale;
}) {
  return (
    <div
      data-component="UserBubble"
      className="ml-auto flex max-w-[80%] flex-col gap-2 break-words rounded-xl rounded-tr-[3px] border border-border bg-surface px-3.5 py-2.5 text-ui-caption leading-6 text-slate-800 select-text"
    >
      {images && images.length > 0 ? <UserImages images={images} /> : null}
      {text ? (
        <div className="whitespace-pre-wrap">
          {splitMentions(text).map((part, index) =>
            part.mention === undefined ? (
              <span key={index}>{part.text}</span>
            ) : (
              <FileMention key={index} path={part.mention} />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
});

/** Thumbnails of one prompt's images; a click opens the app's preview. */
const UserImages = memo(function UserImages({ images }: { images: AgentImage[] }) {
  const host = useAgentHost();
  const [loaded, setLoaded] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    for (const [index, image] of images.entries()) {
      const key = image.attachmentId ?? `pending:${index}`;
      if (image.src) {
        setLoaded((current) =>
          current[key] === image.src ? current : { ...current, [key]: image.src as string },
        );
        continue;
      }
      if (!image.attachmentId || !host.loadAttachmentImage) continue;
      void host.loadAttachmentImage({
        attachmentId: image.attachmentId,
        mediaType: image.mediaType,
      })
        .then((src) => {
          if (!live) return;
          setLoaded((current) => ({ ...current, [key]: src }));
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [host, images]);

  return (
    <div data-component="UserImages" className="flex flex-wrap gap-2">
      {images.map((image, index) => {
        const key = image.attachmentId ?? `pending:${index}`;
        const src = loaded[key];
        const label = image.name ?? `image-${index + 1}`;
        return src ? (
          <button
            key={key}
            type="button"
            title={label}
            onClick={() => host.previewImage?.({ src, label })}
            className="block cursor-zoom-in overflow-hidden rounded-lg border border-border"
          >
            <img
              src={src}
              alt={label}
              width={image.width}
              height={image.height}
              className="max-h-40 max-w-[12rem] object-cover"
            />
          </button>
        ) : (
          <span
            key={key}
            title={label}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-ui-2xs text-slate-500"
          >
            <FileText size={11} className="shrink-0" />
            {label}
          </span>
        );
      })}
    </div>
  );
});

/**
 * Splits prompt text on `@path` / `@"path with spaces"` references — dsh's own
 * file-reference grammar — so the paths read as chips instead of prose.
 */
const MENTION = /(?<![\w@])@(?:"([^"]+)"|([^\s@]+))/gu;

export function splitMentions(
  text: string,
): Array<{ text: string; mention?: string }> {
  const parts: Array<{ text: string; mention?: string }> = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: match[0], mention: match[1] ?? match[2] ?? "" });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

/**
 * One `@path` chip; the host may reveal the file, otherwise it is a label.
 *
 * The box is a fixed 20px tall and `align-middle`, so the chip's optical centre
 * matches the surrounding 24px text line instead of hanging off its baseline.
 * The inner span carries the truncation (`truncate`), and the label keeps a
 * 14px line box: at 11px `leading-none` the descenders of `j`/`g` were taller
 * than the line and the row's `overflow` clipped them.
 */
const FileMention = memo(function FileMention({ path }: { path: string }) {
  const host = useAgentHost();
  const clickable = Boolean(host.openPath);
  return (
    <span
      data-component="FileMention"
      title={path}
      onClick={clickable ? () => host.openPath?.(path) : undefined}
      className={clsx(
        "mx-1 inline-flex h-5 max-w-[18rem] items-center gap-1 rounded border border-border px-1.5 align-middle font-mono text-[11px] leading-[14px] text-slate-600",
        clickable && "cursor-pointer hover:border-slate-300 hover:text-slate-900",
      )}
    >
      <FileText size={10} className="shrink-0 text-slate-400" />
      <span className="min-w-0 truncate">{path}</span>
    </span>
  );
});

/**
 * Rendered assistant answer. Markdown rendering is a host capability
 * (`renderMarkdown`); without one the text shows pre-wrapped and plain, which
 * keeps the block readable in any webview.
 *
 * While the note streams, the Markdown pass reads a deferred copy: token
 * deltas still land immediately in the store, but a long answer cannot make
 * every delta re-parse the whole document on the critical path.
 */
export const AnswerBlock = memo(function AnswerBlock({
  text,
  streaming = false,
}: {
  text: string;
  locale: AgentLocale;
  streaming?: boolean;
}) {
  const host = useAgentHost();
  const deferred = useDeferredValue(text);
  const shown = streaming ? deferred : text;
  return (
    <div data-component="AnswerBlock" className="min-w-0 break-words text-ui-caption leading-6 text-slate-700 select-text">
      {host.renderMarkdown ? (
        host.renderMarkdown(shown)
      ) : (
        <p className="whitespace-pre-wrap">{shown}</p>
      )}
    </div>
  );
});

/** Usage, time and copy under a message. Copy confirms in place, no toast. */
export const MessageMeta = memo(function MessageMeta({
  at,
  text,
  align,
  locale,
  usage,
  provider,
  model,
}: {
  at: string;
  text: string;
  align: "left" | "right";
  locale: AgentLocale;
  usage?: AgentUsage;
  provider?: string;
  model?: string;
}) {
  const host = useAgentHost();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div
      data-component="MessageMeta"
      className={clsx(
        "mt-1 flex items-center gap-2 text-ui-xs text-slate-400",
        align === "right" ? "justify-end" : "justify-start",
      )}
    >
      {usage && host.renderUsage ? host.renderUsage(usage, provider, model) : null}
      <span className="tabular-nums">{clock(at)}</span>
      <button
        type="button"
        title={copied ? agentLabel("meta.copied", locale) : agentLabel("meta.copy", locale)}
        onClick={() => void copy()}
        className="grid h-5 w-5 place-items-center rounded text-slate-300 transition-colors hover:bg-overlay hover:text-slate-600"
      >
        {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
      </button>
    </div>
  );
});
