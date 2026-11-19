import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Check, Loader2, Sparkles } from "lucide-react";

import { plainTitle } from "../lib/title";
import {
  defaultSelection,
  type DshModelsConfig,
  type ModelSelection,
} from "../lib/agentSettings";
import { dshTaskApi } from "../lib/dsh";
import { t } from "../lib/i18n";
import { showToast } from "../lib/toast";
import { useDismiss } from "../hooks/useDismiss";
import { useLayerClose } from "../hooks/useLayerClose";
import { usePanelServices } from "../workbench/panels/context";
import { Button, Switch } from "../components/ui";
import { ScrollingName } from "../components/ScrollingName";
import { ModelPicker } from "./ModelPicker";
import { agentActions, agentStore } from "./store";

/** A bug or a local work item; the popover has no other targets. */
export type EnqueueTarget =
  | { kind: "bug"; workspaceId: string; bugId: string; title: string }
  | { kind: "local"; projectId: string; itemId: string; title: string };

type Props = {
  target: EnqueueTarget;
  /** List rows use the compact icon button; the drawer footer the primary one. */
  variant?: "icon" | "primary";
  /** The row's own write action is running; hand-over has to wait. */
  disabled?: boolean;
};

const WIDTH = 380;
const GAP = 8;
const EDGE = 8;

/**
 * Hand-over button + cursor-anchored card: an optional note and the task's
 * first-turn choices. There is no mask and no footer — while the card is open
 * the button itself turns into the confirm (✔), so one click submits. Outside
 * click, Escape and scrolling dismiss it like a menu.
 */
