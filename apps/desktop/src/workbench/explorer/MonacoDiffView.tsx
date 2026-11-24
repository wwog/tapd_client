/**
 * Monaco's inline diff editor: one column, real line numbers, added/removed
 * lines tinted by Monaco itself.
 *
 * This is the review tab's surface. It replaces threading diff line numbers
 * into a decoration layer: the two texts are all it needs, so anything that
 * can show a file (a worktree, a branch, a phone) can show its change the same
 * way. Read-only by construction — the base side is a commit, not a buffer.
 */
import { useEffect, useRef } from "react";

import { useResolvedTheme } from "../../lib/appearance";
import { monaco } from "./monaco";

type Props = {
  /** The task's baseline text; `null` for a file the baseline never had. */
  base: string | null;
  /** The current text; `null` for a deleted file. */
  current: string | null;
  /** Monaco language id (`plaintext` for unknown files). */
  language: string;
  wrap: boolean;
};

export function MonacoDiffView({ base, current, language, wrap }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{
    original: monaco.editor.ITextModel;
    modified: monaco.editor.ITextModel;
  } | null>(null);
  const theme = useResolvedTheme();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const original = monaco.editor.createModel(base ?? "", language);
    const modified = monaco.editor.createModel(current ?? "", language);
    modelsRef.current = { original, modified };
    const editor = monaco.editor.createDiffEditor(host, {
      theme: theme === "dark" ? "tapd-dark" : "tapd-light",
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily:
        '"SFMono-Regular", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: "selection",
      padding: { top: 10, bottom: 12 },
      // One column, the way an editor's "changes" view reads; the side-by-side
      // split is for comparing two files, not for reviewing one.
      renderSideBySide: false,
      // A review is a reading surface: neither side may be edited.
      readOnly: true,
      originalEditable: false,
      renderOverviewRuler: false,
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false,
      },
    });
    editor.setModel({ original, modified });
    editorRef.current = editor;

    // Open on the first change, the way an editor's changes view does. A file
    // without changes stays at the top.
    const reveal = window.requestAnimationFrame(() => {
      editor.revealFirstDiff();
    });

    return () => {
      window.cancelAnimationFrame(reveal);
      editor.dispose();
      original.dispose();
      modified.dispose();
      editorRef.current = null;
      modelsRef.current = null;
    };
    // Mount-only: the models are replaced by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A refresh (or a finished task) replaces the two sides in place.
  useEffect(() => {
    const models = modelsRef.current;
    if (!models) return;
    if (models.original.getValue() !== (base ?? "")) {
      models.original.setValue(base ?? "");
    }
    if (models.modified.getValue() !== (current ?? "")) {
      models.modified.setValue(current ?? "");
    }
  }, [base, current]);

  useEffect(() => {
    const models = modelsRef.current;
    if (!models) return;
    for (const model of [models.original, models.modified]) {
      if (model.getLanguageId() !== language) {
        monaco.editor.setModelLanguage(model, language);
      }
    }
  }, [language]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      diffWordWrap: wrap ? "on" : "off",
    });
  }, [wrap]);

  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? "tapd-dark" : "tapd-light");
  }, [theme]);

  return (
    <div
      data-component="MonacoDiffView"
      ref={hostRef}
      className="h-full w-full"
      data-workbench-file="monaco-diff"
    />
  );
}
