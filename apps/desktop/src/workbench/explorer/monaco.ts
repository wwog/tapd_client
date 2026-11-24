/**
 * Monaco bootstrap. Imported only by the lazily loaded `MonacoView`, so the
 * editor (~MBs) never affects app startup or the first file preview.
 *
 * Workers are bundled by Vite through `?worker` imports; the environment hook
 * routes each language to its own worker so JSON/CSS/HTML/TS services work
 * offline (Monaco's default tries to fetch workers from a CDN path).
 */
import * as monaco from "monaco-editor";
// The package exports map rewrites `monaco-editor/<path>` to `esm/vs/<path>.js`,
// so the `esm/vs` prefix must not be part of the specifier.
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

const scope = self as unknown as {
  MonacoEnvironment?: {
    getWorker: (workerId: string, label: string) => Worker;
  };
};

scope.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

/** Light theme aligned with the app's surface/canvas tokens. */
monaco.editor.defineTheme("tapd-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#0f172a",
    "editorGutter.background": "#ffffff",
    "editorLineNumber.foreground": "#94a3b8",
    "editorLineNumber.activeForeground": "#475569",
    "editor.selectionBackground": "#0ea5e933",
    "editor.inactiveSelectionBackground": "#0ea5e91a",
    "editor.lineHighlightBackground": "#f1f5f9",
    "editorIndentGuide.background1": "#e2e8f0",
    "editorIndentGuide.activeBackground1": "#cbd5e1",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#0f172a14",
    "editorSuggestWidget.background": "#ffffff",
    "editorSuggestWidget.border": "#0f172a14",
    "editorHoverWidget.background": "#ffffff",
    "editorHoverWidget.border": "#0f172a14",
    // Inline review diff: the same emerald/rose language as the review card,
    // not Monaco's default olive/pink.
    "diffEditor.border": "#0f172a14",
    "diffEditor.insertedLineBackground": "#ecfdf5b3",
    "diffEditor.removedLineBackground": "#fff1f2b3",
    "diffEditor.insertedTextBackground": "#10b9811f",
    "diffEditor.removedTextBackground": "#f43f5e1f",
    "diffEditorGutter.insertedLineBackground": "#d1fae5",
    "diffEditorGutter.removedLineBackground": "#ffe4e6",
  },
});

/** Dark theme aligned with `--color-surface` / `--color-border`. */
monaco.editor.defineTheme("tapd-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#17191e",
    "editor.foreground": "#e2e8f0",
    "editorGutter.background": "#17191e",
    "editorLineNumber.foreground": "#5b6472",
    "editorLineNumber.activeForeground": "#cbd5e1",
    "editor.selectionBackground": "#38bdf833",
    "editor.inactiveSelectionBackground": "#38bdf81a",
    "editor.lineHighlightBackground": "#ffffff0d",
    "editorIndentGuide.background1": "#ffffff14",
    "editorIndentGuide.activeBackground1": "#ffffff2e",
    "editorWidget.background": "#17191e",
    "editorWidget.border": "#ffffff1a",
    "editorSuggestWidget.background": "#17191e",
    "editorSuggestWidget.border": "#ffffff1a",
    "editorHoverWidget.background": "#17191e",
    "editorHoverWidget.border": "#ffffff1a",
    // Dark diff tints: the dark emerald/rose surfaces from styles.css.
    "diffEditor.border": "#ffffff1a",
    "diffEditor.insertedLineBackground": "#0c241c99",
    "diffEditor.removedLineBackground": "#2a151999",
    "diffEditor.insertedTextBackground": "#10b98126",
    "diffEditor.removedTextBackground": "#f43f5e26",
    "diffEditorGutter.insertedLineBackground": "#0f3226",
    "diffEditorGutter.removedLineBackground": "#3a1a20",
  },
});

export { monaco };
