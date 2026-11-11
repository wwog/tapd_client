import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import MDEditor, { type ICommand } from "@uiw/react-md-editor";
import { getCommands as getChineseCommands } from "@uiw/react-md-editor/commands-cn";
import {
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import clsx from "clsx";

import { agentApi } from "../lib/agent";
import { bugTitle } from "../lib/bug";
import { useResolvedTheme } from "../lib/appearance";
import { useTauriSubscription } from "../lib/tauriEvent";
import { useCurrentAgent } from "../lib/useCurrentAgent";
import { Button } from "./ui";

export type AgentComposePayload = {
  prompt: string;
  attachments: string[];
};

type Props = {
  open: boolean;
  /** Bug title, used as the sheet subtitle. */
  title: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (payload: AgentComposePayload) => void;
  toast?: (kind: "ok" | "error", text: string) => void;
};

/**
 * Bottom sheet for a prompt + resource launch. Resources are always handed to
 * the agent as absolute local paths: the editor text is Markdown only, never
 * inline image/video data.
 */
export function AgentComposeSheet(props: Props) {
  const { open, title, submitting, onClose, onSubmit, toast } = props;
  const theme = useResolvedTheme();
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Runtime the queue will use; it comes from Settings → Agent 管理. */
  const currentAgent = useCurrentAgent(open);

  // Every opening starts clean; the bug id is part of the panel key upstream,
  // so switching targets also remounts this sheet.
  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setAttachments([]);
    setSaving(false);
    setDragging(false);
  }, [open]);


  const addPaths = useCallback((paths: string[]) => {
    const next = paths.map((path) => path.trim()).filter(Boolean);
    if (next.length === 0) return;
    setAttachments((current) => {
      const merged = [...current];
      for (const path of next) {
        if (!merged.includes(path)) merged.push(path);
      }
      return merged;
    });
  }, []);

  const pickFiles = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: true,
        directory: false,
        title: "选择图片、视频或其他资源",
        filters: [
          { name: "图片与视频", extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "mp4", "mov", "webm", "m4v"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      });
      if (!selected) return;
      addPaths(Array.isArray(selected) ? selected : [selected]);
    } catch (error) {
      toast?.("error", `打开文件选择器失败：${String(error)}`);
    }
  }, [addPaths, toast]);

  /** Pasted screenshots have no path yet, so persist them once and keep it. */
  const savePasted = useCallback(
    async (files: File[]) => {
      setSaving(true);
      try {
        const saved: string[] = [];
        for (const file of files) {
          const data = await toBase64(await file.arrayBuffer());
          const result = await agentApi.saveResource(
            file.name || `pasted-${Date.now()}.png`,
            data,
          );
          saved.push(result.path);
        }
        addPaths(saved);
      } catch (error) {
        toast?.("error", `保存粘贴资源失败：${String(error)}`);
      } finally {
        setSaving(false);
      }
    },
    [addPaths, toast],
  );

  const submit = useCallback(() => {
    if (submitting || saving) return;
    onSubmit({ prompt: prompt.trim(), attachments });
  }, [attachments, onSubmit, prompt, saving, submitting]);

  // Escape closes, ⌘/Ctrl + Enter submits from anywhere in the sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onClose();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, open, submit, submitting]);

  // Native drag & drop only counts when the pointer is over the sheet, so the
  // rest of the workspace keeps its own drop behaviour.
  useTauriSubscription(
    open
      ? () =>
          getCurrentWindow().onDragDropEvent((event) => {
            const payload = event.payload;
            if (payload.type === "enter") {
              setDragging(isOverSheet(payload.position));
              return;
            }
            if (payload.type === "leave") {
              setDragging(false);
              return;
            }
            if (payload.type !== "drop") return;
            const overSheet = isOverSheet(payload.position);
            setDragging(false);
            if (!overSheet) return;
            addPaths(payload.paths ?? []);
          })
      : null,
    [addPaths, open],
  );

  const commands = useMemo<ICommand[]>(
    () =>
      getChineseCommands()
        .filter((command) => command.name !== "image")
        .concat({
          name: "attach-resource",
          keyCommand: "attach-resource",
          buttonProps: { "aria-label": "添加资源", title: "添加资源（传本地路径）" },
          icon: <Paperclip size={12} />,
          execute: () => void pickFiles(),
        }),
    [pickFiles],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[65]">
      <button
        type="button"
        aria-label="关闭补充说明"
        className="absolute inset-0 cursor-default bg-slate-900/15"
        onClick={() => !submitting && onClose()}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="用 Agent 修复"
        data-agent-compose
        className={clsx(
          "agent-sheet-up absolute inset-x-0 bottom-0 flex h-[min(64vh,560px)] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface ",
          dragging && "outline-2 -outline-offset-2 outline-sky-300",
        )}
        onDragOver={(event) => event.preventDefault()}
      >
        <header className="flex shrink-0 items-center gap-2.5 border-b border-slate-100 px-5 py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-600">
            <Sparkles size={15} />
          </span>
          <div className="min-w-0">
            <h2 className="text-ui-base font-normal text-slate-900">用 Agent 修复</h2>
            <p className="truncate text-ui-sm text-slate-500" title={bugTitle(title)}>
              {bugTitle(title)}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            disabled={submitting}
            className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-3">
          <div className="agent-compose-editor min-h-0 flex-1" data-color-mode={theme}>
            <MDEditor
              value={prompt}
              onChange={(value) => setPrompt(value ?? "")}
              height="100%"
              preview="live"
              visibleDragbar={false}
              commands={commands}
              textareaProps={{
                placeholder: "补充说明（Markdown）…  可写复现步骤、期望行为、注意事项",
                onPaste: (event) => {
                  const files = Array.from(event.clipboardData?.files ?? []).filter(
                    (file) => file.type.startsWith("image/"),
                  );
                  if (files.length === 0) return;
                  event.preventDefault();
                  void savePasted(files);
                },
              }}
            />
          </div>

          <AttachmentTray
            paths={attachments}
            saving={saving}
            dragging={dragging}
            onPick={() => void pickFiles()}
            onRemove={(path) =>
              setAttachments((current) => current.filter((item) => item !== path))
            }
          />
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3">
          <span
            className="min-w-0 truncate text-ui-xs text-slate-400"
            title="当前 Agent 来自 设置 → Agent 管理；图片、视频只把本地路径交给它"
          >
            {currentAgent
              ? `将使用 ${currentAgent.name} · ${currentAgent.binary}`
              : "正在读取当前 Agent…"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Sparkles size={13} />}
              loading={submitting}
              disabled={saving}
              onClick={submit}
            >
              加入队列
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function AttachmentTray(props: {
  paths: string[];
  saving: boolean;
  dragging: boolean;
  onPick: () => void;
  onRemove: (path: string) => void;
}) {
  const { paths, saving, dragging, onPick, onRemove } = props;

  return (
    <div
      title="也可以拖入或粘贴截图"
      className={clsx(
        "flex shrink-0 flex-wrap items-center gap-1.5 rounded-xl border border-dashed px-2 py-1.5 transition",
        dragging
          ? "border-sky-300 bg-sky-50"
          : "border-border bg-slate-50/60",
      )}
    >
      {paths.map((path) => (
        <span
          key={path}
          title={path}
          className="group inline-flex max-w-[260px] items-center gap-1.5 rounded-lg border border-border bg-surface py-1 pl-1.5 pr-1 text-ui-xs text-slate-600"
        >
          <AttachmentIcon path={path} />
          <span className="truncate">{fileName(path)}</span>
          <button
            type="button"
            aria-label={`移除 ${fileName(path)}`}
            onClick={() => onRemove(path)}
            className="grid h-4 w-4 shrink-0 place-items-center rounded text-slate-300 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={10} />
          </button>
        </span>
      ))}

      <button
        type="button"
        onClick={onPick}
        disabled={saving}
        className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-ui-xs text-slate-500 transition hover:bg-surface hover:text-slate-700 disabled:opacity-50"
      >
        {saving ? <Loader2 size={11} className="animate-spin" /> : <Paperclip size={11} />}
        {saving ? "保存中" : paths.length > 0 ? "继续添加" : "添加图片 / 视频"}
      </button>
    </div>
  );
}

function AttachmentIcon(props: { path: string }) {
  const kind = attachmentKind(props.path);
  const className = "shrink-0";
  if (kind === "image") return <ImageIcon size={11} className={className} />;
  if (kind === "video") return <Video size={11} className={className} />;
  return <FileText size={11} className={className} />;
}

function attachmentKind(path: string): "image" | "video" | "file" {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "svg"].includes(extension)) {
    return "image";
  }
  if (["mp4", "mov", "webm", "m4v", "avi", "mkv"].includes(extension)) return "video";
  return "file";
}

/** Tauri reports physical pixels; the sheet check must use CSS pixels. */
function isOverSheet(position: { x: number; y: number }): boolean {
  const ratio = window.devicePixelRatio || 1;
  const element = document.elementFromPoint(
    position.x / ratio,
    position.y / ratio,
  );
  return Boolean(element?.closest?.("[data-agent-compose]"));
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
