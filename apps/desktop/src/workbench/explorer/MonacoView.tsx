/**
 * Monaco-backed text/code surface.
 *
 * The component is loaded lazily by the file panel. The editor model is created
 * once per mounted panel; typing flows through `onChange` and the parent decides
 * what to save. `⌘S` is handled inside the editor so it wins over the browser's
 * own shortcut while focus is in the code.
 */
import { useEffect, useRef } from "react";

import { useResolvedTheme } from "../../lib/appearance";
import { monaco } from "./monaco";

type Props = {
  value: string;
  /** Monaco language id (`plaintext` for unknown files). */
  language: string;
  readOnly: boolean;
  wrap: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
};

export function MonacoView({
  value,
  language,
  readOnly,
  wrap,
  onChange,
  onSave,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  const theme = useResolvedTheme();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const model = monaco.editor.createModel(value, language);
    const editor = monaco.editor.create(host, {
      model,
      theme: theme === "dark" ? "tapd-dark" : "tapd-light",
      // The panel is resized by splitters and tab moves; Monaco follows the
      // element instead of relying on a window resize event.
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily:
        '"SFMono-Regular", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: "smooth",
      renderWhitespace: "selection",
      padding: { top: 10, bottom: 12 },
      readOnly,
      domReadOnly: readOnly,
      fixedOverflowWidgets: true,
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false,
      },
    });
    editorRef.current = editor;

    const subscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue());
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.();
    });

    // Put the cursor at the top; opening a file should not show the end.
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.setScrollTop(0);

    return () => {
      subscription.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
    // Mount-only: the model is per panel, later changes go through the effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External content (save echo, reload after an outside edit) replaces the
  // buffer. Typing already matches, so this is a no-op on the common path.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== value) model.setValue(value);
  }, [value]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language);
    }
  }, [language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, domReadOnly: readOnly });
  }, [readOnly]);

  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wrap ? "on" : "off" });
  }, [wrap]);

  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? "tapd-dark" : "tapd-light");
  }, [theme]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full"
      data-workbench-file="monaco"
    />
  );
}
