import { useState } from "react";
import clsx from "clsx";
import { ChevronDown, ChevronRight, Cpu, Plus, Trash2 } from "lucide-react";

import { Dialog } from "../components/Dialog";
import { Button, inputClass } from "../components/ui";
import {
  REASONING_LEVELS,
  type DshModelEntry,
  type DshReasoningLevel,
} from "../lib/agentSettings";
import { t } from "../lib/i18n";

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

/** Levels that may be offered; `off` is an implicit floor, not an editable row. */
const OFFERED_LEVELS = REASONING_LEVELS.filter((level) => level !== "off");

/** One editable row: only the value sent upstream; the level comes from position. */
type EditableEffort = { key: number; wire: string };
let nextRowKey = 0;
const newRow = (wire: string): EditableEffort => ({ key: nextRowKey++, wire });

/** Compact inline field; several of these boxes share a line. */
const compactField =
  "rounded-md border border-border bg-surface px-1.5 py-0.5 text-ui-xs font-mono text-slate-700 outline-none transition placeholder:text-slate-300";

type Props = {
  /** The entry being edited, or `null` when adding a new one. */
  model: DshModelEntry | null;
  /** Ids already in this provider's catalog, for duplicate detection. */
  existingIds: string[];
  onClose: () => void;
  onSubmit: (model: DshModelEntry) => void;
  /** Present when editing: removes the entry from the catalog. */
  onDelete?: () => void;
};

/**
 * Add or edit one catalog entry. Only the fields dsh's `llm-pi-ai` actually
 * reads are offered: modalities are text and image in this payload, and a
 * reasoning ladder is a level-to-wire-value map.
 */
