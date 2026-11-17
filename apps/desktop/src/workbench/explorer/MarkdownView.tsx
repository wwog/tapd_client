/**
 * Read-only Markdown preview for the file panel. Rendering and sanitizing live
 * in the shared `Markdown` component; this wrapper owns the panel layout and
 * the marker other workbench code looks for.
 */
import { Markdown } from "../../components/Markdown";

export function MarkdownView({ text }: { text: string }) {
  return (
    <div
      className="min-h-0 flex-1 select-text overflow-auto px-4 py-3 text-ui-caption leading-6 text-slate-700"
      data-workbench-file="markdown"
    >
      <Markdown source={text} />
    </div>
  );
}
