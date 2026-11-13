import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import MDEditor, { type ICommand } from "@uiw/react-md-editor";
import { getCommands } from "@uiw/react-md-editor/commands";
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

import { agentApi, type AgentConfig, type AgentRuntimeDescriptor } from "../lib/agent";
import { useAgentScan } from "../lib/agentScan";
import { bugTitle } from "../lib/bug";
import { useResolvedTheme } from "../lib/appearance";
import { getLocale, t } from "../lib/i18n";
import { hasOpenDismissLayer } from "../hooks/useDismiss";
import { useTauriSubscription } from "../lib/tauriEvent";
import { AgentPicker } from "./AgentPicker";
import { Button, ModalDragStrip } from "./ui";

export type AgentComposePayload = {
  prompt: string;
  attachments: string[];
  /** 本次任务指定运行时；为空时使用设置里的默认 Agent。 */
  runtimeId?: string;
  /** 本次任务的模型；为空时使用该运行时的默认值。 */
  model?: string;
  /** 本次任务的访问权限；为空时使用该运行时的默认值。 */
  permissionMode?: string;
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
  /** 运行时目录。 */
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);
  /** 配置快照，用于取每个运行时的默认模型 / 权限。 */
  const [config, setConfig] = useState<AgentConfig | null>(null);
  /** 本次任务要用的运行时；默认跟随设置。 */
  const [runtimeId, setRuntimeId] = useState("");
  /** 本次任务的模型与权限；切换运行时回到该运行时的默认值。 */
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState("");
  const { byRuntime, snapshot: scan } = useAgentScan();

  // Every opening starts clean; the bug id is part of the panel key upstream,
  // so switching targets also remounts this sheet.
  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setAttachments([]);
    setSaving(false);
    setDragging(false);
    setRuntimeId("");
    setModel("");
    setPermissionMode("");
  }, [open]);

  // 打开时读取目录与默认运行时，刷新「本次任务使用」的初值。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([agentApi.configGet(), agentApi.runtimes()])
      .then(([configResult, runtimeResult]) => {
        if (cancelled) return;
        const nextRuntimes = runtimeResult.runtimes.filter((runtime) => runtime.available);
        setConfig(configResult.config);
        setRuntimes(nextRuntimes);
        const nextRuntimeId = configResult.config.runtimeId;
        setRuntimeId(nextRuntimeId);
        const defaults = configResult.config.runtimeOptions?.[nextRuntimeId];
        setModel(defaults?.model ?? "");
        setPermissionMode(
          defaults?.permissionMode ||
            nextRuntimes
              .find((runtime) => runtime.id === nextRuntimeId)
              ?.permissions[0]?.id ||
            "",
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open]);

  /** 切换运行时同时把模型/权限切回该运行时的默认值。 */
  const changeRuntime = useCallback(
    (nextId: string) => {
      setRuntimeId(nextId);
      const defaults = config?.runtimeOptions?.[nextId];
      setModel(defaults?.model ?? "");
      setPermissionMode(
        defaults?.permissionMode ||
          runtimes.find((runtime) => runtime.id === nextId)?.permissions[0]?.id ||
          "",
      );
    },
    [config, runtimes],
  );

  const selectedRuntime =
    runtimes.find((runtime) => runtime.id === runtimeId) ?? null;
  const permissionOptions = selectedRuntime?.permissions ?? [];

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
        title: t("chat.attachTitle"),
        filters: [
          { name: t("chat.imagesAndVideos"), extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "mp4", "mov", "webm", "m4v"] },
          { name: t("chat.allFiles"), extensions: ["*"] },
        ],
      });
      if (!selected) return;
      addPaths(Array.isArray(selected) ? selected : [selected]);
    } catch (error) {
      toast?.("error", t("chat.pickerFailed", { error: String(error) }));
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
        toast?.("error", t("chat.pasteFailed", { error: String(error) }));
      } finally {
        setSaving(false);
      }
    },
    [addPaths, toast],
  );

  const submit = useCallback(() => {
    if (submitting || saving) return;
    onSubmit({
      prompt: prompt.trim(),
      attachments,
      runtimeId: runtimeId || undefined,
      model: model.trim() || undefined,
      permissionMode: permissionMode || undefined,
    });
  }, [attachments, model, onSubmit, permissionMode, prompt, runtimeId, saving, submitting]);

  // Escape closes, ⌘/Ctrl + Enter submits from anywhere in the sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      // Esc 先关掉打开的选择器菜单，再考虑关闭面板。
      if (event.key === "Escape" && !submitting && !hasOpenDismissLayer()) {
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

  const locale = getLocale();
  const commands = useMemo<ICommand[]>(
    () =>
      // The Markdown toolbar ships its own localized command set; pick the one
      // matching the UI language (there is no runtime language switch inside).
      (getLocale() === "en" ? getCommands() : getChineseCommands())
        .filter((command) => command.name !== "image")
        .concat({
          name: "attach-resource",
          keyCommand: "attach-resource",
          buttonProps: {
            "aria-label": t("chat.addResource"),
            title: t("chat.addResourceHint"),
          },
          icon: <Paperclip size={12} />,
          execute: () => void pickFiles(),
        }),
    [pickFiles, locale],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[65]">
      {/* Backdrop is inert: the sheet has explicit close/cancel buttons. */}
      <div aria-hidden="true" className="absolute inset-0 bg-slate-900/15" />
      <ModalDragStrip />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.fixWithAgent")}
        data-agent-compose
        className={clsx(
          "agent-sheet-up absolute inset-x-0 bottom-0 flex h-[min(64vh,560px)] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface ",
          dragging && "outline-2 -outline-offset-2 outline-sky-300",
        )}
        onDragOver={(event) => event.preventDefault()}
      >
        <header
          data-tauri-drag-region
          className="flex shrink-0 items-center gap-2.5 border-b border-slate-100 px-5 py-3"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-600">
            <Sparkles size={15} />
          </span>
          <div className="min-w-0" data-tauri-drag-region>
            <h2 data-tauri-drag-region className="text-ui-base font-normal text-slate-900">
              {t("chat.fixWithAgent")}
            </h2>
            <p className="truncate text-ui-sm text-slate-500" title={bugTitle(title)}>
              {bugTitle(title)}
            </p>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
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
                placeholder: t("chat.contextPlaceholder"),
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
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <span className="shrink-0 text-ui-xs text-slate-400">{t("chat.forThisTask")}</span>
            <AgentPicker
              compact
              placement="up"
              className="w-[200px]"
              runtimes={runtimes}
              value={runtimeId}
              byRuntime={byRuntime}
              hasScan={Boolean(scan)}
              disabled={submitting || runtimes.length === 0}
              onChange={changeRuntime}
            />
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              list={selectedRuntime ? `agent-model-${selectedRuntime.id}` : undefined}
              disabled={submitting}
              spellCheck={false}
              title={t("chat.modelHint")}
              placeholder={t("chat.defaultModel")}
              className="h-[30px] w-[170px] rounded-lg border border-border bg-surface px-2 text-ui-xs text-slate-700 transition placeholder:text-slate-300 focus:border-sky-300 focus:outline-2 focus:outline-sky-200 disabled:opacity-60"
            />
            {selectedRuntime ? (
              <datalist id={`agent-model-${selectedRuntime.id}`}>
                {selectedRuntime.models.map((item) => (
                  <option key={item} value={item} />
                ))}
              </datalist>
            ) : null}
            {permissionOptions.length > 1 ? (
              <select
                value={permissionMode || permissionOptions[0]?.id || "default"}
                onChange={(event) => setPermissionMode(event.target.value)}
                disabled={submitting}
                title={t("chat.permissionHint")}
                className="h-[30px] w-[150px] rounded-lg border border-border bg-surface px-2 text-ui-xs text-slate-700 transition focus:border-sky-300 focus:outline-2 focus:outline-sky-200 disabled:opacity-60"
              >
                {permissionOptions.map((option) => (
                  <option key={option.id} value={option.id} title={option.description}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={submitting}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Sparkles size={13} />}
              loading={submitting}
              disabled={saving}
              onClick={submit}
            >
              {t("chat.addToQueue")}
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
      title={t("chat.dropOrPaste")}
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
            aria-label={t("chat.removeAttachment", { name: fileName(path) })}
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
        {saving ? t("common.saving") : paths.length > 0 ? t("chat.addMore") : t("chat.addImageVideo")}
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
