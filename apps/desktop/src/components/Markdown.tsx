/**
 * Rendered Markdown for arbitrary text (file previews, agent replies).
 *
 * `@uiw/react-md-editor` already ships a renderer; the wrapper owns the things
 * every caller needs to get right: the colour mode and sanitizing after the
 * preview pipeline's `rehype-raw` (the WebView has Tauri IPC, so `javascript:`
 * links and embedded frames must never reach it). Typography lives in
 * `markdown.css`, keyed by the `md-body` class.
 *
 * Agent replies also pass `links`: local paths (a link, inline code that names
 * a file, or an image) open in the workbench file viewer instead of navigating
 * anywhere, and relative images load through the loopback `/file` route. The
 * capability is optional so file previews keep rendering exactly as before.
 */
import MDEditor from "@uiw/react-md-editor";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import clsx from "clsx";
import { FileText } from "lucide-react";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { useResolvedTheme } from "../lib/appearance";
import { openExternalUrl } from "../lib/desktop";
import { t } from "../lib/i18n";
import { inlineCodePath, localPathFromHref } from "../lib/localPath";
import "./markdown.css";

/** What the host does with a local path found in the text. */
export type MarkdownLinks = {
  /** Opens a path from the reply in the app's own file viewer. */
  open: (path: string) => void;
  /** Resolves a local image path into a URL the renderer can load. */
  image?: (path: string) => Promise<string | null>;
};

const LinksContext = createContext<MarkdownLinks | null>(null);
/** Set by `pre`, so a fenced block never turns into a clickable path. */
const BlockCodeContext = createContext(false);
/** Set by an anchor, so inline code inside a link keeps the link's action. */
const InsideLinkContext = createContext(false);

/**
 * The preview pipeline parses raw HTML before react-markdown sees it, and its
 * default protocol list would drop `file:` destinations. Nothing here
 * navigates: the click handler hands the path to the file viewer.
 */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
    src: [...(defaultSchema.protocols?.src ?? []), "file"],
  },
};

/** The protocols react-markdown's own default allows, minus raw HTML input. */
const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

/**
 * Same rule as react-markdown's default transform (no scheme means relative),
 * plus the local paths the viewer handles. Anything else is dropped before it
 * reaches the WebView's IPC.
 */
const URL_TRANSFORM = (url: string, key: string): string => {
  if ((key === "href" || key === "src") && localPathFromHref(url)) return url;
  const colon = url.indexOf(":");
  const question = url.indexOf("?");
  const hash = url.indexOf("#");
  const slash = url.indexOf("/");
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (question !== -1 && colon > question) ||
    (hash !== -1 && colon > hash)
  ) {
    return url;
  }
  return SAFE_PROTOCOL.test(url.slice(0, colon)) ? url : "";
};

/**
 * Links: a URL opens in the system browser (a plain anchor would navigate this
 * WebView, which carries the Tauri IPC away from the app); a local path goes to
 * the host instead. `@uiw` forwards unknown props to react-markdown, so the
 * component map works even though its declared props omit it.
 */
/**
 * The file glyph marks every local target as an in-app viewer link, so a path
 * in a reply does not read like ordinary code. Remote links stay plain.
 */
function FileGlyph() {
  return (
    <FileText
      size={11}
      strokeWidth={1.75}
      aria-hidden
      className="md-file-icon"
    />
  );
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const links = useContext(LinksContext);
  const local = links ? localPathFromHref(href) : null;
  return (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        if (local) links?.open(local);
        else if (href) void openExternalUrl(href);
      }}
    >
      {local ? <FileGlyph /> : null}
      <InsideLinkContext.Provider value>{children}</InsideLinkContext.Provider>
    </a>
  );
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  return (
    <pre>
      <BlockCodeContext.Provider value>{children}</BlockCodeContext.Provider>
    </pre>
  );
}

function plainText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) {
    return children.filter((part): part is string => typeof part === "string").join("");
  }
  return "";
}

/**
 * Inline code that names a file (`docs/a.md`, `main.rs`) is a shortcut into the
 * viewer. Kept as `<code>` so copying the text still works; Enter also opens it.
 */
function MarkdownCode({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const links = useContext(LinksContext);
  const block = useContext(BlockCodeContext);
  const inLink = useContext(InsideLinkContext);
  const path = links && !block && !inLink ? inlineCodePath(plainText(children)) : null;
  if (!path) return <code className={className}>{children}</code>;

  const open = () => links?.open(path);
  return (
    <code
      className={clsx(className, "md-file-link")}
      role="link"
      tabIndex={0}
      title={t("agent.file.open")}
      onClick={(event) => {
        // An inline code span can sit inside a link; the file is the narrower
        // target, so it wins.
        event.stopPropagation();
        event.preventDefault();
        open();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
    >
      <FileGlyph />
      {children}
    </code>
  );
}

/**
 * Relative or absolute image paths are resolved by the host. Remote and data
 * URLs render as before; a failed local image falls back to a clickable chip
 * so the path itself stays usable.
 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const links = useContext(LinksContext);
  const path = links?.image ? localPathFromHref(src) : null;
  if (!path) return <img src={src} alt={alt} />;
  return <LocalImage path={path} alt={alt} />;
}

function LocalImage({ path, alt }: { path: string; alt?: string }) {
  const links = useContext(LinksContext);
  const [resolved, setResolved] = useState<{ src: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    void links
      ?.image?.(path)
      .then((src) => {
        if (!cancelled) setResolved({ src });
      })
      .catch(() => {
        if (!cancelled) setResolved({ src: null });
      });
    return () => {
      cancelled = true;
    };
  }, [links, path]);

  const open = () => links?.open(path);
  if (!resolved) return null;
  if (!resolved.src) {
    return (
      <button
        type="button"
        className="md-image-missing"
        title={t("agent.file.open")}
        onClick={(event) => {
          event.stopPropagation();
          open();
        }}
      >
        <FileGlyph />
        {alt || path}
      </button>
    );
  }
  return (
    <img
      src={resolved.src}
      alt={alt || path}
      title={t("agent.file.open")}
      className="md-local-image"
      onClick={(event) => {
        // An image can be the label of a link; the picture is the target here.
        event.stopPropagation();
        open();
      }}
    />
  );
}

const COMPONENTS = {
  a: MarkdownLink,
  pre: MarkdownPre,
  code: MarkdownCode,
  img: MarkdownImage,
};

/**
 * Memoized: the transcript re-renders on every unrelated stream frame, and
 * re-parsing unchanged Markdown on each of them is the expensive part.
 */
export const Markdown = memo(function Markdown({
  source,
  className,
  links,
}: {
  source: string;
  className?: string;
  links?: MarkdownLinks;
}) {
  const theme = useResolvedTheme();

  return (
    <LinksContext.Provider value={links ?? null}>
      <div className={clsx("md-body", className)}>
        <MDEditor.Markdown
          source={source}
          components={COMPONENTS}
          rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]}
          urlTransform={URL_TRANSFORM}
          wrapperElement={{ "data-color-mode": theme }}
        />
      </div>
    </LinksContext.Provider>
  );
});
