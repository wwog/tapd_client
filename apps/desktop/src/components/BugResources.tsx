import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import {
  Check,
  ChevronDown,
  Eye,
  FileArchive,
  FileText,
  Image as ImageIcon,
  Paperclip,
  UserRound,
  Video,
} from "lucide-react";
import clsx from "clsx";

import {
  api,
  mediaSrc,
  type Attachment,
  type BugDetail,
  type MediaRef,
  type OpenMediaMode,
  type OpenTarget,
  type OpenTargetSet,
} from "../lib/api";
import { formatBytes } from "../lib/format";
import { MediaPreview, type PreviewItem } from "./MediaPreview";
import { BugSectionTitle } from "./BugSectionTitle";

type Props = {
  open: boolean;
  detail: BugDetail;
  /** Mirrors "a preview is open" so the drawer's Escape handler stands down. */
  previewOpenRef: RefObject<boolean>;
  onOpenMedia: (
    url: string,
    mode: OpenMediaMode,
    kind?: string,
    target?: string,
  ) => void;
};

/**
 * Resources (attachments + media embedded in the description/comments), the
 * "open with" target sets and the in-app preview. Kept together because the
 * preview index and the target sets only describe this section.
 */
export function BugResources(props: Props) {
  const { open, detail, previewOpenRef, onOpenMedia } = props;
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [targetSets, setTargetSets] = useState<Record<string, OpenTargetSet>>({});

  const embeddedMedia = detail.embeddedMedia;
  const resourceCount = detail.attachments.length + embeddedMedia.length;

  const previewItems = useMemo<PreviewItem[]>(() => {
    const items: PreviewItem[] = [];
    for (const attachment of detail.attachments) {
      const kind = mediaKindOf(
        attachment.filename,
        attachment.contentType,
        attachment.filetype,
      );
      if (kind === "image" || kind === "video") {
        items.push({
          url: attachment.downloadUrl,
          kind,
          label: attachment.filename,
          size: attachment.size,
        });
      }
    }
    for (const media of detail.embeddedMedia) {
      if (media.kind === "image" || media.kind === "video") {
        items.push({
          url: media.url,
          kind: media.kind,
          label: media.filenameHint,
        });
      }
    }
    return items;
  }, [detail]);

  const resourceKinds = useMemo(() => {
    const kinds = new Set<string>();
    for (const attachment of detail.attachments) {
      kinds.add(
        mediaKindOf(attachment.filename, attachment.contentType, attachment.filetype),
      );
    }
    for (const media of detail.embeddedMedia) {
      kinds.add(media.kind === "image" || media.kind === "video" ? media.kind : "file");
    }
    return Array.from(kinds).sort();
  }, [detail]);

  // Load the "open with" options once per resource kind.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    for (const kind of resourceKinds) {
      if (targetSets[kind]) continue;
      void api
        .openTargets(kind)
        .then((set) => {
          if (cancelled) return;
          setTargetSets((current) =>
            current[kind] ? current : { ...current, [kind]: set },
          );
        })
        .catch(() => {
          /* menu falls back to a single "打开" action */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, resourceKinds, targetSets]);

  // Reset the preview each time the drawer is opened.
  useEffect(() => {
    if (!open) return;
    setPreviewIndex(null);
  }, [open]);

  // The drawer's Escape handler reads this in the same event, before effects.
  useLayoutEffect(() => {
    previewOpenRef.current = previewIndex !== null;
  }, [previewIndex, previewOpenRef]);

  const selectTarget = (kind: string, id: string) => {
    setTargetSets((current) =>
      current[kind] ? { ...current, [kind]: { ...current[kind], selected: id } } : current,
    );
    void api.setOpenTarget(kind, id).catch(() => {
      /* keep the local choice; it is re-validated on the next load */
    });
  };

  return (
    <>
      <section>
        <BugSectionTitle
          icon={<Paperclip size={14} />}
          title={`资源（${resourceCount}）`}
        />
        <div className="mt-2 space-y-2">
          {resourceCount === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-3 text-ui-caption text-slate-400">
              没有附件或内嵌图片/视频
            </div>
          ) : (
            <>
              {detail.attachments.map((attachment) => (
                <AttachmentRow
                  key={attachment.id}
                  attachment={attachment}
                  previewItems={previewItems}
                  onPreview={setPreviewIndex}
                  onOpen={onOpenMedia}
                  targetSets={targetSets}
                  onSelectTarget={selectTarget}
                />
              ))}
              {embeddedMedia.length > 0 ? (
                <div className="space-y-1.5 rounded-xl border border-slate-100 bg-slate-50/60 p-2">
                  <p className="px-1 text-ui-xs text-slate-400">
                    描述 / 评论内嵌（{embeddedMedia.length}）
                  </p>
                  {embeddedMedia.map((media, index) => (
                    <EmbeddedMediaRow
                      key={`${media.url}-${index}`}
                      media={media}
                      previewItems={previewItems}
                      onPreview={setPreviewIndex}
                      onOpen={onOpenMedia}
                      targetSets={targetSets}
                      onSelectTarget={selectTarget}
                    />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>

      {previewIndex !== null && previewItems[previewIndex] ? (
        <MediaPreview
          items={previewItems}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
          onOpenExternal={(url, mode) =>
            onOpenMedia(url, mode, previewItems[previewIndex]?.kind)
          }
        />
      ) : null}
    </>
  );
}

/** TAPD resources are loaded through the loopback media proxy. */
function Thumbnail(props: {
  url: string;
  icon: typeof ImageIcon;
  iconSize?: number;
  onClick?: () => void;
  title?: string;
}) {
  const { url, icon: Icon, iconSize = 16, onClick, title } = props;
  const [broken, setBroken] = useState(false);
  const source = mediaSrc(url);
  const clickable = Boolean(onClick);

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={!clickable}
      className={clsx(
        "grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-50 text-slate-400",
        clickable && "transition hover:outline-2 hover:outline-sky-200",
      )}
    >
      {source && !broken ? (
        <img
          src={source}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <Icon size={iconSize} />
      )}
    </button>
  );
}

/** Explicit, always-visible entry point for the in-app preview. */
function PreviewButton(props: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title="预览"
      aria-label="预览"
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-surface text-slate-500 transition hover:border-slate-300 hover:text-slate-800"
    >
      <Eye size={13} />
    </button>
  );
}

/**
 * Split button: the icon shows the current default app, the caret picks
 * another one. Only "open" targets live in this menu.
 */
function OpenButton(props: {
  kind: string;
  targets: OpenTargetSet | undefined;
  onSelect: (id: string) => void;
  onOpen: () => void;
}) {
  const { kind, targets, onSelect, onOpen } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const selected =
    targets?.targets.find((target) => target.id === targets.selected) ?? null;

  return (
    <div className="relative shrink-0">
      <div className="inline-flex items-stretch overflow-hidden rounded-md border border-border bg-surface text-ui-sm text-slate-600">
        <button
          type="button"
          onClick={onOpen}
          title={selected ? `用${selected.label}打开` : "打开"}
          className="inline-flex items-center gap-1.5 px-2 py-1 transition hover:bg-slate-50"
        >
          <TargetIcon target={selected} fallback="打开" />
          打开
        </button>
        <button
          type="button"
          aria-label="选择默认打开方式"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((current) => !current)}
          className="border-l border-border px-1 transition hover:bg-slate-50"
        >
          <ChevronDown size={11} />
        </button>
      </div>

      {menuOpen ? (
        <>
          <button
            type="button"
            aria-label="关闭菜单"
            onClick={() => setMenuOpen(false)}
            className="fixed inset-0 z-20 cursor-default"
          />
          <div className="absolute right-0 z-30 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-surface py-1 ">
            <p className="px-3 py-1 text-ui-xs text-slate-400">默认打开方式</p>
            {(targets?.targets ?? []).map((target) => {
              const active = target.id === targets?.selected;
              return (
                <button
                  key={`${kind}-${target.id}`}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onSelect(target.id);
                  }}
                  className={clsx(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui-sm transition hover:bg-slate-50",
                    active ? "text-slate-800" : "text-slate-600",
                  )}
                >
                  <TargetIcon target={target} fallback="应用" />
                  <span className="truncate">{target.label}</span>
                  {active ? <Check size={12} className="ml-auto text-sky-500" /> : null}
                </button>
              );
            })}
            {targets && targets.targets.length === 0 ? (
              <p className="px-3 py-2 text-ui-sm text-slate-400">没有可用的应用</p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function TargetIcon(props: {
  target: Pick<OpenTarget, "icon" | "label"> | null;
  fallback: string;
}) {
  const { target, fallback } = props;
  if (target?.icon) {
    return (
      <img
        src={target.icon}
        alt={target.label}
        title={fallback}
        className="h-4 w-4 shrink-0 rounded-[4px] object-contain"
      />
    );
  }
  return (
    <span
      title={fallback}
      className="grid h-4 w-4 shrink-0 place-items-center rounded-[4px] bg-slate-100 text-slate-500"
    >
      <Paperclip size={9} />
    </span>
  );
}

function AttachmentRow(props: {
  attachment: Attachment;
  previewItems: PreviewItem[];
  onPreview: (index: number) => void;
  onOpen: (url: string, mode: OpenMediaMode, kind?: string, target?: string) => void;
  targetSets: Record<string, OpenTargetSet>;
  onSelectTarget: (kind: string, id: string) => void;
}) {
  const { attachment, previewItems, onPreview, onOpen, targetSets, onSelectTarget } = props;
  const Icon = iconForAttachment(attachment);
  const kind = mediaKindOf(attachment.filename, attachment.contentType, attachment.filetype);
  const previewable = kind === "image" || kind === "video";
  const previewIndex = previewable
    ? previewItems.findIndex((item) => item.url === attachment.downloadUrl)
    : -1;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-surface p-3">
      <Thumbnail
        url={attachment.downloadUrl}
        icon={Icon}
        iconSize={17}
        title={previewable ? "预览" : undefined}
        onClick={previewable && previewIndex >= 0 ? () => onPreview(previewIndex) : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui-caption font-normal text-slate-700" title={attachment.filename}>
          {attachment.filename}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-ui-xs text-slate-400">
          <span>{formatBytes(attachment.size)}</span>
          <span className="truncate">{attachment.contentType || attachment.filetype}</span>
          {attachment.owner ? <span>{attachment.owner}</span> : null}
        </div>
      </div>
      {previewable && previewIndex >= 0 ? (
        <PreviewButton onClick={() => onPreview(previewIndex)} />
      ) : null}
      <OpenButton
        kind={kind}
        targets={targetSets[kind]}
        onSelect={(id) => onSelectTarget(kind, id)}
        onOpen={() => onOpen(attachment.downloadUrl, "file", kind)}
      />
    </div>
  );
}

function EmbeddedMediaRow(props: {
  media: MediaRef;
  previewItems: PreviewItem[];
  onPreview: (index: number) => void;
  onOpen: (url: string, mode: OpenMediaMode, kind?: string, target?: string) => void;
  targetSets: Record<string, OpenTargetSet>;
  onSelectTarget: (kind: string, id: string) => void;
}) {
  const { media, previewItems, onPreview, onOpen, targetSets, onSelectTarget } = props;
  const Icon = media.kind === "image" ? ImageIcon : media.kind === "video" ? Video : Paperclip;
  const kindLabel = media.kind === "image" ? "图片" : media.kind === "video" ? "视频" : "文件";
  const previewable = media.kind === "image" || media.kind === "video";
  const previewIndex = previewable
    ? previewItems.findIndex((item) => item.url === media.url)
    : -1;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-100 bg-surface p-2.5">
      <Thumbnail
        url={media.url}
        icon={Icon}
        iconSize={15}
        title={previewable ? "预览" : undefined}
        onClick={previewable && previewIndex >= 0 ? () => onPreview(previewIndex) : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui-caption text-slate-700" title={media.url}>
          {media.filenameHint || "内嵌资源"}
        </div>
        <div className="mt-0.5 text-ui-xs text-slate-400">{kindLabel} · 描述/评论内嵌</div>
      </div>
      {previewable && previewIndex >= 0 ? (
        <PreviewButton onClick={() => onPreview(previewIndex)} />
      ) : null}
      <OpenButton
        kind={media.kind === "image" || media.kind === "video" ? media.kind : "file"}
        targets={targetSets[media.kind === "image" || media.kind === "video" ? media.kind : "file"]}
        onSelect={(id) =>
          onSelectTarget(
            media.kind === "image" || media.kind === "video" ? media.kind : "file",
            id,
          )
        }
        onOpen={() =>
          onOpen(
            media.url,
            "file",
            media.kind === "image" || media.kind === "video" ? media.kind : "file",
          )
        }
      />
    </div>
  );
}

function mediaKindOf(
  filename: string,
  contentType: string,
  filetype: string,
): "image" | "video" | "file" {
  const type = `${contentType} ${filetype}`.toLowerCase();
  if (type.includes("image")) return "image";
  if (type.includes("video")) return "video";

  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(extension)) return "image";
  if (["mp4", "mov", "webm", "m4v", "avi"].includes(extension)) return "video";
  return "file";
}

function iconForAttachment(attachment: Attachment) {
  const type = `${attachment.filetype} ${attachment.contentType}`.toLowerCase();
  if (type.includes("image")) return ImageIcon;
  if (type.includes("video")) return Video;
  if (type.includes("compress") || type.includes("zip")) return FileArchive;
  if (type.includes("text") || type.includes("log") || type.includes("ips")) return FileText;
  if (type.includes("user")) return UserRound;
  return Paperclip;
}
