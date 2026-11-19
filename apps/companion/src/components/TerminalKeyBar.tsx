import { t, type MessageKey } from "../lib/i18n";

type Props = {
  /** Sticky modifier: the next typed character is sent as its control code. */
  ctrl: boolean;
  onToggleCtrl: () => void;
  onKey: (data: string) => void;
  onKeyboard: () => void;
  /**
   * Line mode moves the composer's caret instead of sending `ESC[D`/`ESC[C`;
   * omitting them (direct mode) keeps the arrows on the PTY.
   */
  onCaretLeft?: () => void;
  onCaretRight?: () => void;
};

const KEY_BUTTON =
  "shrink-0 rounded-md border px-2.5 py-1 text-ui-sm transition active:bg-overlay-soft";
const KEY_BUTTON_IDLE = "border-border bg-surface text-slate-700";
const KEY_BUTTON_ACTIVE = "border-sky-200 bg-sky-50 text-sky-700";

function KeyButton(props: {
  label: string;
  title: string;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <button
      data-component="KeyButton"
      type="button"
      aria-label={props.title}
      title={props.title}
      aria-pressed={props.active}
      // Keep the xterm textarea focused: taking focus would dismiss the
      // soft keyboard on every tap.
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onPress}
      className={`${KEY_BUTTON} ${props.active ? KEY_BUTTON_ACTIVE : KEY_BUTTON_IDLE}`}
    >
      {props.label}
    </button>
  );
}

const ARROWS: ReadonlyArray<{
  data: string;
  label: string;
  aria: MessageKey;
  caret?: "left" | "right";
}> = [
  { data: "\x1b[A", label: "↑", aria: "mobile.terminal.keyUp" },
  { data: "\x1b[B", label: "↓", aria: "mobile.terminal.keyDown" },
  { data: "\x1b[D", label: "←", aria: "mobile.terminal.keyLeft", caret: "left" },
  { data: "\x1b[C", label: "→", aria: "mobile.terminal.keyRight", caret: "right" },
];

/** Soft-keyboard replacement row pinned under the terminal. */
export function TerminalKeyBar(props: Props) {
  return (
    <div data-component="TerminalKeyBar" className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-canvas px-2 py-1.5">
      <KeyButton
        label={t("mobile.terminal.keyEsc")}
        title={t("mobile.terminal.keyEsc")}
        onPress={() => props.onKey("\x1b")}
      />
      <KeyButton
        label={t("mobile.terminal.keyTab")}
        title={t("mobile.terminal.keyTab")}
        onPress={() => props.onKey("\t")}
      />
      <KeyButton
        label={t("mobile.terminal.ctrl")}
        title={t("mobile.terminal.ctrl")}
        active={props.ctrl}
        onPress={props.onToggleCtrl}
      />
      {ARROWS.map((arrow) => {
        const moveCaret =
          arrow.caret === "left"
            ? props.onCaretLeft
            : arrow.caret === "right"
              ? props.onCaretRight
              : undefined;
        return (
          <KeyButton
            key={arrow.data}
            label={arrow.label}
            title={t(arrow.aria)}
            onPress={moveCaret ?? (() => props.onKey(arrow.data))}
          />
        );
      })}
      <KeyButton
        label={t("mobile.terminal.keyboard")}
        title={t("mobile.terminal.keyboard")}
        onPress={props.onKeyboard}
      />
    </div>
  );
}
