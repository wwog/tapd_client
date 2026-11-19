/**
 * App-wide entry point for the in-app image/video preview.
 *
 * Any inline media the app renders (agent replies, tool output, resources) can
 * call `openMediaPreview` without owning an overlay: one host at the app root
 * renders the existing `MediaPreview` (zoom, paging, thumbnail rail) above
 * every page and workbench panel.
 */
import { useCallback, useEffect, useState } from "react";

import { MediaPreview, type PreviewItem } from "./MediaPreview";

type Request = { items: PreviewItem[]; index: number };

let open: ((request: Request) => void) | null = null;

/** Opens the full-screen preview. No-op outside the mounted host (tests). */
export function openMediaPreview(items: PreviewItem[], index = 0): void {
  if (items.length === 0) return;
  open?.({ items, index: Math.min(Math.max(index, 0), items.length - 1) });
}

export function MediaPreviewHost() {
  const [request, setRequest] = useState<Request | null>(null);

  useEffect(() => {
    open = setRequest;
    return () => {
      open = null;
    };
  }, []);

  const changeIndex = useCallback((index: number) => {
    setRequest((current) => (current ? { ...current, index } : current));
  }, []);
  const close = useCallback(() => setRequest(null), []);

  if (!request) return null;
  return (
    <MediaPreview
      items={request.items}
      index={request.index}
      onIndexChange={changeIndex}
      onClose={close}
    />
  );
}