export function EnqueueControl({ target, variant = "icon", disabled = false }: Props) {
  const services = usePanelServices();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({
    x: 0,
    y: 0,
    top: 0,
    bottom: 0,
  });
  const [submitting, setSubmitting] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  // Only the config slice is subscribed: rows must not re-render per stream
  // token while another session runs.
  const config = useSyncExternalStore(
    agentStore.subscribe,
    () => agentStore.get().config,
  );
  const models = config?.dshModels ?? null;
  const [note, setNote] = useState("");
  const [team, setTeam] = useState(false);
  const [model, setModel] = useState<ModelSelection | null>(null);

  const heading =
    target.kind === "bug" ? t("bugs.fixWithAgent") : t("local.items.toAgent");

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    const extraPrompt = note.trim() || undefined;
    try {
      const { task } =
        target.kind === "bug"
          ? await dshTaskApi.enqueueBug(
              target.workspaceId,
              target.bugId,
              extraPrompt,
              undefined,
              team,
              model ?? undefined,
            )
          : await dshTaskApi.enqueueLocal(
              target.projectId,
              target.itemId,
              extraPrompt,
              undefined,
              team,
              model ?? undefined,
            );
      agentActions.adoptTask(task);
      // The pick is the default for the sessions that start next; this task
      // already carries its own copy from the enqueue payload.
      if (model) void agentActions.rememberModelDefault(model);
      // The backend emits the new list; one refetch keeps a dropped event from
      // leaving the sidebar stale.
      void agentActions.refreshTasks();
      services.open({ resource: { type: "page", view: "agent" }, target: "primary" });
      setOpen(false);
      setSubmitting(false);
    } catch (error) {
      showToast("error", String(error));
      setSubmitting(false);
    }
  };

  /** The button opens the card; while open it is the confirm instead. */
  const press = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (disabled || submitting) return;
    if (open) {
      void submit();
      return;
    }
    const current = agentStore.get().config;
    if (!current) void agentActions.loadConfig();
    setNote("");
    setTeam(current?.teamEnabled ?? false);
    setModel(defaultSelection(current?.dshModels ?? null));
    const rect = event.currentTarget.getBoundingClientRect();
    // Keyboard activation carries no pointer, so anchor to the button itself.
    setAnchor({
      x: event.detail > 0 ? event.clientX : rect.left + rect.width / 2,
      y: event.detail > 0 ? event.clientY : rect.bottom,
      // The card must never cover the button: while it is open that button is
      // the confirm.
      top: rect.top,
      bottom: rect.bottom,
    });
    setOpen(true);
  };

  const label = open ? t("common.submit") : heading;

  return (
    <>
      {variant === "icon" ? (
        <button
          ref={(el) => {
            triggerRef.current = el;
          }}
          type="button"
          title={label}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled || submitting}
          onClick={press}
          className={clsx(
            "inline-flex items-center justify-center whitespace-nowrap rounded-md border px-2.5 py-1 text-ui-sm font-normal transition disabled:cursor-not-allowed disabled:opacity-40",
            open
              ? "border-sky-300 bg-sky-50 text-sky-700"
              : "border-border bg-surface text-slate-600 hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700",
          )}
        >
          {submitting ? (
            <Loader2 size={12} className="animate-spin" />
          ) : open ? (
            <Check size={13} />
          ) : (
            <Sparkles size={12} />
          )}
        </button>
      ) : (
        // `Button` has no ref; the wrapper still gives dismiss something to
        // recognise as the toggle.
        <span ref={triggerRef} className="contents">
          <Button
            size="sm"
            variant="primary"
            icon={
              submitting ? (
                <Loader2 size={13} className="animate-spin" />
              ) : open ? (
                <Check size={13} />
              ) : (
                <Sparkles size={13} />
              )
            }
            title={open ? label : t("agent.enqueue.bugHint")}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={disabled}
            onClick={press}
          >
            {label}
          </Button>
        </span>
      )}

      {open ? (
        <EnqueuePanel
          target={target}
          heading={heading}
          x={anchor.x}
          y={anchor.y}
          anchorTop={anchor.top}
          anchorBottom={anchor.bottom}
          anchorRef={triggerRef}
          models={models}
          team={team}
          onTeam={setTeam}
          model={model}
          onModel={setModel}
          note={note}
          onNote={setNote}
          submitting={submitting}
          onSubmit={() => void submit()}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

type PanelProps = {
  target: EnqueueTarget;
  heading: string;
  x: number;
  y: number;
  /** Vertical extent of the trigger button, kept clear of the card. */
  anchorTop: number;
  anchorBottom: number;
  /** The trigger button: pressing it confirms, so it is not "outside". */
  anchorRef: RefObject<HTMLElement | null>;
  models: DshModelsConfig | null;
  team: boolean;
  onTeam: (value: boolean) => void;
  model: ModelSelection | null;
  onModel: (value: ModelSelection) => void;
  note: string;
  onNote: (value: string) => void;
  submitting: boolean;
  onSubmit: () => void;
  onClose: () => void;
};

/**
 * The card itself: measured before paint so it never flashes outside the
 * window, flipping above the click point when the lower half is full.
 */
function EnqueuePanel(props: PanelProps) {
  const {
    target,
    heading,
    x,
    y,
    anchorTop,
    anchorBottom,
    anchorRef,
    models,
    team,
    onTeam,
    model,
    onModel,
    note,
    onNote,
    submitting,
    onSubmit,
    onClose,
  } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const { closing, requestClose } = useLayerClose(onClose);
  // `autoFocus` does not reach a portal-mounted node reliably, and the first
  // paint is `visibility: hidden` until the measure lands — an element that
  // cannot take focus. One frame in, the card is visible.
  useEffect(() => {
    const frame = requestAnimationFrame(() => noteRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  useDismiss(true, panelRef, () => requestClose(), {
    ignore: anchorRef,
    scroll: true,
    resize: true,
    blur: true,
  });

  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(
    null,
  );

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = Math.min(
      Math.max(EDGE, x),
      Math.max(EDGE, window.innerWidth - width - EDGE),
    );
    // Never cover the trigger button — it is the confirm while the card is open.
    const below = Math.max(y + GAP, anchorBottom + GAP);
    const above = Math.min(y - GAP - height, anchorTop - GAP - height);
    // Prefer below the click; flip up when that side is the one with room.
    const fitsBelow = below + height <= window.innerHeight - EDGE;
    const up = !fitsBelow && above >= EDGE;
    const top = up
      ? above
      : Math.max(EDGE, Math.min(below, window.innerHeight - height - EDGE));
    setPos({ left, top, up });
  }, [x, y, anchorTop, anchorBottom]);

  const left = pos?.left ?? x;
  const width = Math.min(WIDTH, window.innerWidth - EDGE * 2);
  const style = {
    left,
    top: pos?.top ?? y + GAP,
    width,
    visibility: pos ? "visible" : "hidden",
    // The card grows out of the click point, whichever side it landed on.
    transformOrigin: `${x < left + width / 2 ? "left" : "right"} ${pos?.up ? "bottom" : "top"}`,
    "--pop-shift": pos?.up ? "-4px" : "4px",
  } as CSSProperties;

  return createPortal(
    <div
      data-component="EnqueuePanel"
      ref={panelRef}
      role="dialog"
      aria-label={heading}
      style={style}
      className={clsx(
        "enqueue-pop fixed z-[68] rounded-xl border border-border bg-surface p-3",
        closing && "enqueue-pop-out",
      )}
    >
      <header className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-sky-50 text-sky-600">
          <Sparkles size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-caption text-slate-800">{heading}</div>
          <ScrollingName
            text={plainTitle(target.title)}
            className="text-ui-2xs text-slate-400"
          />
        </div>
      </header>

      <div className="mt-2.5 flex items-center gap-3">
        <span
          className="flex shrink-0 items-center gap-1.5 text-ui-2xs text-slate-500"
          title={t("agent.enqueue.teamHint")}
        >
          <Switch
            checked={team}
            onChange={onTeam}
            disabled={submitting}
            label={t("agent.chat.team")}
          />
          {t("agent.chat.team")}
        </span>
        {/* Route and effort for this task's first turn; fixed once it runs. */}
        <span className="ml-auto flex min-w-0 items-center gap-1 text-ui-2xs text-slate-500">
          <span className="shrink-0 text-slate-400">
            {t("agent.model.pickTitle")}
          </span>
          <ModelPicker
            models={models}
            value={model}
            onChange={onModel}
            disabled={submitting}
            placement="down"
          />
        </span>
      </div>

      <textarea
        ref={noteRef}
        rows={2}
        value={note}
        title={t("agent.enqueue.hint")}
        placeholder={t("agent.enqueue.placeholder")}
        onChange={(event) => onNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          onSubmit();
        }}
        className="mt-2 w-full resize-none rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ui-caption leading-5 text-slate-700 transition placeholder:text-slate-300"
      />

      <div className="mt-1.5 flex items-center justify-end text-ui-2xs text-slate-300">
        <span className="whitespace-nowrap">⌘↵ {t("common.submit")}</span>
      </div>
    </div>,
    document.body,
  );
}
