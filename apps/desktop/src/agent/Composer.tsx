import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import clsx from "clsx";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  FolderGit2,
  GitBranch,
  LayoutGrid,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Send,
  Square,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

import { t } from "../lib/i18n";
import { showToast } from "../lib/toast";
import { useTauriSubscription } from "../lib/tauriEvent";
import { pickExportDir } from "../lib/exportDir";
import { api } from "../lib/api";
import { dshApi } from "../lib/dsh";
import { Button } from "../components/ui";
import { Dialog } from "../components/Dialog";
import { ScrollingName } from "../components/ScrollingName";
import { openMediaPreview } from "../components/MediaPreviewHost";
import { GoalChip } from "./GoalChip";
import { AGENT_COLUMN } from "./layout";
import { moveIndex } from "./listNav";
import { MentionPalette } from "./MentionPalette";
import { QueuedPrompts } from "./QueuedPrompts";
import {
  activeMention,
  applyMention,
  type MentionRow,
} from "./mentions";
import { PromptHistoryPanel } from "./PromptHistoryPanel";
import { runtimeBlock, runtimeLabel } from "./runtime";
import { SessionModePicker } from "./SessionModePicker";
import { SessionModelPicker } from "./SessionModelPicker";
import { SessionUsageBar } from "./usage/SessionUsageBar";
import { SlashPalette } from "./SlashPalette";
import {
  buildSlashItems,
  fileMention,
  permissionArg,
  slashIntent,
  runtimeCommandNames,
  slashQuery,
  type SlashCommand,
} from "./slashCommands";
import {
  collectPromptHistory,
  filterHistory,
} from "./promptHistory";
import {
  agentActions,
  agentStore,
  agentTaskView,
  agentTeamView,
  isSessionRunning,
  sessionPermissionMode,
  sessionPlan,
  taskReviewable,
  type QueuedPrompt,
} from "./store";
import { isWorkflowTask } from "./workflow";

/** Draft key before any session exists; the text follows the first one. */
const NEW_SESSION_KEY = "__new";

/** Stable empty catalog, so `buildSlashItems` keeps its memo. */
const EMPTY_COMMANDS: never[] = [];

/** One image waiting to be sent: `data` is canonical base64 for the model. */
type ComposerImage = {
  id: string;
  name: string;
  mediaType: string;
  data: string;
  /** The same bytes as a data URL, for the chip and the optimistic bubble. */
  src: string;
};

const EMPTY_IMAGES: ComposerImage[] = [];

const EMPTY_QUEUE: QueuedPrompt[] = [];

/** dsh admits exactly these four image types (attachment store allowlist). */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const MAX_IMAGES = 8;

/** The media type a picked path can be attached as, or undefined. */
function imageTypeOf(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_TYPES[ext];
}

function fileNameOf(path: string): string {
  return path.split(/[/\\]/u).pop() ?? path;
}

/**
 * One compact control in the composer's work bar. It reads as text until it is
 * active; the only border in the composer is the card's own, so a row of these
 * never turns into a second toolbar.
 *
 * A locked control (the session already started, or a workflow task) drops
 * every hover variant: it is a plain state label, so hovering must not suggest
 * it could be toggled.
 */
function WorkBarButton(props: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  error?: string | null;
  onClick?: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      data-component="WorkBarButton"
      type="button"
      aria-pressed={props.active}
      disabled={props.disabled}
      title={props.error || props.title}
      onClick={props.onClick}
      className={clsx(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-ui-2xs transition",
        props.disabled && "cursor-default",
        props.active
          ? "bg-sky-50 text-sky-700"
          : "text-slate-500",
        !props.disabled &&
          !props.active &&
          "hover:bg-overlay-soft hover:text-slate-700",
        props.error && "text-rose-600",
      )}
    >
      <Icon size={11} />
      {props.label}
    </button>
  );
}

/**
 * Enter sends, Shift+Enter adds a line.
 *
 * One bordered card holds the work bar, the editor and its toolbar: the top
 * row names the project and branch and carries the two start-only choices
 * (coworkers, worktree); the text sits below; only the card is outlined.
 * The primary button is a single state machine — while the session is running
 * it stops the turn, otherwise it sends the draft.
 */
