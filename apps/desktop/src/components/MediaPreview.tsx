import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Film,
  Globe,
  Maximize2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import clsx from "clsx";

import { mediaSrc } from "../lib/api";
import { formatBytes } from "../lib/format";

export type PreviewItem = {
  url: string;
  kind: "image" | "video";
  label: string;
  size?: number;
};

type Props = {
  items: PreviewItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onOpenExternal: (url: string, mode: "file" | "browser") => void;
};

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 6;

type Size = { width: number; height: number };

/** Full-screen resource preview with zoom, prev/next and a thumbnail strip. */
export function MediaPreview(props: Props) {
  const { items, index, onIndexChange, onClose, onOpenExternal } = props;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const thumbRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const centeredOnce = useRef(false);
  const [zoom, setZoom] = useState(1);
  // Measured once the overlay is mounted, so the media is contained by the real
  // available box instead of a viewport guess (`100vh - <magic>` broke as soon
  // as header/footer/paddings changed).
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size | null>(null);

  const current = items[index];

  const zoomBy = useCallback((factor: number) => {
    setZoom((value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value * factor)));
  }, []);

  const go = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      const next = (index + delta + items.length) % items.length;
      onIndexChange(next);
    },
    [index, items.length, onIndexChange],
  );

  const rememberSize = useCallback((next: Size | null) => {
    setNatural(next && next.width > 0 && next.height > 0 ? next : null);
  }, []);

  // Reset fit state and scroll offsets when switching resources.
  useEffect(() => {
    setZoom(1);
    setNatural(null);
    const node = stageRef.current;
    if (node) {
      node.scrollTop = 0;
      node.scrollLeft = 0;
    }
  }, [index]);

  // Track the usable stage box (viewport minus padding) so the media can be
  // scaled to fit exactly, whatever the window size.
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;

    const measure = () => {
      const style = window.getComputedStyle(node);
      const width =
        node.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0);
      const height =
        node.clientHeight -
        (Number.parseFloat(style.paddingTop) || 0) -
        (Number.parseFloat(style.paddingBottom) || 0);
      setStage((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width: Math.max(0, width), height: Math.max(0, height) },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Keep the active thumbnail in the middle of the rail. The first centering is
  // instant (so the preview opens already centered), later ones slide.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const thumb = thumbRefs.current[index];
    if (!thumb) return;

    const stripRect = strip.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const delta =
      thumbRect.left + thumbRect.width / 2 - (stripRect.left + stripRect.width / 2);

    strip.scrollBy({
      left: delta,
      behavior: centeredOnce.current ? "smooth" : "auto",
    });
    centeredOnce.current = true;
  }, [index, items.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          onClose();
          break;
        case "ArrowLeft":
          event.preventDefault();
          go(-1);
          break;
        case "ArrowRight":
          event.preventDefault();
          go(1);
          break;
        case "+":
        case "=":
          event.preventDefault();
          zoomBy(1.25);
          break;
        case "-":
        case "_":
          event.preventDefault();
          zoomBy(0.8);
          break;
        case "0":
          event.preventDefault();
          setZoom(1);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [go, onClose, zoomBy]);

  // Wheel pans natively (so a zoomed-in image can be inspected); pinch/⌘-wheel
  // zooms. Registered natively so the zoom case can preventDefault.
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!current || current.kind !== "image") return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.1 : 0.9);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [current, zoomBy]);

  if (!current) return null;

  const source = mediaSrc(current.url);

  // Zoom is relative to "fits the stage": 100% always shows the whole resource.
  const fit =
    natural && stage.width > 0 && stage.height > 0
      ? Math.min(stage.width / natural.width, stage.height / natural.height, 1)
      : 1;
  const effectiveZoom = current.kind === "image" ? zoom : 1;
  const mediaSize = natural
    ? {
        width: Math.round(natural.width * fit * effectiveZoom),
        height: Math.round(natural.height * fit * effectiveZoom),
      }
    : null;

  return createPortal(
    <div className="theme-static-dark fixed inset-0 z-[60] flex flex-col bg-slate-950/95 text-slate-100">
      <header
        data-tauri-drag-region
        className="relative flex shrink-0 items-center justify-center border-b border-white/10 px-4 py-2.5"
      >
        <div data-tauri-drag-region className="min-w-0 max-w-[min(60%,34rem)] text-center">
          <div className="truncate text-ui-caption font-normal" title={current.label}>
            {current.label}
          </div>
          <div className="text-ui-xs text-slate-400">
            {index + 1} / {items.length}
            {current.size ? ` · ${formatBytes(current.size)}` : ""}
            {current.kind === "video" ? " · 视频" : ""}
          </div>
        </div>

        <div className="absolute inset-y-0 right-3 flex items-center gap-1">
          {current.kind === "image" ? (
            <>
              <IconButton label="缩小" onClick={() => zoomBy(0.8)}>
                <ZoomOut size={15} />
              </IconButton>
              <span className="w-11 text-center font-mono text-ui-sm text-slate-300">
                {Math.round(zoom * 100)}%
              </span>
              <IconButton label="放大" onClick={() => zoomBy(1.25)}>
                <ZoomIn size={15} />
              </IconButton>
              <IconButton label="适应窗口" onClick={() => setZoom(1)}>
                <Maximize2 size={14} />
              </IconButton>
            </>
          ) : null}
          <IconButton
            label="用本地应用打开"
            onClick={() => onOpenExternal(current.url, "file")}
          >
            <ExternalLink size={15} />
          </IconButton>
          <IconButton
            label="在浏览器中打开"
            onClick={() => onOpenExternal(current.url, "browser")}
          >
            <Globe size={15} />
          </IconButton>
          <IconButton label="关闭预览" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
      </header>

      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-auto p-6">
        {/* `m-auto` centers without the usual flex-centering trap where the
            overflowing start of a zoomed image becomes unreachable. */}
        <div className="flex min-h-full min-w-full">
          {current.kind === "video" ? (
            source ? (
              <video
                key={current.url}
                src={source}
                controls
                autoPlay
                playsInline
                onLoadedMetadata={(event) =>
                  rememberSize({
                    width: event.currentTarget.videoWidth,
                    height: event.currentTarget.videoHeight,
                  })
                }
                style={mediaSize ?? undefined}
                className={clsx(
                  "m-auto rounded-lg bg-black ",
                  mediaSize ? null : "max-h-[calc(100vh-10rem)] max-w-full",
                )}
              />
            ) : (
              <Hint text="预览服务尚未就绪，可用「在浏览器中打开」" />
            )
          ) : source ? (
            <img
              key={current.url}
              src={source}
              alt={current.label}
              draggable={false}
              onLoad={(event) =>
                rememberSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              onError={() => rememberSize(null)}
              onDoubleClick={() => setZoom((value) => (value > 1 ? 1 : 2))}
              style={
                mediaSize
                  ? { width: mediaSize.width, height: mediaSize.height }
                  : undefined
              }
              className={clsx(
                "m-auto select-none rounded-lg bg-white/5 ",
                mediaSize ? null : "max-h-[calc(100vh-10rem)] max-w-full",
              )}
            />
          ) : (
            <Hint text="预览服务尚未就绪，可用「在浏览器中打开」" />
          )}
        </div>

        {items.length > 1 ? (
          <>
            <button
              type="button"
              aria-label="上一个资源"
              onClick={() => go(-1)}
              className="absolute left-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-slate-900/70 text-slate-200 transition hover:bg-slate-800"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              aria-label="下一个资源"
              onClick={() => go(1)}
              className="absolute right-3 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-slate-900/70 text-slate-200 transition hover:bg-slate-800"
            >
              <ChevronRight size={20} />
            </button>
          </>
        ) : null}
      </div>

      {/* Docked, opaque footer: it takes its own row, so it never covers the
          resource being previewed. */}
      <footer className="shrink-0 border-t border-white/10 bg-slate-950 px-3 py-2">
        {/* Centered rail: the active thumbnail sits in the middle and the
            previously active one slides left as you move on. */}
        <div
          ref={stripRef}
          style={{ scrollbarWidth: "none" }}
          className="flex gap-2 overflow-x-auto px-[calc(50%-1.75rem)] pb-1 [&::-webkit-scrollbar]:hidden"
        >
          {items.map((item, itemIndex) => (
            <button
              key={`${item.url}-${itemIndex}`}
              ref={(element) => {
                thumbRefs.current[itemIndex] = element;
              }}
              type="button"
              onClick={() => onIndexChange(itemIndex)}
              title={item.label}
              className={clsx(
                "relative h-14 w-14 shrink-0 overflow-hidden rounded-md border-2 transition",
                itemIndex === index
                  ? "border-sky-400"
                  : "border-transparent opacity-60 hover:opacity-100",
              )}
            >
              {item.kind === "image" && mediaSrc(item.url) ? (
                <img
                  src={mediaSrc(item.url)}
                  alt={item.label}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="grid h-full w-full place-items-center bg-slate-800 text-slate-300">
                  <Film size={16} />
                </span>
              )}
            </button>
          ))}
        </div>
      </footer>
    </div>,
    document.body,
  );
}

function IconButton(props: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className="grid h-8 w-8 place-items-center rounded-lg text-slate-300 transition hover:bg-white/10 hover:text-white"
    >
      {props.children}
    </button>
  );
}

function Hint(props: { text: string }) {
  return (
    <div className="m-auto rounded-xl border border-dashed border-white/20 px-4 py-6 text-ui-caption text-slate-400">
      {props.text}
    </div>
  );
}