export function ModelEditorDialog(props: Props) {
  const { model, existingIds, onClose, onSubmit, onDelete } = props;
  const [id, setId] = useState(model?.id ?? "");
  const [context, setContext] = useState(String(model?.contextWindow ?? 128_000));
  const [maxTokens, setMaxTokens] = useState(
    model?.maxTokens === null || model?.maxTokens === undefined ? "" : String(model.maxTokens),
  );
  const [image, setImage] = useState(model?.input.includes("image") ?? true);
  // `off` is the implicit floor the backend re-adds; the editor shows only the
  // real ladder. Each row carries just the wire value — the level is its index
  // in this list (low → high), so there is no separate "name" to make sense of.
  const [reasoning, setReasoning] = useState<EditableEffort[]>(
    () =>
      model?.reasoning
        .filter((effort) => effort.level !== "off")
        .map((effort) => newRow(effort.wire)) ?? [],
  );
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edit = (update: (current: EditableEffort[]) => EditableEffort[]) => {
    setReasoning(update);
    setError(null);
  };

  const addLevel = () => {
    if (reasoning.length >= OFFERED_LEVELS.length) return;
    edit((current) => [...current, newRow("")]);
  };

  const changeWire = (key: number, wire: string) =>
    edit((current) =>
      current.map((effort) => (effort.key === key ? { ...effort, wire } : effort)),
    );

  const removeLevel = (key: number) =>
    edit((current) => current.filter((effort) => effort.key !== key));

  const save = () => {
    const trimmed = id.trim();
    if (!trimmed) {
      setError(t("agent.model.idRequired"));
      return;
    }
    if (existingIds.some((existing) => existing === trimmed && existing !== model?.id)) {
      setError(t("agent.model.idDuplicate"));
      return;
    }

    if (reasoning.some((effort) => effort.wire.trim().length === 0)) {
      setError(t("agent.model.wireRequired"));
      return;
    }

    const window = Number.parseInt(context, 10);
    const output = Number.parseInt(maxTokens, 10);
    // Level names come from the row's position in the low→high ladder; `off`
    // is the implicit floor the backend inserts. The wire value is all the
    // user enters, so a partial ladder (e.g. low/high) keeps its own meaning.
    const ladder = reasoning.map((effort, index) => ({
      level: OFFERED_LEVELS[index] as DshReasoningLevel,
      wire: effort.wire.trim(),
    }));
    onSubmit({
      id: trimmed,
      contextWindow: clamp(
        Number.isFinite(window) && window > 0 ? window : 128_000,
        1_024,
        4_000_000,
      ),
      maxTokens:
        maxTokens.trim() && Number.isFinite(output) ? clamp(output, 1, 4_000_000) : null,
      input: image ? ["text", "image"] : ["text"],
      reasoning: ladder,
      enabled: model?.enabled ?? true,
    });
    onClose();
  };

  return (
    <Dialog
      title={model ? t("agent.model.editModel") : t("agent.model.addModel")}
      icon={<Cpu size={16} className="text-slate-400" />}
      onClose={onClose}
    >
      <div className="space-y-1.5">
        <div className="text-ui-xs text-slate-400">{t("agent.model.modelId")}</div>
        <input
          autoFocus
          value={id}
          placeholder={t("agent.model.modelIdPlaceholder")}
          onChange={(event) => setId(event.target.value)}
          className={`${inputClass} font-mono`}
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="text-ui-xs text-slate-400">{t("agent.model.contextWindow")}</div>
          <input
            type="number"
            min={1_024}
            max={4_000_000}
            value={context}
            onChange={(event) => setContext(event.target.value)}
            className={`${inputClass} tabular-nums`}
          />
        </div>
        <div className="space-y-1.5">
          <div className="text-ui-xs text-slate-400">{t("agent.model.maxTokens")}</div>
          <input
            type="number"
            min={1}
            max={4_000_000}
            value={maxTokens}
            placeholder={t("agent.model.optional")}
            onChange={(event) => setMaxTokens(event.target.value)}
            className={`${inputClass} tabular-nums`}
          />
        </div>
      </div>

      <div className="mt-3">
        <div className="text-ui-xs text-slate-400" title={t("agent.model.inputTypesHint")}>
          {t("agent.model.inputTypes")}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span
            className="rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1 text-ui-caption text-sky-700"
            title={t("agent.model.inputTextLocked")}
          >
            {t("agent.model.inputText")}
          </span>
          <button
            type="button"
            aria-pressed={image}
            onClick={() => setImage((current) => !current)}
            className={clsx(
              "rounded-lg border px-2.5 py-1 text-ui-caption transition",
              image
                ? "border-sky-200 bg-sky-50 text-sky-700"
                : "border-border bg-surface text-slate-600 hover:border-slate-300",
            )}
          >
            {t("agent.model.inputImage")}
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setAdvanced((current) => !current)}
        className="mt-4 flex items-center gap-1.5 text-ui-sm text-slate-600 transition hover:text-slate-900"
      >
        {advanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {t("agent.model.advanced")}
      </button>

      {advanced ? (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <div className="flex items-center justify-between gap-2">
            <div
              className="text-ui-xs text-slate-400"
              title={t("agent.model.reasoningHint")}
            >
              {t("agent.model.reasoningLevels")}
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={13} />}
              disabled={reasoning.length >= OFFERED_LEVELS.length}
              onClick={addLevel}
            >
              {t("agent.model.addLevel")}
            </Button>
          </div>
          {reasoning.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {reasoning.map((effort) => (
                <div
                  key={effort.key}
                  className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1"
                >
                  <input
                    value={effort.wire}
                    placeholder={t("agent.model.wirePlaceholder")}
                    aria-label={t("agent.model.reasoningMapping")}
                    onChange={(event) => changeWire(effort.key, event.target.value)}
                    className={`${compactField} w-20`}
                  />
                  <button
                    type="button"
                    title={t("agent.model.removeLevel")}
                    onClick={() => removeLevel(effort.key)}
                    className="grid h-5 w-5 shrink-0 place-items-center rounded text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-1.5 text-ui-xs leading-5 text-slate-400">
              {t("agent.model.reasoningHint")}
            </p>
          )}
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 break-all rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-600">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        {onDelete ? (
          <Button
            size="sm"
            variant="danger"
            className="mr-auto"
            onClick={() => {
              onDelete();
              onClose();
            }}
          >
            {t("agent.model.removeModel")}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={id.trim().length === 0}
          title={id.trim() ? undefined : t("agent.model.idRequired")}
          onClick={save}
        >
          {t("common.save")}
        </Button>
      </div>
    </Dialog>
  );
}
