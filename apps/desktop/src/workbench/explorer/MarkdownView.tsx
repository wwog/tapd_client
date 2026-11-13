/**
 * Read-only Markdown preview for the file panel.
 *
 * `@uiw/react-md-editor` already ships a Markdown renderer; the wrapper sets
 * its colour mode so code blocks and tables follow the app theme. Typography
 * overrides live in `code.css` next to the syntax palette.
 */
import MDEditor from "@uiw/react-md-editor";
import rehypeSanitize from "rehype-sanitize";

import { useResolvedTheme } from "../../lib/appearance";
import "./code.css";

export function MarkdownView({ text }: { text: string }) {
  const theme = useResolvedTheme();

  return (
    <div
      className="explorer-markdown min-h-0 flex-1 select-text overflow-auto px-4 py-3 text-ui-caption leading-6 text-slate-700"
      data-workbench-file="markdown"
    >
      <MDEditor.Markdown
        source={text}
        // READMEs come from arbitrary repositories. The preview pipeline adds
        // `rehype-raw` by default; sanitize after it so `iframe`/`script` and
        // `javascript:` URLs never reach the WebView (which has Tauri IPC).
        rehypePlugins={[rehypeSanitize]}
        wrapperElement={{ "data-color-mode": theme }}
      />
    </div>
  );
}
