/**
 * Rendered Markdown for arbitrary text (file previews, agent replies).
 *
 * `@uiw/react-md-editor` already ships a renderer; the wrapper owns the two
 * things every caller needs to get right: the colour mode and sanitizing after
 * the preview pipeline's `rehype-raw` (the WebView has Tauri IPC, so
 * `javascript:` links and embedded frames must never reach it). Typography
 * lives in `markdown.css`, keyed by the `md-body` class.
 */
import MDEditor from "@uiw/react-md-editor";
import rehypeSanitize from "rehype-sanitize";
import clsx from "clsx";
import { memo, type ReactNode } from "react";

import { useResolvedTheme } from "../lib/appearance";
import { openExternalUrl } from "../lib/desktop";
import "./markdown.css";

/**
 * Links open in the system browser: a plain anchor would navigate this WebView
 * (which carries the Tauri IPC) away from the app. `@uiw` forwards unknown
 * props to react-markdown, so the component map works even though its declared
 * props omit it.
 */
const COMPONENTS = {
  a({ href, children }: { href?: string; children?: ReactNode }) {
    return (
      <a
        href={href}
        title={href}
        onClick={(event) => {
          event.preventDefault();
          if (href) void openExternalUrl(href);
        }}
      >
        {children}
      </a>
    );
  },
};

/**
 * Memoized: the transcript re-renders on every unrelated stream frame, and
 * re-parsing unchanged Markdown on each of them is the expensive part.
 */
export const Markdown = memo(function Markdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const theme = useResolvedTheme();

  return (
    <div className={clsx("md-body", className)}>
      <MDEditor.Markdown
        source={source}
        components={COMPONENTS}
        rehypePlugins={[rehypeSanitize]}
        wrapperElement={{ "data-color-mode": theme }}
      />
    </div>
  );
});
