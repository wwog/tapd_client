import { useId, useState } from "react";
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

/** One editable row. `level` stays free text until it is validated on save. */
type EditableEffort = { key: number; level: string; wire: string };
let nextRowKey = 0;
const newRow = (level: string, wire: string): EditableEffort => ({
  key: nextRowKey++,
  level,
  wire,
});

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
  // real ladder so there is no phantom row that keeps coming back after delete.
  const [reasoning, setReasoning] = useState<EditableEffort[]>(
    () =>
      model?.reasoning
        .filter((effort) => effort.level !== "off")
        .map((effort) => newRow(effort.level, effort.wire)) ?? [],
  );
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const levelListId = useId();

  const edit = (update: (current: EditableEffort[]) => EditableEffort[]) => {
    setReasoning(update);
    setError(null);
  };

  const addLevel = () => {
    if (reasoning.length >= OFFERED_LEVELS.length) return;
    edit((current) => [...current, newRow("", "")]);
  };

  const changeLevel = (key: number, level: string) =>
    edit((current) =>
      current.map((effort) => {
        if (effort.key !== key) return effort;
        // Keep an untouched wire value in step with the level it names.
        const wire =
          effort.wire.trim() === effort.level.trim() ? level : effort.wire;
        return { ...effort, level, wire };
      }),
    );

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

    // Normalize and validate the free-text ladder before it reaches the backend.
    const seen = new Set<string>();
    for (const effort of reasoning) {
      const level = effort.level.trim().toLowerCase();
      if (!OFFERED_LEVELS.some((offered) => offered === level)) {
        setError(t("agent.model.reasoningLevelInvalid", { level: effort.level || "—" }));
        return;
      }
      if (seen.has(level)) {
        setError(t("agent.model.reasoningLevelDuplicate", { level }));
        return;
      }
      seen.add(level);
    }
    if (reasoning.some((effort) => effort.wire.trim().length === 0)) {
      setError(t("agent.model.wireRequired"));
      return;
    }

    const window = Number.parseInt(context, 10);
    const output = Number.parseInt(maxTokens, 10);
    // Persist in escalation order so the profile writes a stable ladder.
    const ladder = reasoning
      .map((effort) => ({
        level: effort.level.trim().toLowerCase() as DshReasoningLevel,
        wire: effort.wire.trim(),
      }))
      .sort(
        (left, right) =>
          REASONING_LEVELS.indexOf(left.level) - REASONING_LEVELS.indexOf(right.level),
      );
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
          <datalist id={levelListId}>
            {OFFERED_LEVELS.map((level) => (
              <option key={level} value={level} />
            ))}
          </datalist>
          {reasoning.length > 0 ? (
            <div className="mt-1.5 space-y-1.5">
              {reasoning.map((effort) => (
                <div key={effort.key} className="flex items-center gap-2">
                  <input
                    list={levelListId}
                    value={effort.level}
                    placeholder="low"
                    aria-label={t("agent.model.reasoningLevels")}
                    onChange={(event) => changeLevel(effort.key, event.target.value)}
                    className={`${inputClass} w-24 shrink-0 py-1 font-mono`}
                  />
                  <span className="shrink-0 text-slate-300">→</span>
                  <input
                    value={effort.wire}
                    placeholder={t("agent.model.wirePlaceholder")}
                    aria-label={t("agent.model.reasoningMapping")}
                    onChange={(event) => changeWire(effort.key, event.target.value)}
                    className={`${inputClass} font-mono`}
                  />
                  <button
                    type="button"
                    title={t("agent.model.removeLevel")}
                    onClick={() => removeLevel(effort.key)}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 size={12} />
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