export function Composer() {
  const state = agentStore.use();
  const sessionId = state.selectedId ?? NEW_SESSION_KEY;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [images, setImages] = useState<Record<string, ComposerImage[]>>({});
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  /** Draft the palette was dismissed for; a new keystroke reopens it. */
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(0);
  /** `@` completion state: the caret's token drives the query. */
  const [caret, setCaret] = useState(0);
  const [mention, setMention] = useState<{ items: MentionRow[]; root: string } | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  /** Rising counters that open the composer's own model / mode sheets. */
  const [signals, setSignals] = useState({ model: 0, mode: 0 });
  /** A draft submitted while the paused queue needs a decision first. */
  const [sendConfirm, setSendConfirm] = useState<{
    text: string;
    images: ComposerImage[];
  } | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  /** What the composer held before a queued item was loaded for editing. */
  const editStash = useRef<
    Record<string, { text: string; images: ComposerImage[] } | undefined>
  >({});
  const text = drafts[sessionId] ?? "";
  const attachments = images[sessionId] ?? EMPTY_IMAGES;
  const queue =
    (state.selectedId ? state.queuedPrompts[state.selectedId] : undefined) ??
    EMPTY_QUEUE;
  const queuePaused = state.selectedId
    ? state.queuePause[state.selectedId]
    : undefined;
  const editingQueueId = state.selectedId
    ? state.queueEditing[state.selectedId]
    : undefined;
  const setText = (value: string) =>
    setDrafts((current) => ({ ...current, [sessionId]: value }));
  /** Empties this chat's draft, including the slot a send may have outgrown
   *  (allocation moves the selection off `__new` mid-flight). */
  const clearDraft = () =>
    setDrafts((current) => ({
      ...current,
      [sessionId]: "",
      [NEW_SESSION_KEY]: "",
    }));
  const setAttachments = (next: ComposerImage[]) =>
    setImages((current) => ({ ...current, [sessionId]: next }));
  const clearImages = () =>
    setImages((current) => ({
      ...current,
      [sessionId]: [],
      [NEW_SESSION_KEY]: [],
    }));
  const block = runtimeBlock(state);
  const running = isSessionRunning(state, state.selectedId);
  const task = state.tasks?.find((item) => item.id === state.selectedId);
  const chat = !isWorkflowTask(task);
  const reviewing = taskReviewable(task);
  const project = task?.project ?? null;
  const branch = task?.branch ?? null;
  const worktree = Boolean(task?.worktreePath);

  // Both choices are start-only: a task is created with the config default, a
  // free chat may switch them until its first message. After that the row is
  // read-only (the controls stay visible so the state is still legible).
  const started =
    task != null &&
    (isWorkflowTask(task) ||
      task.messageCount > 0 ||
      (state.pendingPrompts[task.id]?.length ?? 0) > 0 ||
      (state.queuedPrompts[task.id]?.length ?? 0) > 0 ||
      task.status === "running");
  const canChoose = Boolean(task && project && !started);

  const team = task ? state.team[task.id] : undefined;
  const teamEnabled = task
    ? (state.chatTeamDrafts[task.id] ?? Boolean(team?.enabled))
    : false;
  const teamBusy = task ? Boolean(state.teamBusy[task.id]) : false;
  const teamError = task ? state.teamErrors[task.id] : null;
  const teamView = task ? agentTeamView(state, task.id) : "chat";
  const paneView = agentTaskView(state, state.selectedId);
  const goal = state.selectedId ? state.sessions[state.selectedId]?.goal : undefined;

  // 「继续修改」in the review pane switches back here and asks for the caret.
  const focusAt = state.composerFocusAt;
  useEffect(() => {
    if (focusAt > 0) editorRef.current?.focus();
  }, [focusAt]);

  // ---------------------------------------------------------------------
  // `/` palette and ↑ history
  // ---------------------------------------------------------------------

  const catalogKey = state.selectedId ?? NEW_SESSION_KEY;
  const descriptors = state.commandCatalog[catalogKey] ?? EMPTY_COMMANDS;
  const slashItems = useMemo(
    () => buildSlashItems(text, descriptors, (key) => t(key)),
    [text, descriptors],
  );
  const slashOpen =
    slashQuery(text) !== undefined && slashDismissed !== text;

  /**
   * `@` completion. The token under the caret is the query; a slash command
   * draft never opens it, so the two panels cannot fight over the same keys.
   */
  const mentionToken = slashOpen ? undefined : activeMention(text, caret);
  const mentionOpen = mentionToken !== undefined && mention !== null;

  /** Engine command names for routing a typed line without opening the menu. */
  const runtimeNames = useMemo(() => runtimeCommandNames(descriptors), [descriptors]);

  const historyItems = useMemo(() => {
    const session = state.selectedId;
    const own = session ? state.entries[session]?.items : undefined;
    const ownTexts = own
      ?.filter((entry) => entry.kind === "user")
      .map((entry) => entry.text);
    const pending = session ? state.pendingPrompts[session] : undefined;
    return filterHistory(
      collectPromptHistory([
        pending?.map((item) => item.text),
        ownTexts,
        state.promptHistory ?? undefined,
      ]),
      historyOpen ? text : "",
    );
  }, [
    historyOpen,
    state.entries,
    state.pendingPrompts,
    state.promptHistory,
    state.selectedId,
    text,
  ]);

  // A new draft restarts both lists at the top.
  useEffect(() => {
    setSlashIndex(0);
    setHistoryIndex(0);
  }, [text]);

  useEffect(() => {
    if (!slashOpen) return;
    if (state.commandCatalog[catalogKey] !== undefined) return;
    void agentActions.loadCommands(state.selectedId);
  }, [catalogKey, slashOpen, state.commandCatalog, state.selectedId]);

  useEffect(() => {
    if (historyOpen) void agentActions.loadPromptHistory(true);
  }, [historyOpen]);

  // One search per settled query; a keystroke inside the debounce window
  // cancels the previous request so results can never arrive out of order.
  const mentionQuery = mentionToken?.query;
  useEffect(() => {
    if (mentionQuery === undefined) {
      setMention(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void dshApi
        .mentions({
          sessionId: state.selectedId,
          root: mentionBase(),
          query: mentionQuery,
        })
        .then((reply) => {
          if (!live) return;
          setMention({ items: reply.items, root: reply.root });
          setMentionIndex(0);
        })
        .catch(() => {
          if (live) setMention(null);
        });
    }, 120);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // `mentionBase` reads the selected task, which `state.selectedId` already
    // keys; the query is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionQuery, state.selectedId]);

  const focusEditor = () => editorRef.current?.focus();

  /** Puts the caret after the last character once the new value is committed. */
  const caretToEnd = () => {
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    });
  };

  /** Replaces the active `@token` with the picked path and keeps the caret. */
  const pickMention = (row: MentionRow) => {
    if (!mentionToken) return;
    const next = applyMention(text, mentionToken, row.path);
    setText(next.text);
    setCaret(next.caret);
    setMention(null);
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(next.caret, next.caret);
    });
  };

  /** The directory a `@` reference should be relative to, when there is one. */
  const mentionBase = (): string => {
    if (task?.worktreePath) return task.worktreePath;
    const repo = state.projects?.find((item) => item.id === task?.project?.id);
    return repo?.repoPath ?? "";
  };

  /**
   * Routes picked or dropped paths: images become real attachments so the
   * model sees them (`@path` only lets it read the file, which cannot show a
   * picture); everything else becomes a readable `@path` reference.
   */
  const addPaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    const base = mentionBase();
    const mentions: string[] = [];
    const picked: ComposerImage[] = [];
    // Past the cap an image falls back to a reference instead of vanishing.
    const room = MAX_IMAGES - (images[sessionId]?.length ?? 0);
    for (const path of paths) {
      const mediaType = imageTypeOf(path);
      if (mediaType && picked.length < room) {
        try {
          const dataUrl = await api.imageDataUrl(path);
          const comma = dataUrl.indexOf(",");
          if (comma > 0) {
            picked.push({
              id: `${Date.now()}-${picked.length}`,
              name: fileNameOf(path),
              mediaType,
              data: dataUrl.slice(comma + 1),
              src: dataUrl,
            });
            continue;
          }
        } catch {
          // Unreadable or oversized: fall back to a readable reference.
        }
      }
      mentions.push(base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path);
    }
    if (picked.length > 0) {
      setImages((current) => ({
        ...current,
        [sessionId]: [...(current[sessionId] ?? EMPTY_IMAGES), ...picked].slice(
          0,
          MAX_IMAGES,
        ),
      }));
    }
    if (mentions.length > 0) {
      const snippet = mentions.map(fileMention).join(" ");
      setDrafts((current) => {
        const head = (current[sessionId] ?? "").replace(/\s+$/u, "");
        return {
          ...current,
          [sessionId]: head === "" ? snippet : `${head} ${snippet}`,
        };
      });
      caretToEnd();
    } else {
      focusEditor();
    }
  };

  /** The `+` control and `/file`: one picker, routed by file type. */
  const pickFiles = async (args: string) => {
    const typed = args
      .split(/\s+/u)
      .filter(Boolean)
      .map((path) => path.replace(/^"(.*)"$/u, "$1"));
    let paths = typed;
    if (paths.length === 0) {
      const selected = await openDialog({
        multiple: true,
        title: t("agent.cmd.filePick"),
      });
      paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    }
    await addPaths(paths);
  };

  /** Clipboard pictures paste straight into the draft as attachments. */
  const pasteImages = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      Object.values(IMAGE_TYPES).includes(file.type),
    );
    if (files.length === 0) return;
    event.preventDefault();
    for (const [index, file] of files.entries()) {
      const reader = new FileReader();
      reader.onload = () => {
        const src = typeof reader.result === "string" ? reader.result : "";
        const comma = src.indexOf(",");
        if (comma < 0) return;
        setImages((current) => ({
          ...current,
          [sessionId]: [
            ...(current[sessionId] ?? EMPTY_IMAGES).slice(0, MAX_IMAGES - 1),
            {
              id: `${Date.now()}-${index}`,
              name: file.name || `pasted-${index + 1}.png`,
              mediaType: file.type,
              data: src.slice(comma + 1),
              src,
            },
          ],
        }));
      };
      reader.readAsDataURL(file);
    }
  };

  // Dropping files onto the composer is the fast path for both kinds: images
  // become attachments, other files become `@` references. The ref keeps the
  // subscription alive across renders while the handler reads the latest draft.
  const addPathsRef = useRef(addPaths);
  addPathsRef.current = addPaths;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  useTauriSubscription(
    () =>
      // File drops target the *webview*: Tauri emits them only to Webview
      // listeners, so `getCurrentWindow().onDragDropEvent` never fires here.
      getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setDragging(false);
          return;
        }
        // wry on macOS reports `draggingLocation` in logical points (it already
        // matches CSS pixels) even though Tauri types it as a physical
        // position; other platforms report physical pixels. Try both so the
        // hit test works either way instead of halving macOS coordinates.
        const rect = cardRef.current?.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        const inside = Boolean(
          rect &&
            [
              { x: payload.position.x, y: payload.position.y },
              { x: payload.position.x / ratio, y: payload.position.y / ratio },
            ].some(
              (point) =>
                point.x >= rect.left &&
                point.x <= rect.right &&
                point.y >= rect.top &&
                point.y <= rect.bottom,
            ),
        );
        if (payload.type === "enter" || payload.type === "over") {
          setDragging(inside);
          return;
        }
        setDragging(false);
        if (!inside) return;
        void addPathsRef.current(payload.paths);
      }),
    [],
  );

  const exportLog = async () => {
    const id = agentStore.get().selectedId;
    if (!id) {
      showToast("error", t("agent.cmd.noSession"));
      return;
    }
    const dir = await pickExportDir();
    if (!dir) return;
    try {
      const result = await dshApi.exportSession(id, dir);
      await api.revealPath(result.path);
    } catch (error) {
      showToast("error", t("agent.cmd.exportFailed", { error: String(error) }));
    }
  };

  /**
   * Runs one of the five commands this app owns. The caller clears the draft
   * first: a command line is not message content, and `file` writes the
   * references it produced straight back.
   */
  const runNative = async (name: string, args: string): Promise<void> => {
    if (name === "file") {
      await pickFiles(args);
      return;
    }
    if (name === "model") {
      setSignals((current) => ({ ...current, model: current.model + 1 }));
      return;
    }
    if (name === "export") {
      await exportLog();
      return;
    }
    if (name === "permission") {
      const mode = permissionArg(args);
      if (!mode) {
        // `/permission` with no argument opens the picker, it does not guess.
        try {
          await agentActions.ensureSession();
        } catch (error) {
          showToast("error", String(error));
          return;
        }
        setSignals((current) => ({ ...current, mode: current.mode + 1 }));
        return;
      }
      try {
        const id = await agentActions.ensureSession();
        await agentActions.selectSessionMode(id, mode);
      } catch (error) {
        showToast("error", String(error));
      }
      return;
    }
    if (name === "plan") {
      const message = args.trim();
      try {
        const id = await agentActions.ensureSession();
        const current = agentStore.get();
        if (message.toLowerCase() === "off") {
          // Leaving plan keeps the permission mode underneath it.
          await agentActions.selectSessionMode(
            id,
            sessionPermissionMode(current, id) ?? "auto",
          );
          return;
        }
        if (message !== "") {
          // A message enters the plan and becomes its first instruction, the
          // way dsh steers the rest of the line into plan mode.
          if (!sessionPlan(current, id)) {
            await agentActions.selectSessionMode(id, "plan");
          }
          await agentActions.sendPrompt(message);
          return;
        }
        // Bare `/plan` toggles, which is what the palette row promises.
        await agentActions.selectSessionMode(
          id,
          sessionPlan(current, id)
            ? sessionPermissionMode(current, id) ?? "auto"
            : "plan",
        );
      } catch (error) {
        showToast("error", String(error));
      }
    }
  };

  /** The draft's bytes in the shape the queue stores (and resends) them. */
  const queueImages = (): NonNullable<QueuedPrompt["images"]> =>
    attachments.map((image) => ({
      name: image.name,
      mediaType: image.mediaType,
      data: image.data,
      src: image.src,
    }));

  const queueToComposerImages = (
    id: string,
    item: QueuedPrompt,
  ): ComposerImage[] =>
    (item.images ?? []).map((image, index) => ({
      id: `queue-${id}-${index}`,
      name: image.name ?? t("agent.queue.image"),
      mediaType: image.mediaType,
      data: image.data,
      src: image.src,
    }));

  /** Loads a queued item into the composer; the queue keeps it and waits. */
  const editQueued = (id: string) => {
    const session = state.selectedId;
    const item = queue.find((entry) => entry.id === id);
    if (!session || !item) return;
    // One item at a time: the composer holds the edit, and switching targets
    // would silently drop it (the row's button is disabled while editing).
    if (editingQueueId && editingQueueId !== id) return;
    // The draft that predates the edit is stashed, so applying or cancelling
    // returns the composer to what the reader was writing.
    editStash.current[session] = { text, images: attachments };
    agentActions.setQueueEditing(session, id);
    setDrafts((current) => ({ ...current, [session]: item.text }));
    setImages((current) => ({
      ...current,
      [session]: queueToComposerImages(id, item),
    }));
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    });
  };

  /** Leaves edit mode; `restore` puts the pre-edit draft back (取消). */
  const closeEdit = (restore: boolean) => {
    const session = state.selectedId;
    if (!session) return;
    const saved = editStash.current[session];
    delete editStash.current[session];
    agentActions.setQueueEditing(session, null);
    if (restore) {
      setDrafts((current) => ({ ...current, [session]: saved?.text ?? "" }));
      setImages((current) => ({
        ...current,
        [session]: saved?.images ?? EMPTY_IMAGES,
      }));
    }
    agentActions.advanceQueue(session);
  };

  /**
   * Applies the composer's text to the item being edited. Returns false when
   * the item vanished meanwhile: ZCode then treats the send as a new message.
   */
  const applyEdit = (): boolean => {
    const session = state.selectedId;
    const id = session ? editingQueueId : undefined;
    if (!session || !id) return false;
    const exists = queue.some((item) => item.id === id);
    if (!exists) {
      // Keep the text that was being edited: ZCode sends it as a new message.
      closeEdit(false);
      showToast("error", t("agent.queue.itemGone"));
      return false;
    }
    const updated = agentActions.updateQueuedPrompt(
      session,
      id,
      text,
      queueImages(),
    );
    if (updated) {
      // The draft that predated the edit comes back: editing a queued item
      // must not swallow a message the reader was still writing.
      closeEdit(true);
    }
    return updated;
  };

  /** Hands the current draft to the runtime now (idle / 立即发送). */
  const deliverNow = async (
    payloadText: string,
    payloadImages: ComposerImage[],
  ): Promise<void> => {
    setSending(true);
    const accepted = await agentActions.sendPrompt(
      payloadText,
      payloadImages.map((image) => ({
        data: image.data,
        mimeType: image.mediaType,
        name: image.name,
      })),
      payloadImages.map((image) => ({
        name: image.name,
        mediaType: image.mediaType,
        src: image.src,
      })),
    );
    if (accepted) {
      clearDraft();
      clearImages();
    }
    setSending(false);
  };

  /** Queue items handed to the runtime but not echoed yet still mean a reply
   *  is on its way; `running` alone misses that admission window. */
  const pendingCount = state.selectedId
    ? (state.pendingPrompts[state.selectedId]?.length ?? 0)
    : 0;
  const busy = running || sending || pendingCount > 0;

  /** Holds the draft for after this reply; the queue keeps it editable. */
  const queueDraft = async (sendNow: boolean) => {
    const session = state.selectedId;
    if (!session) return;
    const id = agentActions.enqueuePrompt(text, queueImages());
    if (!id) return;
    clearDraft();
    clearImages();
    if (sendNow) await agentActions.sendQueuedNow(session, id);
  };

  /** Delivers an idle draft. Only `submit`'s non-queue paths call this, so a
   *  pending edit has already been applied (or rejected) above. */
  const send = async () => {
    const hasImages = attachments.length > 0;
    if (block !== null || sending || (!text.trim() && !hasImages)) return;
    // From the task pane (or the review section) a message means "keep
    // editing": show the transcript first, so the reply lands where the reader
    // can follow it.
    if (task && (reviewing || paneView === "task")) {
      agentActions.setTaskView(task.id, "chat");
    }
    // ZCode asks before a manual send discards a paused queue.
    if (queuePaused && queue.length > 0) {
      setSendConfirm({ text, images: attachments });
      return;
    }
    await deliverNow(text, attachments);
  };

  /**
   * Enter. A line that names a known command takes the command path; anything
   * else (including `/unknown`) is an ordinary message, which is exactly what
   * dsh does with text it cannot resolve.
   *
   * While a reply is streaming, a plain send joins the queue instead of
   * interrupting the turn (ZCode's 队列 behaviour); the modified shortcut
   * (`sendNow`) steers it into the running turn right away, exactly like
   * ZCode's 「立即」.
   */
  const submit = async (sendNow = false) => {
    const draft = text.trim();
    // An edit lands first: submitting while a queued item is loaded applies
    // the change instead of starting a turn.
    if (editingQueueId && (draft || attachments.length > 0)) {
      if (applyEdit()) return;
      // The item is gone: fall through and treat the text as a new message.
    }
    if (!draft) {
      // An image-only prompt has no command line to route. While a reply is on
      // its way it still joins the queue like any other message.
      if (attachments.length > 0) {
        if (busy) await queueDraft(sendNow);
        else await send();
      }
      return;
    }
    const intent = slashIntent(draft, runtimeNames);
    setSlashDismissed(null);
    if (intent.kind !== "prompt" && attachments.length > 0) {
      // Slash commands own the turn/state they touch; an attachment has no
      // meaning for them, so say so instead of silently dropping the pictures.
      showToast("error", t("agent.cmd.noAttachments"));
      return;
    }
    if (intent.kind === "native") {
      // The command line is not content: clear it before anything runs, so a
      // cancelled picker leaves an empty draft instead of `/file`.
      setText("");
      await runNative(intent.name, intent.args);
      focusEditor();
      return;
    }
    if (intent.kind === "runtime") {
      if (await agentActions.runCommand(intent.line)) clearDraft();
      return;
    }
    if (busy) {
      await queueDraft(sendNow);
      return;
    }
    await send();
  };

  /** A palette row. No-input commands run; input ones rewrite the draft. */
  const pickSlash = async (command: SlashCommand) => {
    setSlashDismissed(null);
    if (command.action.kind === "insert") {
      setText(command.action.text);
      focusEditor();
      return;
    }
    if (command.action.kind === "runtime") {
      if (await agentActions.runCommand(`/${command.name}`)) clearDraft();
      return;
    }
    setText("");
    await runNative(command.name, "");
    focusEditor();
  };

  const stop = async () => {
    const id = state.selectedId;
    if (!id || stopping) return;
    setStopping(true);
    await agentActions.cancelTurn(id);
    setStopping(false);
  };

  /** Session-level workspace choice; a dirty worktree refuses to be removed. */
  const toggleWorktree = async (enabled: boolean) => {
    if (!task || worktreeBusy || !canChoose) return;
    setWorktreeBusy(true);
    try {
      await agentActions.chatWorktree(task.id, enabled);
    } catch (error) {
      showToast("error", t("agent.chat.worktreeFailed", { error: String(error) }));
    } finally {
      setWorktreeBusy(false);
    }
  };

  const toggleTeam = () => {
    if (!task || teamBusy || !canChoose) return;
    void agentActions.setTeamEnabled(task.id, !teamEnabled);
  };

  const toggleBoard = () => {
    if (!task) return;
    agentActions.setTeamView(task.id, teamView === "board" ? "chat" : "board");
  };

  const lockedHint = t("agent.chat.lockedHint");
  const primaryBusy = running ? stopping : sending;
  const primaryDisabled = running
    ? stopping
    : block !== null || sending || (!text.trim() && attachments.length === 0);
  const primaryTitle = running
    ? t("agent.task.stop")
    : block
      ? runtimeLabel(block)
      : t("common.send");

  return (
    <div data-component="Composer" className="px-6 pb-3 pt-2">
      <div className={AGENT_COLUMN}>
        <div
          ref={cardRef}
          className={clsx(
            "relative rounded-2xl border bg-surface transition",
            dragging
              ? "border-sky-300"
              : "border-border focus-within:border-slate-300",
          )}
        >
          {dragging ? (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl bg-sky-50/85 text-ui-caption text-sky-700">
              {t("agent.composer.drop")}
            </div>
          ) : null}
          {/* The two keyboard lists float above the card, like dsh desktop:
              they never push the transcript while a draft is being shaped. */}
          {slashOpen ? (
            <SlashPalette
              items={slashItems}
              index={slashIndex}
              onPick={(command) => void pickSlash(command)}
              onHover={setSlashIndex}
            />
          ) : mentionOpen ? (
            <MentionPalette
              items={mention.items}
              index={mentionIndex}
              root={mention.root}
              onPick={pickMention}
              onHover={setMentionIndex}
            />
          ) : historyOpen ? (
            <PromptHistoryPanel
              items={historyItems}
              index={historyIndex}
              onPick={(picked) => {
                setText(picked);
                setHistoryOpen(false);
                focusEditor();
              }}
              onHover={setHistoryIndex}
            />
          ) : null}
          {/* Messages typed while a reply streams wait here (ZCode queue):
              they are not in the transcript yet, so they stay editable. */}
          <QueuedPrompts
            items={queue}
            paused={queuePaused}
            editingId={editingQueueId}
            onMove={(id, beforeId) => {
              if (state.selectedId) {
                agentActions.moveQueuedPrompt(state.selectedId, id, beforeId);
              }
            }}
            onSendNow={(id) => {
              if (state.selectedId) {
                void agentActions.sendQueuedNow(state.selectedId, id);
              }
            }}
            onEdit={editQueued}
            onRemove={(id) => {
              if (state.selectedId) {
                agentActions.removeQueuedPrompt(state.selectedId, id);
              }
            }}
            onResume={() => {
              if (state.selectedId) agentActions.resumeQueue(state.selectedId);
            }}
          />
          {project ? (
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
              {/* The task pane above already names the project and branch. */}
              {paneView === "task" ? null : (
                <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-slate-500">
                  <FolderGit2 size={12} className="shrink-0" />
                  <ScrollingName text={project.name} className="max-w-[12rem]" />
                  {branch ? (
                    <>
                      <span className="shrink-0 text-slate-300">·</span>
                      <GitBranch size={12} className="shrink-0" />
                      <ScrollingName text={branch} className="max-w-[14rem]" />
                    </>
                  ) : null}
                </span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1">
                {teamEnabled ? (
                  <WorkBarButton
                    icon={teamView === "board" ? MessageSquare : LayoutGrid}
                    label={
                      teamView === "board"
                        ? t("agent.team.viewChat")
                        : t("agent.team.viewBoard")
                    }
                    onClick={toggleBoard}
                  />
                ) : null}
                <WorkBarButton
                  icon={Users}
                  label={t("agent.chat.team")}
                  active={teamEnabled}
                  disabled={!canChoose || teamBusy}
                  error={teamError}
                  title={canChoose ? t("agent.chat.teamHint") : lockedHint}
                  onClick={toggleTeam}
                />
                {chat ? (
                  <WorkBarButton
                    icon={GitBranch}
                    label={t("agent.chat.worktree")}
                    active={worktree}
                    disabled={!canChoose || worktreeBusy}
                    title={canChoose ? t("agent.chat.worktreeHint") : lockedHint}
                    onClick={() => void toggleWorktree(!worktree)}
                  />
                ) : (
                  <WorkBarButton
                    icon={GitBranch}
                    label={t("agent.chat.worktree")}
                    active
                    disabled
                    title={lockedHint}
                  />
                )}
              </span>
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2 border-b border-border px-3 py-2">
              {attachments.map((image) => (
                <span
                  key={image.id}
                  data-component="ComposerImage"
                  className="group/thumb relative"
                >
                  <button
                    type="button"
                    title={`${image.name} · ${t("agent.composer.preview")}`}
                    onClick={() =>
                      openMediaPreview(
                        [
                          {
                            url: image.src,
                            src: image.src,
                            kind: "image",
                            label: image.name,
                          },
                        ],
                        0,
                      )
                    }
                    className="block cursor-zoom-in overflow-hidden rounded-lg border border-border"
                  >
                    <img
                      src={image.src}
                      alt={image.name}
                      className="h-14 w-14 object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    aria-label={t("agent.composer.removeImage")}
                    title={t("agent.composer.removeImage")}
                    onClick={() =>
                      setAttachments(attachments.filter((item) => item.id !== image.id))
                    }
                    className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full border border-border bg-surface text-slate-500 transition hover:text-rose-600"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {editingQueueId ? (
            <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-ui-2xs text-slate-500">
              <Pencil size={11} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {t("agent.queue.editing")}
              </span>
              <button
                type="button"
                onClick={() => closeEdit(true)}
                className="shrink-0 rounded-md px-1 text-ui-2xs text-slate-500 transition hover:bg-overlay-soft hover:text-slate-700"
              >
                {t("common.cancel")}
              </button>
            </div>
          ) : null}
          <textarea
            ref={editorRef}
            value={text}
            rows={3}
            title={
              running ? t("agent.queue.composerHint") : t("agent.composer.hint")
            }
            placeholder={
              running
                ? t("agent.queue.placeholder")
                : reviewing
                  ? t("agent.review.continuePlaceholder")
                  : t("agent.composer.placeholder")
            }
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
            }}
            onSelect={(event) =>
              setCaret(event.currentTarget.selectionStart ?? text.length)
            }
            onPaste={pasteImages}
            // Leaving the field drops both lists; a row click keeps the focus
            // (mousedown is prevented), so this only fires on a real exit.
            onBlur={() => {
              setSlashDismissed(text);
              setHistoryOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              const key = event.key;

              // The `/` menu owns the arrows, Enter/Tab and Escape while it is
              // open; anything else is ordinary editing of the query.
              if (slashOpen) {
                if (key === "ArrowDown" || key === "ArrowUp") {
                  event.preventDefault();
                  setSlashIndex((index) =>
                    moveIndex(index, key === "ArrowDown" ? 1 : -1, slashItems.length),
                  );
                  return;
                }
                if (key === "Escape") {
                  event.preventDefault();
                  setSlashDismissed(text);
                  return;
                }
                if (key === "Enter" || key === "Tab") {
                  const command = slashItems[slashIndex];
                  if (command) {
                    event.preventDefault();
                    void pickSlash(command);
                    return;
                  }
                  // No match: Enter still sends, which is how an unknown
                  // `/line` reaches the model.
                }
              }

              // The `@` panel owns the same keys while it lists candidates.
              if (mentionOpen) {
                if (key === "ArrowDown" || key === "ArrowUp") {
                  event.preventDefault();
                  setMentionIndex((index) =>
                    moveIndex(index, key === "ArrowDown" ? 1 : -1, mention.items.length),
                  );
                  return;
                }
                if (key === "Escape") {
                  event.preventDefault();
                  setMention(null);
                  return;
                }
                if (key === "Enter" || key === "Tab") {
                  const row = mention.items[mentionIndex];
                  if (row) {
                    event.preventDefault();
                    pickMention(row);
                    return;
                  }
                }
              }

              // The ↑ panel behaves the same way over history rows.
              if (historyOpen) {
                if (key === "ArrowDown" || key === "ArrowUp") {
                  event.preventDefault();
                  setHistoryIndex((index) =>
                    moveIndex(index, key === "ArrowDown" ? 1 : -1, historyItems.length),
                  );
                  return;
                }
                if (key === "Escape") {
                  event.preventDefault();
                  setHistoryOpen(false);
                  return;
                }
                if (key === "Enter" || key === "Tab") {
                  const picked = historyItems[historyIndex];
                  if (picked !== undefined) {
                    event.preventDefault();
                    setText(picked);
                    setHistoryOpen(false);
                    return;
                  }
                }
              }

              // ↑ on an empty draft opens history (a caret move otherwise).
              if (key === "ArrowUp" && text === "") {
                event.preventDefault();
                setHistoryIndex(0);
                setHistoryOpen(true);
                return;
              }

              if (key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              // Enter always sends or queues; only the button carries the
              // send/stop state, so a keystroke never kills a run. The
              // modifier sends at once instead of joining the queue.
              void submit(event.metaKey || event.ctrlKey);
            }}
            className="block w-full resize-none bg-transparent px-3 pb-1 pt-2 text-ui-caption leading-6 text-slate-700 placeholder:text-slate-300 focus:outline-none"
          />
          <div className="flex items-center gap-2 px-2 pb-2 pt-0.5">
            <SessionModePicker openSignal={signals.mode} />
            {/* Only operable controls live inside the field: the session's
                figures are read-only status, so they sit under the card. */}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                title={t("agent.composer.add")}
                aria-label={t("agent.composer.add")}
                onClick={() => void pickFiles("")}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-overlay-soft hover:text-slate-600"
              >
                <Plus size={14} />
              </button>
              <SessionModelPicker openSignal={signals.model} />
              <button
                type="button"
                title={primaryTitle}
                aria-label={running ? t("agent.task.stop") : t("common.send")}
                aria-pressed={running}
                disabled={primaryDisabled}
                // Same path as Enter: an edit applies, a running turn queues,
                // a paused queue asks first, and slash lines route.
                onClick={() => (running ? void stop() : void submit())}
                className={clsx(
                  // Semantic primary, not `bg-slate-900`: the dark theme
                  // inverts slate, so that painted a white block under a white
                  // arrow. `primary-foreground` keeps the glyph readable.
                  "grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition hover:bg-primary-hover",
                  "disabled:cursor-default disabled:bg-slate-200 disabled:text-slate-400",
                )}
              >
                {primaryBusy ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : running ? (
                  <Square size={11} fill="currentColor" />
                ) : (
                  <Send size={13} />
                )}
              </button>
            </span>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-center">
          <SessionUsageBar
            usage={state.selectedId ? state.sessions[state.selectedId]?.usage : undefined}
          />
          {goal ? (
            <>
              <span className="px-1.5 text-ui-xs text-slate-300">·</span>
              <GoalChip goal={goal} />
            </>
          ) : null}
        </div>
      </div>
      {sendConfirm ? (
        <Dialog
          title={t("agent.queue.sendConfirmTitle")}
          icon={<Send size={15} className="text-slate-500" />}
          onClose={() => setSendConfirm(null)}
        >
          <p className="text-ui-caption leading-6 text-slate-600">
            {t("agent.queue.sendConfirmBody", {
              count: String(queue.length),
            })}
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const payload = sendConfirm;
                setSendConfirm(null);
                if (state.selectedId) agentActions.clearQueue(state.selectedId);
                if (payload) void deliverNow(payload.text, payload.images);
              }}
            >
              {t("agent.queue.sendConfirmClear")}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const payload = sendConfirm;
                setSendConfirm(null);
                if (payload) void deliverNow(payload.text, payload.images);
              }}
            >
              {t("agent.queue.sendConfirmKeep")}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
